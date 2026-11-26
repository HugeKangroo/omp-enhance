import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { FlowBoardEntry, FlowBoardKind, FlowLeaseMode } from "./graph-types.ts";
import {
  hasTable,
  inferStoreCwd,
  isProcessAliveWithToken,
  type LeaseRow,
  mutateSnapshotForInterrupt,
  ProjectBusyError,
  type ProjectFlowLease,
  safeParseObject,
  toLease,
} from "./store-schema.ts";

export interface BoardEventRow {
  seq: number;
  event_id: string;
  flow_id: string;
  node_id: string | null;
  kind: FlowBoardKind;
  speaker: string;
  target: string | null;
  payload_json: string;
  created_at: string;
  consumed_at: string | null;
  consumed_by_node: string | null;
}

export const BOARD_SCHEMA_TABLE =
  "CREATE TABLE IF NOT EXISTS flow_board_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, flow_id TEXT NOT NULL REFERENCES flow_runs(flow_id) ON DELETE CASCADE, node_id TEXT, kind TEXT NOT NULL, speaker TEXT NOT NULL, target TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, consumed_at TEXT, consumed_by_node TEXT);";

export const BOARD_SCHEMA_INDEX =
  "CREATE INDEX IF NOT EXISTS idx_flow_board_flow_seq ON flow_board_events(flow_id, seq ASC);";

export const GRAPH_COLUMN_MIGRATIONS: ReadonlyArray<[table: string, column: string, ddl: string]> = [
  ["flow_runs", "graph_spec_json", "TEXT"],
  ["flow_runs", "machine_state_json", "TEXT"],
  ["flow_runs", "lease_mode", "TEXT"],
];

export function toFlowBoardEntry(row: BoardEventRow): FlowBoardEntry {
  const payload = safeParseObject<{ text?: string; metadata?: Record<string, unknown> }>(row.payload_json) ?? {};
  return {
    seq: row.seq,
    eventId: row.event_id,
    flowId: row.flow_id,
    ...(row.node_id ? { nodeId: row.node_id } : {}),
    kind: row.kind,
    speaker: row.speaker,
    ...(row.target ? { target: row.target } : {}),
    text: typeof payload.text === "string" ? payload.text : row.payload_json,
    ...(payload.metadata ? { metadata: payload.metadata } : {}),
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
    consumedByNode: row.consumed_by_node,
  };
}

export function leaseKeyForMode(flowId: string, mode: FlowLeaseMode): string {
  if (mode === "read") return `read:${flowId}`;
  if (mode === "write_worktree") return `worktree:${flowId}`;
  return "active_flow";
}

export function runAppendBoardEventTx(
  db: Database,
  flowId: string,
  entry: Omit<FlowBoardEntry, "seq" | "eventId" | "flowId" | "createdAt"> & { eventId?: string; createdAt?: string },
  ts: string,
): FlowBoardEntry {
  const exists = db.query("SELECT 1 FROM flow_runs WHERE flow_id = ? LIMIT 1").get(flowId);
  if (!exists) throw new Error(`Unknown flowId "${flowId}".`);
  const eventId = entry.eventId?.trim() || `bev-${randomUUID()}`;
  const dup = db.query("SELECT * FROM flow_board_events WHERE event_id = ?").get(eventId) as BoardEventRow | null;
  if (dup) return toFlowBoardEntry(dup);
  const createdAt = entry.createdAt ?? ts;
  const payloadJson = JSON.stringify({
    text: entry.text,
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
  });
  db.query(
    "INSERT INTO flow_board_events (event_id, flow_id, node_id, kind, speaker, target, payload_json, created_at, consumed_at, consumed_by_node) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
  ).run(eventId, flowId, entry.nodeId ?? null, entry.kind, entry.speaker, entry.target ?? null, payloadJson, createdAt);
  return toFlowBoardEntry(db.query("SELECT * FROM flow_board_events WHERE event_id = ?").get(eventId) as BoardEventRow);
}

export function listBoardEventsQuery(
  db: Database,
  flowId: string,
  opts?: { afterSeq?: number; seqs?: readonly number[]; limit?: number; target?: string },
): FlowBoardEntry[] {
  if (!hasTable(db, "flow_board_events")) return [];
  if (opts?.seqs && opts.seqs.length > 0) {
    const clean = [...new Set(opts.seqs.filter((n) => Number.isInteger(n) && n > 0))];
    if (clean.length === 0) return [];
    const ph = clean.map(() => "?").join(",");
    const rows = db.query(`SELECT * FROM flow_board_events WHERE flow_id = ? AND seq IN (${ph}) ORDER BY seq ASC`).all(flowId, ...clean) as BoardEventRow[];
    return rows.map(toFlowBoardEntry);
  }
  const lim = opts?.limit && opts.limit > 0 ? opts.limit : -1;
  const rows = db.query(
    "SELECT * FROM flow_board_events WHERE flow_id = ? AND (? IS NULL OR seq > ?) AND (? IS NULL OR target IS NULL OR target = 'all' OR target = ?) ORDER BY seq ASC LIMIT ?",
  ).all(flowId, opts?.afterSeq ?? null, opts?.afterSeq ?? null, opts?.target ?? null, opts?.target ?? null, lim) as BoardEventRow[];
  return rows.map(toFlowBoardEntry);
}

export function runAcquireScopedLeaseTx(
  db: Database,
  dbPath: string,
  targetFlowId: string,
  mode: FlowLeaseMode,
  pid: number,
  token: string | null | undefined,
  reqLeaseToken: string | undefined,
  ts: string,
): { leaseToken: string; stateVersion: number; leaseKey: string } {
  const leaseKey = leaseKeyForMode(targetFlowId, mode);
  const existing = db.query("SELECT * FROM project_leases WHERE lease_key = ?").get(leaseKey) as LeaseRow | null;
  const sameOwner = Boolean(
    existing && existing.flow_id === targetFlowId && (
      reqLeaseToken ? existing.lease_token === reqLeaseToken : (existing.owner_pid === pid && (existing.owner_start_token ?? null) === (token ?? null))
    ),
  );
  if (existing && !sameOwner) {
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
      db.query("UPDATE flow_runs SET status = 'interrupted', owner_pid = NULL, owner_start_token = NULL, lease_token = NULL, state_version = COALESCE(state_version, 0) + 1, snapshot_json = ?, updated_at = ? WHERE flow_id = ?")
        .run(mutateSnapshotForInterrupt(flowRow.snapshot_json, ts), ts, existing.flow_id);
    }
  }
  const effectiveLeaseToken = sameOwner
    ? (reqLeaseToken?.trim() || existing!.lease_token || randomUUID())
    : (reqLeaseToken?.trim() || randomUUID());
  const targetRow = db.query("SELECT state_version FROM flow_runs WHERE flow_id = ?").get(targetFlowId) as { state_version: number | null } | null;
  const nextVersion = Number(targetRow?.state_version ?? 0) + 1;
  db.query("INSERT OR REPLACE INTO project_leases (lease_key, flow_id, owner_pid, owner_start_token, lease_token, acquired_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(leaseKey, targetFlowId, pid, token ?? null, effectiveLeaseToken, ts);
  if (targetRow) {
    db.query("UPDATE flow_runs SET lease_token = ?, lease_mode = ?, owner_pid = ?, owner_start_token = ?, state_version = ?, updated_at = ? WHERE flow_id = ?")
      .run(effectiveLeaseToken, mode, pid, token ?? null, nextVersion, ts, targetFlowId);
  }
  return { leaseToken: effectiveLeaseToken, stateVersion: nextVersion, leaseKey };
}

export function findFlowLeaseRow(db: Database, flowId: string): LeaseRow | null {
  if (!hasTable(db, "project_leases")) return null;
  return (db.query("SELECT * FROM project_leases WHERE lease_key = 'active_flow' AND flow_id = ?").get(flowId) as LeaseRow | null)
    ?? (db.query("SELECT * FROM project_leases WHERE flow_id = ? LIMIT 1").get(flowId) as LeaseRow | null)
    ?? (db.query("SELECT * FROM project_leases WHERE lease_key = 'active_flow'").get() as LeaseRow | null);
}

export function releaseScopedLeaseQuery(db: Database, flowId?: string, expectedLeaseToken?: string | null): boolean {
  if (!hasTable(db, "project_leases")) return false;
  if (expectedLeaseToken !== undefined) {
    return db.query("DELETE FROM project_leases WHERE (? IS NULL OR flow_id = ?) AND lease_token IS ?")
      .run(flowId ?? null, flowId ?? null, expectedLeaseToken).changes > 0;
  }
  if (flowId) return db.query("DELETE FROM project_leases WHERE flow_id = ?").run(flowId).changes > 0;
  return db.query("DELETE FROM project_leases WHERE lease_key = 'active_flow'").run().changes > 0;
}

export function listActiveLeasesQuery(db: Database): Array<ProjectFlowLease & { leaseKey: string }> {
  if (!hasTable(db, "project_leases")) return [];
  const rows = db.query("SELECT * FROM project_leases ORDER BY acquired_at DESC").all() as LeaseRow[];
  return rows.map((r) => ({ ...toLease(r), leaseKey: r.lease_key }));
}
