import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  ArtifactRecord, BackgroundJob, EpistemicItem, EpistemicKind, EpistemicStatus,
  HandoffEnvelope, JobStatus, Mandate,
} from "./types.ts";

export interface SnapshotEntry { sha256: string; byteSize: number }

const SKIP_DIRS: Record<string, true> = {
  ".git": true, node_modules: true, ".omp-enhance": true, ".omp": true,
};
const now = (): string => new Date().toISOString();
const parseArray = <T>(raw: string): T[] => JSON.parse(raw) as T[];
const normalizePath = (value: string): string => value.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");

export function matchesGlobList(relPath: string, globs: readonly string[]): boolean {
  const normalized = normalizePath(relPath);
  return globs.some((glob) => new Bun.Glob(glob).match(normalized));
}

export function snapshotWorkspace(cwd: string, includeGlobs?: readonly string[]): Map<string, SnapshotEntry> {
  const snapshot = new Map<string, SnapshotEntry>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS[entry.name]) walk(fullPath);
      } else if (entry.isFile()) {
        const relPath = normalizePath(path.relative(cwd, fullPath));
        if (includeGlobs && !matchesGlobList(relPath, includeGlobs)) continue;
        const content = readFileSync(fullPath);
        snapshot.set(relPath, {
          sha256: createHash("sha256").update(content).digest("hex"),
          byteSize: content.byteLength,
        });
      }
    }
  };
  walk(cwd);
  return snapshot;
}

export function diffSnapshots(before: ReadonlyMap<string, SnapshotEntry>, after: ReadonlyMap<string, SnapshotEntry>) {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [relPath, entry] of after) {
    const previous = before.get(relPath);
    if (!previous) added.push(relPath);
    else if (previous.sha256 !== entry.sha256) modified.push(relPath);
  }
  for (const relPath of before.keys()) {
    if (!after.has(relPath)) deleted.push(relPath);
  }
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

export function findProtectedViolations(
  cwd: string, before: ReadonlyMap<string, SnapshotEntry>, protectedGlobs: readonly string[],
): string[] {
  if (protectedGlobs.length === 0) return [];
  const diff = diffSnapshots(before, snapshotWorkspace(cwd));
  return [...diff.added, ...diff.modified, ...diff.deleted]
    .filter((relPath) => matchesGlobList(relPath, protectedGlobs)).sort();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mandates (id TEXT PRIMARY KEY, rev INTEGER NOT NULL, goal TEXT NOT NULL,
  constraints TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS epistemic_items (id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'hypothesis', 'inquiry', 'decision')), statement TEXT NOT NULL,
  evidence_ref TEXT, verification_plan TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
  CHECK (kind != 'fact' OR (evidence_ref IS NOT NULL AND length(trim(evidence_ref)) > 0)));
CREATE TABLE IF NOT EXISTS artifacts (artifact_id INTEGER PRIMARY KEY AUTOINCREMENT, mandate_id TEXT NOT NULL,
  path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (mandate_id, path, sha256));
CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL, mandate_rev INTEGER NOT NULL,
  parent_handoff_id TEXT, from_role TEXT NOT NULL, to_target TEXT NOT NULL, verdict TEXT NOT NULL, summary TEXT NOT NULL,
  artifacts TEXT NOT NULL, verified_facts TEXT NOT NULL, open_risks TEXT NOT NULL, feedback_for_upstream TEXT,
  observed_usage TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, mandate_id TEXT, hypothesis_id TEXT, command TEXT NOT NULL,
  cwd TEXT NOT NULL, pid INTEGER NOT NULL, pgid INTEGER NOT NULL, log_path TEXT NOT NULL, exit_file_path TEXT NOT NULL,
  status TEXT NOT NULL, exit_code INTEGER, started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS flow_runs (flow_id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL, goal TEXT NOT NULL,
  role_chain TEXT NOT NULL, status TEXT NOT NULL, current_index INTEGER NOT NULL, repair_round INTEGER NOT NULL,
  last_handoff_id TEXT, max_repair_rounds INTEGER NOT NULL, snapshot_json TEXT NOT NULL, updated_at TEXT NOT NULL);`;

export interface PersistedFlowCheckpoint {
  flowId: string; mandateId: string; goal: string; roleChain: string[]; status: string;
  currentIndex: number; repairRound: number; lastHandoffId: string | null;
  maxRepairRounds: number; snapshotJson: string; updatedAt: string;
}

interface MandateRow { id: string; rev: number; goal: string; constraints: string; acceptance: string; status: Mandate["status"]; created_at: string; updated_at: string }
interface EpistemicRow { id: string; mandate_id: string; kind: EpistemicKind; statement: string; evidence_ref: string | null; verification_plan: string | null; status: EpistemicStatus; created_at: string }
interface ArtifactRow { path: string; sha256: string; byte_size: number; role: ArtifactRecord["role"] }
interface HandoffRow { id: string; mandate_id: string; mandate_rev: number; parent_handoff_id: string | null; from_role: string; to_target: string; verdict: HandoffEnvelope["verdict"]; summary: string; artifacts: string; verified_facts: string; open_risks: string; feedback_for_upstream: string | null; observed_usage: string | null; created_at: string }
interface JobRow { job_id: string; mandate_id: string | null; hypothesis_id: string | null; command: string; cwd: string; pid: number; pgid: number; log_path: string; exit_file_path: string; status: JobStatus; exit_code: number | null; started_at: string; ended_at: string | null }

const toMandate = (r: MandateRow): Mandate => ({ id: r.id, rev: r.rev, goal: r.goal, constraints: parseArray(r.constraints), acceptance: parseArray(r.acceptance), status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });
const toEpistemicItem = (r: EpistemicRow): EpistemicItem => ({ id: r.id, mandateId: r.mandate_id, kind: r.kind, statement: r.statement, evidenceRef: r.evidence_ref, verificationPlan: r.verification_plan, status: r.status, createdAt: r.created_at });
const toArtifact = (r: ArtifactRow): ArtifactRecord => ({ path: r.path, sha256: r.sha256, byteSize: r.byte_size, role: r.role });
const toHandoff = (r: HandoffRow): HandoffEnvelope => ({
  id: r.id, mandateId: r.mandate_id, mandateRev: r.mandate_rev, parentHandoffId: r.parent_handoff_id,
  fromRole: r.from_role, toTarget: r.to_target, verdict: r.verdict, summary: r.summary,
  artifacts: parseArray(r.artifacts), verifiedFacts: parseArray(r.verified_facts), openRisks: parseArray(r.open_risks),
  feedbackForUpstream: r.feedback_for_upstream,
  observedUsage: r.observed_usage ? JSON.parse(r.observed_usage) as HandoffEnvelope["observedUsage"] : null,
  createdAt: r.created_at,
});
const toJob = (r: JobRow): BackgroundJob => ({
  jobId: r.job_id, mandateId: r.mandate_id, hypothesisId: r.hypothesis_id, command: r.command, cwd: r.cwd,
  pid: r.pid, pgid: r.pgid, logPath: r.log_path, exitFilePath: r.exit_file_path, status: r.status,
  exitCode: r.exit_code, startedAt: r.started_at, endedAt: r.ended_at,
});

export class EnhanceStore {
  private db: Database | null = null;

  constructor(readonly dbPath: string) {}

  private conn(create: boolean): Database | null {
    if (this.db) return this.db;
    if (!create && !existsSync(this.dbPath)) return null;
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    return this.db;
  }

  close(): void { this.db?.close(); this.db = null; }

  upsertMandate(input: { id?: string; goal: string; constraints?: string[]; acceptance?: string[]; status?: Mandate["status"] }): Mandate {
    const db = this.conn(true)!, existing = input.id ? this.getMandate(input.id) : null, ts = now();
    if (!existing) {
      const id = input.id ?? randomUUID(), status = input.status ?? "active";
      if (status === "active") db.query("UPDATE mandates SET status = 'archived', updated_at = ? WHERE status = 'active'").run(ts);
      db.query(`INSERT INTO mandates (id, rev, goal, constraints, acceptance, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, 1, input.goal, JSON.stringify(input.constraints ?? []), JSON.stringify(input.acceptance ?? []), status, ts, ts);
      return this.getMandate(id)!;
    }
    const constraints = input.constraints ?? existing.constraints, acceptance = input.acceptance ?? existing.acceptance;
    const status = input.status ?? existing.status;
    const changed = input.goal !== existing.goal || JSON.stringify(constraints) !== JSON.stringify(existing.constraints)
      || JSON.stringify(acceptance) !== JSON.stringify(existing.acceptance);
    const rev = changed ? existing.rev + 1 : existing.rev, updatedAt = now();
    db.query("UPDATE mandates SET rev = ?, goal = ?, constraints = ?, acceptance = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(rev, input.goal, JSON.stringify(constraints), JSON.stringify(acceptance), status, updatedAt, existing.id);
    return { ...existing, rev, goal: input.goal, constraints, acceptance, status, updatedAt };
  }

  getActiveMandate(): Mandate | null {
    const db = this.conn(false);
    const row = db ? db.query("SELECT * FROM mandates WHERE status = 'active' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as MandateRow | null : null;
    return row ? toMandate(row) : null;
  }

  getMandate(id: string): Mandate | null {
    const db = this.conn(false);
    const row = db ? db.query("SELECT * FROM mandates WHERE id = ?").get(id) as MandateRow | null : null;
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
      evidenceRef, verificationPlan: input.verificationPlan?.trim() || null, status: input.status ?? "open", createdAt: now(),
    };
    this.conn(true)!.query(`INSERT INTO epistemic_items
      (id, mandate_id, kind, statement, evidence_ref, verification_plan, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(item.id, item.mandateId, item.kind, item.statement, item.evidenceRef, item.verificationPlan, item.status, item.createdAt);
    return item;
  }

  updateEpistemicStatus(id: string, status: EpistemicStatus, evidenceRef?: string | null): EpistemicItem {
    const db = this.conn(false);
    const row = db ? db.query("SELECT * FROM epistemic_items WHERE id = ?").get(id) as EpistemicRow | null : null;
    if (!row) throw new Error(`Epistemic item "${id}" not found.`);
    const nextEvidence = evidenceRef === undefined ? row.evidence_ref : evidenceRef?.trim() || null;
    if (row.kind === "fact" && !nextEvidence) throw new Error("Epistemic item of kind 'fact' requires a non-empty evidenceRef.");
    db!.query("UPDATE epistemic_items SET status = ?, evidence_ref = ? WHERE id = ?").run(status, nextEvidence, id);
    return { ...toEpistemicItem(row), status, evidenceRef: nextEvidence };
  }

  listEpistemicItems(mandateId: string): EpistemicItem[] {
    const db = this.conn(false);
    if (!db) return [];
    return (db.query("SELECT * FROM epistemic_items WHERE mandate_id = ? ORDER BY created_at ASC, rowid ASC").all(mandateId) as EpistemicRow[]).map(toEpistemicItem);
  }

  recordArtifacts(mandateId: string, artifacts: readonly ArtifactRecord[]): void {
    if (artifacts.length === 0) return;
    const statement = this.conn(true)!.query(`INSERT OR IGNORE INTO artifacts
      (mandate_id, path, sha256, byte_size, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
    const ts = now();
    for (const artifact of artifacts) statement.run(mandateId, artifact.path, artifact.sha256, artifact.byteSize, artifact.role, ts);
  }

  listArtifacts(mandateId: string): ArtifactRecord[] {
    const db = this.conn(false);
    return db ? db.query("SELECT path, sha256, byte_size, role FROM artifacts WHERE mandate_id = ? ORDER BY path ASC, rowid ASC")
      .all(mandateId).map((row) => toArtifact(row as ArtifactRow)) : [];
  }

  saveHandoff(envelope: HandoffEnvelope): void {
    this.conn(true)!.query(`INSERT OR REPLACE INTO handoffs (id, mandate_id, mandate_rev, parent_handoff_id, from_role,
      to_target, verdict, summary, artifacts, verified_facts, open_risks, feedback_for_upstream, observed_usage, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      envelope.id, envelope.mandateId, envelope.mandateRev, envelope.parentHandoffId, envelope.fromRole,
      envelope.toTarget, envelope.verdict, envelope.summary, JSON.stringify(envelope.artifacts),
      JSON.stringify(envelope.verifiedFacts), JSON.stringify(envelope.openRisks), envelope.feedbackForUpstream,
      envelope.observedUsage ? JSON.stringify(envelope.observedUsage) : null, envelope.createdAt,
    );
  }

  getHandoff(id: string): HandoffEnvelope | null {
    const db = this.conn(false);
    const row = db ? db.query("SELECT * FROM handoffs WHERE id = ?").get(id) as HandoffRow | null : null;
    return row ? toHandoff(row) : null;
  }

  getLatestHandoff(mandateId?: string): HandoffEnvelope | null {
    const db = this.conn(false);
    const row = db ? db.query(`SELECT * FROM handoffs WHERE (? IS NULL OR mandate_id = ?)
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(mandateId ?? null, mandateId ?? null) as HandoffRow | null : null;
    return row ? toHandoff(row) : null;
  }

  listHandoffs(mandateId?: string, limit?: number): HandoffEnvelope[] {
    const db = this.conn(false);
    if (!db) return [];
    const rows = db.query(`SELECT * FROM handoffs WHERE (? IS NULL OR mandate_id = ?)
      ORDER BY created_at DESC, rowid DESC LIMIT COALESCE(?, -1)`).all(mandateId ?? null, mandateId ?? null, limit ?? null) as HandoffRow[];
    return rows.map(toHandoff);
  }

  saveJob(job: BackgroundJob): void {
    this.conn(true)!.query(`INSERT OR REPLACE INTO jobs (job_id, mandate_id, hypothesis_id, command, cwd, pid, pgid,
      log_path, exit_file_path, status, exit_code, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      job.jobId, job.mandateId, job.hypothesisId, job.command, job.cwd, job.pid, job.pgid,
      job.logPath, job.exitFilePath, job.status, job.exitCode, job.startedAt, job.endedAt,
    );
  }

  getJob(jobId: string): BackgroundJob | null {
    const db = this.conn(false);
    const row = db ? db.query("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | null : null;
    return row ? toJob(row) : null;
  }

  listJobs(status?: JobStatus): BackgroundJob[] {
    const db = this.conn(false);
    return db ? db.query("SELECT * FROM jobs WHERE (? IS NULL OR status = ?) ORDER BY started_at DESC, rowid DESC")
      .all(status ?? null, status ?? null).map((row) => toJob(row as JobRow)) : [];
  }

  saveFlowCheckpoint(cp: PersistedFlowCheckpoint): void {
    this.conn(true)!.query(`INSERT OR REPLACE INTO flow_runs (flow_id, mandate_id, goal, role_chain, status,
      current_index, repair_round, last_handoff_id, max_repair_rounds, snapshot_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      cp.flowId, cp.mandateId, cp.goal, JSON.stringify(cp.roleChain), cp.status,
      cp.currentIndex, cp.repairRound, cp.lastHandoffId, cp.maxRepairRounds, cp.snapshotJson, cp.updatedAt,
    );
  }

  getLatestFlowCheckpoint(): PersistedFlowCheckpoint | null {
    const db = this.conn(false);
    const row = db ? db.query("SELECT * FROM flow_runs ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as Record<string, any> | null : null;
    return row ? {
      flowId: String(row.flow_id), mandateId: String(row.mandate_id), goal: String(row.goal),
      roleChain: parseArray<string>(String(row.role_chain)), status: String(row.status),
      currentIndex: Number(row.current_index), repairRound: Number(row.repair_round),
      lastHandoffId: row.last_handoff_id ? String(row.last_handoff_id) : null,
      maxRepairRounds: Number(row.max_repair_rounds), snapshotJson: String(row.snapshot_json), updatedAt: String(row.updated_at),
    } : null;
  }
}
