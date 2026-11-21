import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  ArtifactRecord, BackgroundJob, EpistemicItem, EpistemicKind, EpistemicStatus,
  FlowUserSteer, HandoffEnvelope, JobStatus, Mandate, MandateStatus, PersistedFlowCheckpoint,
} from "./types.ts";

export type { PersistedFlowCheckpoint } from "./types.ts";

const nowIso = (): string => new Date().toISOString();
const MAX_ARCHIVED_FLOW_RUNS = 50;

function safeParseArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try { const p: unknown = JSON.parse(raw); return Array.isArray(p) ? (p as T[]) : []; } catch { return []; }
}

function safeParseObject<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    const p: unknown = JSON.parse(raw);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as T) : null;
  } catch { return null; }
}

/** Capture OS process start-time token (`starttime` on Linux `/proc`, `ps lstart=` on macOS/BSD). */
export function captureProcessStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const procStatPath = `/proc/${pid}/stat`;
  if (existsSync(procStatPath)) {
    try {
      const stat = readFileSync(procStatPath, "utf8"), closeParen = stat.lastIndexOf(")");
      if (closeParen > 0) {
        const f = stat.slice(closeParen + 2).trim().split(/\s+/);
        if (f[19]) return `proc:${f[19]}`;
      }
    } catch { return null; }
  }
  try {
    const res = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1_500 });
    const token = res.status === 0 ? res.stdout.trim() : "";
    return token ? `ps:${token}` : null;
  } catch { return null; }
}

/** Verify both PID existence and start-time identity to prevent PID-reuse false positives. */
export function isProcessAliveWithToken(pid: number, expectedToken?: string | null): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM" && expectedToken) {
      return captureProcessStartToken(pid) === expectedToken;
    }
    return false;
  }
  return !expectedToken || captureProcessStartToken(pid) === expectedToken;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mandates (id TEXT PRIMARY KEY, rev INTEGER NOT NULL, goal TEXT NOT NULL,
  constraints TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT, flow_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS epistemic_items (id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'hypothesis', 'inquiry', 'decision')), statement TEXT NOT NULL,
  evidence_ref TEXT, verification_plan TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
  CHECK (kind != 'fact' OR (evidence_ref IS NOT NULL AND length(trim(evidence_ref)) > 0)));
CREATE TABLE IF NOT EXISTS artifacts (artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE,
  path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, role TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE (mandate_id, path, sha256));
CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE,
  mandate_rev INTEGER NOT NULL, parent_handoff_id TEXT, from_role TEXT NOT NULL, to_target TEXT NOT NULL,
  verdict TEXT NOT NULL, summary TEXT NOT NULL, artifacts TEXT NOT NULL, deleted_files TEXT,
  verified_facts TEXT NOT NULL, open_risks TEXT NOT NULL, feedback_for_upstream TEXT,
  observed_usage TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY,
  mandate_id TEXT REFERENCES mandates(id) ON DELETE SET NULL, hypothesis_id TEXT,
  command TEXT NOT NULL, cwd TEXT NOT NULL, pid INTEGER NOT NULL, pgid INTEGER NOT NULL,
  owner_pid INTEGER, process_start_token TEXT, log_path TEXT NOT NULL, exit_file_path TEXT NOT NULL,
  status TEXT NOT NULL, exit_code INTEGER, started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS flow_runs (flow_id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE, goal TEXT NOT NULL,
  role_chain TEXT NOT NULL, status TEXT NOT NULL, current_index INTEGER NOT NULL, repair_round INTEGER NOT NULL,
  last_handoff_id TEXT, max_repair_rounds INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
  owner_pid INTEGER, owner_start_token TEXT, next_stage_seq INTEGER, last_rejection_sig TEXT,
  user_steers TEXT, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_mandates_status_updated ON mandates(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_epistemic_mandate ON epistemic_items(mandate_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_artifacts_mandate_path ON artifacts(mandate_id, path ASC);
CREATE INDEX IF NOT EXISTS idx_handoffs_mandate_created ON handoffs(mandate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status_started ON jobs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_flow_runs_updated ON flow_runs(updated_at DESC);`;

const MIGRATIONS: ReadonlyArray<[table: string, column: string, ddl: string]> = [
  ["mandates", "session_id", "TEXT"], ["mandates", "flow_id", "TEXT"], ["handoffs", "deleted_files", "TEXT"],
  ["jobs", "owner_pid", "INTEGER"], ["jobs", "process_start_token", "TEXT"],
  ["flow_runs", "owner_pid", "INTEGER"], ["flow_runs", "owner_start_token", "TEXT"],
  ["flow_runs", "next_stage_seq", "INTEGER"], ["flow_runs", "last_rejection_sig", "TEXT"],
  ["flow_runs", "user_steers", "TEXT"],
];

export interface MandateScope { sessionId?: string | null; flowId?: string | null }

interface MandateRow {
  id: string; rev: number; goal: string; constraints: string; acceptance: string;
  status: MandateStatus; session_id: string | null; flow_id: string | null; created_at: string; updated_at: string;
}
interface EpistemicRow {
  id: string; mandate_id: string; kind: EpistemicKind; statement: string;
  evidence_ref: string | null; verification_plan: string | null; status: EpistemicStatus; created_at: string;
}
interface ArtifactRow { path: string; sha256: string; byte_size: number; role: ArtifactRecord["role"] }
interface HandoffRow {
  id: string; mandate_id: string; mandate_rev: number; parent_handoff_id: string | null;
  from_role: string; to_target: string; verdict: HandoffEnvelope["verdict"]; summary: string;
  artifacts: string; deleted_files: string | null; verified_facts: string; open_risks: string;
  feedback_for_upstream: string | null; observed_usage: string | null; created_at: string;
}
interface JobRow {
  job_id: string; mandate_id: string | null; hypothesis_id: string | null; command: string; cwd: string;
  pid: number; pgid: number; owner_pid: number | null; process_start_token: string | null;
  log_path: string; exit_file_path: string; status: JobStatus; exit_code: number | null;
  started_at: string; ended_at: string | null;
}

const toMandate = (r: MandateRow): Mandate => ({
  id: r.id, rev: r.rev, goal: r.goal,
  constraints: safeParseArray(r.constraints), acceptance: safeParseArray(r.acceptance), status: r.status,
  ...(r.session_id ? { sessionId: r.session_id } : {}), ...(r.flow_id ? { flowId: r.flow_id } : {}),
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const toEpistemicItem = (r: EpistemicRow): EpistemicItem => ({
  id: r.id, mandateId: r.mandate_id, kind: r.kind, statement: r.statement,
  evidenceRef: r.evidence_ref, verificationPlan: r.verification_plan, status: r.status, createdAt: r.created_at,
});
const toArtifact = (r: ArtifactRow): ArtifactRecord => ({
  path: r.path, sha256: r.sha256, byteSize: r.byte_size, role: r.role,
});
const toHandoff = (r: HandoffRow): HandoffEnvelope => {
  const deletedFiles = r.deleted_files !== null ? safeParseArray<string>(r.deleted_files) : undefined;
  return {
    id: r.id, mandateId: r.mandate_id, mandateRev: r.mandate_rev, parentHandoffId: r.parent_handoff_id,
    fromRole: r.from_role, toTarget: r.to_target, verdict: r.verdict, summary: r.summary,
    artifacts: safeParseArray(r.artifacts), ...(deletedFiles !== undefined ? { deletedFiles } : {}),
    verifiedFacts: safeParseArray(r.verified_facts), openRisks: safeParseArray(r.open_risks),
    feedbackForUpstream: r.feedback_for_upstream,
    observedUsage: safeParseObject<NonNullable<HandoffEnvelope["observedUsage"]>>(r.observed_usage),
    createdAt: r.created_at,
  };
};
const toJob = (r: JobRow): BackgroundJob => ({
  jobId: r.job_id, mandateId: r.mandate_id, hypothesisId: r.hypothesis_id, command: r.command, cwd: r.cwd,
  pid: r.pid, pgid: r.pgid,
  ...(r.owner_pid != null ? { ownerPid: r.owner_pid } : {}),
  ...(r.process_start_token != null ? { processStartToken: r.process_start_token } : {}),
  logPath: r.log_path, exitFilePath: r.exit_file_path, status: r.status,
  exitCode: r.exit_code, startedAt: r.started_at, endedAt: r.ended_at,
});
const toFlowCheckpoint = (row: Record<string, unknown>): PersistedFlowCheckpoint => ({
  flowId: String(row.flow_id), mandateId: String(row.mandate_id), goal: String(row.goal),
  roleChain: safeParseArray<string>(String(row.role_chain ?? "[]")), status: String(row.status),
  currentIndex: Number(row.current_index), repairRound: Number(row.repair_round),
  lastHandoffId: row.last_handoff_id ? String(row.last_handoff_id) : null,
  maxRepairRounds: Number(row.max_repair_rounds), snapshotJson: String(row.snapshot_json ?? "{}"),
  updatedAt: String(row.updated_at),
  ...(row.owner_pid != null ? { ownerPid: Number(row.owner_pid) } : {}),
  ...(row.owner_start_token != null ? { ownerStartToken: String(row.owner_start_token) } : {}),
  ...(row.next_stage_seq != null ? { nextStageSeq: Number(row.next_stage_seq) } : {}),
  ...(row.last_rejection_sig != null ? { lastRejectionSig: String(row.last_rejection_sig) } : {}),
  ...(row.user_steers != null ? { userSteers: safeParseArray<FlowUserSteer>(String(row.user_steers)) } : {}),
});

export class EnhanceStore {
  private db: Database | null = null;
  private closed = false;

  constructor(readonly dbPath: string) {}

  isClosed(): boolean { return this.closed; }
  reopen(): void { this.closed = false; }
  close(): void { this.closed = true; try { this.db?.close(); } catch {} this.db = null; }

  private migrateSchema(db: Database): void {
    const colsByTable = new Map<string, Set<string>>();
    for (const [table, col, ddl] of MIGRATIONS) {
      let cols = colsByTable.get(table);
      if (!cols) {
        const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        cols = new Set(rows.map((r) => r.name));
        colsByTable.set(table, cols);
      }
      if (!cols.has(col)) { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); cols.add(col); }
    }
  }

  private conn(create: boolean): Database | null {
    if (this.closed) { if (!create) return null; throw new Error("EnhanceStore is closed."); }
    if (this.db) return this.db;
    if (!create && !existsSync(this.dbPath)) return null;
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrateSchema(this.db);
    return this.db;
  }

  upsertMandate(input: {
    id?: string; goal: string; constraints?: string[]; acceptance?: string[];
    status?: MandateStatus; sessionId?: string | null; flowId?: string | null;
  }): Mandate {
    const db = this.conn(true)!;
    return db.transaction(() => {
      const existingRow = input.id ? (db.query("SELECT * FROM mandates WHERE id = ?").get(input.id) as MandateRow | null) : null;
      const ts = nowIso();
      if (!existingRow) {
        const id = input.id ?? randomUUID(), status = input.status ?? "active";
        const sessionId = input.sessionId ?? null, flowId = input.flowId ?? null;
        if (status === "active") {
          if (flowId) db.query("UPDATE mandates SET status = 'archived', updated_at = ? WHERE status = 'active' AND flow_id = ?").run(ts, flowId);
          else if (sessionId) db.query("UPDATE mandates SET status = 'archived', updated_at = ? WHERE status = 'active' AND flow_id IS NULL AND (session_id IS NULL OR session_id = ?)").run(ts, sessionId);
          else db.query("UPDATE mandates SET status = 'archived', updated_at = ? WHERE status = 'active' AND flow_id IS NULL").run(ts);
        }
        db.query("INSERT INTO mandates (id, rev, goal, constraints, acceptance, status, session_id, flow_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, 1, input.goal, JSON.stringify(input.constraints ?? []), JSON.stringify(input.acceptance ?? []), status, sessionId, flowId, ts, ts);
        return toMandate(db.query("SELECT * FROM mandates WHERE id = ?").get(id) as MandateRow);
      }
      const existing = toMandate(existingRow);
      const constraints = input.constraints ?? existing.constraints, acceptance = input.acceptance ?? existing.acceptance;
      const status = input.status ?? existing.status;
      const sessionId = input.sessionId === undefined ? (existingRow.session_id ?? null) : input.sessionId;
      const flowId = input.flowId === undefined ? (existingRow.flow_id ?? null) : input.flowId;
      const changed = input.goal !== existing.goal
        || JSON.stringify(constraints) !== JSON.stringify(existing.constraints)
        || JSON.stringify(acceptance) !== JSON.stringify(existing.acceptance);
      const rev = changed ? existing.rev + 1 : existing.rev;
      db.query("UPDATE mandates SET rev = ?, goal = ?, constraints = ?, acceptance = ?, status = ?, session_id = ?, flow_id = ?, updated_at = ? WHERE id = ?")
        .run(rev, input.goal, JSON.stringify(constraints), JSON.stringify(acceptance), status, sessionId, flowId, ts, existing.id);
      return toMandate(db.query("SELECT * FROM mandates WHERE id = ?").get(existing.id) as MandateRow);
    }).immediate();
  }

  completeMandate(id: string): Mandate | null {
    const db = this.conn(false);
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
    const db = this.conn(false);
    if (!db) return null;
    if (scope?.flowId) {
      const row = db.query("SELECT * FROM mandates WHERE status = 'active' AND flow_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1")
        .get(scope.flowId) as MandateRow | null;
      return row ? toMandate(row) : null;
    }
    if (scope?.sessionId) {
      const row = db.query(
        "SELECT * FROM mandates WHERE status = 'active' AND flow_id IS NULL AND (session_id = ? OR session_id IS NULL) ORDER BY CASE WHEN session_id = ? THEN 0 ELSE 1 END, updated_at DESC, rowid DESC LIMIT 1",
      ).get(scope.sessionId, scope.sessionId) as MandateRow | null;
      return row ? toMandate(row) : null;
    }
    const row = db.query("SELECT * FROM mandates WHERE status = 'active' ORDER BY updated_at DESC, rowid DESC LIMIT 1")
      .get() as MandateRow | null;
    return row ? toMandate(row) : null;
  }

  getMandate(id: string): Mandate | null {
    const db = this.conn(false);
    const row = db ? (db.query("SELECT * FROM mandates WHERE id = ?").get(id) as MandateRow | null) : null;
    return row ? toMandate(row) : null;
  }

  addEpistemicItem(input: {
    mandateId: string; kind: EpistemicKind; statement: string; evidenceRef?: string | null;
    verificationPlan?: string | null; status?: EpistemicStatus;
  }): EpistemicItem {
    const evidenceRef = input.evidenceRef?.trim() || null;
    if (input.kind === "fact" && !evidenceRef) throw new Error("Epistemic item of kind 'fact' requires a non-empty evidenceRef.");
    const item: EpistemicItem = {
      id: randomUUID(), mandateId: input.mandateId, kind: input.kind, statement: input.statement,
      evidenceRef, verificationPlan: input.verificationPlan?.trim() || null, status: input.status ?? "open", createdAt: nowIso(),
    };
    this.conn(true)!.query(
      "INSERT INTO epistemic_items (id, mandate_id, kind, statement, evidence_ref, verification_plan, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(item.id, item.mandateId, item.kind, item.statement, item.evidenceRef, item.verificationPlan, item.status, item.createdAt);
    return item;
  }

  updateEpistemicStatus(id: string, status: EpistemicStatus, evidenceRef?: string | null): EpistemicItem {
    const db = this.conn(false);
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
    const db = this.conn(false);
    return db ? (db.query("SELECT * FROM epistemic_items WHERE mandate_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(mandateId) as EpistemicRow[]).map(toEpistemicItem) : [];
  }

  recordArtifacts(mandateId: string, artifacts: readonly ArtifactRecord[]): void {
    if (artifacts.length === 0) return;
    const db = this.conn(true)!;
    db.transaction(() => {
      const stmt = db.query("INSERT OR IGNORE INTO artifacts (mandate_id, path, sha256, byte_size, role, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      const ts = nowIso();
      for (const a of artifacts) stmt.run(mandateId, a.path, a.sha256, a.byteSize, a.role, ts);
    }).immediate();
  }

  listArtifacts(mandateId: string): ArtifactRecord[] {
    const db = this.conn(false);
    return db ? db.query(
      "SELECT path, sha256, byte_size, role FROM artifacts WHERE artifact_id IN (SELECT MAX(artifact_id) FROM artifacts WHERE mandate_id = ? GROUP BY path) ORDER BY path ASC",
    ).all(mandateId).map((row) => toArtifact(row as ArtifactRow)) : [];
  }

  saveHandoff(envelope: HandoffEnvelope): void {
    this.conn(true)!.query(
      "INSERT OR REPLACE INTO handoffs (id, mandate_id, mandate_rev, parent_handoff_id, from_role, to_target, verdict, summary, artifacts, deleted_files, verified_facts, open_risks, feedback_for_upstream, observed_usage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      envelope.id, envelope.mandateId, envelope.mandateRev, envelope.parentHandoffId, envelope.fromRole,
      envelope.toTarget, envelope.verdict, envelope.summary, JSON.stringify(envelope.artifacts),
      envelope.deletedFiles !== undefined ? JSON.stringify(envelope.deletedFiles) : null,
      JSON.stringify(envelope.verifiedFacts), JSON.stringify(envelope.openRisks), envelope.feedbackForUpstream,
      envelope.observedUsage ? JSON.stringify(envelope.observedUsage) : null, envelope.createdAt,
    );
  }

  getHandoff(id: string): HandoffEnvelope | null {
    const db = this.conn(false), row = db ? (db.query("SELECT * FROM handoffs WHERE id = ?").get(id) as HandoffRow | null) : null;
    return row ? toHandoff(row) : null;
  }

  getLatestHandoff(mandateId?: string): HandoffEnvelope | null {
    const db = this.conn(false);
    const row = db ? (db.query("SELECT * FROM handoffs WHERE (? IS NULL OR mandate_id = ?) ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(mandateId ?? null, mandateId ?? null) as HandoffRow | null) : null;
    return row ? toHandoff(row) : null;
  }

  listHandoffs(mandateId?: string, limit?: number): HandoffEnvelope[] {
    const db = this.conn(false);
    return db ? (db.query("SELECT * FROM handoffs WHERE (? IS NULL OR mandate_id = ?) ORDER BY created_at DESC, rowid DESC LIMIT COALESCE(?, -1)")
      .all(mandateId ?? null, mandateId ?? null, limit ?? null) as HandoffRow[]).map(toHandoff) : [];
  }

  saveJob(job: BackgroundJob): void {
    this.conn(true)!.query(
      "INSERT OR REPLACE INTO jobs (job_id, mandate_id, hypothesis_id, command, cwd, pid, pgid, owner_pid, process_start_token, log_path, exit_file_path, status, exit_code, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      job.jobId, job.mandateId, job.hypothesisId, job.command, job.cwd, job.pid, job.pgid,
      job.ownerPid ?? null, job.processStartToken ?? null, job.logPath, job.exitFilePath,
      job.status, job.exitCode, job.startedAt, job.endedAt,
    );
  }

  transitionJobStatus(
    jobId: string,
    expectedStatuses: readonly JobStatus[],
    patch: { status: JobStatus; exitCode?: number | null; endedAt?: string | null },
  ): BackgroundJob | null {
    const db = this.conn(false);
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
    const db = this.conn(false), row = db ? (db.query("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | null) : null;
    return row ? toJob(row) : null;
  }

  listJobs(status?: JobStatus, limit = 200): BackgroundJob[] {
    const db = this.conn(false);
    return db ? db.query("SELECT * FROM jobs WHERE (? IS NULL OR status = ?) ORDER BY started_at DESC, rowid DESC LIMIT ?")
      .all(status ?? null, status ?? null, limit > 0 ? limit : -1).map((row) => toJob(row as JobRow)) : [];
  }

  saveFlowCheckpoint(cp: PersistedFlowCheckpoint): void {
    if (this.closed) return;
    const db = this.conn(true)!;
    db.transaction(() => {
      db.query("INSERT OR REPLACE INTO flow_runs (flow_id, mandate_id, goal, role_chain, status, current_index, repair_round, last_handoff_id, max_repair_rounds, snapshot_json, owner_pid, owner_start_token, next_stage_seq, last_rejection_sig, user_steers, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(cp.flowId, cp.mandateId, cp.goal, JSON.stringify(cp.roleChain), cp.status, cp.currentIndex, cp.repairRound, cp.lastHandoffId, cp.maxRepairRounds, cp.snapshotJson, cp.ownerPid ?? null, cp.ownerStartToken ?? null, cp.nextStageSeq ?? null, cp.lastRejectionSig ?? null, cp.userSteers !== undefined ? JSON.stringify(cp.userSteers) : null, cp.updatedAt);
      db.query("DELETE FROM flow_runs WHERE status != 'running' AND flow_id NOT IN (SELECT flow_id FROM flow_runs ORDER BY updated_at DESC, rowid DESC LIMIT ?)").run(MAX_ARCHIVED_FLOW_RUNS);
    }).immediate();
  }

  releaseFlowOwnership(flowId?: string | null, ownerPid?: number): void {
    if (this.closed) return;
    const db = this.conn(false);
    if (!db) return;
    if (flowId) db.query("UPDATE flow_runs SET owner_pid = NULL, owner_start_token = NULL WHERE flow_id = ? AND status = 'running'").run(flowId);
    else if (ownerPid !== undefined) db.query("UPDATE flow_runs SET owner_pid = NULL, owner_start_token = NULL WHERE owner_pid = ? AND status = 'running'").run(ownerPid);
  }

  getFlowCheckpoint(flowId: string): PersistedFlowCheckpoint | null {
    const db = this.conn(false);
    const row = db ? (db.query("SELECT * FROM flow_runs WHERE flow_id = ?").get(flowId) as Record<string, unknown> | null) : null;
    return row ? toFlowCheckpoint(row) : null;
  }

  getLatestFlowCheckpoint(): PersistedFlowCheckpoint | null {
    const db = this.conn(false);
    const row = db ? (db.query("SELECT * FROM flow_runs ORDER BY updated_at DESC, rowid DESC LIMIT 1")
      .get() as Record<string, unknown> | null) : null;
    return row ? toFlowCheckpoint(row) : null;
  }
}
