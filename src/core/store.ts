import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BOARD_SCHEMA_INDEX, BOARD_SCHEMA_TABLE, findFlowLeaseRow, GRAPH_COLUMN_MIGRATIONS,
  listActiveLeasesQuery, listBoardEventsQuery, releaseScopedLeaseQuery, runAcquireScopedLeaseTx,
  runAppendBoardEventTx,
} from "./store-board.ts";
import {
  type ArtifactRow, captureProcessStartToken, type EpistemicRow, type HandoffRow, hasCol, hasTable,
  isProcessAliveWithToken, type JobRow, LeaseLostError, type LeaseRow, listFlowSteersQuery, type MandateRow,
  type MandateScope, MAX_ARCHIVED_FLOW_RUNS, mergeSteerLists, mergeSteersIntoSnapshotJson, MIGRATIONS,
  ProjectBusyError, type ProjectFlowLease, runAcquireProjectLeaseTx, runAppendFlowSteerTx,
  runCancelCheckpointTx, runUpsertMandateTx, type SaveFlowCheckpointOptions, SCHEMA_INDEXES, SCHEMA_TABLES,
  toArtifact, toEpistemicItem, toFlowCheckpoint, toHandoff, toJob, toLease, toMandate,
} from "./store-schema.ts";
import type {
  ArtifactRecord, BackgroundJob, EpistemicItem, EpistemicKind, EpistemicStatus, FlowBoardEntry,
  FlowLeaseMode, FlowUserSteer, HandoffEnvelope, JobStatus, Mandate, MandateStatus, PersistedFlowCheckpoint,
} from "./types.ts";

export {
  captureProcessStartToken, isProcessAliveWithToken, LeaseLostError, type MandateScope,
  ProjectBusyError, type ProjectFlowLease, type SaveFlowCheckpointOptions,
};
export type { PersistedFlowCheckpoint } from "./types.ts";

const nowIso = (): string => new Date().toISOString();

export class EnhanceStore {
  private db: Database | null = null;
  private roDb: Database | null = null;
  private closed = false;

  constructor(readonly dbPath: string) {}

  isClosed(): boolean { return this.closed; }
  reopen(): void { this.closed = false; }
  close(): void {
    this.closed = true;
    try { this.roDb?.close(); } catch {}
    try { this.db?.close(); } catch {}
    this.roDb = null; this.db = null;
  }

  private migrateSchema(db: Database): void {
    const colsByTable = new Map<string, Set<string>>();
    for (const [table, col, ddl] of [...MIGRATIONS, ...GRAPH_COLUMN_MIGRATIONS]) {
      let cols = colsByTable.get(table);
      if (!cols) {
        cols = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
        colsByTable.set(table, cols);
      }
      if (!cols.has(col)) { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); cols.add(col); }
    }
  }

  private writeConn(create: boolean): Database | null {
    if (this.closed) { if (!create) return null; throw new Error("EnhanceStore is closed."); }
    if (this.db) return this.db;
    if (!create && !existsSync(this.dbPath)) return null;
    try { this.roDb?.close(); } catch {}
    this.roDb = null;
    const dir = path.dirname(this.dbPath);
    mkdirSync(dir, { recursive: true });
    if (path.basename(dir) === ".omp-enhance") {
      try { const gi = path.join(dir, ".gitignore"); if (!existsSync(gi)) writeFileSync(gi, "*\n", "utf8"); } catch {}
    }
    this.db = new Database(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`${SCHEMA_TABLES}\n${BOARD_SCHEMA_TABLE}`); this.migrateSchema(this.db); this.db.exec(`${SCHEMA_INDEXES}\n${BOARD_SCHEMA_INDEX}`);
    return this.db;
  }

  private readConn(): Database | null {
    if (this.closed) return null;
    if (this.db || this.roDb) return this.db ?? this.roDb;
    if (!existsSync(this.dbPath)) return null;
    const walPath = `${this.dbPath}-wal`;
    try {
      if (existsSync(walPath) && statSync(walPath).size > 0 && !existsSync(`${this.dbPath}-shm`)) return this.writeConn(false);
      const ro = new Database(this.dbPath, { readonly: true });
      ro.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
      this.roDb = ro;
      return ro;
    } catch { return this.writeConn(false); }
  }

  upsertMandate(input: {
    id?: string; goal: string; constraints?: string[]; acceptance?: string[];
    status?: MandateStatus; sessionId?: string | null; flowId?: string | null;
  }): Mandate {
    const db = this.writeConn(true)!;
    return db.transaction(() => runUpsertMandateTx(db, input, nowIso(), randomUUID)).immediate();
  }

  completeMandate(id: string): Mandate | null {
    const db = this.writeConn(false);
    if (!db) return null;
    return db.transaction(() => {
      const existing = db.query("SELECT * FROM mandates WHERE id = ?").get(id) as MandateRow | null;
      if (!existing) return null;
      const ts = nowIso();
      db.query("UPDATE mandates SET status = 'completed', updated_at = ? WHERE id = ?").run(ts, id);
      return toMandate({ ...existing, status: "completed", updated_at: ts });
    }).immediate();
  }

  getActiveMandate(scope?: MandateScope): Mandate | null {
    const db = this.readConn();
    if (!db || !hasTable(db, "mandates")) return null;
    const scopedCols = this.db !== null || (hasCol(db, "mandates", "session_id") && hasCol(db, "mandates", "flow_id"));
    if (scope?.flowId) {
      if (!scopedCols) return null;
      const row = db.query("SELECT * FROM mandates WHERE status = 'active' AND flow_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(scope.flowId) as MandateRow | null;
      return row ? toMandate(row) : null;
    }
    if (scope?.sessionId && scopedCols) {
      const row = db.query("SELECT * FROM mandates WHERE status = 'active' AND flow_id IS NULL AND (session_id = ? OR session_id IS NULL) ORDER BY CASE WHEN session_id = ? THEN 0 ELSE 1 END, updated_at DESC, rowid DESC LIMIT 1")
        .get(scope.sessionId, scope.sessionId) as MandateRow | null;
      return row ? toMandate(row) : null;
    }
    const row = db.query("SELECT * FROM mandates WHERE status = 'active' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as MandateRow | null;
    return row ? toMandate(row) : null;
  }

  getMandate(id: string): Mandate | null {
    const db = this.readConn(), row = db && hasTable(db, "mandates") ? (db.query("SELECT * FROM mandates WHERE id = ?").get(id) as MandateRow | null) : null;
    return row ? toMandate(row) : null;
  }

  addEpistemicItem(input: {
    mandateId: string; kind: EpistemicKind; statement: string; evidenceRef?: string | null; verificationPlan?: string | null; status?: EpistemicStatus;
  }): EpistemicItem {
    const evidenceRef = input.evidenceRef?.trim() || null;
    if (input.kind === "fact" && !evidenceRef) throw new Error("Epistemic item of kind 'fact' requires a non-empty evidenceRef.");
    const item: EpistemicItem = {
      id: randomUUID(), mandateId: input.mandateId, kind: input.kind, statement: input.statement,
      evidenceRef, verificationPlan: input.verificationPlan?.trim() || null, status: input.status ?? "open", createdAt: nowIso(),
    };
    this.writeConn(true)!.query("INSERT INTO epistemic_items (id, mandate_id, kind, statement, evidence_ref, verification_plan, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(item.id, item.mandateId, item.kind, item.statement, item.evidenceRef, item.verificationPlan, item.status, item.createdAt);
    return item;
  }

  updateEpistemicStatus(id: string, status: EpistemicStatus, evidenceRef?: string | null): EpistemicItem {
    const db = this.writeConn(false);
    if (!db) throw new Error(`Epistemic item "${id}" not found.`);
    return db.transaction(() => {
      const row = db.query("SELECT * FROM epistemic_items WHERE id = ?").get(id) as EpistemicRow | null;
      if (!row) throw new Error(`Epistemic item "${id}" not found.`);
      const nextEvidence = evidenceRef === undefined ? row.evidence_ref : evidenceRef?.trim() || null;
      if (row.kind === "fact" && !nextEvidence) throw new Error("Epistemic item of kind 'fact' requires a non-empty evidenceRef.");
      db.query("UPDATE epistemic_items SET status = ?, evidence_ref = ? WHERE id = ?").run(status, nextEvidence, id);
      return { ...toEpistemicItem(row), status, evidenceRef: nextEvidence };
    }).immediate();
  }

  listEpistemicItems(mandateId: string): EpistemicItem[] {
    const db = this.readConn();
    return db && hasTable(db, "epistemic_items")
      ? (db.query("SELECT * FROM epistemic_items WHERE mandate_id = ? ORDER BY created_at ASC, rowid ASC").all(mandateId) as EpistemicRow[]).map(toEpistemicItem) : [];
  }

  recordArtifacts(mandateId: string, artifacts: readonly ArtifactRecord[]): void {
    if (artifacts.length === 0) return;
    const db = this.writeConn(true)!;
    db.transaction(() => {
      const stmt = db.query("INSERT OR IGNORE INTO artifacts (mandate_id, path, sha256, byte_size, role, digest_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      const ts = nowIso();
      for (const a of artifacts) stmt.run(mandateId, a.path, a.sha256, a.byteSize, a.role, a.digestKind ?? null, ts);
    }).immediate();
  }

  listArtifacts(mandateId: string): ArtifactRecord[] {
    const db = this.readConn();
    if (!db || !hasTable(db, "artifacts")) return [];
    const cols = this.db !== null || hasCol(db, "artifacts", "digest_kind") ? "path, sha256, byte_size, role, digest_kind" : "path, sha256, byte_size, role, NULL AS digest_kind";
    return db.query(`SELECT ${cols} FROM artifacts WHERE artifact_id IN (SELECT MAX(artifact_id) FROM artifacts WHERE mandate_id = ? GROUP BY path) ORDER BY path ASC`)
      .all(mandateId).map((row) => toArtifact(row as ArtifactRow));
  }

  saveHandoff(envelope: HandoffEnvelope): void {
    this.writeConn(true)!.query(
      "INSERT OR REPLACE INTO handoffs (id, mandate_id, mandate_rev, parent_handoff_id, from_role, to_target, verdict, summary, artifacts, deleted_files, verified_facts, verification_evidence, open_risks, questions_for_user, feedback_for_upstream, observed_usage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      envelope.id, envelope.mandateId, envelope.mandateRev, envelope.parentHandoffId, envelope.fromRole,
      envelope.toTarget, envelope.verdict, envelope.summary, JSON.stringify(envelope.artifacts),
      envelope.deletedFiles !== undefined ? JSON.stringify(envelope.deletedFiles) : null, JSON.stringify(envelope.verifiedFacts),
      envelope.verificationEvidence !== undefined ? JSON.stringify(envelope.verificationEvidence) : null, JSON.stringify(envelope.openRisks),
      envelope.questionsForUser !== undefined ? JSON.stringify(envelope.questionsForUser) : null,
      envelope.feedbackForUpstream, envelope.observedUsage ? JSON.stringify(envelope.observedUsage) : null, envelope.createdAt,
    );
  }
  getHandoff(id: string): HandoffEnvelope | null { const db = this.readConn(), row = db && hasTable(db, "handoffs") ? (db.query("SELECT * FROM handoffs WHERE id = ?").get(id) as HandoffRow | null) : null; return row ? toHandoff(row) : null; }
  getLatestHandoff(mandateId?: string): HandoffEnvelope | null { const db = this.readConn(), row = db && hasTable(db, "handoffs") ? (db.query("SELECT * FROM handoffs WHERE (? IS NULL OR mandate_id = ?) ORDER BY created_at DESC, rowid DESC LIMIT 1").get(mandateId ?? null, mandateId ?? null) as HandoffRow | null) : null; return row ? toHandoff(row) : null; }
  listHandoffs(mandateId?: string, limit?: number): HandoffEnvelope[] { const db = this.readConn(); return db && hasTable(db, "handoffs") ? (db.query("SELECT * FROM handoffs WHERE (? IS NULL OR mandate_id = ?) ORDER BY created_at DESC, rowid DESC LIMIT COALESCE(?, -1)").all(mandateId ?? null, mandateId ?? null, limit ?? null) as HandoffRow[]).map(toHandoff) : []; }
  saveJob(job: BackgroundJob): void {
    this.writeConn(true)!.query("INSERT OR REPLACE INTO jobs (job_id, mandate_id, hypothesis_id, idempotency_key, command, cwd, pid, pgid, owner_pid, process_start_token, log_path, exit_file_path, status, exit_code, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(job.jobId, job.mandateId, job.hypothesisId, job.idempotencyKey ?? null, job.command, job.cwd, job.pid, job.pgid, job.ownerPid ?? null, job.processStartToken ?? null, job.logPath, job.exitFilePath, job.status, job.exitCode, job.startedAt, job.endedAt);
  }

  transitionJobStatus(jobId: string, expectedStatuses: readonly JobStatus[], patch: { status: JobStatus; exitCode?: number | null; endedAt?: string | null }): BackgroundJob | null {
    const db = this.writeConn(false);
    if (!db) return null;
    return db.transaction(() => {
      const row = db.query("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | null;
      if (!row) return null;
      if (!expectedStatuses.includes(row.status)) return toJob(row);
      const nextExit = patch.exitCode === undefined ? row.exit_code : patch.exitCode;
      const nextEnded = patch.endedAt === undefined ? row.ended_at : patch.endedAt;
      db.query("UPDATE jobs SET status = ?, exit_code = ?, ended_at = ? WHERE job_id = ?").run(patch.status, nextExit, nextEnded, jobId);
      return toJob({ ...row, status: patch.status, exit_code: nextExit, ended_at: nextEnded });
    }).immediate();
  }

  getJob(jobId: string): BackgroundJob | null {
    const db = this.readConn(), row = db && hasTable(db, "jobs") ? (db.query("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | null) : null;
    return row ? toJob(row) : null;
  }

  findJobByIdempotencyKey(idempotencyKey: string, mandateId?: string | null): BackgroundJob | null {
    const key = idempotencyKey.trim();
    if (!key) return null;
    const db = this.readConn();
    if (!db || !hasTable(db, "jobs") || !(this.db !== null || hasCol(db, "jobs", "idempotency_key"))) return null;
    const row = db.query(
      "SELECT * FROM jobs WHERE idempotency_key = ? AND (? IS NULL OR mandate_id = ?) ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END, started_at DESC, rowid DESC LIMIT 1",
    ).get(key, mandateId ?? null, mandateId ?? null) as JobRow | null;
    return row ? toJob(row) : null;
  }

  listJobs(status?: JobStatus, limit = 200): BackgroundJob[] {
    const db = this.readConn();
    return db && hasTable(db, "jobs") ? db.query("SELECT * FROM jobs WHERE (? IS NULL OR status = ?) ORDER BY started_at DESC, rowid DESC LIMIT ?")
      .all(status ?? null, status ?? null, limit > 0 ? limit : -1).map((row) => toJob(row as JobRow)) : [];
  }

  acquireProjectFlowLease(
    flowId: string, ownerPid?: number, ownerStartToken?: string | null, leaseToken?: string,
  ): { leaseToken: string; stateVersion: number } {
    const targetFlowId = flowId.trim();
    if (!targetFlowId) throw new Error("acquireProjectFlowLease requires a non-empty flowId.");
    const pid = ownerPid ?? process.pid, token = ownerStartToken !== undefined ? ownerStartToken : captureProcessStartToken(pid);
    const db = this.writeConn(true)!;
    return db.transaction(() => runAcquireProjectLeaseTx(db, this.dbPath, targetFlowId, pid, token, leaseToken, nowIso())).immediate();
  }

  acquireScopedFlowLease(
    flowId: string, mode: FlowLeaseMode, ownerPid?: number, ownerStartToken?: string | null, leaseToken?: string,
  ): { leaseToken: string; stateVersion: number; leaseKey: string } {
    const targetFlowId = flowId.trim();
    if (!targetFlowId) throw new Error("acquireScopedFlowLease requires a non-empty flowId.");
    const pid = ownerPid ?? process.pid, token = ownerStartToken !== undefined ? ownerStartToken : captureProcessStartToken(pid);
    return this.writeConn(true)!.transaction(() => runAcquireScopedLeaseTx(this.db!, this.dbPath, targetFlowId, mode, pid, token, leaseToken, nowIso())).immediate();
  }
  releaseProjectFlowLease(flowId?: string, expectedLeaseToken?: string | null): boolean {
    if (this.closed) return false;
    const db = this.writeConn(false);
    return db ? releaseScopedLeaseQuery(db, flowId, expectedLeaseToken) : false;
  }
  getProjectFlowLease(flowId?: string): ProjectFlowLease | null {
    const db = this.readConn();
    if (!db || !hasTable(db, "project_leases")) return null;
    const row = flowId ? findFlowLeaseRow(db, flowId) : (db.query("SELECT * FROM project_leases WHERE lease_key = 'active_flow'").get() as LeaseRow | null);
    return row ? toLease(row) : null;
  }
  listActiveFlowLeases(): Array<ProjectFlowLease & { leaseKey: string }> { const db = this.readConn(); return db ? listActiveLeasesQuery(db) : []; }
  appendFlowBoardEvent(flowId: string, entry: Omit<FlowBoardEntry, "seq" | "eventId" | "flowId" | "createdAt"> & { eventId?: string; createdAt?: string }): FlowBoardEntry {
    const db = this.writeConn(false);
    if (!db || !hasTable(db, "flow_runs")) throw new Error(`Unknown flowId "${flowId}".`);
    return db.transaction(() => runAppendBoardEventTx(db, flowId, entry, nowIso())).immediate();
  }
  listFlowBoardEvents(flowId: string, opts?: { afterSeq?: number; seqs?: readonly number[]; limit?: number; target?: string }): FlowBoardEntry[] {
    const db = this.readConn(); return db ? listBoardEventsQuery(db, flowId, opts) : [];
  }

  saveFlowCheckpoint(cp: PersistedFlowCheckpoint, options?: SaveFlowCheckpointOptions): PersistedFlowCheckpoint | null {
    if (this.closed) return null;
    const db = this.writeConn(true)!;
    return db.transaction(() => {
      const strict = options?.expectedLeaseToken !== undefined || options?.expectedStateVersion !== undefined;
      const hasExplicitToken = options?.expectedLeaseToken !== undefined || cp.leaseToken !== undefined;
      const callerToken = options?.expectedLeaseToken !== undefined ? options.expectedLeaseToken : (cp.leaseToken ?? null);
      const activeLease = findFlowLeaseRow(db, cp.flowId);
      const existingRow = db.query("SELECT * FROM flow_runs WHERE flow_id = ?").get(cp.flowId) as Record<string, unknown> | null;
      const leaseLive = Boolean(
        activeLease && (activeLease.owner_pid === process.pid || isProcessAliveWithToken(activeLease.owner_pid, activeLease.owner_start_token)),
      );
      const refuse = (actualTok: string | null, actualPid: number | null, msg?: string): PersistedFlowCheckpoint | null => {
        if (strict) {
          throw new LeaseLostError({ flowId: cp.flowId, expectedLeaseToken: callerToken, actualLeaseToken: actualTok, actualOwnerPid: actualPid, ...(msg ? { message: msg } : {}) });
        }
        return existingRow ? toFlowCheckpoint(existingRow, listFlowSteersQuery(db, cp.flowId)) : null;
      };

      if (options?.expectedLeaseToken !== undefined) {
        if (options.expectedLeaseToken !== null) {
          if (!activeLease || !leaseLive || activeLease.flow_id !== cp.flowId || activeLease.lease_token !== options.expectedLeaseToken) {
            return refuse(activeLease?.lease_token ?? null, activeLease?.owner_pid ?? null);
          }
        } else if (activeLease && leaseLive && activeLease.flow_id === cp.flowId) {
          return refuse(activeLease.lease_token, activeLease.owner_pid);
        }
      } else if (activeLease && leaseLive) {
        if (activeLease.flow_id === cp.flowId) {
          const callerPid = cp.ownerPid ?? process.pid;
          const mismatch = hasExplicitToken && activeLease.lease_token != null
            ? callerToken !== activeLease.lease_token
            : activeLease.owner_pid !== callerPid;
          if (mismatch) return refuse(activeLease.lease_token, activeLease.owner_pid);
        } else if (cp.status === "running") {
          return refuse(activeLease.lease_token, activeLease.owner_pid);
        }
      }

      if (options?.expectedStateVersion !== undefined && existingRow && Number(existingRow.state_version ?? 0) !== options.expectedStateVersion) {
        return refuse(
          String(existingRow.lease_token ?? "") || null,
          existingRow.owner_pid != null ? Number(existingRow.owner_pid) : null,
          `Flow "${cp.flowId}" stateVersion mismatch (expected=${options.expectedStateVersion}, actual=${Number(existingRow.state_version ?? 0)}).`,
        );
      }

      const nextVer = existingRow ? Number(existingRow.state_version ?? 0) + 1 : Math.max(1, cp.stateVersion ?? 1);
      const savedLeaseTok = cp.status === "running"
        ? (callerToken ?? (activeLease?.flow_id === cp.flowId ? activeLease.lease_token : null))
        : null;
      const mergedSteers = mergeSteerLists(cp.userSteers ?? [], listFlowSteersQuery(db, cp.flowId));
      const nextSnap = mergedSteers.length > 0 ? mergeSteersIntoSnapshotJson(cp.snapshotJson, mergedSteers) : cp.snapshotJson;
      const steersJson = cp.userSteers !== undefined || mergedSteers.length > 0 ? JSON.stringify(mergedSteers) : null;

      db.query(
        "INSERT INTO flow_runs (flow_id, mandate_id, goal, cwd, role_chain, status, current_index, repair_round, last_handoff_id, max_repair_rounds, snapshot_json, owner_pid, owner_start_token, lease_token, state_version, next_stage_seq, last_rejection_sig, user_steers, graph_spec_json, machine_state_json, lease_mode, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(flow_id) DO UPDATE SET mandate_id=excluded.mandate_id, goal=excluded.goal, cwd=excluded.cwd, role_chain=excluded.role_chain, status=excluded.status, current_index=excluded.current_index, repair_round=excluded.repair_round, last_handoff_id=excluded.last_handoff_id, max_repair_rounds=excluded.max_repair_rounds, snapshot_json=excluded.snapshot_json, owner_pid=excluded.owner_pid, owner_start_token=excluded.owner_start_token, lease_token=excluded.lease_token, state_version=excluded.state_version, next_stage_seq=excluded.next_stage_seq, last_rejection_sig=excluded.last_rejection_sig, user_steers=excluded.user_steers, graph_spec_json=COALESCE(excluded.graph_spec_json, flow_runs.graph_spec_json), machine_state_json=COALESCE(excluded.machine_state_json, flow_runs.machine_state_json), lease_mode=COALESCE(excluded.lease_mode, flow_runs.lease_mode), updated_at=excluded.updated_at",
      ).run(
        cp.flowId, cp.mandateId, cp.goal, cp.cwd ?? null, JSON.stringify(cp.roleChain), cp.status, cp.currentIndex, cp.repairRound,
        cp.lastHandoffId, cp.maxRepairRounds, nextSnap, cp.ownerPid ?? null, cp.ownerStartToken ?? null, savedLeaseTok, nextVer,
        cp.nextStageSeq ?? null, cp.lastRejectionSig ?? null, steersJson, cp.graphSpecJson ?? null, cp.machineStateJson ?? null, cp.leaseMode ?? null, cp.updatedAt,
      );

      for (const s of cp.userSteers ?? []) {
        const sid = s.steerId?.trim() || `steer-inline-${createHash("sha256").update(`${cp.flowId}\0${s.createdAt}\0${s.targetRole ?? ""}\0${s.text}`).digest("hex").slice(0, 16)}`;
        db.query("INSERT OR IGNORE INTO flow_steers (steer_id, flow_id, text, target_role, created_at, consumed_at, consumed_by_stage) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(sid, cp.flowId, s.text, s.targetRole ?? null, s.createdAt, s.consumedAt ?? null, s.consumedByStage ?? null);
      }

      if (cp.status !== "running" && activeLease && activeLease.flow_id === cp.flowId) {
        const canRelease = hasExplicitToken ? activeLease.lease_token === callerToken : activeLease.owner_pid === process.pid;
        if (canRelease) releaseScopedLeaseQuery(db, cp.flowId, hasExplicitToken ? callerToken : undefined);
      }
      db.query("DELETE FROM flow_runs WHERE status != 'running' AND flow_id NOT IN (SELECT flow_id FROM flow_runs ORDER BY updated_at DESC, rowid DESC LIMIT ?)").run(MAX_ARCHIVED_FLOW_RUNS);
      const row = db.query("SELECT * FROM flow_runs WHERE flow_id = ?").get(cp.flowId) as Record<string, unknown>;
      return toFlowCheckpoint(row, listFlowSteersQuery(db, cp.flowId));
    }).immediate();
  }

  appendFlowSteer(flowId: string, steer: { steerId?: string; text: string; targetRole?: string | null; createdAt?: string }): FlowUserSteer {
    const db = this.writeConn(false);
    if (!db || !hasTable(db, "flow_runs")) throw new Error(`Unknown flowId "${flowId}".`);
    return db.transaction(() => runAppendFlowSteerTx(db, flowId, steer, nowIso())).immediate();
  }

  listFlowSteers(flowId: string, opts?: { afterSeq?: number; unconsumedOnly?: boolean }): FlowUserSteer[] {
    const db = this.readConn();
    return db ? listFlowSteersQuery(db, flowId, opts) : [];
  }

  markFlowSteersConsumed(flowId: string, steerIds: readonly string[], stageId: string): number {
    const ids = [...new Set(steerIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0 || this.closed) return 0;
    const db = this.writeConn(false);
    if (!db || !hasTable(db, "flow_steers")) return 0;
    return db.transaction(() => {
      const ts = nowIso();
      const stmt = db.query("UPDATE flow_steers SET consumed_at = ?, consumed_by_stage = ? WHERE flow_id = ? AND steer_id = ? AND consumed_at IS NULL");
      let count = 0;
      for (const sid of ids) count += stmt.run(ts, stageId, flowId, sid).changes;
      return count;
    }).immediate();
  }

  appendFlowCheckpointSteer(flowId: string, steer: FlowUserSteer): PersistedFlowCheckpoint {
    this.appendFlowSteer(flowId, steer);
    return this.getFlowCheckpoint(flowId)!;
  }

  cancelFlowCheckpoint(
    flowId: string, expectedLeaseToken?: string | null,
  ): { cancelled: boolean; checkpoint: PersistedFlowCheckpoint | null; reason?: string } {
    const ro = this.readConn();
    if (!ro || !hasTable(ro, "flow_runs")) return { cancelled: false, checkpoint: null, reason: `Unknown flowId "${flowId}".` };
    const db = this.writeConn(false)!;
    return db.transaction(() => runCancelCheckpointTx(db, flowId, nowIso(), expectedLeaseToken)).immediate();
  }

  releaseFlowOwnership(flowId?: string | null, ownerPid?: number, expectedLeaseToken?: string | null): void {
    if (this.closed) return;
    const db = this.writeConn(false);
    if (!db) return;
    db.transaction(() => {
      if (flowId) {
        if (expectedLeaseToken !== undefined) {
          db.query("UPDATE flow_runs SET owner_pid = NULL, owner_start_token = NULL, lease_token = NULL WHERE flow_id = ? AND status = 'running' AND lease_token IS ?").run(flowId, expectedLeaseToken);
          if (hasTable(db, "project_leases")) db.query("DELETE FROM project_leases WHERE lease_key = 'active_flow' AND flow_id = ? AND lease_token IS ?").run(flowId, expectedLeaseToken);
        } else {
          db.query("UPDATE flow_runs SET owner_pid = NULL, owner_start_token = NULL, lease_token = NULL WHERE flow_id = ? AND status = 'running'").run(flowId);
          if (hasTable(db, "project_leases")) db.query("DELETE FROM project_leases WHERE lease_key = 'active_flow' AND flow_id = ?").run(flowId);
        }
      } else if (ownerPid !== undefined) {
        db.query("UPDATE flow_runs SET owner_pid = NULL, owner_start_token = NULL, lease_token = NULL WHERE owner_pid = ? AND status = 'running'").run(ownerPid);
        if (hasTable(db, "project_leases")) db.query("DELETE FROM project_leases WHERE lease_key = 'active_flow' AND owner_pid = ?").run(ownerPid);
      }
    }).immediate();
  }

  getFlowCheckpoint(flowId: string): PersistedFlowCheckpoint | null {
    const db = this.readConn();
    const row = db && hasTable(db, "flow_runs") ? (db.query("SELECT * FROM flow_runs WHERE flow_id = ?").get(flowId) as Record<string, unknown> | null) : null;
    return row && db ? toFlowCheckpoint(row, listFlowSteersQuery(db, flowId)) : null;
  }

  getLatestFlowCheckpoint(): PersistedFlowCheckpoint | null {
    const db = this.readConn();
    const row = db && hasTable(db, "flow_runs") ? (db.query("SELECT * FROM flow_runs ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as Record<string, unknown> | null) : null;
    return row && db ? toFlowCheckpoint(row, listFlowSteersQuery(db, String(row.flow_id))) : null;
  }

  listFlowCheckpoints(limit = 50): PersistedFlowCheckpoint[] {
    const db = this.readConn();
    return db && hasTable(db, "flow_runs")
      ? (db.query("SELECT * FROM flow_runs ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(limit > 0 ? limit : -1) as Array<Record<string, unknown>>)
          .map((r) => toFlowCheckpoint(r, listFlowSteersQuery(db, String(r.flow_id))))
      : [];
  }
}
