import type {
  FlowCommand,
  FlowEvent,
  FlowGraphSpec,
  FlowMachineState,
  FlowNodeRuntime,
  GraphValidationResult,
} from "../core/graph-types.ts";
import {
  buildFlowGraphSnapshot,
  cloneState,
  dispatchSingleNode,
  emitTerminalCleanup,
  evaluateFlowSettlement,
  formatWaitingNodesReason,
  getNodeSpec,
  getUnmetResumeDependencies,
  handleRejection,
  handleResilienceRecovery,
  makeNodeRuntime,
  scheduleReadyNodes,
  type MachineTransitionOptions,
} from "./machine-helpers.ts";
import type { RoleSpec } from "../core/types.ts";

export { buildFlowGraphSnapshot, type MachineTransitionOptions };

const TERMINAL_FLOW_STATUSES = new Set([
  "completed", "blocked", "stagnated", "rejected_max_rounds",
  "violation", "aborted_by_supervisor", "failed", "cancelled",
]);

export const isFlowTerminal = (status: FlowMachineState["status"]): boolean => TERMINAL_FLOW_STATUSES.has(status);

export function createInitialFlowState(input: {
  flowId: string;
  mandateId: string;
  cwd: string;
  spec: FlowGraphSpec;
  validation: GraphValidationResult;
  initialHandoffId?: string | null;
  roleSnapshots?: Record<string, RoleSpec>;
  nowIso: string;
}): FlowMachineState {
  const effectiveSpec = input.validation.normalizedSpec ?? input.spec;
  const nodes: Record<string, FlowNodeRuntime> = {};
  for (const node of effectiveSpec.nodes) {
    nodes[node.id] = makeNodeRuntime(
      node,
      input.validation.waveByNode[node.id] ?? 0,
      input.validation.effectiveWorkspaceByNode[node.id] ?? node.workspace ?? "inherit",
    );
  }
  return {
    flowId: input.flowId, mandateId: input.mandateId, cwd: input.cwd, spec: effectiveSpec, status: "draft",
    nodes, nodeOrder: effectiveSpec.nodes.map((n) => n.id), waves: input.validation.waves.map((w) => [...w]),
    repairRound: 0, maxRepairRounds: effectiveSpec.policies.maxRepairRounds, lastRejectionSig: null,
    nextStageSeq: 0, boardSeq: 0, initialHandoffId: input.initialHandoffId ?? null,
    lastHandoffId: input.initialHandoffId ?? null, mergedRef: null,
    ...(input.roleSnapshots ? { roleSnapshots: { ...input.roleSnapshots } } : {}),
    startedAt: null, endedAt: null,
  };
}

export function transitionFlow(
  state: FlowMachineState,
  event: FlowEvent,
  nowIso: string,
  opts?: MachineTransitionOptions,
): { state: FlowMachineState; commands: FlowCommand[] } {
  const next = cloneState(state);
  const commands: FlowCommand[] = [];
  const finish = () => { commands.push({ type: "PERSIST_STATE" }); return { state: next, commands }; };

  switch (event.type) {
    case "FLOW_START": {
      if (next.status !== "draft") return { state: next, commands };
      next.status = "running"; next.startedAt = nowIso;
      commands.push({ type: "APPEND_BOARD", entry: { kind: "brief", speaker: "coordinator", target: "all", text: next.spec.goal } });
      scheduleReadyNodes(next, commands, nowIso);
      evaluateFlowSettlement(next, commands, nowIso);
      return finish();
    }
    case "FLOW_RESUME": {
      if (next.status !== "waiting_input" && next.status !== "interrupted" && next.status !== "failed" && next.status !== "cancelled") {
        return { state: next, commands };
      }
      const waitingNodes = next.nodeOrder.filter((id) => next.nodes[id]!.status === "waiting_input");
      const trimmedReply = event.replyText?.trim();
      if (next.status === "waiting_input" && !trimmedReply) {
        next.reason = formatWaitingNodesReason(next, waitingNodes);
        return finish();
      }
      if (next.status === "waiting_input" && !event.targetNodeId && waitingNodes.length > 1) {
        next.reason = formatWaitingNodesReason(next, waitingNodes);
        return finish();
      }
      if (event.targetNodeId) {
        const tRt = next.nodes[event.targetNodeId];
        if (!tRt) return { state: next, commands };
        const unmet = getUnmetResumeDependencies(next, event.targetNodeId);
        const eligible = tRt.status === "waiting_input" || (
          (tRt.status === "ready" || tRt.status === "running" || tRt.status === "failed" || tRt.status === "retrying" || tRt.status === "cancelled") &&
          unmet.length === 0
        );
        if (!eligible) {
          next.reason = `Node "${event.targetNodeId}" is not ready to resume (status=${tRt.status}${unmet.length ? `; unmet dependencies: ${unmet.map((u) => `${u.nodeId} (${u.status})`).join(", ")}` : ""}).`;
          return finish();
        }
      }
      const prevStatus = next.status;
      next.status = "running"; next.endedAt = null; next.reason = undefined;
      const replyByNode = new Map<string, string>();
      const targets = event.targetNodeId
        ? [event.targetNodeId]
        : prevStatus === "waiting_input"
          ? waitingNodes
          : next.nodeOrder.filter((id) => {
              const st = next.nodes[id]!.status;
              return st === "ready" || st === "running" || st === "failed" || st === "retrying" || st === "cancelled";
            });
      for (const id of targets) {
        const rt = next.nodes[id]!, spec = getNodeSpec(next, id)!;
        if (spec.kind === "human" && rt.status === "waiting_input") {
          rt.status = "succeeded"; rt.endedAt = nowIso; rt.questionsForUser = []; rt.lastReply = trimmedReply!;
          commands.push({
            type: "APPEND_BOARD",
            entry: {
              nodeId: id, kind: "user_steer", speaker: "user", target: id, text: trimmedReply!,
              metadata: { ...(rt.questionPrompt ? { question: rt.questionPrompt } : {}), nodeId: id },
            },
          });
        } else {
          rt.status = "ready"; rt.activeStageId = null; rt.lastError = null; rt.questionsForUser = [];
          if (trimmedReply) {
            rt.lastReply = trimmedReply;
            replyByNode.set(id, trimmedReply);
            commands.push({ type: "APPEND_BOARD", entry: { nodeId: id, kind: "user_steer", speaker: "user", target: id, text: trimmedReply } });
          }
        }
      }
      scheduleReadyNodes(next, commands, nowIso, replyByNode);
      evaluateFlowSettlement(next, commands, nowIso, Boolean(event.targetNodeId));
      return finish();
    }
    case "FLOW_CANCEL": {
      if (isFlowTerminal(next.status)) return { state: next, commands };
      next.status = "cancelled"; next.endedAt = nowIso; next.reason = event.reason ?? "Cancelled by user.";
      for (const id of next.nodeOrder) {
        const rt = next.nodes[id]!;
        if (rt.status === "running") commands.push({ type: "ABORT_NODE", nodeId: id, reason: next.reason });
        if (rt.status === "running" || rt.status === "ready" || rt.status === "pending" || rt.status === "waiting_input" || rt.status === "retrying") {
          rt.status = "cancelled"; rt.endedAt = nowIso;
        }
      }
      emitTerminalCleanup(next, commands);
      return finish();
    }
    case "USER_STEER": {
      commands.push({
        type: "APPEND_BOARD",
        entry: { ...(event.targetNodeId ? { nodeId: event.targetNodeId } : {}), kind: "user_steer", speaker: "user", target: event.targetNodeId ?? event.targetRole ?? "all", text: event.text },
      });
      for (const id of next.nodeOrder) {
        if (next.nodes[id]!.status !== "running") continue;
        const hit = event.targetNodeId ? id === event.targetNodeId : (event.targetRole ? getNodeSpec(next, id)?.role === event.targetRole : true);
        if (hit) commands.push({ type: "DELIVER_STEER", nodeId: id, steerId: event.steerId, text: event.text });
      }
      return finish();
    }
    case "NODE_WORKTREE_READY": {
      const rt = next.nodes[event.nodeId];
      if (!rt || next.status !== "running") return { state: next, commands };
      rt.worktreePath = event.worktreePath; rt.status = "ready";
      dispatchSingleNode(next, event.nodeId, commands, nowIso);
      return finish();
    }
    case "NODE_DISPATCHED": {
      const rt = next.nodes[event.nodeId];
      if (rt) {
        rt.activeStageId = event.stageId;
        if (event.modelLabel) {
          rt.currentModel = event.modelLabel;
          if (!rt.triedModels.includes(event.modelLabel)) rt.triedModels.push(event.modelLabel);
        }
      }
      return finish();
    }
    case "NODE_SUCCEEDED": {
      const rt = next.nodes[event.nodeId];
      if (!rt || isFlowTerminal(next.status)) return { state: next, commands };
      rt.status = "succeeded"; rt.endedAt = nowIso; rt.lastHandoff = event.handoff; rt.lastHandoffId = event.handoff.id;
      rt.lastError = null; rt.lastRepairFeedback = null; rt.questionsForUser = [];
      rt.sessionResidency = event.sessionWarm ? "warm" : "disposed";
      if (event.commitRef) rt.commitRef = event.commitRef;
      if (event.commitSha) {
        rt.commitSha = event.commitSha;
        if (next.mergedCommitSha || event.commitRef === next.mergedRef) {
          next.mergedCommitSha = event.commitSha;
          if (event.commitRef) next.mergedRef = event.commitRef;
        }
      }
      next.lastHandoffId = event.handoff.id;
      commands.push({ type: "APPEND_BOARD", entry: { nodeId: event.nodeId, kind: "handoff", speaker: event.handoff.fromRole, target: event.handoff.toTarget, text: event.handoff.summary } });
      scheduleReadyNodes(next, commands, nowIso);
      evaluateFlowSettlement(next, commands, nowIso);
      return finish();
    }
    case "NODE_NEEDS_INPUT": {
      const rt = next.nodes[event.nodeId];
      if (!rt || isFlowTerminal(next.status)) return { state: next, commands };
      rt.status = "waiting_input"; rt.lastHandoff = event.handoff; rt.lastHandoffId = event.handoff.id;
      rt.questionsForUser = [...event.questions]; rt.sessionResidency = event.sessionWarm ? "warm" : "disposed";
      next.lastHandoffId = event.handoff.id;
      commands.push({ type: "APPEND_BOARD", entry: { nodeId: event.nodeId, kind: "handoff", speaker: event.handoff.fromRole, target: "user", text: `待确认: ${event.questions.join(" | ") || event.handoff.summary}` } });
      evaluateFlowSettlement(next, commands, nowIso);
      return finish();
    }
    case "NODE_REJECTED": {
      const rt = next.nodes[event.nodeId];
      if (!rt || isFlowTerminal(next.status)) return { state: next, commands };
      rt.lastHandoff = event.handoff; rt.lastHandoffId = event.handoff.id; rt.sessionResidency = "disposed"; next.lastHandoffId = event.handoff.id;
      handleRejection(next, event.nodeId, event.feedback, event.targetNodeId, commands, nowIso, opts);
      return finish();
    }
    case "NODE_BLOCKED": {
      const rt = next.nodes[event.nodeId];
      if (!rt || isFlowTerminal(next.status)) return { state: next, commands };
      rt.status = "blocked"; rt.endedAt = nowIso; rt.lastError = event.reason;
      if (event.handoff) { rt.lastHandoff = event.handoff; rt.lastHandoffId = event.handoff.id; next.lastHandoffId = event.handoff.id; }
      scheduleReadyNodes(next, commands, nowIso);
      evaluateFlowSettlement(next, commands, nowIso);
      return finish();
    }
    case "NODE_VIOLATION": {
      const rt = next.nodes[event.nodeId];
      if (!rt || isFlowTerminal(next.status)) return { state: next, commands };
      rt.status = "violation"; rt.endedAt = nowIso; rt.lastError = event.reason;
      for (const id of next.nodeOrder) if (next.nodes[id]!.status === "running") commands.push({ type: "ABORT_NODE", nodeId: id, reason: event.reason });
      next.status = "violation"; next.endedAt = nowIso; next.reason = event.reason;
      emitTerminalCleanup(next, commands);
      return finish();
    }
    case "NODE_ABORTED_BY_SUPERVISOR": {
      const rt = next.nodes[event.nodeId];
      if (!rt || isFlowTerminal(next.status)) return { state: next, commands };
      rt.status = "failed"; rt.endedAt = nowIso; rt.lastError = event.reason;
      next.status = "aborted_by_supervisor"; next.endedAt = nowIso; next.reason = event.reason;
      emitTerminalCleanup(next, commands);
      return finish();
    }
    case "NODE_HOST_ERROR": {
      if (!next.nodes[event.nodeId] || isFlowTerminal(next.status)) return { state: next, commands };
      handleResilienceRecovery(next, event.nodeId, event.error, event.retryable, event.currentModel, commands, nowIso);
      return finish();
    }
    case "NODE_STALLED": {
      if (!next.nodes[event.nodeId] || isFlowTerminal(next.status)) return { state: next, commands };
      handleResilienceRecovery(next, event.nodeId, `Stream stalled for ${event.idleSec}s`, true, event.currentModel, commands, nowIso);
      return finish();
    }
    case "GATE_COMPLETED": {
      const rt = next.nodes[event.nodeId];
      if (!rt || isFlowTerminal(next.status)) return { state: next, commands };
      rt.lastGateEvidence = event.evidence;
      if (event.handoff) { rt.lastHandoff = event.handoff; rt.lastHandoffId = event.handoff.id; next.lastHandoffId = event.handoff.id; }
      commands.push({ type: "APPEND_BOARD", entry: { nodeId: event.nodeId, kind: "gate_result", speaker: event.nodeId, target: "all", text: `${event.passed ? "PASS" : "FAIL"} (${event.evidence.command}, exit=${event.evidence.exitCode})` } });
      if (event.passed) {
        rt.status = "succeeded"; rt.endedAt = nowIso; rt.lastError = null;
        scheduleReadyNodes(next, commands, nowIso); evaluateFlowSettlement(next, commands, nowIso);
      } else {
        handleRejection(next, event.nodeId, event.feedback ?? `Gate "${event.evidence.command}" failed (exit ${event.evidence.exitCode}): ${event.evidence.outputSnippet}`, undefined, commands, nowIso, opts);
      }
      return finish();
    }
    case "MERGE_COMPLETED": {
      const rt = next.nodes[event.nodeId], spec = getNodeSpec(next, event.nodeId);
      if (!rt || !spec || isFlowTerminal(next.status)) return { state: next, commands };
      if (event.handoff) { rt.lastHandoff = event.handoff; rt.lastHandoffId = event.handoff.id; next.lastHandoffId = event.handoff.id; }
      commands.push({ type: "APPEND_BOARD", entry: { nodeId: event.nodeId, kind: "merge_result", speaker: event.nodeId, target: "all", text: event.summary } });
      if (event.ok) {
        rt.status = "succeeded"; rt.endedAt = nowIso; rt.commitRef = event.mergedRef ?? null; rt.commitSha = event.mergedCommitSha ?? null;
        next.mergedRef = event.mergedRef ?? null; next.mergedCommitSha = event.mergedCommitSha ?? null;
        scheduleReadyNodes(next, commands, nowIso); evaluateFlowSettlement(next, commands, nowIso);
      } else {
        if (event.mergedRef) { rt.commitRef = event.mergedRef; next.mergedRef = event.mergedRef; }
        if (event.mergedCommitSha) { rt.commitSha = event.mergedCommitSha; next.mergedCommitSha = event.mergedCommitSha; }
        const conflictList = (event.conflicts ?? []).join(", ");
        const msg = `Merge conflicts in ${event.nodeId}: ${conflictList || event.summary}`;
        if ((spec.merge?.conflictPolicy ?? "spawn_resolver") === "fail") {
          rt.status = "blocked"; rt.endedAt = nowIso; rt.lastError = msg; evaluateFlowSettlement(next, commands, nowIso);
        } else {
          rt.status = "waiting_input"; rt.lastError = msg;
          rt.questionsForUser = [`合并冲突文件 (${conflictList || "见摘要"})，请确认保留策略或手动解决后继续。`];
          next.status = "waiting_input"; next.reason = msg;
          commands.push({ type: "WAKE_COORDINATOR", kind: "conflict", summary: msg, nodeId: event.nodeId });
        }
      }
      return finish();
    }
    case "HUMAN_RESOLVED":
      return transitionFlow(next, { type: "FLOW_RESUME", targetNodeId: event.nodeId, replyText: event.replyText }, nowIso, opts);
    case "GRAPH_PATCH": {
      if (isFlowTerminal(next.status)) return { state: next, commands };
      const { patch, validated } = event;
      for (const skipId of patch.skipNodeIds ?? []) {
        const rt = next.nodes[skipId];
        if (rt && (rt.status === "pending" || rt.status === "ready")) { rt.status = "skipped"; rt.endedAt = nowIso; }
      }
      let addedCount = 0;
      if (validated?.normalizedSpec) {
        next.spec = {
          ...validated.normalizedSpec,
          nodes: validated.normalizedSpec.nodes.map((n) => ({ ...n, dependsOn: [...n.dependsOn] })),
          policies: { ...validated.normalizedSpec.policies },
        };
        for (const norm of next.spec.nodes) {
          if (next.nodes[norm.id]) continue;
          next.nodeOrder.push(norm.id);
          next.nodes[norm.id] = makeNodeRuntime(norm, validated.waveByNode[norm.id] ?? 0, validated.effectiveWorkspaceByNode[norm.id] ?? norm.workspace ?? "inherit");
          addedCount += 1;
        }
      } else {
        for (const rw of patch.rewireDeps ?? []) { const spec = getNodeSpec(next, rw.nodeId); if (spec) spec.dependsOn = [...rw.dependsOn]; }
        for (const add of patch.addNodes ?? []) {
          next.spec.nodes.push({ ...add, dependsOn: [...add.dependsOn] });
          next.nodeOrder.push(add.id);
          next.nodes[add.id] = makeNodeRuntime(add, 0, add.workspace ?? "inherit");
          addedCount += 1;
        }
      }
      if (validated) {
        next.waves = validated.waves.map((w) => [...w]);
        for (const [id, w] of Object.entries(validated.waveByNode)) if (next.nodes[id]) next.nodes[id]!.waveIndex = w;
      }
      commands.push({ type: "APPEND_BOARD", entry: { kind: "system", speaker: "coordinator", target: "all", text: `动态更新任务图 (+${addedCount} 节点, 跳过 ${patch.skipNodeIds?.length ?? 0} 节点)` } });
      scheduleReadyNodes(next, commands, nowIso);
      evaluateFlowSettlement(next, commands, nowIso);
      return finish();
    }
  }
}
