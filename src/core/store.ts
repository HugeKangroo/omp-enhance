import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type ArtifactRow, captureProcessStartToken, type EpistemicRow, type HandoffRow, hasCol, hasTable,
  isProcessAliveWithToken, type JobRow, type LeaseRow, type MandateRow, type MandateScope,
  MAX_ARCHIVED_FLOW_RUNS, MIGRATIONS, ProjectBusyError, type ProjectFlowLease,
  runAcquireProjectLeaseTx, runAppendSteerTx, runCancelCheckpointTx, runUpsertMandateTx,
  SCHEMA_INDEXES, SCHEMA_TABLES, toArtifact, toEpistemicItem, toFlowCheckpoint, toHandoff, toJob, toLease, toMandate,
} from "./store-schema.ts";
import type {
  ArtifactRecord, BackgroundJob, EpistemicItem, EpistemicKind, EpistemicStatus,
  FlowUserSteer, HandoffEnvelope, JobStatus, Mandate, MandateStatus, PersistedFlowCheckpoint,
} from "./types.ts";

export {
  captureProcessStartToken, isProcessAliveWithToken, type MandateScope, ProjectBusyError, type ProjectFlowLease,
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
    for (const [table, col, ddl] of MIGRATIONS) {
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
    this.db.exec(SCHEMA_TABLES); this.migrateSchema(this.db); this.db.exec(SCHEMA_INDEXES);
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
      "INSERT OR REPLACE INTO handoffs (id, mandate_id, mandate_rev, parent_handoff_id, from_role, to_target, verdict, summary, artifacts, deleted_files, verified_facts, open_risks, questions_for_user, feedback_for_upstream, observed_usage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      envelope.id, envelope.mandateId, envelope.mandateRev, envelope.parentHandoffId, envelope.fromRole,
      envelope.toTarget, envelope.verdict, envelope.summary, JSON.stringify(envelope.artifacts),
      envelope.deletedFiles !== undefined ? JSON.stringify(envelope.deletedFiles) : null,
      JSON.stringify(envelope.verifiedFacts), JSON.stringify(envelope.openRisks),
      envelope.questionsForUser !== undefined ? JSON.stringify(envelope.questionsForUser) : null,
      envelope.feedbackForUpstream, envelope.observedUsage ? JSON.stringify(envelope.observedUsage) : null, envelope.createdAt,
    );
  }

  getHandoff(id: string): HandoffEnvelope | null {
    const db = this.readConn(), row = db && hasTable(db, "handoffs") ? (db.query("SELECT * FROM handoffs WHERE id = ?").get(id) as HandoffRow | null) : null;
    return row ? toHandoff(row) : null;
  }

  getLatestHandoff(mandateId?: string): HandoffEnvelope | null {
    const db = this.readConn();
    const row = db && hasTable(db, "handoffs") ? (db.query("SELECT * FROM handoffs WHERE (? IS NULL OR mandate_id = ?) ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(mandateId ?? null, mandateId ?? null) as HandoffRow | null) : null;
    return row ? toHandoff(row) : null;
  }

  listHandoffs(mandateId?: string, limit?: number): HandoffEnvelope[] {
    const db = this.readConn();
    return db && hasTable(db, "handoffs") ? (db.query("SELECT * FROM handoffs WHERE (? IS NULL OR mandate_id = ?) ORDER BY created_at DESC, rowid DESC LIMIT COALESCE(?, -1)")
      .all(mandateId ?? null, mandateId ?? null, limit ?? null) as HandoffRow[]).map(toHandoff) : [];
  }

  saveJob(job: BackgroundJob): void {
    this.writeConn(true)!.query(
      "INSERT OR REPLACE INTO jobs (job_id, mandate_id, hypothesis_id, command, cwd, pid, pgid, owner_pid, process_start_token, log_path, exit_file_path, status, exit_code, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      job.jobId, job.mandateId, job.hypothesisId, job.command, job.cwd, job.pid, job.pgid,
      job.ownerPid ?? null, job.processStartToken ?? null, job.logPath, job.exitFilePath,
      job.status, job.exitCode, job.startedAt, job.endedAt,
    );
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

  listJobs(status?: JobStatus, limit = 200): BackgroundJob[] {
    const db = this.readConn();
    return db && hasTable(db, "jobs") ? db.query("SELECT * FROM jobs WHERE (? IS NULL OR status = ?) ORDER BY started_at DESC, rowid DESC LIMIT ?")
      .all(status ?? null, status ?? null, limit > 0 ? limit : -1).map((row) => toJob(row as JobRow)) : [];
  }

  acquireProjectFlowLease(flowId: string, ownerPid?: number, ownerStartToken?: string | null): void {
    const targetFlowId = flowId.trim();
    if (!targetFlowId) throw new Error("acquireProjectFlowLease requires a non-empty flowId.");
    const pid = ownerPid ?? process.pid, token = ownerStartToken !== undefined ? ownerStartToken : captureProcessStartToken(pid);
    const db = this.writeConn(true)!;
    db.transaction(() => runAcquireProjectLeaseTx(db, this.dbPath, targetFlowId, pid, token, nowIso())).immediate();
  }

  releaseProjectFlowLease(flowId?: string): void {
    if (this.closed) return;
    const db = this.writeConn(false);
    if (!db || !hasTable(db, "project_leases")) return;
    if (flowId) db.query("DELETE FROM project_leases WHERE lease_key = 'active_flow' AND flow_id = ?").run(flowId);
    else db.query("DELETE FROM project_leases WHERE lease_key = 'active_flow'").run();
  }

  getProjectFlowLease(): ProjectFlowLease | null {
    const db = this.readConn();
    const row = db && hasTable(db, "project_leases") ? (db.query("SELECT * FROM project_leases WHERE lease_key = 'active_flow'").get() as LeaseRow | null) : null;
    return row ? toLease(row) : null;
  }

  saveFlowCheckpoint(cp: PersistedFlowCheckpoint): void {
    if (this.closed) return;
    const db = this.writeConn(true)!;
    db.transaction(() => {
      db.query("INSERT OR REPLACE INTO flow_runs (flow_id, mandate_id, goal, cwd, role_chain, status, current_index, repair_round, last_handoff_id, max_repair_rounds, snapshot_json, owner_pid, owner_start_token, next_stage_seq, last_rejection_sig, user_steers, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(cp.flowId, cp.mandateId, cp.goal, cp.cwd ?? null, JSON.stringify(cp.roleChain), cp.status, cp.currentIndex, cp.repairRound, cp.lastHandoffId, cp.maxRepairRounds, cp.snapshotJson, cp.ownerPid ?? null, cp.ownerStartToken ?? null, cp.nextStageSeq ?? null, cp.lastRejectionSig ?? null, cp.userSteers !== undefined ? JSON.stringify(cp.userSteers) : null, cp.updatedAt);
      if (cp.status !== "running") db.query("DELETE FROM project_leases WHERE lease_key = 'active_flow' AND flow_id = ?").run(cp.flowId);
      db.query("DELETE FROM flow_runs WHERE status != 'running' AND flow_id NOT IN (SELECT flow_id FROM flow_runs ORDER BY updated_at DESC, rowid DESC LIMIT ?)").run(MAX_ARCHIVED_FLOW_RUNS);
    }).immediate();
  }

  appendFlowCheckpointSteer(flowId: string, steer: FlowUserSteer): PersistedFlowCheckpoint {
    const db = this.writeConn(false);
    if (!db || !hasTable(db, "flow_runs")) throw new Error(`Unknown flowId "${flowId}".`);
    return db.transaction(() => runAppendSteerTx(db, flowId, steer, nowIso())).immediate();
  }

  cancelFlowCheckpoint(flowId: string): { cancelled: boolean; checkpoint: PersistedFlowCheckpoint | null; reason?: string } {
    const ro = this.readConn();
    if (!ro || !hasTable(ro, "flow_runs")) return { cancelled: false, checkpoint: null, reason: `Unknown flowId "${flowId}".` };
    const db = this.writeConn(false)!;
    return db.transaction(() => runCancelCheckpointTx(db, flowId, nowIso())).immediate();
  }

  releaseFlowOwnership(flowId?: string | null, ownerPid?: number): void {
    if (this.closed) return;
    const db = this.writeConn(false);
    if (!db) return;
    db.transaction(() => {
      if (flowId) {
        db.query("UPDATE flow_runs SET owner_pid = NULL, owner_start_token = NULL WHERE flow_id = ? AND status = 'running'").run(flowId);
        if (hasTable(db, "project_leases")) db.query("DELETE FROM project_leases WHERE lease_key = 'active_flow' AND flow_id = ?").run(flowId);
      } else if (ownerPid !== undefined) {
        db.query("UPDATE flow_runs SET owner_pid = NULL, owner_start_token = NULL WHERE owner_pid = ? AND status = 'running'").run(ownerPid);
        if (hasTable(db, "project_leases")) db.query("DELETE FROM project_leases WHERE lease_key = 'active_flow' AND owner_pid = ?").run(ownerPid);
      }
    }).immediate();
  }

  getFlowCheckpoint(flowId: string): PersistedFlowCheckpoint | null {
    const db = this.readConn();
    const row = db && hasTable(db, "flow_runs") ? (db.query("SELECT * FROM flow_runs WHERE flow_id = ?").get(flowId) as Record<string, unknown> | null) : null;
    return row ? toFlowCheckpoint(row) : null;
  }

  getLatestFlowCheckpoint(): PersistedFlowCheckpoint | null {
    const db = this.readConn();
    const row = db && hasTable(db, "flow_runs") ? (db.query("SELECT * FROM flow_runs ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as Record<string, unknown> | null) : null;
    return row ? toFlowCheckpoint(row) : null;
  }

  listFlowCheckpoints(limit = 50): PersistedFlowCheckpoint[] {
    const db = this.readConn();
    return db && hasTable(db, "flow_runs")
      ? (db.query("SELECT * FROM flow_runs ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(limit > 0 ? limit : -1) as Array<Record<string, unknown>>).map(toFlowCheckpoint)
      : [];
  }
}
