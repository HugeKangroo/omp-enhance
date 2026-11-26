import type {
  FlowCommand,
  FlowGraphNodeView,
  FlowGraphSnapshot,
  FlowMachineState,
  FlowNodeRuntime,
  FlowNodeSpec,
  NodeStatus,
} from "../core/graph-types.ts";
import { computeAncestorMap, computeDescendantMap } from "./graph.ts";

export interface MachineTransitionOptions {
  isRoleReadOnly?: (roleId: string) => boolean;
}

const HARD_FAILURE_NODE_STATUSES = new Set<NodeStatus>(["failed", "violation", "blocked", "cancelled"]);

export function makeNodeRuntime(node: FlowNodeSpec, waveIndex: number, effectiveWorkspace: "inherit" | "worktree"): FlowNodeRuntime {
  return {
    nodeId: node.id, status: "pending", waveIndex, effectiveWorkspace, sessionResidency: "none",
    attempt: 0, repairRound: 0, activeStageId: null, worktreePath: null, commitRef: null,
    currentModel: null, triedModels: [], lastHandoffId: null, lastHandoff: null,
    lastGateEvidence: null, lastError: null, lastRepairFeedback: null, questionsForUser: [],
    startedAt: null, endedAt: null,
  };
}

export function cloneState(state: FlowMachineState): FlowMachineState {
  const nodes: Record<string, FlowNodeRuntime> = {};
  for (const [id, rt] of Object.entries(state.nodes)) {
    nodes[id] = {
      ...rt,
      triedModels: [...rt.triedModels],
      questionsForUser: [...rt.questionsForUser],
      ...(rt.subState ? { subState: cloneState(rt.subState) } : {}),
    };
  }
  return {
    ...state,
    spec: { ...state.spec, nodes: state.spec.nodes.map((n) => ({ ...n, dependsOn: [...n.dependsOn] })), policies: { ...state.spec.policies } },
    nodes,
    nodeOrder: [...state.nodeOrder],
    waves: state.waves.map((w) => [...w]),
  };
}

export const getNodeSpec = (state: FlowMachineState, nodeId: string): FlowNodeSpec | undefined =>
  state.spec.nodes.find((n) => n.id === nodeId);

export function buildFlowGraphSnapshot(state: FlowMachineState): FlowGraphSnapshot {
  const specById = new Map(state.spec.nodes.map((n) => [n.id, n]));
  const nodes: FlowGraphNodeView[] = state.nodeOrder.map((id) => {
    const spec = specById.get(id)!, rt = state.nodes[id]!;
    let subProgress: FlowGraphNodeView["subProgress"];
    if (rt.subState) {
      const subSpecById = new Map(rt.subState.spec.nodes.map((n) => [n.id, n]));
      const phases = rt.subState.nodeOrder.map((pid) => {
        const ps = subSpecById.get(pid)!, prt = rt.subState!.nodes[pid]!;
        return { id: pid, title: ps.title ?? pid, kind: ps.kind, status: prt.status };
      });
      const completed = phases.filter((p) => p.status === "succeeded" || p.status === "skipped").length;
      const activePhaseId = phases.find((p) => p.status === "running" || p.status === "waiting_input")?.id;
      subProgress = { completed, total: phases.length, ...(activePhaseId ? { activePhaseId } : {}), phases };
    }
    return {
      nodeId: id, title: spec.title ?? spec.role ?? id, kind: spec.kind,
      ...(spec.role ? { role: spec.role } : {}), waveIndex: rt.waveIndex, dependsOn: [...spec.dependsOn],
      status: rt.status, workspace: rt.effectiveWorkspace, worktreePath: rt.worktreePath,
      ...(spec.writableScope ? { writableScope: [...spec.writableScope] } : {}),
      sessionResidency: rt.sessionResidency, attempt: rt.attempt, repairRound: rt.repairRound,
      currentModel: rt.currentModel, triedModels: [...rt.triedModels], activeStageId: rt.activeStageId,
      ...(rt.questionsForUser.length > 0 ? { questionsForUser: [...rt.questionsForUser] } : {}),
      ...(subProgress ? { subProgress } : {}),
      ...(rt.lastHandoff?.summary ? { summary: rt.lastHandoff.summary } : rt.lastReply ? { summary: rt.lastReply } : rt.lastError ? { summary: rt.lastError } : {}),
    };
  });
  return { preset: state.spec.preset ?? "custom", waves: state.waves.map((w) => [...w]), nodes, mergedRef: state.mergedRef };
}

function inferNearestWritableAncestor(state: FlowMachineState, fromNodeId: string, isRoleReadOnly?: (roleId: string) => boolean): string | null {
  const ancestors = computeAncestorMap(state.spec.nodes).get(fromNodeId);
  if (!ancestors || ancestors.size === 0) return null;
  const specById = new Map(state.spec.nodes.map((n) => [n.id, n]));
  const candidates = [...ancestors]
    .map((id) => ({ id, spec: specById.get(id), wave: state.nodes[id]?.waveIndex ?? 0 }))
    .filter((c) => c.spec?.kind === "role" && c.spec.role && !(isRoleReadOnly?.(c.spec.role) ?? false));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (state.spec.preset === "linear" ? a.wave - b.wave : b.wave - a.wave));
  return candidates[0]!.id;
}

function isPureReadOnlyGraph(state: FlowMachineState, isRoleReadOnly?: (roleId: string) => boolean): boolean {
  if (!isRoleReadOnly) return false;
  return state.spec.nodes.every((n) => (n.kind === "role" && n.role ? isRoleReadOnly(n.role) : n.kind === "human" || n.kind === "native_task"));
}

export function emitTerminalCleanup(next: FlowMachineState, commands: FlowCommand[], kind: "settled" | "conflict" = "settled"): void {
  for (const id of next.nodeOrder) {
    const rt = next.nodes[id]!;
    if (rt.sessionResidency === "warm" || rt.sessionResidency === "hibernated") {
      rt.sessionResidency = "disposed";
      commands.push({ type: "DISPOSE_SESSION", nodeId: id });
    }
  }
  if (next.nodeOrder.some((id) => next.nodes[id]!.worktreePath !== null)) {
    commands.push({ type: "CLEANUP_WORKTREES", flowId: next.flowId });
  }
  commands.push({ type: "APPEND_BOARD", entry: { kind: "done", speaker: "flow", target: "all", text: `[${next.status}] ${next.reason ?? next.spec.goal}` } });
  commands.push({ type: "WAKE_COORDINATOR", kind, summary: next.reason ?? next.spec.goal });
}

function findUpstreamPreviewMergeRef(state: FlowMachineState, nodeId: string): string | null {
  const ancestors = computeAncestorMap(state.spec.nodes).get(nodeId);
  if (!ancestors || ancestors.size === 0) return null;
  const specById = new Map(state.spec.nodes.map((n) => [n.id, n]));
  const hits = [...ancestors]
    .map((id) => ({ id, spec: specById.get(id), rt: state.nodes[id] }))
    .filter((c) => c.spec?.kind === "merge" && c.spec.merge?.landingMode === "branch_preview" && Boolean(c.rt?.commitRef))
    .sort((a, b) => (b.rt!.waveIndex - a.rt!.waveIndex));
  return hits[0]?.rt?.commitRef ?? null;
}

export function dispatchSingleNode(
  next: FlowMachineState,
  nodeId: string,
  commands: FlowCommand[],
  nowIso: string,
  extra?: { replyText?: string; modelOverride?: string },
): void {
  const spec = getNodeSpec(next, nodeId)!, rt = next.nodes[nodeId]!;
  if (spec.kind === "role" && rt.effectiveWorkspace === "worktree" && !rt.worktreePath) {
    rt.status = "running";
    if (!rt.startedAt) rt.startedAt = nowIso;
    commands.push({ type: "PREPARE_WORKTREE", nodeId, dependsOn: [...spec.dependsOn] });
    return;
  }

  next.nextStageSeq += 1;
  const stageId = `step-${next.nextStageSeq}-r${rt.repairRound}-${nodeId}`;
  rt.activeStageId = stageId; rt.attempt += 1; rt.endedAt = null;
  if (!rt.startedAt) rt.startedAt = nowIso;

  if (spec.kind === "human") {
    rt.status = "waiting_input"; rt.questionsForUser = [spec.human!.prompt];
    commands.push({ type: "RUN_HUMAN_NODE", nodeId, stageId, config: spec.human! });
    commands.push({ type: "APPEND_BOARD", entry: { nodeId, kind: "system", speaker: nodeId, target: "user", text: `等待确认: ${spec.human!.prompt}` } });
    return;
  }

  rt.status = "running";
  if (spec.kind === "role") {
    const reuseSession = Boolean(next.spec.policies.enableSessionReuse && rt.sessionResidency === "warm" && spec.sessionMode !== "fresh");
    const previewRef = !rt.worktreePath ? findUpstreamPreviewMergeRef(next, nodeId) : null;
    commands.push({
      type: "DISPATCH_ROLE_NODE", nodeId, stageId, attempt: rt.attempt, repairRound: rt.repairRound, reuseSession,
      ...(spec.sessionMode === "fork" && spec.forkFromNodeId ? { forkFromNodeId: spec.forkFromNodeId } : {}),
      ...(rt.worktreePath ? { worktreePath: rt.worktreePath } : {}),
      ...(previewRef ? { targetCommitRef: previewRef } : {}),
      ...(extra?.modelOverride ? { modelOverride: extra.modelOverride } : {}),
      ...(rt.lastRepairFeedback ? { repairFeedback: rt.lastRepairFeedback } : {}),
      ...(extra?.replyText ? { replyText: extra.replyText } : {}),
    });
  } else if (spec.kind === "gate") {
    const previewRef = findUpstreamPreviewMergeRef(next, nodeId);
    const depWt = previewRef ? undefined : (spec.dependsOn.map((d) => next.nodes[d]?.worktreePath).find(Boolean) ?? undefined);
    commands.push({
      type: "RUN_GATE_NODE", nodeId, stageId, attempt: rt.attempt,
      ...(previewRef ? { targetCommitRef: previewRef } : {}),
      ...(depWt ? { worktreePath: depWt } : {}), config: spec.gate!,
    });
  } else if (spec.kind === "merge") {
    const sourceRefs: Record<string, string> = {};
    for (const srcId of spec.merge!.sourceNodeIds) { const ref = next.nodes[srcId]?.commitRef; if (ref) sourceRefs[srcId] = ref; }
    commands.push({ type: "RUN_MERGE_NODE", nodeId, stageId, attempt: rt.attempt, sourceNodeIds: [...spec.merge!.sourceNodeIds], sourceRefs, config: spec.merge! });
  } else if (spec.kind === "native_task") {
    commands.push({ type: "RUN_NATIVE_TASK_NODE", nodeId, stageId, attempt: rt.attempt, config: spec.nativeTask! });
  }
}

export function scheduleReadyNodes(next: FlowMachineState, commands: FlowCommand[], nowIso: string, replyByNode?: Map<string, string>): void {
  if (next.status !== "running") return;
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of next.nodeOrder) {
      const rt = next.nodes[id]!;
      if (rt.status !== "pending") continue;
      const spec = getNodeSpec(next, id)!, deps = spec.dependsOn;
      if (deps.length === 0) { rt.status = "ready"; changed = true; continue; }
      const depStatuses = deps.map((d) => next.nodes[d]?.status ?? "failed");
      const allDone = depStatuses.every((s) => s === "succeeded" || s === "skipped");
      const anySucceeded = depStatuses.some((s) => s === "succeeded");
      const anyHardFail = depStatuses.some((s) => HARD_FAILURE_NODE_STATUSES.has(s));
      const allHardFailOrSkipped = depStatuses.every((s) => HARD_FAILURE_NODE_STATUSES.has(s) || s === "skipped");
      if ((spec.join ?? "all") === "any") {
        if (anySucceeded) { rt.status = "ready"; changed = true; }
        else if (allHardFailOrSkipped && spec.skipOnUpstreamFail) { rt.status = "skipped"; rt.endedAt = nowIso; changed = true; }
      } else if (allDone) {
        if (depStatuses.every((s) => s === "skipped") && spec.skipOnUpstreamFail) { rt.status = "skipped"; rt.endedAt = nowIso; }
        else rt.status = "ready";
        changed = true;
      } else if (anyHardFail && spec.skipOnUpstreamFail) {
        rt.status = "skipped"; rt.endedAt = nowIso; changed = true;
      }
    }
  }
  let runningCount = next.nodeOrder.filter((id) => next.nodes[id]!.status === "running").length;
  const readyIds = next.nodeOrder
    .filter((id) => next.nodes[id]!.status === "ready")
    .sort((a, b) => (next.nodes[a]!.waveIndex - next.nodes[b]!.waveIndex) || (next.nodeOrder.indexOf(a) - next.nodeOrder.indexOf(b)));
  for (const id of readyIds) {
    if (runningCount >= next.spec.policies.maxConcurrency) break;
    dispatchSingleNode(next, id, commands, nowIso, { ...(replyByNode?.has(id) ? { replyText: replyByNode.get(id) } : {}) });
    if (next.nodes[id]!.status === "running") runningCount += 1;
  }
}

export function formatWaitingNodesReason(state: FlowMachineState, waitingNodes: readonly string[]): string {
  if (waitingNodes.length === 1) {
    const id = waitingNodes[0]!, first = state.nodes[id]!;
    const qs = first.questionsForUser.length ? ` (${first.questionsForUser.join("; ")})` : "";
    return `[${id}] ${first.lastHandoff?.summary ?? first.questionsForUser[0] ?? "需要用户确认"}${qs}`;
  }
  return waitingNodes.map((id) => {
    const rt = state.nodes[id]!;
    const q = rt.questionsForUser.length ? rt.questionsForUser.join("; ") : (rt.lastHandoff?.summary ?? "需要用户确认");
    return `[${id}] ${q}`;
  }).join(" | ");
}

export function evaluateFlowSettlement(
  next: FlowMachineState, commands: FlowCommand[], nowIso: string, allowActiveOnTargetedResume = false,
): void {
  if (next.status !== "running") return;
  const statuses = next.nodeOrder.map((id) => next.nodes[id]!.status);
  const active = statuses.some((s) => s === "running" || s === "ready" || s === "retrying");
  const waitingNodes = next.nodeOrder.filter((id) => next.nodes[id]!.status === "waiting_input");
  const shouldPauseForWaiting = waitingNodes.length > 0 && (!active || (next.spec.policies.pauseOnWaitingInput === "whole_flow" && !allowActiveOnTargetedResume));
  if (shouldPauseForWaiting) {
    next.status = "waiting_input";
    next.reason = formatWaitingNodesReason(next, waitingNodes);
    commands.push({ type: "WAKE_COORDINATOR", kind: "needs_input", summary: next.reason, ...(waitingNodes.length === 1 ? { nodeId: waitingNodes[0] } : {}) });
    return;
  }
  if (active) return;
  const pick = (st: NodeStatus) => next.nodeOrder.find((id) => next.nodes[id]!.status === st);
  const viol = pick("violation"), blocked = pick("blocked"), failed = pick("failed");
  if (viol) { next.status = "violation"; next.endedAt = nowIso; next.reason = next.nodes[viol]!.lastError ?? `Node "${viol}" violated boundaries.`; emitTerminalCleanup(next, commands); return; }
  if (blocked) { next.status = "blocked"; next.endedAt = nowIso; next.reason = next.nodes[blocked]!.lastError ?? next.nodes[blocked]!.lastHandoff?.summary ?? `Node "${blocked}" blocked.`; emitTerminalCleanup(next, commands); return; }
  if (failed) { next.status = "failed"; next.endedAt = nowIso; next.reason = next.nodes[failed]!.lastError ?? `Node "${failed}" failed.`; emitTerminalCleanup(next, commands); return; }
  if (statuses.every((s) => s === "succeeded" || s === "skipped")) { next.status = "completed"; next.endedAt = nowIso; emitTerminalCleanup(next, commands); }
}

export function handleRejection(
  next: FlowMachineState, fromNodeId: string, feedback: string, explicitTarget: string | undefined,
  commands: FlowCommand[], nowIso: string, opts?: MachineTransitionOptions,
): void {
  const fromSpec = getNodeSpec(next, fromNodeId);
  const descMap = computeDescendantMap(next.spec.nodes);
  if (isPureReadOnlyGraph(next, opts?.isRoleReadOnly) && (descMap.get(fromNodeId)?.size ?? 0) === 0) {
    next.nodes[fromNodeId]!.status = "succeeded"; next.nodes[fromNodeId]!.endedAt = nowIso; next.reason = feedback;
    evaluateFlowSettlement(next, commands, nowIso);
    return;
  }
  const targetId = explicitTarget ?? fromSpec?.repairTargetNodeId ?? fromSpec?.gate?.repairTargetNodeId ?? inferNearestWritableAncestor(next, fromNodeId, opts?.isRoleReadOnly) ?? undefined;
  if (!targetId || !next.nodes[targetId]) {
    next.nodes[fromNodeId]!.status = "blocked"; next.nodes[fromNodeId]!.lastError = feedback; next.nodes[fromNodeId]!.endedAt = nowIso;
    evaluateFlowSettlement(next, commands, nowIso);
    return;
  }
  const sig = `${targetId}:${feedback.trim().toLowerCase().replace(/\s+/g, " ")}`;
  if (next.lastRejectionSig !== null && next.lastRejectionSig === sig) {
    next.status = "stagnated"; next.endedAt = nowIso; next.reason = "Identical rejection feedback repeated without progress.";
    emitTerminalCleanup(next, commands); return;
  }
  if (next.repairRound >= next.maxRepairRounds) {
    next.status = "rejected_max_rounds"; next.endedAt = nowIso; next.reason = `Exceeded maxRepairRounds (${next.maxRepairRounds}).`;
    emitTerminalCleanup(next, commands); return;
  }
  next.repairRound += 1; next.lastRejectionSig = sig;
  const dirty = new Set<string>([targetId, ...(descMap.get(targetId) ?? []), fromNodeId]);
  for (const id of dirty) {
    const rt = next.nodes[id]!;
    if (rt.status === "running" && id !== fromNodeId) commands.push({ type: "ABORT_NODE", nodeId: id, reason: `Invalidated by ${fromNodeId}` });
    rt.status = id === targetId ? "ready" : "pending";
    rt.repairRound = next.repairRound; rt.activeStageId = null; rt.endedAt = null; rt.lastError = null;
    rt.lastRepairFeedback = id === targetId ? feedback : null;
  }
  commands.push({ type: "APPEND_BOARD", entry: { nodeId: fromNodeId, kind: "repair_feedback", speaker: fromNodeId, target: targetId, text: `[R${next.repairRound}] ${feedback}` } });
  scheduleReadyNodes(next, commands, nowIso);
  evaluateFlowSettlement(next, commands, nowIso);
}

export function handleResilienceRecovery(
  next: FlowMachineState, nodeId: string, reason: string, retryable: boolean,
  currentModel: string | undefined, commands: FlowCommand[], nowIso: string,
): void {
  const spec = getNodeSpec(next, nodeId)!, rt = next.nodes[nodeId]!;
  const activeModel = currentModel ?? rt.currentModel;
  if (activeModel && !rt.triedModels.includes(activeModel)) rt.triedModels.push(activeModel);
  const nextFallback = (spec.fallbackModels ?? []).find((m) => m && !rt.triedModels.includes(m));
  if (nextFallback && spec.kind === "role" && rt.activeStageId) {
    rt.attempt += 1; rt.currentModel = nextFallback; rt.triedModels.push(nextFallback); rt.status = "running";
    commands.push({ type: "APPEND_BOARD", entry: { nodeId, kind: "system", speaker: "flow", target: nodeId, text: `模型热切 ${activeModel ?? "default"} → ${nextFallback} (${reason})` } });
    commands.push({ type: "SWITCH_MODEL_AND_RESUME", nodeId, stageId: rt.activeStageId, nextModel: nextFallback, reason, attempt: rt.attempt });
    return;
  }
  const maxAttempts = spec.maxAttempts ?? 2;
  if (retryable && rt.attempt < maxAttempts) {
    rt.status = "ready"; rt.activeStageId = null; rt.lastError = reason;
    commands.push({ type: "APPEND_BOARD", entry: { nodeId, kind: "system", speaker: "flow", target: nodeId, text: `重试节点 ${nodeId} (${rt.attempt}/${maxAttempts}): ${reason}` } });
    scheduleReadyNodes(next, commands, nowIso);
    return;
  }
  rt.status = "failed"; rt.endedAt = nowIso; rt.lastError = reason;
  if (rt.sessionResidency === "warm") { rt.sessionResidency = "disposed"; commands.push({ type: "DISPOSE_SESSION", nodeId }); }
  scheduleReadyNodes(next, commands, nowIso);
  evaluateFlowSettlement(next, commands, nowIso);
}
