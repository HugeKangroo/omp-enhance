import type { EnhanceStore, PersistedFlowCheckpoint } from "../core/store.ts";
import type { FlowRoomStatus, FlowStageTrace, FlowUserSteer, RoomEntry } from "../core/types.ts";
import type { ActiveStageControls, FlowRoomSnapshot, StageTurnSummaryLike } from "./state.ts";

const MAX_ASSISTANT_TEXT_CHARS = 16_384;
const DIRECTED_STEER_RE = /^(?:\[@([a-zA-Z0-9][a-zA-Z0-9_-]*)\]|@([a-zA-Z0-9][a-zA-Z0-9_-]*))\s+([\s\S]+)$/;

export function parseDirectedSteer(rawMessage: string): { text: string; targetRole?: string } {
  const clean = rawMessage.trim(), m = DIRECTED_STEER_RE.exec(clean);
  const candidate = m ? (m[1] ?? m[2] ?? "").trim() : "";
  const targetRole = candidate && candidate !== "supervisor" ? candidate : undefined;
  return { text: targetRole && m?.[3] ? m[3].trim() : clean, ...(targetRole ? { targetRole } : {}) };
}

export function isCheckpointResumable(cp: PersistedFlowCheckpoint | null | undefined): boolean {
  return Boolean(
    cp?.flowId && cp.mandateId && cp.roleChain.length > 0 && cp.currentIndex < cp.roleChain.length &&
    (cp.status === "waiting_input" || cp.status === "interrupted" || cp.status === "failed" || cp.status === "cancelled"),
  );
}

export function snapshotFromCheckpoint(cp: PersistedFlowCheckpoint, fallbackCwd?: string): FlowRoomSnapshot {
  let snap: Partial<FlowRoomSnapshot> = {};
  try {
    const parsed: unknown = JSON.parse(cp.snapshotJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) snap = parsed as Partial<FlowRoomSnapshot>;
  } catch {}
  const resolvedCwd = cp.cwd ?? snap.cwd ?? fallbackCwd;
  const steers = Array.isArray(cp.userSteers)
    ? cp.userSteers.map((u) => ({ ...u }))
    : (Array.isArray(snap.userSteers) ? snap.userSteers.map((u) => ({ ...u })) : []);
  return {
    flowId: cp.flowId, mandateId: cp.mandateId, goal: cp.goal, ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
    roleChain: [...cp.roleChain], status: cp.status as FlowRoomStatus,
    currentIndex: cp.currentIndex, repairRound: cp.repairRound,
    ...(typeof snap.reason === "string" && snap.reason ? { reason: snap.reason } : {}),
    startedAt: typeof snap.startedAt === "string" ? snap.startedAt : null,
    endedAt: typeof snap.endedAt === "string" ? snap.endedAt : null,
    activeStageId: cp.status === "running" && typeof snap.activeStageId === "string" ? snap.activeStageId : null,
    entries: Array.isArray(snap.entries) ? snap.entries.map((e) => ({ ...e })) : [],
    stages: Array.isArray(snap.stages)
      ? snap.stages.map((s) => ({ ...s, calls: (s.calls ?? []).map((c) => ({ ...c, touchedPaths: [...(c.touchedPaths ?? [])] })), notes: [...(s.notes ?? [])] }))
      : [],
    userSteers: steers,
    ...(snap.graphSnapshot ? { graphSnapshot: snap.graphSnapshot } : {}),
  };
}

export function computeMaxIdSeq(entries: readonly RoomEntry[], stages: readonly FlowStageTrace[]): number {
  let max = 0;
  for (const e of entries) for (const m of e.id.matchAll(/(\d+)/g)) max = Math.max(max, Number(m[1]));
  for (const s of stages) for (const m of s.stageId.matchAll(/(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export function syncSteerRecord(
  userSteers: FlowUserSteer[],
  insertEntry: (entry: RoomEntry) => void,
  entries: RoomEntry[],
  nextSeq: () => number,
  s: FlowUserSteer,
  deliveredLive: boolean,
  stageId?: string | null,
): boolean {
  const idx = s.steerId ? userSteers.findIndex((u) => u.steerId === s.steerId) : -1;
  if (idx >= 0) {
    userSteers[idx] = { ...userSteers[idx]!, ...s };
    if (deliveredLive && s.steerId) {
      const bubble = entries.find((e) => e.id === `steer-${s.steerId}`);
      if (bubble) bubble.badge = "插话";
    }
    return false;
  }
  userSteers.push({ ...s });
  const entryId = s.steerId ? `steer-${s.steerId}` : `user-${nextSeq()}`;
  if (!entries.some((e) => e.id === entryId)) {
    insertEntry({
      id: entryId, side: "right", speaker: "你", ...(s.targetRole ? { target: s.targetRole } : {}),
      badge: deliveredLive ? "插话" : (s.targetRole ? `@${s.targetRole}` : "留言"),
      tone: "success", text: s.targetRole ? `[@${s.targetRole}] ${s.text}` : s.text,
      timestamp: s.createdAt, ...(stageId && deliveredLive ? { stageId } : {}),
    });
  }
  return true;
}

export async function drainPendingFlowSteers(ctx: {
  store: EnhanceStore;
  flowId: string;
  stages: FlowStageTrace[];
  controlStack: ReadonlyArray<{ stageId: string; controls: ActiveStageControls }>;
  activeStageId: string | null;
  syncSteer: (s: FlowUserSteer, deliveredLive: boolean, stageId?: string | null) => boolean;
  onChanged: (persisted: boolean) => void;
  info?: { roleId?: string; stageId?: string; phase?: "pre_stage" | "mid_stage" };
}): Promise<number> {
  const allDbSteers = ctx.store.listFlowSteers(ctx.flowId);
  let addedNew = false;
  for (const s of allDbSteers) if (ctx.syncSteer(s, false)) addedNew = true;

  const unconsumed = allDbSteers.filter((s) => !s.consumedAt && Boolean(s.steerId));
  if (unconsumed.length === 0) {
    if (addedNew) ctx.onChanged(false);
    return 0;
  }

  if (ctx.info?.phase === "pre_stage" && ctx.info.roleId && ctx.info.stageId) {
    const matching = unconsumed.filter((s) => !s.targetRole || s.targetRole === ctx.info!.roleId);
    if (matching.length === 0) { if (addedNew) ctx.onChanged(false); return 0; }
    const count = ctx.store.markFlowSteersConsumed(ctx.flowId, matching.map((s) => s.steerId!), ctx.info.stageId);
    const ts = new Date().toISOString();
    for (const s of matching) ctx.syncSteer({ ...s, consumedAt: ts, consumedByStage: ctx.info.stageId }, false);
    if (count > 0 || addedNew) ctx.onChanged(true);
    return count;
  }

  const topControl = ctx.controlStack.at(-1) ?? null;
  if (!topControl) { if (addedNew) ctx.onChanged(false); return 0; }
  const currentStageId = ctx.info?.stageId ?? topControl.stageId ?? ctx.activeStageId;
  const activeStage = currentStageId ? ctx.stages.find((st) => st.stageId === currentStageId) : undefined;
  const activeRoleId = ctx.info?.roleId ?? activeStage?.roleId;
  if (!currentStageId || !activeRoleId) { if (addedNew) ctx.onChanged(false); return 0; }

  let deliveredCount = 0;
  for (const s of unconsumed) {
    if (s.targetRole && s.targetRole !== activeRoleId) continue;
    if (!ctx.controlStack.some((c) => c.stageId === topControl.stageId)) break;
    const claimed = ctx.store.markFlowSteersConsumed(ctx.flowId, [s.steerId!], currentStageId);
    if (claimed > 0) {
      await topControl.controls.steer(s.text);
      if (activeStage) activeStage.notes.push(`你插话: ${s.text}`);
      ctx.syncSteer({ ...s, consumedAt: new Date().toISOString(), consumedByStage: currentStageId }, true, currentStageId);
      deliveredCount += 1;
    }
  }
  if (deliveredCount > 0 || addedNew) ctx.onChanged(true);
  return deliveredCount;
}

export function applyStageEndToRoom(input: {
  stageId: string;
  status: "ready" | "needs_input" | "rejected" | "blocked" | "violation" | "host_error" | "missing_handoff" | "aborted";
  outcome: StageTurnSummaryLike | null;
  reason?: string;
  hostError?: string | null;
  stages: FlowStageTrace[];
  entries: RoomEntry[];
  roleChain: readonly string[];
}): string | null {
  const { stageId, status, outcome, reason, hostError, stages, entries, roleChain } = input;
  const st = stages.find((s) => s.stageId === stageId), effHostErr = hostError ?? outcome?.hostError ?? null;
  if (st) {
    st.status = status; st.endedAt = new Date().toISOString(); st.activeTool = null;
    if (effHostErr) st.hostError = effHostErr;
    const raw = outcome?.assistantText ?? "";
    st.assistantText = raw.length > MAX_ASSISTANT_TEXT_CHARS ? `${raw.slice(0, MAX_ASSISTANT_TEXT_CHARS)}…` : raw;
    st.envelope = outcome?.envelope ?? null;
    for (const c of outcome?.observedCalls ?? []) if (!st.calls.some((p) => p.toolCallId === c.toolCallId)) st.calls.push(c);
  }
  const en = entries.find((e) => e.id === `stage-${stageId}`);
  if (en) {
    if (status === "ready") {
      en.badge = "✓ ready"; en.tone = "success"; en.text = outcome?.envelope?.summary ?? (outcome?.assistantText || "阶段完成");
    } else if (status === "needs_input") {
      en.badge = "? 待确认"; en.tone = "warning"; en.target = "user";
      const qs = outcome?.envelope?.questionsForUser;
      en.text = qs?.length ? `${outcome?.envelope?.summary ?? ""}\n• ${qs.join("\n• ")}`.trim() : (outcome?.envelope?.summary ?? reason ?? "需补充信息后继续");
    } else if (status === "rejected") {
      en.badge = "✕ rejected"; en.tone = "warning";
      en.target = outcome?.envelope?.toTarget && outcome.envelope.toTarget !== en.speaker
        ? outcome.envelope.toTarget : (roleChain[0] && roleChain[0] !== en.speaker ? roleChain[0] : "user");
      en.text = outcome?.envelope?.feedbackForUpstream ?? outcome?.envelope?.summary ?? reason ?? "验收未通过";
    } else if (status === "blocked") {
      en.badge = "! blocked"; en.tone = "warning"; en.target = "user";
      en.text = outcome?.envelope?.summary ?? reason ?? "阶段受阻，需你确认";
    } else {
      en.badge = status === "aborted" ? "⏹ aborted" : status === "host_error" ? "! 服务异常" : status === "missing_handoff" ? "! 未交接" : "✕ violation";
      en.tone = "error"; en.target = "user"; en.text = reason ?? outcome?.envelope?.summary ?? "执行中止";
    }
  }
  return [...stages].reverse().find((s) => s.status === "running")?.stageId ?? null;
}
