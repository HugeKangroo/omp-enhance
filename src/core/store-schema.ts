import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  ArtifactDigestKind, ArtifactRecord, BackgroundJob, EpistemicItem, EpistemicKind, EpistemicStatus,
  FlowLeaseMode, FlowMachineState, FlowStageTrace, FlowUserSteer, HandoffEnvelope, JobStatus, Mandate, MandateStatus,
  PersistedFlowCheckpoint, RoomEntry, VerificationEvidenceRecord,
} from "./types.ts";

export const MAX_ARCHIVED_FLOW_RUNS = 50;
export const STEERABLE_FLOW_STATUSES: ReadonlySet<string> = new Set(["running", "waiting_input", "interrupted", "failed"]);
const DIRECTED_STEER_RE = /^(?:\[@([a-zA-Z0-9][a-zA-Z0-9_-]*)\]|@([a-zA-Z0-9][a-zA-Z0-9_-]*))\s+([\s\S]+)$/;

export interface MandateScope { sessionId?: string | null; flowId?: string | null }
export interface SaveFlowCheckpointOptions { expectedLeaseToken?: string | null; expectedStateVersion?: number }
export interface ProjectFlowLease {
  flowId: string; ownerPid: number; ownerStartToken: string | null; leaseToken: string | null; acquiredAt: string;
}

export class ProjectBusyError extends Error {
  readonly cwd: string; readonly activeFlowId: string; readonly ownerPid: number;
  constructor(input: { cwd: string; activeFlowId: string; ownerPid: number; message?: string }) {
    super(input.message ?? `项目 ${input.cwd} 当前已有运行中任务 (${input.activeFlowId}, PID ${input.ownerPid}) 占用执行权；请等待其释放或先中止该任务。`);
    this.name = "ProjectBusyError"; this.cwd = input.cwd; this.activeFlowId = input.activeFlowId; this.ownerPid = input.ownerPid;
  }
}

export class LeaseLostError extends Error {
  readonly flowId: string;
  readonly expectedLeaseToken: string | null;
  readonly actualLeaseToken: string | null;
  readonly actualOwnerPid: number | null;
  constructor(input: {
    flowId: string; expectedLeaseToken: string | null; actualLeaseToken: string | null; actualOwnerPid: number | null; message?: string;
  }) {
    super(input.message ?? `Flow "${input.flowId}" lost execution lease (expected=${input.expectedLeaseToken ?? "none"}, actual=${input.actualLeaseToken ?? "none"}, ownerPid=${input.actualOwnerPid ?? "none"}).`);
    this.name = "LeaseLostError"; this.flowId = input.flowId;
    this.expectedLeaseToken = input.expectedLeaseToken; this.actualLeaseToken = input.actualLeaseToken; this.actualOwnerPid = input.actualOwnerPid;
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
  "CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE, mandate_rev INTEGER NOT NULL, parent_handoff_id TEXT, from_role TEXT NOT NULL, to_target TEXT NOT NULL, verdict TEXT NOT NULL, summary TEXT NOT NULL, artifacts TEXT NOT NULL, deleted_files TEXT, verified_facts TEXT NOT NULL, verification_evidence TEXT, open_risks TEXT NOT NULL, questions_for_user TEXT, feedback_for_upstream TEXT, observed_usage TEXT, created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, mandate_id TEXT REFERENCES mandates(id) ON DELETE SET NULL, hypothesis_id TEXT, idempotency_key TEXT, command TEXT NOT NULL, cwd TEXT NOT NULL, pid INTEGER NOT NULL, pgid INTEGER NOT NULL, owner_pid INTEGER, process_start_token TEXT, log_path TEXT NOT NULL, exit_file_path TEXT NOT NULL, status TEXT NOT NULL, exit_code INTEGER, started_at TEXT NOT NULL, ended_at TEXT);",
  "CREATE TABLE IF NOT EXISTS flow_runs (flow_id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE, goal TEXT NOT NULL, cwd TEXT, role_chain TEXT NOT NULL, status TEXT NOT NULL, current_index INTEGER NOT NULL, repair_round INTEGER NOT NULL, last_handoff_id TEXT, max_repair_rounds INTEGER NOT NULL, snapshot_json TEXT NOT NULL, owner_pid INTEGER, owner_start_token TEXT, lease_token TEXT, state_version INTEGER NOT NULL DEFAULT 0, next_stage_seq INTEGER, last_rejection_sig TEXT, user_steers TEXT, updated_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS project_leases (lease_key TEXT PRIMARY KEY, flow_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_start_token TEXT, lease_token TEXT, acquired_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS flow_steers (seq INTEGER PRIMARY KEY AUTOINCREMENT, steer_id TEXT UNIQUE NOT NULL, flow_id TEXT NOT NULL REFERENCES flow_runs(flow_id) ON DELETE CASCADE, text TEXT NOT NULL, target_role TEXT, created_at TEXT NOT NULL, consumed_at TEXT, consumed_by_stage TEXT);",
].join("\n");

export const SCHEMA_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_mandates_status_updated ON mandates(status, updated_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_mandates_session ON mandates(session_id, status, updated_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_mandates_flow ON mandates(flow_id, status, updated_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_epistemic_mandate ON epistemic_items(mandate_id, created_at ASC);",
  "CREATE INDEX IF NOT EXISTS idx_artifacts_mandate_path ON artifacts(mandate_id, path ASC);",
  "CREATE INDEX IF NOT EXISTS idx_handoffs_mandate_created ON handoffs(mandate_id, created_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_jobs_status_started ON jobs(status, started_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(idempotency_key, started_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_flow_runs_updated ON flow_runs(updated_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_flow_steers_flow_seq ON flow_steers(flow_id, seq ASC);",
].join("\n");

export const MIGRATIONS: ReadonlyArray<[table: string, column: string, ddl: string]> = [
  ["mandates", "session_id", "TEXT"], ["mandates", "flow_id", "TEXT"], ["artifacts", "digest_kind", "TEXT"],
  ["handoffs", "deleted_files", "TEXT"], ["handoffs", "questions_for_user", "TEXT"], ["handoffs", "verification_evidence", "TEXT"],
  ["jobs", "owner_pid", "INTEGER"], ["jobs", "process_start_token", "TEXT"], ["jobs", "idempotency_key", "TEXT"],
  ["flow_runs", "cwd", "TEXT"], ["flow_runs", "owner_pid", "INTEGER"], ["flow_runs", "owner_start_token", "TEXT"],
  ["flow_runs", "lease_token", "TEXT"], ["flow_runs", "state_version", "INTEGER DEFAULT 0"],
  ["flow_runs", "next_stage_seq", "INTEGER"], ["flow_runs", "last_rejection_sig", "TEXT"], ["flow_runs", "user_steers", "TEXT"],
  ["project_leases", "lease_token", "TEXT"],
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
  artifacts: string; deleted_files: string | null; verified_facts: string; verification_evidence: string | null; open_risks: string;
  questions_for_user: string | null; feedback_for_upstream: string | null; observed_usage: string | null; created_at: string;
}
export interface JobRow {
  job_id: string; mandate_id: string | null; hypothesis_id: string | null; idempotency_key: string | null; command: string; cwd: string;
  pid: number; pgid: number; owner_pid: number | null; process_start_token: string | null;
  log_path: string; exit_file_path: string; status: JobStatus; exit_code: number | null; started_at: string; ended_at: string | null;
}
export interface LeaseRow {
  lease_key: string; flow_id: string; owner_pid: number; owner_start_token: string | null; lease_token: string | null; acquired_at: string;
}
export interface SteerRow {
  seq: number; steer_id: string; flow_id: string; text: string; target_role: string | null;
  created_at: string; consumed_at: string | null; consumed_by_stage: string | null;
}

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
  const verificationEvidence = r.verification_evidence != null ? safeParseArray<VerificationEvidenceRecord>(r.verification_evidence) : undefined;
  return {
    id: r.id, mandateId: r.mandate_id, mandateRev: r.mandate_rev, parentHandoffId: r.parent_handoff_id,
    fromRole: r.from_role, toTarget: r.to_target, verdict: r.verdict, summary: r.summary,
    artifacts: safeParseArray(r.artifacts), ...(deletedFiles !== undefined ? { deletedFiles } : {}),
    verifiedFacts: safeParseArray(r.verified_facts), ...(verificationEvidence !== undefined ? { verificationEvidence } : {}),
    openRisks: safeParseArray(r.open_risks), ...(questionsForUser !== undefined ? { questionsForUser } : {}),
    feedbackForUpstream: r.feedback_for_upstream,
    observedUsage: safeParseObject<NonNullable<HandoffEnvelope["observedUsage"]>>(r.observed_usage), createdAt: r.created_at,
  };
};
export const toJob = (r: JobRow): BackgroundJob => ({
  jobId: r.job_id, mandateId: r.mandate_id, hypothesisId: r.hypothesis_id,
  ...(r.idempotency_key != null ? { idempotencyKey: r.idempotency_key } : {}),
  command: r.command, cwd: r.cwd, pid: r.pid, pgid: r.pgid,
  ...(r.owner_pid != null ? { ownerPid: r.owner_pid } : {}), ...(r.process_start_token != null ? { processStartToken: r.process_start_token } : {}),
  logPath: r.log_path, exitFilePath: r.exit_file_path, status: r.status, exitCode: r.exit_code, startedAt: r.started_at, endedAt: r.ended_at,
});
export const toFlowSteer = (r: SteerRow): FlowUserSteer => ({
  steerId: r.steer_id, seq: r.seq, text: r.text, ...(r.target_role ? { targetRole: r.target_role } : {}),
  createdAt: r.created_at, consumedAt: r.consumed_at, consumedByStage: r.consumed_by_stage,
});
export const toFlowCheckpoint = (row: Record<string, unknown>, tableSteers?: readonly FlowUserSteer[]): PersistedFlowCheckpoint => {
  const rowSteers = row.user_steers != null ? safeParseArray<FlowUserSteer>(String(row.user_steers)) : undefined;
  const mergedSteers = tableSteers && tableSteers.length > 0 ? mergeSteerLists(rowSteers ?? [], tableSteers) : rowSteers;
  const snapshotJson = mergedSteers && mergedSteers.length > 0
    ? mergeSteersIntoSnapshotJson(String(row.snapshot_json ?? "{}"), mergedSteers)
    : String(row.snapshot_json ?? "{}");
  return {
    flowId: String(row.flow_id), mandateId: String(row.mandate_id), goal: String(row.goal),
    ...(row.cwd != null ? { cwd: String(row.cwd) } : {}),
    roleChain: safeParseArray<string>(String(row.role_chain ?? "[]")), status: String(row.status),
    currentIndex: Number(row.current_index), repairRound: Number(row.repair_round),
    lastHandoffId: row.last_handoff_id ? String(row.last_handoff_id) : null,
    maxRepairRounds: Number(row.max_repair_rounds), snapshotJson, updatedAt: String(row.updated_at),
    ...(row.owner_pid != null ? { ownerPid: Number(row.owner_pid) } : {}),
    ...(row.owner_start_token != null ? { ownerStartToken: String(row.owner_start_token) } : {}),
    ...(row.lease_token != null ? { leaseToken: String(row.lease_token) } : {}),
    ...(row.state_version != null ? { stateVersion: Number(row.state_version) } : {}),
    ...(row.next_stage_seq != null ? { nextStageSeq: Number(row.next_stage_seq) } : {}),
    ...(row.last_rejection_sig != null ? { lastRejectionSig: String(row.last_rejection_sig) } : {}),
    ...(mergedSteers !== undefined ? { userSteers: mergedSteers } : {}),
    ...(row.graph_spec_json != null ? { graphSpecJson: String(row.graph_spec_json) } : {}),
    ...(row.machine_state_json != null ? { machineStateJson: String(row.machine_state_json) } : {}),
    ...(row.lease_mode != null ? { leaseMode: String(row.lease_mode) as FlowLeaseMode } : {}),
  };
};
export const toLease = (r: LeaseRow): ProjectFlowLease => ({
  flowId: r.flow_id, ownerPid: r.owner_pid, ownerStartToken: r.owner_start_token, leaseToken: r.lease_token ?? null, acquiredAt: r.acquired_at,
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

export function normalizeCheckpointSteer(
  steer: { steerId?: string; text: string; targetRole?: string | null; createdAt?: string }, fallbackTs: string,
): FlowUserSteer & { steerId: string } {
  const clean = steer.text.trim();
  if (!clean) throw new Error("Steer text must not be empty.");
  const steerId = steer.steerId?.trim() || `steer-${randomUUID()}`;
  if (steer.targetRole !== undefined) {
    const t = steer.targetRole?.trim() || null;
    return { steerId, text: clean, ...(t && t !== "supervisor" ? { targetRole: t } : {}), createdAt: steer.createdAt || fallbackTs };
  }
  const m = DIRECTED_STEER_RE.exec(clean);
  const cand = m ? (m[1] ?? m[2] ?? "").trim() : "";
  const targetRole = cand && cand !== "supervisor" ? cand : null;
  return { steerId, text: targetRole && m?.[3] ? m[3].trim() : clean, ...(targetRole ? { targetRole } : {}), createdAt: steer.createdAt || fallbackTs };
}

export function mergeSteerLists(base: readonly FlowUserSteer[], appended: readonly FlowUserSteer[]): FlowUserSteer[] {
  const out: FlowUserSteer[] = [];
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  for (const s of [...appended, ...base]) {
    const key = `${s.createdAt}\0${s.targetRole ?? ""}\0${s.text}`;
    if ((s.steerId && seenIds.has(s.steerId)) || seenKeys.has(key)) continue;
    if (s.steerId) seenIds.add(s.steerId);
    seenKeys.add(key);
    out.push(s);
  }
  return out.sort((a, b) => (a.seq !== undefined && b.seq !== undefined ? a.seq - b.seq : a.createdAt.localeCompare(b.createdAt)));
}

export function mergeSteersIntoSnapshotJson(snapshotJson: string, steers: readonly FlowUserSteer[]): string {
  const snap = safeParseObject<Record<string, unknown>>(snapshotJson) ?? {};
  const entries = Array.isArray(snap.entries) ? [...(snap.entries as RoomEntry[])] : [];
  const activeStageId = typeof snap.activeStageId === "string" ? snap.activeStageId : null;
  for (const s of steers) {
    const expectedText = s.targetRole ? `[@${s.targetRole}] ${s.text}` : s.text;
    const entryId = s.steerId ? `steer-${s.steerId}` : null;
    const alreadyInEntries = entries.some((e) => (entryId && e.id === entryId) || (e.side === "right" && e.text === expectedText && e.timestamp === s.createdAt));
    if (alreadyInEntries) continue;
    const entry: RoomEntry = {
      id: entryId ?? `user-db-${entries.length + 1}`, side: "right", speaker: "你",
      ...(s.targetRole ? { target: s.targetRole } : {}), badge: s.targetRole ? `@${s.targetRole}` : "留言",
      tone: "success", text: expectedText, timestamp: s.createdAt,
    };
    const idx = activeStageId ? entries.findIndex((e) => e.id === `stage-${activeStageId}`) : -1;
    if (idx >= 0) entries.splice(idx, 0, entry); else entries.push(entry);
  }
  return JSON.stringify({ ...snap, entries, userSteers: steers });
}

export function markMachineStateInterrupted(state: FlowMachineState, ts: string): FlowMachineState {
  const nodes: FlowMachineState["nodes"] = {};
  for (const [id, rt] of Object.entries(state.nodes)) {
    nodes[id] = rt.status === "running" || rt.status === "retrying"
      ? { ...rt, status: "ready", activeStageId: null, sessionResidency: "disposed", endedAt: ts }
      : rt;
  }
  return state.status === "running"
    ? { ...state, status: "interrupted", endedAt: ts, reason: "上次进程中断，可在总秘书 (/coord) 中断点续跑", nodes }
    : { ...state, nodes };
}

export function mutateMachineStateForInterrupt(machineStateJson: string | null | undefined, ts: string): string | null {
  const parsed = safeParseObject<FlowMachineState>(machineStateJson);
  return parsed?.nodes ? JSON.stringify(markMachineStateInterrupted(parsed, ts)) : (machineStateJson ?? null);
}

export function mutateSnapshotForInterrupt(snapshotJson: string, ts: string): string {
  const snap = safeParseObject<Record<string, unknown>>(snapshotJson) ?? {};
  const stages = (Array.isArray(snap.stages) ? [...(snap.stages as FlowStageTrace[])] : []).map((st) =>
    st.status === "running" ? { ...st, status: "aborted" as const, endedAt: ts, activeTool: null } : st,
  );
  const entries = (Array.isArray(snap.entries) ? [...(snap.entries as RoomEntry[])] : []).map((en) =>
    en.badge?.startsWith("●") ? { ...en, badge: "⏸ 中断", tone: "warning" as const, text: "进程中断，可在总秘书 (/coord) 中从本阶段断点续跑" } : en,
  );
  const rawGraph = snap.graphSnapshot && typeof snap.graphSnapshot === "object" ? (snap.graphSnapshot as Record<string, unknown>) : null;
  const graphSnapshot = rawGraph && Array.isArray(rawGraph.nodes)
    ? { ...rawGraph, nodes: rawGraph.nodes.map((n: any) => (n?.status === "running" || n?.status === "retrying" ? { ...n, status: "ready", activeStageId: null, sessionResidency: "disposed" } : n)) }
    : rawGraph;
  return JSON.stringify({
    ...snap, status: "interrupted", activeStageId: null, endedAt: ts,
    reason: "上次进程中断，可在总秘书 (/coord) 中断点续跑", stages, entries,
    ...(graphSnapshot ? { graphSnapshot } : {}),
  });
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

export function listFlowSteersQuery(db: Database, flowId: string, opts?: { afterSeq?: number; unconsumedOnly?: boolean }): FlowUserSteer[] {
  if (!hasTable(db, "flow_steers")) return [];
  const rows = db.query(
    "SELECT * FROM flow_steers WHERE flow_id = ? AND (? IS NULL OR seq > ?) AND (? = 0 OR consumed_at IS NULL) ORDER BY seq ASC",
  ).all(flowId, opts?.afterSeq ?? null, opts?.afterSeq ?? null, opts?.unconsumedOnly ? 1 : 0) as SteererRowAlias[];
  return rows.map(toFlowSteer);
}
type SteererRowAlias = SteerRow;

export function runUpsertMandateTx(
  db: Database,
  input: { id?: string; goal: string; constraints?: string[]; acceptance?: string[]; status?: MandateStatus; sessionId?: string | null; flowId?: string | null },
  ts: string, newId: () => string,
): Mandate {
  const existingRow = input.id ? (db.query("SELECT * FROM mandates WHERE id = ?").get(input.id) as MandateRow | null) : null;
  if (!existingRow) {
    const id = input.id ?? newId(), status = input.status ?? "active", sessionId = input.sessionId ?? null, flowId = input.flowId ?? null;
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
  db: Database, dbPath: string, targetFlowId: string, pid: number, token: string | null | undefined, reqLeaseToken: string | undefined, ts: string,
): { leaseToken: string; stateVersion: number } {
  const existing = db.query("SELECT * FROM project_leases WHERE lease_key = 'active_flow'").get() as LeaseRow | null;
  const sameOwnerReacquire = Boolean(
    existing && existing.flow_id === targetFlowId && (
      reqLeaseToken ? existing.lease_token === reqLeaseToken : (existing.owner_pid === pid && (existing.owner_start_token ?? null) === (token ?? null))
    ),
  );
  if (existing && !sameOwnerReacquire) {
    const flowRow = db.query("SELECT status, cwd, snapshot_json, machine_state_json FROM flow_runs WHERE flow_id = ?")
      .get(existing.flow_id) as { status: string; cwd: string | null; snapshot_json: string; machine_state_json: string | null } | null;
    const alreadySettled = Boolean(flowRow && flowRow.status !== "running");
    const holderActive = !alreadySettled && (
      existing.owner_pid === pid || isProcessAliveWithToken(existing.owner_pid, existing.owner_start_token)
    );
    if (holderActive) {
      throw new ProjectBusyError({ cwd: inferStoreCwd(dbPath, flowRow?.cwd), activeFlowId: existing.flow_id, ownerPid: existing.owner_pid });
    }
    if (flowRow && flowRow.status === "running") {
      db.query("UPDATE flow_runs SET status = 'interrupted', owner_pid = NULL, owner_start_token = NULL, lease_token = NULL, state_version = COALESCE(state_version, 0) + 1, snapshot_json = ?, machine_state_json = ?, updated_at = ? WHERE flow_id = ?")
        .run(mutateSnapshotForInterrupt(flowRow.snapshot_json, ts), mutateMachineStateForInterrupt(flowRow.machine_state_json, ts), ts, existing.flow_id);
    }
  }
  const effectiveLeaseToken = sameOwnerReacquire
    ? (reqLeaseToken?.trim() || existing!.lease_token || randomUUID())
    : (reqLeaseToken?.trim() || randomUUID());
  const targetRow = db.query("SELECT state_version FROM flow_runs WHERE flow_id = ?").get(targetFlowId) as { state_version: number | null } | null;
  const nextVersion = Number(targetRow?.state_version ?? 0) + 1;
  db.query("INSERT OR REPLACE INTO project_leases (lease_key, flow_id, owner_pid, owner_start_token, lease_token, acquired_at) VALUES ('active_flow', ?, ?, ?, ?, ?)")
    .run(targetFlowId, pid, token ?? null, effectiveLeaseToken, ts);
  if (targetRow) {
    db.query("UPDATE flow_runs SET lease_token = ?, owner_pid = ?, owner_start_token = ?, state_version = ?, updated_at = ? WHERE flow_id = ?")
      .run(effectiveLeaseToken, pid, token ?? null, nextVersion, ts, targetFlowId);
  }
  return { leaseToken: effectiveLeaseToken, stateVersion: nextVersion };
}

export function runAppendFlowSteerTx(
  db: Database, flowId: string, steer: { steerId?: string; text: string; targetRole?: string | null; createdAt?: string }, ts: string,
): FlowUserSteer {
  const row = db.query("SELECT status FROM flow_runs WHERE flow_id = ?").get(flowId) as { status: string } | null;
  if (!row) throw new Error(`Unknown flowId "${flowId}".`);
  if (!STEERABLE_FLOW_STATUSES.has(row.status)) throw new Error(`Flow "${flowId}" is in terminal status "${row.status}" and cannot accept steers.`);
  const norm = normalizeCheckpointSteer(steer, ts);
  const dup = db.query("SELECT * FROM flow_steers WHERE steer_id = ?").get(norm.steerId) as SteerRow | null;
  if (dup) return toFlowSteer(dup);
  db.query("INSERT INTO flow_steers (steer_id, flow_id, text, target_role, created_at, consumed_at, consumed_by_stage) VALUES (?, ?, ?, ?, ?, NULL, NULL)")
    .run(norm.steerId, flowId, norm.text, norm.targetRole ?? null, norm.createdAt);
  return toFlowSteer(db.query("SELECT * FROM flow_steers WHERE steer_id = ?").get(norm.steerId) as SteerRow);
}

export function runCancelCheckpointTx(
  db: Database, flowId: string, ts: string, expectedLeaseToken?: string | null,
): { cancelled: boolean; checkpoint: PersistedFlowCheckpoint | null; reason?: string } {
  const row = db.query("SELECT * FROM flow_runs WHERE flow_id = ?").get(flowId) as Record<string, unknown> | null;
  if (!row) return { cancelled: false, checkpoint: null, reason: `Unknown flowId "${flowId}".` };
  const cp = toFlowCheckpoint(row, listFlowSteersQuery(db, flowId));
  const deadRunning = cp.status === "running" && (cp.ownerPid == null || !isProcessAliveWithToken(cp.ownerPid, cp.ownerStartToken));
  if (cp.status !== "waiting_input" && cp.status !== "interrupted" && cp.status !== "failed" && !deadRunning) {
    return { cancelled: false, checkpoint: cp, reason: `Flow "${flowId}" cannot be checkpoint-cancelled while in status "${cp.status}".` };
  }
  const activeLease = db.query("SELECT * FROM project_leases WHERE lease_key = 'active_flow'").get() as LeaseRow | null;
  if (activeLease && activeLease.flow_id === flowId) {
    const live = activeLease.owner_pid === process.pid || isProcessAliveWithToken(activeLease.owner_pid, activeLease.owner_start_token);
    if (live && expectedLeaseToken !== undefined && activeLease.lease_token !== expectedLeaseToken) {
      return { cancelled: false, checkpoint: cp, reason: `Flow "${flowId}" is actively owned by another runner.` };
    }
    if (!live || expectedLeaseToken === undefined || activeLease.lease_token === expectedLeaseToken) {
      db.query("DELETE FROM project_leases WHERE lease_key = 'active_flow' AND flow_id = ?").run(flowId);
    }
  }
  const nextVer = Number(row.state_version ?? 0) + 1;
  db.query("UPDATE flow_runs SET status = 'cancelled', owner_pid = NULL, owner_start_token = NULL, lease_token = NULL, state_version = ?, snapshot_json = ?, updated_at = ? WHERE flow_id = ?")
    .run(nextVer, mutateSnapshotForCancel(cp.snapshotJson, ts), ts, flowId);
  const updated = db.query("SELECT * FROM flow_runs WHERE flow_id = ?").get(flowId) as Record<string, unknown>;
  return { cancelled: true, checkpoint: toFlowCheckpoint(updated, listFlowSteersQuery(db, flowId)) };
}
