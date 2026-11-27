import { randomUUID } from "node:crypto";
import type {
  FlowCommand,
  FlowEvent,
  FlowGraphPatch,
  FlowGraphSpec,
  FlowMachineState,
  GraphValidationResult,
} from "../core/graph-types.ts";
import { isRoleReadOnly } from "../core/policy.ts";
import { resolveNodeEffectiveRole } from "../core/scope.ts";
import type { EnhanceStore } from "../core/store.ts";
import type {
  FlowRunResult,
  FlowStepResult,
  FlowUserSteer,
  HandoffEnvelope,
  Mandate,
  RoleSpec,
} from "../core/types.ts";
import { appendBoardEntrySafe, formatNodeBrief, renderBoardContextForNode } from "./board.ts";
import {
  applyLivePatchOnState,
  resolveUpstreamHandoff,
  runDeterministicGate,
  snapshotReferencedRoles,
  type LivePatchHandler,
  type LivePatchResult,
  type WorktreeManagerLike,
} from "./executor-gate.ts";
import { createInitialFlowState, isFlowTerminal, transitionFlow } from "./machine.ts";
import {
  executeRoleStep,
  type RoleSessionPoolLike,
  type RoleSessionRunner,
  type RoleSupervisorConfig,
} from "./orchestrator.ts";
import type { FlowObserver } from "./state.ts";
import { migrateLegacySubStateMachine } from "./workflow.ts";

export type { LivePatchHandler, LivePatchResult, WorktreeManagerLike };

export interface ExecuteFlowGraphInput {
  cwd: string; store: EnhanceStore; flowId: string; mandate: Mandate;
  spec: FlowGraphSpec; validation: GraphValidationResult;
  roles: ReadonlyMap<string, RoleSpec>; runner: RoleSessionRunner;
  initialState?: FlowMachineState | null; resumeReplyText?: string; resumeTargetNodeId?: string;
  initialHandoff?: HandoffEnvelope | null; userSteers?: readonly FlowUserSteer[];
  observer?: FlowObserver; supervisor?: RoleSupervisorConfig; signal?: AbortSignal;
  sessionPool?: RoleSessionPoolLike; worktreeManager?: WorktreeManagerLike;
  onStateChange?: (state: FlowMachineState) => void;
  registerLivePatchHandler?: (handler: LivePatchHandler | null) => void;
}

const nowIso = (): string => new Date().toISOString();

export async function executeFlowGraph(
  input: ExecuteFlowGraphInput,
): Promise<FlowRunResult & { finalState: FlowMachineState }> {
  const effectiveSpec = input.validation.normalizedSpec ?? input.spec;
  let state: FlowMachineState = input.initialState
    ? migrateLegacySubStateMachine({ ...input.initialState }, input.roles)
    : createInitialFlowState({
        flowId: input.flowId, mandateId: input.mandate.id, cwd: input.cwd,
        spec: effectiveSpec, validation: input.validation, initialHandoffId: input.initialHandoff?.id ?? null,
        roleSnapshots: snapshotReferencedRoles(effectiveSpec, input.roles), nowIso: nowIso(),
      });
  if (!state.roleSnapshots) state.roleSnapshots = snapshotReferencedRoles(state.spec, input.roles);
  const roleOf = (roleId: string): RoleSpec | undefined => state.roleSnapshots?.[roleId] ?? input.roles.get(roleId);
  const isRo = (roleId: string): boolean => isRoleReadOnly(roleOf(roleId));

  const queue: FlowEvent[] = [];
  const inFlight = new Map<string, Promise<void>>();
  const nodeAborts = new Map<string, AbortController>();
  const steps: FlowStepResult[] = [];
  let wakeResolve: (() => void) | null = null;

  const pushEvent = (ev: FlowEvent): void => {
    queue.push(ev);
    if (wakeResolve) { const r = wakeResolve; wakeResolve = null; r(); }
  };

  const onExternalAbort = () => pushEvent({ type: "FLOW_CANCEL", reason: "Cancelled by user." });
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const launchAsync = (nodeId: string, fn: (nodeSignal: AbortSignal, isInternalAbort: () => boolean) => Promise<void>): void => {
    const ac = new AbortController();
    nodeAborts.set(nodeId, ac);
    const effSignal = input.signal ? AbortSignal.any([input.signal, ac.signal]) : ac.signal;
    const isInternalAbort = () => ac.signal.aborted && !input.signal?.aborted && !input.observer?.isCancelled?.();
    const p: Promise<void> = fn(effSignal, isInternalAbort).catch((err) => {
      if (isInternalAbort()) return;
      const msg = err instanceof Error ? err.message : String(err);
      pushEvent({ type: "NODE_HOST_ERROR", nodeId, error: msg, retryable: false });
    }).finally(() => {
      if (inFlight.get(nodeId) === p) inFlight.delete(nodeId);
      if (nodeAborts.get(nodeId) === ac) nodeAborts.delete(nodeId);
      if (wakeResolve) { const r = wakeResolve; wakeResolve = null; r(); }
    });
    inFlight.set(nodeId, p);
  };

  const executeRoleDispatch = async (
    cmd: Extract<FlowCommand, { type: "DISPATCH_ROLE_NODE" }>,
    nodeSignal: AbortSignal,
    isInternalAbort: () => boolean,
  ): Promise<void> => {
    const spec = state.spec.nodes.find((n) => n.id === cmd.nodeId);
    if (!spec || !spec.role) {
      pushEvent({ type: "NODE_HOST_ERROR", nodeId: cmd.nodeId, error: `Missing role spec for node "${cmd.nodeId}".`, retryable: false });
      return;
    }
    const baseRole = roleOf(spec.role);
    if (!baseRole) {
      pushEvent({ type: "NODE_HOST_ERROR", nodeId: cmd.nodeId, error: `Role "${spec.role}" could not be resolved from frozen snapshots.`, retryable: false });
      return;
    }
    const effCwd = cmd.worktreePath ?? input.cwd;
    const upstreamHandoff = resolveUpstreamHandoff(state, spec, input.initialHandoff ?? null);
    const narrowed = resolveNodeEffectiveRole(baseRole, spec);
    if (!narrowed.ok) {
      pushEvent({ type: "NODE_VIOLATION", nodeId: cmd.nodeId, violations: spec.writableScope ?? [], reason: narrowed.reason });
      return;
    }
    const effRole = spec.isWorkflowPhase ? { ...narrowed.role, id: `${baseRole.id}__${spec.id.split("__").slice(1).join("__") || spec.id}` } : narrowed.role;
    const boardContext = renderBoardContextForNode({ store: input.store, flowId: input.flowId, nodeSpec: spec });
    const nodeBrief = spec.brief ? formatNodeBrief(spec.brief, input.mandate.goal) : undefined;
    const toTarget = state.spec.nodes.find((n) => n.dependsOn.includes(spec.id))?.id ?? "user";
    const keepWarm = Boolean(state.spec.policies.enableSessionReuse && spec.sessionMode !== "fresh");
    const sessionSlotId = cmd.sessionGroup ?? spec.sessionGroup ?? cmd.nodeId;
    const reuseSharedWarm = Boolean(
      cmd.reuseSession || (spec.sessionGroup && keepWarm && input.sessionPool?.hasWarm(input.flowId, sessionSlotId)),
    );

    const runStepInCwd = async (stepCwd: string) => executeRoleStep({
      cwd: stepCwd, store: input.store, role: effRole, mandate: input.mandate, upstreamHandoff, userSteers: input.userSteers, toTarget,
      repairTargetRoleId: spec.repairTargetNodeId ?? "user", flowId: input.flowId, nodeId: cmd.nodeId,
      sessionSlotId,
      runner: input.runner, stageId: cmd.stageId, round: cmd.repairRound, observer: input.observer, supervisor: input.supervisor,
      signal: nodeSignal, reuseSession: reuseSharedWarm, keepSessionWarm: keepWarm,
      ...(cmd.modelOverride ? { modelOverride: cmd.modelOverride } : {}),
      ...(cmd.repairFeedback ? { repairFeedback: cmd.repairFeedback } : {}),
      ...(cmd.replyText ? { replyText: cmd.replyText } : {}), ...(nodeBrief ? { nodeBrief } : {}),
      ...(boardContext ? { boardContext } : {}), ...(spec.stallTimeoutSec ? { stallTimeoutMs: spec.stallTimeoutSec * 1000 } : {}),
      ...(input.sessionPool ? { sessionPool: input.sessionPool } : {}),
    });

    let previewUpdated: { commitRef: string; commitSha: string } | null = null;
    const pinnedPreviewTarget = cmd.targetCommitSha ?? cmd.targetCommitRef;
    const res = pinnedPreviewTarget && !cmd.worktreePath && input.worktreeManager?.withCommitWorktree
      ? await input.worktreeManager.withCommitWorktree(
          { cwd: input.cwd, flowId: input.flowId, nodeId: cmd.nodeId, commitRef: pinnedPreviewTarget },
          async ({ worktreePath, commitSha }) => {
            const stepRes = await runStepInCwd(worktreePath);
            if (stepRes.ok && stepRes.envelope.verdict === "ready" && !isRoleReadOnly(effRole) && input.worktreeManager?.commitAndUpdatePreviewRef) {
              previewUpdated = await input.worktreeManager.commitAndUpdatePreviewRef({
                cwd: input.cwd, worktreePath, flowId: input.flowId, nodeId: cmd.nodeId,
                targetRef: cmd.targetCommitRef ?? state.mergedRef ?? pinnedPreviewTarget, expectedParentSha: commitSha, summary: stepRes.envelope.summary,
              });
            }
            return stepRes;
          },
        )
      : await runStepInCwd(effCwd);
    if (isInternalAbort()) return;
    if (!res.ok) {
      if (res.status === "cancelled") {
        if (input.signal?.aborted || input.observer?.isCancelled?.()) pushEvent({ type: "FLOW_CANCEL", reason: res.reason });
        return;
      }
      if (res.status === "violation") { pushEvent({ type: "NODE_VIOLATION", nodeId: cmd.nodeId, violations: res.violations, reason: res.reason }); return; }
      if (res.status === "aborted_by_supervisor") { pushEvent({ type: "NODE_ABORTED_BY_SUPERVISOR", nodeId: cmd.nodeId, reason: res.reason }); return; }
      if (res.status === "stalled") { pushEvent({ type: "NODE_STALLED", nodeId: cmd.nodeId, idleSec: res.idleSec, currentModel: res.modelLabel }); return; }
      pushEvent({
        type: "NODE_HOST_ERROR", nodeId: cmd.nodeId, error: res.reason,
        retryable: res.status === "host_error" ? Boolean(res.retryable) : false,
        ...(res.status === "host_error" && res.modelLabel ? { currentModel: res.modelLabel } : {}),
      });
      return;
    }
    const env = res.envelope;
    steps.push({ stepIndex: state.nodeOrder.indexOf(cmd.nodeId), roleId: effRole.id, round: cmd.repairRound, envelope: env });
    if (env.verdict === "needs_input") {
      pushEvent({ type: "NODE_NEEDS_INPUT", nodeId: cmd.nodeId, handoff: env, questions: env.questionsForUser ?? [env.summary], sessionWarm: res.sessionWarm });
      return;
    }
    if (env.verdict === "blocked") { pushEvent({ type: "NODE_BLOCKED", nodeId: cmd.nodeId, handoff: env, reason: env.summary }); return; }
    if (env.verdict === "rejected") {
      pushEvent({
        type: "NODE_REJECTED", nodeId: cmd.nodeId, handoff: env,
        ...(env.toTarget && state.nodes[env.toTarget] ? { targetNodeId: env.toTarget } : {}),
        feedback: env.feedbackForUpstream ?? env.summary,
      });
      return;
    }
    let commitRef: string | null = (previewUpdated as { commitRef: string; commitSha: string } | null)?.commitRef ?? null;
    const commitSha: string | null = (previewUpdated as { commitRef: string; commitSha: string } | null)?.commitSha ?? null;
    if (cmd.worktreePath && input.worktreeManager) {
      commitRef = await input.worktreeManager.commitNodeWorktree({
        worktreePath: cmd.worktreePath, flowId: input.flowId, nodeId: cmd.nodeId, summary: env.summary,
      });
    }
    pushEvent({ type: "NODE_SUCCEEDED", nodeId: cmd.nodeId, handoff: env, sessionWarm: res.sessionWarm, commitRef, commitSha });
  };

  const runRoleDispatch = (cmd: Extract<FlowCommand, { type: "DISPATCH_ROLE_NODE" }>): void => {
    launchAsync(cmd.nodeId, (nodeSignal, isInternalAbort) => executeRoleDispatch(cmd, nodeSignal, isInternalAbort));
  };

  const executeCommands = async (commands: readonly FlowCommand[]): Promise<void> => {
    for (const cmd of commands) {
      switch (cmd.type) {
        case "APPEND_BOARD": {
          const saved = appendBoardEntrySafe(input.store, input.flowId, cmd.entry);
          if (saved?.seq) state.boardSeq = Math.max(state.boardSeq, saved.seq);
          break;
        }
        case "PERSIST_STATE":
          input.onStateChange?.(state);
          break;
        case "PREPARE_WORKTREE":
          launchAsync(cmd.nodeId, async () => {
            if (!input.worktreeManager) throw new Error(`Worktree manager unavailable for node "${cmd.nodeId}".`);
            const wt = await input.worktreeManager.prepareNodeWorktree({
              cwd: input.cwd, flowId: input.flowId, nodeId: cmd.worktreeGroup ?? cmd.nodeId,
              ...(cmd.baseCommitSha ? { baseCommitSha: cmd.baseCommitSha } : {}),
            });
            pushEvent({ type: "NODE_WORKTREE_READY", nodeId: cmd.nodeId, worktreePath: wt.worktreePath });
          });
          break;
        case "DISPATCH_ROLE_NODE":
          runRoleDispatch(cmd);
          break;
        case "SWITCH_MODEL_AND_RESUME":
          launchAsync(cmd.nodeId, async (nodeSignal, isInternalAbort) => {
            const spec = state.spec.nodes.find((n) => n.id === cmd.nodeId);
            const slotId = spec?.sessionGroup ?? cmd.nodeId;
            let switched = false;
            if (input.sessionPool?.switchModelInPlace) {
              const sw = await input.sessionPool.switchModelInPlace(input.flowId, slotId, cmd.nextModel);
              switched = sw.switched;
            }
            const rt = state.nodes[cmd.nodeId]!;
            await executeRoleDispatch({
              type: "DISPATCH_ROLE_NODE", nodeId: cmd.nodeId, stageId: cmd.stageId, attempt: cmd.attempt,
              repairRound: rt.repairRound, reuseSession: switched,
              ...(spec?.sessionGroup ? { sessionGroup: spec.sessionGroup } : {}),
              ...(rt.worktreePath ? { worktreePath: rt.worktreePath } : {}),
              modelOverride: cmd.nextModel,
              repairFeedback: `Previous attempt interrupted (${cmd.reason}); switched model to ${cmd.nextModel}. Continue and call enhance_handoff when done.`,
            }, nodeSignal, isInternalAbort);
          });
          break;
        case "RUN_GATE_NODE":
          launchAsync(cmd.nodeId, async (nodeSignal, isInternalAbort) => {
            const evalGate = (gateCwd: string, testedCommitSha?: string) => runDeterministicGate({
              cwd: gateCwd, flowId: input.flowId, mandate: input.mandate, store: input.store,
              nodeId: cmd.nodeId, stageId: cmd.stageId, config: cmd.config, testedCommitSha, signal: nodeSignal,
            });
            const pinnedCommit = cmd.targetCommitSha ?? cmd.targetCommitRef;
            let g: Awaited<ReturnType<typeof runDeterministicGate>>;
            if (pinnedCommit) {
              if (!input.worktreeManager?.withCommitWorktree) {
                throw new Error(`Worktree manager unavailable to evaluate candidate ref "${pinnedCommit}" for gate "${cmd.nodeId}".`);
              }
              g = await input.worktreeManager.withCommitWorktree(
                { cwd: input.cwd, flowId: input.flowId, nodeId: cmd.nodeId, commitRef: pinnedCommit },
                ({ worktreePath, commitSha }) => evalGate(worktreePath, commitSha),
              );
            } else {
              g = await evalGate(cmd.worktreePath ?? input.cwd);
            }
            if (isInternalAbort()) return;
            steps.push({ stepIndex: state.nodeOrder.indexOf(cmd.nodeId), roleId: cmd.nodeId, round: state.nodes[cmd.nodeId]!.repairRound, envelope: g.handoff });
            pushEvent({ type: "GATE_COMPLETED", nodeId: cmd.nodeId, passed: g.passed, evidence: g.evidence, handoff: g.handoff, ...(g.feedback ? { feedback: g.feedback } : {}) });
          });
          break;
        case "RUN_MERGE_NODE":
          launchAsync(cmd.nodeId, async (_nodeSignal, isInternalAbort) => {
            if (!input.worktreeManager) throw new Error(`Worktree manager unavailable for merge node "${cmd.nodeId}".`);
            const m = await input.worktreeManager.mergeWorktrees({
              cwd: input.cwd, flowId: input.flowId, nodeId: cmd.nodeId,
              sourceRefs: cmd.sourceRefs, landingMode: cmd.config.landingMode ?? "apply",
              ...(cmd.baseCommitSha ? { baseCommitSha: cmd.baseCommitSha } : {}),
            });
            if (isInternalAbort()) return;
            const handoff: HandoffEnvelope = {
              id: `ho-merge-${randomUUID()}`, mandateId: input.mandate.id, mandateRev: input.mandate.rev,
              parentHandoffId: null, fromRole: cmd.nodeId, toTarget: "user", verdict: m.ok ? "ready" : "needs_input",
              summary: m.summary, artifacts: [], verifiedFacts: [], openRisks: m.conflicts ?? [],
              ...(m.conflicts?.length ? { questionsForUser: [`Resolve merge conflicts in: ${m.conflicts.join(", ")}`] } : {}),
              feedbackForUpstream: null, observedUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, createdAt: nowIso(),
            };
            if (!input.store.isClosed()) input.store.saveHandoff(handoff);
            pushEvent({
              type: "MERGE_COMPLETED", nodeId: cmd.nodeId, ok: m.ok,
              mergedRef: m.mergedRef, mergedCommitSha: m.mergedCommitSha, summary: m.summary, conflicts: m.conflicts, handoff,
            });
          });
          break;
        case "ABORT_NODE":
          nodeAborts.get(cmd.nodeId)?.abort();
          break;
        case "DISPOSE_SESSION":
          await input.sessionPool?.disposeNode(input.flowId, cmd.nodeId);
          break;
        case "CLEANUP_WORKTREES":
          await input.worktreeManager?.cleanupFlowWorktrees(input.cwd, cmd.flowId);
          break;
        case "RUN_HUMAN_NODE":
        case "DELIVER_STEER":
        case "WAKE_COORDINATOR":
          break;
      }
    }
  };

  const pendingPatches: Array<{
    patch: FlowGraphPatch;
    patchRoles?: ReadonlyMap<string, RoleSpec>;
    resolve: (result: LivePatchResult) => void;
  }> = [];
  let loopEnded = false;

  const processPendingPatches = async (): Promise<void> => {
    while (pendingPatches.length > 0) {
      const req = pendingPatches.shift()!;
      const applied = applyLivePatchOnState({
        state,
        flowId: input.flowId,
        cwd: input.cwd,
        patch: req.patch,
        baseRoles: input.roles,
        patchRoles: req.patchRoles,
        isGitRepo: input.worktreeManager ? input.worktreeManager.isGitRepo(input.cwd) : false,
        isRoleReadOnly: isRo,
        nowIso: nowIso(),
      });
      if (applied.nextState && applied.commands) {
        state = applied.nextState;
        await executeCommands(applied.commands);
      }
      req.resolve(applied.result);
    }
  };

  try {
    input.registerLivePatchHandler?.((patch, patchRoles) => {
      if (loopEnded || isFlowTerminal(state.status)) {
        return Promise.resolve({
          patched: false,
          error: `Flow "${input.flowId}" is no longer active and could not be patched.`,
        });
      }
      return new Promise<LivePatchResult>((resolve) => {
        pendingPatches.push({ patch, patchRoles, resolve });
        if (wakeResolve) {
          const r = wakeResolve;
          wakeResolve = null;
          r();
        }
      });
    });
    pushEvent(
      state.status === "draft"
        ? { type: "FLOW_START" }
        : { type: "FLOW_RESUME", ...(input.resumeReplyText ? { replyText: input.resumeReplyText } : {}), ...(input.resumeTargetNodeId ? { targetNodeId: input.resumeTargetNodeId } : {}) },
    );

    while (true) {
      while (queue.length > 0 || pendingPatches.length > 0) {
        while (queue.length > 0) {
          const ev = queue.shift()!;
          const out = transitionFlow(state, ev, nowIso(), { isRoleReadOnly: isRo });
          state = out.state;
          await executeCommands(out.commands);
        }
        if (pendingPatches.length > 0) await processPendingPatches();
      }
      if (isFlowTerminal(state.status) || state.status === "waiting_input") break;
      if (inFlight.size === 0) break;
      await new Promise<void>((resolve) => { wakeResolve = resolve; });
    }
  } finally {
    loopEnded = true;
    input.registerLivePatchHandler?.(null);
    while (pendingPatches.length > 0) {
      pendingPatches.shift()!.resolve({
        patched: false,
        error: `Flow "${input.flowId}" ended (${state.status}) before patch could be applied.`,
      });
    }
    input.signal?.removeEventListener("abort", onExternalAbort);
    for (const ac of nodeAborts.values()) ac.abort();
    if (inFlight.size > 0) await Promise.allSettled([...inFlight.values()]);
    if (isFlowTerminal(state.status)) await input.sessionPool?.disposeFlow(input.flowId);
  }

  if (state.status === "completed") input.store.completeMandate(input.mandate.id);
  const finalEnvelope = (state.lastHandoffId ? input.store.getHandoff(state.lastHandoffId) : null)
    ?? [...state.nodeOrder].reverse().map((id) => state.nodes[id]?.lastHandoff).find(Boolean)
    ?? input.initialHandoff
    ?? null;
  const resultStatus: FlowRunResult["status"] =
    state.status === "completed" || state.status === "waiting_input" || state.status === "rejected_max_rounds" ||
    state.status === "stagnated" || state.status === "blocked" || state.status === "violation" ||
    state.status === "aborted_by_supervisor" || state.status === "cancelled"
      ? state.status
      : "failed";
  return {
    status: resultStatus, cwd: input.cwd, steps, finalEnvelope,
    ...(state.mergedRef ? { mergedRef: state.mergedRef } : {}),
    ...(state.mergedCommitSha ? { mergedCommitSha: state.mergedCommitSha } : {}),
    ...(state.reason ? { reason: state.reason } : {}), finalState: state,
  };
}
