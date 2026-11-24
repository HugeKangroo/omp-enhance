import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  ArtifactDigestKind, ArtifactRecord, BackgroundJob, EpistemicItem, EpistemicKind, EpistemicStatus,
  FlowStageTrace, FlowUserSteer, HandoffEnvelope, JobStatus, Mandate, MandateStatus,
  PersistedFlowCheckpoint, RoomEntry,
} from "./types.ts";

export const MAX_ARCHIVED_FLOW_RUNS = 50;
export const STEERABLE_FLOW_STATUSES: ReadonlySet<string> = new Set(["running", "waiting_input", "interrupted", "failed"]);
const DIRECTED_STEER_RE = /^(?:\[@([a-zA-Z0-9][a-zA-Z0-9_-]*)\]|@([a-zA-Z0-9][a-zA-Z0-9_-]*))\s+([\s\S]+)$/;

export interface MandateScope { sessionId?: string | null; flowId?: string | null }
export interface ProjectFlowLease { flowId: string; ownerPid: number; ownerStartToken: string | null; acquiredAt: string }

export class ProjectBusyError extends Error {
  readonly cwd: string;
  readonly activeFlowId: string;
  readonly ownerPid: number;
  constructor(input: { cwd: string; activeFlowId: string; ownerPid: number; message?: string }) {
    super(input.message ?? `项目 ${input.cwd} 当前已有运行中任务 (${input.activeFlowId}, PID ${input.ownerPid}) 占用执行权；请等待其释放或先中止该任务。`);
    this.name = "ProjectBusyError"; this.cwd = input.cwd; this.activeFlowId = input.activeFlowId; this.ownerPid = input.ownerPid;
  }
}

export function safeParseArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try { const p: unknown = JSON.parse(raw); return Array.isArray(p) ? (p as T[]) : []; } catch { return []; }
}

export function safeParseObject<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try { const p: unknown = JSON.parse(raw); return p && typeof p === "object" && !Array.isArray(p) ? (p as T) : null; } catch { return null; }
}

export function captureProcessStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const procStatPath = `/proc/${pid}/stat`;
  if (existsSync(procStatPath)) {
    try {
      const stat = readFileSync(procStatPath, "utf8"), closeParen = stat.lastIndexOf(")");
      const f = closeParen > 0 ? stat.slice(closeParen + 2).trim().split(/\s+/) : [];
      if (f[19]) return `proc:${f[19]}`;
    } catch { return null; }
  }
  try {
    const res = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1_500 });
    const token = res.status === 0 ? res.stdout.trim() : "";
    return token ? `ps:${token}` : null;
  } catch { return null; }
}

export function isProcessAliveWithToken(pid: number, expectedToken?: string | null): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" && Boolean(expectedToken) && captureProcessStartToken(pid) === expectedToken;
  }
  return !expectedToken || captureProcessStartToken(pid) === expectedToken;
}

export const SCHEMA_TABLES = [
  "CREATE TABLE IF NOT EXISTS mandates (id TEXT PRIMARY KEY, rev INTEGER NOT NULL, goal TEXT NOT NULL, constraints TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT, flow_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS epistemic_items (id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('fact', 'hypothesis', 'inquiry', 'decision')), statement TEXT NOT NULL, evidence_ref TEXT, verification_plan TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, CHECK (kind != 'fact' OR (evidence_ref IS NOT NULL AND length(trim(evidence_ref)) > 0)));",
  "CREATE TABLE IF NOT EXISTS artifacts (artifact_id INTEGER PRIMARY KEY AUTOINCREMENT, mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE, path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, role TEXT NOT NULL, digest_kind TEXT, created_at TEXT NOT NULL, UNIQUE (mandate_id, path, sha256));",
  "CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE, mandate_rev INTEGER NOT NULL, parent_handoff_id TEXT, from_role TEXT NOT NULL, to_target TEXT NOT NULL, verdict TEXT NOT NULL, summary TEXT NOT NULL, artifacts TEXT NOT NULL, deleted_files TEXT, verified_facts TEXT NOT NULL, open_risks TEXT NOT NULL, questions_for_user TEXT, feedback_for_upstream TEXT, observed_usage TEXT, created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, mandate_id TEXT REFERENCES mandates(id) ON DELETE SET NULL, hypothesis_id TEXT, command TEXT NOT NULL, cwd TEXT NOT NULL, pid INTEGER NOT NULL, pgid INTEGER NOT NULL, owner_pid INTEGER, process_start_token TEXT, log_path TEXT NOT NULL, exit_file_path TEXT NOT NULL, status TEXT NOT NULL, exit_code INTEGER, started_at TEXT NOT NULL, ended_at TEXT);",
  "CREATE TABLE IF NOT EXISTS flow_runs (flow_id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE, goal TEXT NOT NULL, cwd TEXT, role_chain TEXT NOT NULL, status TEXT NOT NULL, current_index INTEGER NOT NULL, repair_round INTEGER NOT NULL, last_handoff_id TEXT, max_repair_rounds INTEGER NOT NULL, snapshot_json TEXT NOT NULL, owner_pid INTEGER, owner_start_token TEXT, next_stage_seq INTEGER, last_rejection_sig TEXT, user_steers TEXT, updated_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS project_leases (lease_key TEXT PRIMARY KEY, flow_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_start_token TEXT, acquired_at TEXT NOT NULL);",
].join("\n");

export const SCHEMA_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_mandates_status_updated ON mandates(status, updated_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_mandates_session ON mandates(session_id, status, updated_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_mandates_flow ON mandates(flow_id, status, updated_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_epistemic_mandate ON epistemic_items(mandate_id, created_at ASC);",
  "CREATE INDEX IF NOT EXISTS idx_artifacts_mandate_path ON artifacts(mandate_id, path ASC);",
  "CREATE INDEX IF NOT EXISTS idx_handoffs_mandate_created ON handoffs(mandate_id, created_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_jobs_status_started ON jobs(status, started_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_flow_runs_updated ON flow_runs(updated_at DESC);",
].join("\n");

export const MIGRATIONS: ReadonlyArray<[table: string, column: string, ddl: string]> = [
  ["mandates", "session_id", "TEXT"], ["mandates", "flow_id", "TEXT"], ["artifacts", "digest_kind", "TEXT"],
  ["handoffs", "deleted_files", "TEXT"], ["handoffs", "questions_for_user", "TEXT"],
  ["jobs", "owner_pid", "INTEGER"], ["jobs", "process_start_token", "TEXT"],
  ["flow_runs", "cwd", "TEXT"], ["flow_runs", "owner_pid", "INTEGER"], ["flow_runs", "owner_start_token", "TEXT"],
  ["flow_runs", "next_stage_seq", "INTEGER"], ["flow_runs", "last_rejection_sig", "TEXT"], ["flow_runs", "user_steers", "TEXT"],
];

export interface MandateRow {
  id: string; rev: number; goal: string; constraints: string; acceptance: string;
  status: MandateStatus; session_id: string | null; flow_id: string | null; created_at: string; updated_at: string;
}
export interface EpistemicRow {
  id: string; mandate_id: string; kind: EpistemicKind; statement: string;
  evidence_ref: string | null; verification_plan: string | null; status: EpistemicStatus; created_at: string;
}
export interface ArtifactRow { path: string; sha256: string; byte_size: number; role: ArtifactRecord["role"]; digest_kind: ArtifactDigestKind | null }
export interface HandoffRow {
  id: string; mandate_id: string; mandate_rev: number; parent_handoff_id: string | null;
  from_role: string; to_target: string; verdict: HandoffEnvelope["verdict"]; summary: string;
  artifacts: string; deleted_files: string | null; verified_facts: string; open_risks: string;
  questions_for_user: string | null; feedback_for_upstream: string | null; observed_usage: string | null; created_at: string;
}
export interface JobRow {
  job_id: string; mandate_id: string | null; hypothesis_id: string | null; command: string; cwd: string;
  pid: number; pgid: number; owner_pid: number | null; process_start_token: string | null;
  log_path: string; exit_file_path: string; status: JobStatus; exit_code: number | null; started_at: string; ended_at: string | null;
}
export interface LeaseRow { lease_key: string; flow_id: string; owner_pid: number; owner_start_token: string | null; acquired_at: string }

export const toMandate = (r: MandateRow): Mandate => ({
  id: r.id, rev: r.rev, goal: r.goal,
  constraints: safeParseArray(r.constraints), acceptance: safeParseArray(r.acceptance), status: r.status,
  ...(r.session_id ? { sessionId: r.session_id } : {}), ...(r.flow_id ? { flowId: r.flow_id } : {}),
  createdAt: r.created_at, updatedAt: r.updated_at,
});
export const toEpistemicItem = (r: EpistemicRow): EpistemicItem => ({
  id: r.id, mandateId: r.mandate_id, kind: r.kind, statement: r.statement,
  evidenceRef: r.evidence_ref, verificationPlan: r.verification_plan, status: r.status, createdAt: r.created_at,
});
export const toArtifact = (r: ArtifactRow): ArtifactRecord => ({
  path: r.path, sha256: r.sha256, byteSize: r.byte_size, role: r.role, ...(r.digest_kind ? { digestKind: r.digest_kind } : {}),
});
export const toHandoff = (r: HandoffRow): HandoffEnvelope => {
  const deletedFiles = r.deleted_files != null ? safeParseArray<string>(r.deleted_files) : undefined;
  const questionsForUser = r.questions_for_user != null ? safeParseArray<string>(r.questions_for_user) : undefined;
  return {
    id: r.id, mandateId: r.mandate_id, mandateRev: r.mandate_rev, parentHandoffId: r.parent_handoff_id,
    fromRole: r.from_role, toTarget: r.to_target, verdict: r.verdict, summary: r.summary,
    artifacts: safeParseArray(r.artifacts), ...(deletedFiles !== undefined ? { deletedFiles } : {}),
    verifiedFacts: safeParseArray(r.verified_facts), openRisks: safeParseArray(r.open_risks),
    ...(questionsForUser !== undefined ? { questionsForUser } : {}), feedbackForUpstream: r.feedback_for_upstream,
    observedUsage: safeParseObject<NonNullable<HandoffEnvelope["observedUsage"]>>(r.observed_usage), createdAt: r.created_at,
  };
};
export const toJob = (r: JobRow): BackgroundJob => ({
  jobId: r.job_id, mandateId: r.mandate_id, hypothesisId: r.hypothesis_id, command: r.command, cwd: r.cwd,
  pid: r.pid, pgid: r.pgid,
  ...(r.owner_pid != null ? { ownerPid: r.owner_pid } : {}), ...(r.process_start_token != null ? { processStartToken: r.process_start_token } : {}),
  logPath: r.log_path, exitFilePath: r.exit_file_path, status: r.status, exitCode: r.exit_code, startedAt: r.started_at, endedAt: r.ended_at,
});
export const toFlowCheckpoint = (row: Record<string, unknown>): PersistedFlowCheckpoint => ({
  flowId: String(row.flow_id), mandateId: String(row.mandate_id), goal: String(row.goal),
  ...(row.cwd != null ? { cwd: String(row.cwd) } : {}),
  roleChain: safeParseArray<string>(String(row.role_chain ?? "[]")), status: String(row.status),
  currentIndex: Number(row.current_index), repairRound: Number(row.repair_round),
  lastHandoffId: row.last_handoff_id ? String(row.last_handoff_id) : null,
  maxRepairRounds: Number(row.max_repair_rounds), snapshotJson: String(row.snapshot_json ?? "{}"), updatedAt: String(row.updated_at),
  ...(row.owner_pid != null ? { ownerPid: Number(row.owner_pid) } : {}),
  ...(row.owner_start_token != null ? { ownerStartToken: String(row.owner_start_token) } : {}),
  ...(row.next_stage_seq != null ? { nextStageSeq: Number(row.next_stage_seq) } : {}),
  ...(row.last_rejection_sig != null ? { lastRejectionSig: String(row.last_rejection_sig) } : {}),
  ...(row.user_steers != null ? { userSteers: safeParseArray<FlowUserSteer>(String(row.user_steers)) } : {}),
});
export const toLease = (r: LeaseRow): ProjectFlowLease => ({
  flowId: r.flow_id, ownerPid: r.owner_pid, ownerStartToken: r.owner_start_token, acquiredAt: r.acquired_at,
});

export const hasTable = (db: Database, name: string): boolean =>
  Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name));
export const hasCol = (db: Database, table: string, col: string): boolean =>
  (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((r) => r.name === col);
export const inferStoreCwd = (dbPath: string, flowCwd?: string | null): string => {
  if (flowCwd?.trim()) return flowCwd;
  const dir = path.dirname(dbPath);
  return path.basename(dir) === ".omp-enhance" ? path.dirname(dir) : dir;
};

export function normalizeCheckpointSteer(steer: FlowUserSteer, fallbackTs: string): FlowUserSteer {
  const clean = steer.text.trim();
  if (!clean) throw new Error("Steer text must not be empty.");
  if (steer.targetRole !== undefined) {
    const t = steer.targetRole?.trim() || null;
    return { text: clean, ...(t && t !== "supervisor" ? { targetRole: t } : {}), createdAt: steer.createdAt || fallbackTs };
  }
  const m = DIRECTED_STEER_RE.exec(clean);
  const cand = m ? (m[1] ?? m[2] ?? "").trim() : "";
  const targetRole = cand && cand !== "supervisor" ? cand : null;
  return { text: targetRole && m?.[3] ? m[3].trim() : clean, ...(targetRole ? { targetRole } : {}), createdAt: steer.createdAt || fallbackTs };
}

export function mutateSnapshotForSteer(snapshotJson: string, steer: FlowUserSteer, nextSteers: FlowUserSteer[]): string {
  const snap = safeParseObject<Record<string, unknown>>(snapshotJson) ?? {};
  const entries = Array.isArray(snap.entries) ? [...(snap.entries as RoomEntry[])] : [];
  const entry: RoomEntry = {
    id: `user-db-${entries.length + 1}-${Date.now().toString(36)}`, side: "right", speaker: "你",
    ...(steer.targetRole ? { target: steer.targetRole } : {}), badge: steer.targetRole ? `@${steer.targetRole}` : "留言",
    tone: "success", text: steer.targetRole ? `[@${steer.targetRole}] ${steer.text}` : steer.text, timestamp: steer.createdAt,
  };
  const activeStageId = typeof snap.activeStageId === "string" ? snap.activeStageId : null;
  const idx = activeStageId ? entries.findIndex((e) => e.id === `stage-${activeStageId}`) : -1;
  if (idx >= 0) entries.splice(idx, 0, entry); else entries.push(entry);
  return JSON.stringify({ ...snap, entries, userSteers: nextSteers });
}

export function mutateSnapshotForInterrupt(snapshotJson: string, ts: string): string {
  const snap = safeParseObject<Record<string, unknown>>(snapshotJson) ?? {};
  const stages = (Array.isArray(snap.stages) ? [...(snap.stages as FlowStageTrace[])] : []).map((st) =>
    st.status === "running" ? { ...st, status: "aborted" as const, endedAt: ts, activeTool: null } : st,
  );
  const entries = (Array.isArray(snap.entries) ? [...(snap.entries as RoomEntry[])] : []).map((en) =>
    en.badge?.startsWith("●") ? { ...en, badge: "⏸ 中断", tone: "warning" as const, text: "进程中断，可在总秘书 (/coord) 中从本阶段断点续跑" } : en,
  );
  return JSON.stringify({ ...snap, status: "interrupted", activeStageId: null, endedAt: ts, reason: "上次进程中断，可在总秘书 (/coord) 中断点续跑", stages, entries });
}

export function mutateSnapshotForCancel(snapshotJson: string, ts: string): string {
  const snap = safeParseObject<Record<string, unknown>>(snapshotJson) ?? {};
  const stages = (Array.isArray(snap.stages) ? [...(snap.stages as FlowStageTrace[])] : []).map((st) =>
    st.status === "running" ? { ...st, status: "aborted" as const, endedAt: ts, activeTool: null } : st,
  );
  const entries = Array.isArray(snap.entries) ? [...(snap.entries as RoomEntry[])] : [];
  entries.push({ id: `user-db-cancel-${entries.length + 1}`, side: "right", speaker: "你", badge: "中止", tone: "warning", text: "停止当前协作 Flow", timestamp: ts });
  return JSON.stringify({ ...snap, status: "cancelled", activeStageId: null, endedAt: ts, reason: "已由用户取消", stages, entries });
}

export function runUpsertMandateTx(
  db: Database,
  input: { id?: string; goal: string; constraints?: string[]; acceptance?: string[]; status?: MandateStatus; sessionId?: string | null; flowId?: string | null },
  ts: string,
  newId: () => string,
): Mandate {
  const existingRow = input.id ? (db.query("SELECT * FROM mandates WHERE id = ?").get(input.id) as MandateRow | null) : null;
  if (!existingRow) {
    const id = input.id ?? newId(), status = input.status ?? "active";
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
  const changed = input.goal !== existing.goal || JSON.stringify(constraints) !== JSON.stringify(existing.constraints) || JSON.stringify(acceptance) !== JSON.stringify(existing.acceptance);
  const rev = changed ? existing.rev + 1 : existing.rev;
  db.query("UPDATE mandates SET rev = ?, goal = ?, constraints = ?, acceptance = ?, status = ?, session_id = ?, flow_id = ?, updated_at = ? WHERE id = ?")
    .run(rev, input.goal, JSON.stringify(constraints), JSON.stringify(acceptance), status, sessionId, flowId, ts, existing.id);
  return toMandate(db.query("SELECT * FROM mandates WHERE id = ?").get(existing.id) as MandateRow);
}

export function runAcquireProjectLeaseTx(
  db: Database, dbPath: string, targetFlowId: string, pid: number, token: string | null | undefined, ts: string,
): void {
  const existing = db.query("SELECT * FROM project_leases WHERE lease_key = 'active_flow'").get() as LeaseRow | null;
  if (existing && existing.flow_id !== targetFlowId) {
    const flowRow = db.query("SELECT status, cwd, snapshot_json FROM flow_runs WHERE flow_id = ?")
      .get(existing.flow_id) as { status: string; cwd: string | null; snapshot_json: string } | null;
    const alreadySettled = Boolean(flowRow && flowRow.status !== "running");
    const holderActive = !alreadySettled && (
      existing.owner_pid === pid || isProcessAliveWithToken(existing.owner_pid, existing.owner_start_token)
    );
    if (holderActive) {
      throw new ProjectBusyError({ cwd: inferStoreCwd(dbPath, flowRow?.cwd), activeFlowId: existing.flow_id, ownerPid: existing.owner_pid });
    }
    if (flowRow && flowRow.status === "running") {
      db.query("UPDATE flow_runs SET status = 'interrupted', owner_pid = NULL, owner_start_token = NULL, snapshot_json = ?, updated_at = ? WHERE flow_id = ?")
        .run(mutateSnapshotForInterrupt(flowRow.snapshot_json, ts), ts, existing.flow_id);
    }
  }
  db.query("INSERT OR REPLACE INTO project_leases (lease_key, flow_id, owner_pid, owner_start_token, acquired_at) VALUES ('active_flow', ?, ?, ?, ?)")
    .run(targetFlowId, pid, token ?? null, ts);
}

export function runAppendSteerTx(db: Database, flowId: string, steer: FlowUserSteer, ts: string): PersistedFlowCheckpoint {
  const row = db.query("SELECT * FROM flow_runs WHERE flow_id = ?").get(flowId) as Record<string, unknown> | null;
  if (!row) throw new Error(`Unknown flowId "${flowId}".`);
  const cp = toFlowCheckpoint(row);
  if (!STEERABLE_FLOW_STATUSES.has(cp.status)) throw new Error(`Flow "${flowId}" is in terminal status "${cp.status}" and cannot accept steers.`);
  const normSteer = normalizeCheckpointSteer(steer, ts), nextSteers = [...(cp.userSteers ?? []), normSteer];
  const nextSnap = mutateSnapshotForSteer(cp.snapshotJson, normSteer, nextSteers);
  db.query("UPDATE flow_runs SET user_steers = ?, snapshot_json = ?, updated_at = ? WHERE flow_id = ?").run(JSON.stringify(nextSteers), nextSnap, ts, flowId);
  return toFlowCheckpoint(db.query("SELECT * FROM flow_runs WHERE flow_id = ?").get(flowId) as Record<string, unknown>);
}

export function runCancelCheckpointTx(
  db: Database, flowId: string, ts: string,
): { cancelled: boolean; checkpoint: PersistedFlowCheckpoint | null; reason?: string } {
  const row = db.query("SELECT * FROM flow_runs WHERE flow_id = ?").get(flowId) as Record<string, unknown> | null;
  if (!row) return { cancelled: false, checkpoint: null, reason: `Unknown flowId "${flowId}".` };
  const cp = toFlowCheckpoint(row);
  const deadRunning = cp.status === "running" && (cp.ownerPid == null || !isProcessAliveWithToken(cp.ownerPid, cp.ownerStartToken));
  if (cp.status !== "waiting_input" && cp.status !== "interrupted" && cp.status !== "failed" && !deadRunning) {
    return { cancelled: false, checkpoint: cp, reason: `Flow "${flowId}" cannot be checkpoint-cancelled while in status "${cp.status}".` };
  }
  db.query("UPDATE flow_runs SET status = 'cancelled', owner_pid = NULL, owner_start_token = NULL, snapshot_json = ?, updated_at = ? WHERE flow_id = ?")
    .run(mutateSnapshotForCancel(cp.snapshotJson, ts), ts, flowId);
  db.query("DELETE FROM project_leases WHERE lease_key = 'active_flow' AND flow_id = ?").run(flowId);
  return { cancelled: true, checkpoint: toFlowCheckpoint(db.query("SELECT * FROM flow_runs WHERE flow_id = ?").get(flowId) as Record<string, unknown>) };
}
