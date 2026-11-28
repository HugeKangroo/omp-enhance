import { canRoleUseCompanionTool } from "../core/policy.ts";
import { ProjectBusyError } from "../core/store.ts";
import type { FlowMachineState, HandoffEnvelope } from "../core/types.ts";
import { evaluateHumanReply } from "../flow/human-policy.ts";
import { getUnmetResumeDependencies } from "../flow/machine-helpers.ts";
import { isCheckpointResumable, parseDirectedSteer, snapshotFromCheckpoint } from "../flow/state.ts";
import { migrateLegacySubStateMachine, resolveLegacyTargetNodeId } from "../flow/workflow.ts";
import { buildFlowToolParameters, type SchemaKitLike } from "./flow-schema.ts";
import { buildAndValidateStartGraph, formatGraphWavesSummary, parsePatchObject } from "./graph-dispatch.ts";
import type { WorkspaceHub } from "./hub.ts";
import {
  collectNonTerminalFlowCandidates,
  collectResumableFlowCandidates,
  decorateFlowDeliveryPayload,
  persistHeldHumanDecision,
} from "./hub-helpers.ts";
import type { ManagedWorkspace } from "./workspace.ts";

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const asStringArray = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((it): it is string => typeof it === "string" && it.trim().length > 0);
  return items.length > 0 ? items : undefined;
};

const toolResult = (payload: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  ...(isError ? { isError: true } : {}),
});
const toolError = (error: unknown) =>
  toolResult({ error: error instanceof Error ? error.message : String(error) }, true);

export async function executeCancelFlow(
  hub: WorkspaceHub, originWs: ManagedWorkspace, params: { flowId?: string; cwd?: string }, ctx: any,
): Promise<{ cancelled: boolean; cwd: string; flowId: string | null; status: string; reason?: string }> {
  const reqFlowId = params.flowId?.trim() || undefined, reqCwd = params.cwd?.trim() || undefined;
  const targetWs = hub.resolveFlowWorkspace(originWs, { flowId: reqFlowId, cwd: reqCwd }, ctx, (w) => w.room.hasActiveLeaseOwnership());
  if (reqFlowId) {
    if (targetWs.room.hasActiveLeaseOwnership() && targetWs.room.getSnapshot().flowId === reqFlowId) {
      const cancelled = await targetWs.room.cancelActiveFlow(ctx);
      hub.syncGlobalUi(ctx, originWs);
      return { cancelled, cwd: targetWs.cwd, flowId: reqFlowId, status: targetWs.room.getSnapshot().status };
    }
    const tx = targetWs.store.cancelFlowCheckpoint(reqFlowId);
    if (!tx.checkpoint) throw new Error(tx.reason ?? `Unknown flowId "${reqFlowId}".`);
    if (!targetWs.room.isRunning() && targetWs.room.getSnapshot().flowId === reqFlowId) targetWs.room.syncFromCheckpoint(tx.checkpoint, ctx);
    hub.syncGlobalUi(ctx, originWs);
    return { cancelled: tx.cancelled, cwd: targetWs.cwd, flowId: reqFlowId, status: tx.checkpoint.status, ...(tx.reason ? { reason: tx.reason } : {}) };
  }
  if (targetWs.room.hasActiveLeaseOwnership()) {
    const cancelled = await targetWs.room.cancelActiveFlow(ctx);
    hub.syncGlobalUi(ctx, originWs);
    const snap = targetWs.room.getSnapshot();
    return { cancelled, cwd: targetWs.cwd, flowId: snap.flowId, status: snap.status };
  }
  const activeLease = !targetWs.store.isClosed() ? targetWs.store.getProjectFlowLease() : null;
  if (activeLease) {
    return { cancelled: false, cwd: targetWs.cwd, flowId: activeLease.flowId, status: "running", reason: `Flow "${activeLease.flowId}" is actively running in another OMP window (pid=${activeLease.ownerPid}).` };
  }
  const snap = targetWs.room.getSnapshot();
  return { cancelled: false, cwd: targetWs.cwd, flowId: snap.flowId, status: snap.status, reason: "No running Flow in target workspace." };
}

export function registerFlowTool(
  registerTool: (input: {
    name: string; label: string; description: string; approval?: "read" | "write" | "exec"; parameters: unknown;
    execute: (params: Record<string, unknown>, ctx: any, signal?: AbortSignal) => Promise<unknown>;
  }) => void,
  kit: SchemaKitLike,
  hub: WorkspaceHub,
): void {
  registerTool({
    name: "enhance_flow",
    label: "Enhance Flow",
    approval: "exec",
    description: "Start, resume, list/inspect status, steer, patch, or cancel Markov-isolated specialist Flows (linear roles or DAG nodes/presets) across one or multiple project directories (cwd).",
    parameters: buildFlowToolParameters(kit),
    async execute(params, ctx, signal) {
      try {
        const originWs = hub.getWorkspace(ctx);
        originWs.refresh(ctx);
        const action = asString(params.action) ?? "start";
        const activeRole = originWs.getActiveRole(ctx);
        const reqFlowId = asString(params.flowId);
        const reqCwd = asString(params.cwd);

        if (action === "list") {
          hub.markAllSettledFlowsObserved();
          return toolResult({ cwd: originWs.cwd, flows: hub.getAllFlowSummaries(), runningJobs: hub.getAllRunningJobs() });
        }

        if (action === "status") {
          if (reqFlowId) {
            const targetWs = hub.resolveFlowWorkspace(originWs, { flowId: reqFlowId, cwd: reqCwd }, ctx);
            hub.markFlowSnapshotObserved(targetWs, reqFlowId);
            if (targetWs.room.hasActiveLeaseOwnership() && targetWs.room.getSnapshot().flowId === reqFlowId) {
              return toolResult(decorateFlowDeliveryPayload({ cwd: targetWs.cwd, ...targetWs.room.getSnapshot(), resumable: targetWs.room.isResumable() }));
            }
            const cp = !targetWs.store.isClosed() ? targetWs.store.reclaimDeadCheckpoint(reqFlowId) : null;
            if (cp) return toolResult(decorateFlowDeliveryPayload({ cwd: targetWs.cwd, ...snapshotFromCheckpoint(cp, targetWs.cwd), resumable: isCheckpointResumable(cp) }));
            if (targetWs.room.getSnapshot().flowId === reqFlowId) return toolResult(decorateFlowDeliveryPayload({ cwd: targetWs.cwd, ...targetWs.room.getSnapshot(), resumable: targetWs.room.isResumable() }));
            throw new Error(`Unknown flowId "${reqFlowId}".`);
          }
          if (reqCwd) {
            const targetWs = hub.resolveTargetWorkspace(originWs, reqCwd, ctx);
            hub.markFlowSnapshotObserved(targetWs);
            const latest = !targetWs.room.hasActiveLeaseOwnership() && !targetWs.store.isClosed() ? targetWs.store.getLatestFlowCheckpoint() : null;
            const snap = latest ? snapshotFromCheckpoint(latest, targetWs.cwd) : targetWs.room.getSnapshot();
            return toolResult(decorateFlowDeliveryPayload({ cwd: targetWs.cwd, ...snap, resumable: latest ? isCheckpointResumable(latest) : targetWs.room.isResumable(), ...(targetWs.trustNotice ? { trustNotice: targetWs.trustNotice } : {}) }));
          }
          hub.markAllSettledFlowsObserved();
          const latestOrigin = !originWs.room.hasActiveLeaseOwnership() && !originWs.store.isClosed() ? originWs.store.getLatestFlowCheckpoint() : null;
          const baseSnap = latestOrigin ? snapshotFromCheckpoint(latestOrigin, originWs.cwd) : originWs.room.getSnapshot();
          return toolResult(decorateFlowDeliveryPayload({ cwd: originWs.cwd, ...baseSnap, resumable: latestOrigin ? isCheckpointResumable(latestOrigin) : originWs.room.isResumable(), flows: hub.getAllFlowSummaries(), runningJobs: hub.getAllRunningJobs() }));
        }

        if (action === "cancel") return toolResult(await executeCancelFlow(hub, originWs, { flowId: reqFlowId, cwd: reqCwd }, ctx));

        if (action === "steer") {
          const perm = canRoleUseCompanionTool(activeRole, "enhance_flow", "steer");
          if (!perm.allowed) throw new Error(perm.reason);
          const msg = asString(params.message) ?? asString(params.goal);
          if (!msg) throw new Error("enhance_flow steer requires a message.");
          let targetWs: ManagedWorkspace;
          let resolvedFlowId = reqFlowId;
          if (reqFlowId) {
            targetWs = hub.resolveFlowWorkspace(originWs, { flowId: reqFlowId, cwd: reqCwd }, ctx);
          } else {
            const scopeWorkspaces = reqCwd
              ? [hub.resolveTargetWorkspace(originWs, reqCwd, ctx)]
              : hub.hydrateTrackedWorkspaces(originWs, ctx);
            const candidates = collectNonTerminalFlowCandidates(scopeWorkspaces);
            if (candidates.length > 1) {
              const choices = candidates.map((c) => `${c.flowId} (${c.cwd}) [${c.status}: ${c.goal}]`).join("; ");
              return toolResult({
                ok: false, ambiguous: true, requiresFlowId: true,
                ...(reqCwd ? { cwd: scopeWorkspaces[0]!.cwd } : {}),
                candidates: candidates.map(({ cwd, flowId, status, goal, roleChain }) => ({ cwd, flowId, status, goal, roleChain })),
                error: `Multiple active/paused Flows exist; specify flowId or cwd (${choices}).`,
              }, true);
            }
            targetWs = candidates[0]?.ws ?? scopeWorkspaces[0] ?? originWs;
            resolvedFlowId = candidates[0]?.flowId ?? targetWs.room.getSnapshot().flowId ?? undefined;
          }
          if (!resolvedFlowId) throw new Error(`No active or resumable Flow found in ${targetWs.cwd}.`);
          if (targetWs.room.hasActiveLeaseOwnership() && targetWs.room.getSnapshot().flowId === resolvedFlowId) {
            const res = await targetWs.room.postUserSteer(msg, ctx);
            return toolResult({ ok: true, cwd: targetWs.cwd, flowId: resolvedFlowId, ...res, status: targetWs.room.getSnapshot().status });
          }
          const { text: steerText, targetRole } = parseDirectedSteer(msg);
          const liveCp = !targetWs.store.isClosed() ? targetWs.store.getFlowCheckpoint(resolvedFlowId) : null;
          if (!liveCp) throw new Error(`Unknown flowId "${resolvedFlowId}".`);
          const appended = targetWs.store.appendFlowSteer(resolvedFlowId, { text: steerText, targetRole: targetRole ?? null });
          if (!targetWs.room.isRunning() && targetWs.room.getSnapshot().flowId === resolvedFlowId && liveCp.status !== "running") {
            const updatedCp = targetWs.store.getFlowCheckpoint(resolvedFlowId);
            if (updatedCp) targetWs.room.syncFromCheckpoint(updatedCp, ctx);
          }
          return toolResult({
            ok: true, deliveryState: "saved_pending_delivery", delivered: false, savedToCheckpoint: true, steerId: appended.steerId,
            ...(targetRole ? { queuedForRole: targetRole } : {}), cwd: targetWs.cwd, flowId: resolvedFlowId, status: liveCp.status, activeStageId: null,
          });
        }

        if (action === "resume") {
          const perm = canRoleUseCompanionTool(activeRole, "enhance_flow", "resume");
          if (!perm.allowed) throw new Error(perm.reason);
          let targetWs: ManagedWorkspace;
          let targetFlowId = reqFlowId;
          if (reqFlowId) {
            targetWs = hub.resolveFlowWorkspace(originWs, { flowId: reqFlowId, cwd: reqCwd }, ctx);
          } else {
            const scopeWorkspaces = reqCwd
              ? [hub.resolveTargetWorkspace(originWs, reqCwd, ctx)]
              : hub.hydrateTrackedWorkspaces(originWs, ctx);
            const candidates = collectResumableFlowCandidates(scopeWorkspaces);
            if (candidates.length > 1) {
              const choices = candidates.map((c) => `${c.flowId} (${c.cwd}) [${c.status}: ${c.goal}]`).join("; ");
              return toolResult({
                started: false, resumed: false, ok: false, ambiguous: true, requiresFlowId: true,
                ...(reqCwd ? { cwd: scopeWorkspaces[0]!.cwd } : {}),
                candidates: candidates.map(({ cwd, flowId, status, goal, waitingNodes }) => ({
                  cwd, flowId, status, goal, ...(waitingNodes ? { waitingNodes } : {}),
                })),
                error: `Multiple waiting/resumable Flows exist; specify flowId or cwd (${choices}).`,
              }, true);
            }
            targetWs = candidates[0]?.ws ?? scopeWorkspaces[0] ?? originWs;
            targetFlowId = candidates[0]?.flowId;
          }
          targetWs.refresh(ctx);
          if (!targetFlowId) throw new Error("当前没有可断点续跑的中断/失败 Flow。");
          const cp = !targetWs.store.isClosed()
            ? (targetWs.room.hasActiveLeaseOwnership() && targetWs.room.getSnapshot().flowId === targetFlowId
                ? targetWs.store.getFlowCheckpoint(targetFlowId)
                : targetWs.store.reclaimDeadCheckpoint(targetFlowId))
            : null;
          if (reqFlowId && !cp && targetWs.room.getSnapshot().flowId !== reqFlowId) throw new Error(`Unknown flowId "${reqFlowId}".`);
          if (cp && !isCheckpointResumable(cp)) throw new Error(`Flow "${cp.flowId}" 当前状态为 ${cp.status}，无法断点续跑。`);
          const waitingNow = (cp?.status ?? targetWs.room.getSnapshot().status) === "waiting_input";
          if (waitingNow && hub.isSelfResumeBlockedDuringWakeup(targetFlowId, ctx)) {
            return toolResult({
              started: false, resumed: false, awaitingUserReply: true, cwd: targetWs.cwd, flowId: targetFlowId, status: "waiting_input",
              error: `Flow "${targetFlowId}" just paused awaiting user input. Relay the specialist's questions to the user in plain language and wait for an explicit user message before calling resume.`,
            }, true);
          }

          const msg = asString(params.message);
          const rawNodeId = asString(params.nodeId);
          let persistedMachine: FlowMachineState | null = null;
          if (cp?.machineStateJson) { try { persistedMachine = JSON.parse(cp.machineStateJson) as FlowMachineState; } catch {} }
          else if (targetWs.room.getSnapshot().flowId === targetFlowId) persistedMachine = targetWs.room.getPersistedMachineState();
          if (persistedMachine) persistedMachine = migrateLegacySubStateMachine(persistedMachine, targetWs.roles);
          const reqNodeId = persistedMachine ? resolveLegacyTargetNodeId(persistedMachine, rawNodeId) : rawNodeId;
          const waitingIds = persistedMachine?.status === "waiting_input"
            ? persistedMachine.nodeOrder.filter((id) => persistedMachine!.nodes[id]?.status === "waiting_input")
            : [];
          const hasHumanWaiting = waitingIds.some((id) => persistedMachine?.spec.nodes.find((n) => n.id === id)?.kind === "human");
          const queuedSteers = !msg && waitingNow && !hasHumanWaiting && !targetWs.store.isClosed()
            ? targetWs.store.listFlowSteers(targetFlowId, { unconsumedOnly: true })
            : [];
          const effectiveReplyText = msg ?? (queuedSteers.length > 0 ? queuedSteers.map((s) => s.text).join("\n") : undefined);
          if (waitingNow && !effectiveReplyText) {
            return toolResult({
              started: false, resumed: false, requiresReply: true, cwd: targetWs.cwd, flowId: targetFlowId, status: "waiting_input",
              error: `Flow "${targetFlowId}" is waiting for user input; pass the user's explicit non-empty reply in message before resuming.`,
            }, true);
          }
          if (persistedMachine?.status === "waiting_input") {
            const waitingNodes = waitingIds.map((id) => ({ nodeId: id, questions: [...(persistedMachine!.nodes[id]?.questionsForUser ?? [])] }));
            if (reqNodeId && !waitingIds.includes(reqNodeId)) {
              return toolResult({
                started: false, resumed: false, cwd: targetWs.cwd, flowId: targetFlowId, nodeId: reqNodeId, waitingNodes,
                error: `Node "${reqNodeId}" is not waiting for input in Flow "${targetFlowId}" (waiting: ${waitingIds.join(", ") || "none"}).`,
              }, true);
            }
            if (!reqNodeId && waitingIds.length > 1) {
              return toolResult({
                started: false, resumed: false, requiresNodeId: true, cwd: targetWs.cwd, flowId: targetFlowId, waitingNodes,
                error: `Flow "${targetFlowId}" has multiple waiting nodes (${waitingIds.join(", ")}); specify nodeId to bind the user's answer to a single node.`,
              }, true);
            }
            const targetHumanId = reqNodeId ?? (waitingIds.length === 1 ? waitingIds[0] : undefined);
            const targetHumanSpec = targetHumanId ? persistedMachine.spec.nodes.find((n) => n.id === targetHumanId) : undefined;
            if (targetHumanId && targetHumanSpec?.kind === "human" && targetHumanSpec.human && effectiveReplyText) {
              const evalRes = evaluateHumanReply(targetHumanSpec.human, effectiveReplyText);
              if (evalRes.decision === "invalid") {
                return toolResult({
                  started: false, resumed: false, invalidReply: true, decision: "invalid",
                  cwd: targetWs.cwd, flowId: targetFlowId, nodeId: targetHumanId, status: "waiting_input",
                  ...(targetHumanSpec.human.options?.length ? { options: targetHumanSpec.human.options } : {}),
                  error: evalRes.reason ?? "User reply is not valid for this human decision gate.",
                }, true);
              }
              if (evalRes.decision === "hold") {
                const held = persistHeldHumanDecision({
                  targetWs, cp, persistedMachine, flowId: targetFlowId, nodeId: targetHumanId, replyText: effectiveReplyText, ctx,
                });
                hub.syncGlobalUi(ctx, originWs);
                return toolResult({
                  started: false, resumed: false, held: true, decision: "hold",
                  cwd: targetWs.cwd, flowId: targetFlowId, nodeId: targetHumanId, status: "waiting_input",
                  reply: effectiveReplyText, ...(held.reason ? { reason: held.reason } : {}),
                });
              }
            }
          } else if (persistedMachine && reqNodeId) {
            const tRt = persistedMachine.nodes[reqNodeId];
            if (!tRt) return toolResult({ started: false, resumed: false, cwd: targetWs.cwd, flowId: targetFlowId, nodeId: reqNodeId, error: `Unknown nodeId "${reqNodeId}" in Flow "${targetFlowId}".` }, true);
            const unmet = getUnmetResumeDependencies(persistedMachine, reqNodeId);
            const eligible = (tRt.status === "ready" || tRt.status === "running" || tRt.status === "failed" || tRt.status === "retrying" || tRt.status === "cancelled") && unmet.length === 0;
            if (!eligible) {
              return toolResult({
                started: false, resumed: false, cwd: targetWs.cwd, flowId: targetFlowId, nodeId: reqNodeId, nodeStatus: tRt.status, unmetDependencies: unmet,
                error: `Node "${reqNodeId}" cannot be resumed yet (status=${tRt.status}${unmet.length ? `; unmet dependencies: ${unmet.map((u) => `${u.nodeId} (${u.status})`).join(", ")}` : ""}).`,
              }, true);
            }
          }
          let savedReply = false;
          if (msg) {
            const { text: steerText, targetRole } = parseDirectedSteer(msg);
            const effTargetRole = reqNodeId ?? targetRole ?? null;
            if (!targetWs.store.isClosed() && cp) {
              targetWs.store.appendFlowSteer(targetFlowId, { text: steerText, targetRole: effTargetRole });
              const refreshed = targetWs.store.getFlowCheckpoint(targetFlowId);
              if (refreshed) targetWs.room.syncFromCheckpoint(refreshed, ctx);
            } else {
              await targetWs.room.postUserSteer(msg, ctx);
            }
            savedReply = true;
          }

          if (targetWs.room.hasActiveLeaseOwnership() && targetWs.room.getSnapshot().flowId !== targetFlowId) {
            const activeFlowId = targetWs.room.getSnapshot().flowId ?? "unknown";
            return toolResult({
              started: false, resumed: false, busy: true, cwd: targetWs.cwd, flowId: targetFlowId,
              status: cp?.status ?? "waiting_input", activeFlowId, ownerPid: process.pid, savedReply,
              reason: `Project "${targetWs.cwd}" already has active Flow "${activeFlowId}" owned by PID ${process.pid}.`,
            });
          }

          try {
            const background = params.wait === true ? false : Boolean(ctx?.hasUI);
            const res = await targetWs.resumeManagedFlow(
              ctx, background, background ? undefined : signal, originWs, targetFlowId,
              { ...(reqNodeId ? { targetNodeId: reqNodeId } : {}), ...(effectiveReplyText ? { replyText: effectiveReplyText } : {}) },
            );
            hub.syncGlobalUi(ctx, originWs);
            return toolResult(decorateFlowDeliveryPayload({ ...(res as object), ...(targetWs.trustNotice ? { trustNotice: targetWs.trustNotice } : {}) }));
          } catch (err) {
            if (err instanceof ProjectBusyError) {
              return toolResult({
                started: false, resumed: false, busy: true, cwd: targetWs.cwd, flowId: targetFlowId,
                status: (!targetWs.store.isClosed() ? targetWs.store.getFlowCheckpoint(targetFlowId)?.status : undefined) ?? cp?.status ?? "waiting_input",
                activeFlowId: err.activeFlowId, ownerPid: err.ownerPid, savedReply, reason: err.message,
              });
            }
            throw err;
          }
        }

        if (action === "patch") {
          const perm = canRoleUseCompanionTool(activeRole, "enhance_flow", "steer");
          if (!perm.allowed) throw new Error(perm.reason);
          const targetWs = hub.resolveFlowWorkspace(originWs, { flowId: reqFlowId, cwd: reqCwd }, ctx, (w) => w.room.hasActiveLeaseOwnership());
          targetWs.refresh(ctx);
          const liveState = targetWs.room.getPersistedMachineState();
          if (!liveState || !targetWs.room.isRunning()) {
            return toolResult({
              patched: false, ...(reqFlowId ? { flowId: reqFlowId } : {}),
              error: reqFlowId ? `Flow "${reqFlowId}" is not currently running and cannot be patched.` : "No running DAG Flow found to patch in target workspace.",
            }, true);
          }
          if (reqFlowId && liveState.flowId !== reqFlowId) {
            return toolResult({
              patched: false, flowId: reqFlowId, activeFlowId: liveState.flowId,
              error: `Flow "${reqFlowId}" is not the currently running DAG Flow (active: "${liveState.flowId}") and cannot be patched.`,
            }, true);
          }
          const targetFlowId = reqFlowId ?? liveState.flowId;
          const patch = parsePatchObject(params.patch);
          const patchRes = targetWs.patchActiveFlow
            ? await targetWs.patchActiveFlow(targetFlowId, patch, targetWs.roles)
            : { patched: false, error: `Flow "${targetFlowId}" is no longer active and could not be patched.` };
          return toolResult({ flowId: targetFlowId, ...patchRes }, !patchRes.patched);
        }

        if (action !== "start") throw new Error(`Unknown enhance_flow action "${action}".`);

        const targetWs = hub.resolveTargetWorkspace(originWs, reqCwd, ctx);
        targetWs.refresh(ctx);
        const sid = originWs.getSessionId(ctx), goal = asString(params.goal);
        const priorSessionMandate = targetWs.store.getActiveMandate({ sessionId: sid });
        const existingMandate = goal ? null : priorSessionMandate;
        const previewGoal = goal ?? existingMandate?.goal;
        if (!previewGoal) throw new Error("enhance_flow requires a goal or an active mandate.");

        const built = buildAndValidateStartGraph({
          params, goal: previewGoal, cwd: targetWs.cwd, rolesMap: targetWs.roles,
          defaultMaxRepairRounds: targetWs.settings.flowMaxRepairRounds,
        });
        if (!built.validation.ok) {
          return toolResult({
            started: false,
            invalidGraph: true,
            issues: built.validation.issues,
            error: `Flow graph validation failed: ${built.validation.issues.map((i) => i.message).join(" | ")}`,
          }, true);
        }
        const { roles, spec, validation, isGraphMode } = built;
        const perm = canRoleUseCompanionTool(activeRole, "enhance_flow", "start", roles);
        if (!perm.allowed) throw new Error(perm.reason);
        if (targetWs.room.hasActiveLeaseOwnership()) {
          const activeId = targetWs.room.getSnapshot().flowId ?? "unknown";
          return toolResult({
            error: `项目 ${targetWs.cwd} 已有正在运行的协作 Flow (${activeId})；可通过 steer 留言、/flow 查看或 cancel 取消。`,
            started: false, busy: true, cwd: targetWs.cwd, activeFlowId: activeId, ownerPid: process.pid,
          }, true);
        }

        if (originWs.settings.flowRoutingMode === "manual") {
          return toolResult({
            started: false, blockedByRoutingMode: "manual",
            suggestion: "Automatic Flow dispatch is disabled (flowRoutingMode=manual). Enable auto or ask in /settings → Plugins → omp-enhance.",
          });
        }
        if (originWs.settings.flowRoutingMode === "ask") {
          const planSummary = isGraphMode ? formatGraphWavesSummary(spec, validation) : roles.map((r) => r.id).join(" → ");
          if (ctx?.hasUI) {
            if (typeof ctx?.ui?.confirm !== "function") return toolResult({ started: false, declined: true, reason: "Interactive confirmation unavailable under flowRoutingMode=ask." });
            const ok = (await ctx.ui.confirm("启动后台专员协作 Flow？", `目录: ${targetWs.cwd}\n编排计划: ${planSummary}\n目标: ${previewGoal}`)) === true;
            if (!ok) return toolResult({ started: false, declined: true, reason: "User declined multi-role Flow dispatch." });
          } else if (params.confirmed !== true) {
            return toolResult({
              started: false, requiresConfirmation: true, cwd: targetWs.cwd, goal: previewGoal, planSummary, roles: roles.map((r) => r.id),
              reason: 'flowRoutingMode is "ask" without interactive UI; confirm the plan and re-call with confirmed=true to start.',
            });
          }
        }

        const flowId = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const effectiveLeaseMode = isGraphMode ? validation.leaseMode : "write_main";
        const preflightLease = effectiveLeaseMode === "write_main"
          ? targetWs.store.acquireProjectFlowLease(flowId, process.pid)
          : targetWs.store.acquireScopedFlowLease(flowId, effectiveLeaseMode, process.pid);
        try {
          const reqConstraints = asStringArray(params.constraints);
          const reqAcceptance = asStringArray(params.acceptance);
          const mandate = goal
            ? targetWs.store.upsertMandate({ goal, constraints: reqConstraints, acceptance: reqAcceptance, flowId })
            : existingMandate!;
          const initialHandoffId = asString(params.initialHandoffId);
          let initialHandoff: HandoffEnvelope | null = initialHandoffId
            ? (targetWs.store.getHandoff(initialHandoffId) ?? (originWs !== targetWs ? originWs.store.getHandoff(initialHandoffId) : null))
            : (!goal ? targetWs.store.getLatestHandoff(mandate.id) : (priorSessionMandate ? targetWs.store.getLatestHandoff(priorSessionMandate.id) : null));
          if (!initialHandoff && targetWs.cwd === originWs.cwd && roles.length > 0) {
            initialHandoff = hub.seedLocalChangesHandoff(originWs, sid, mandate, roles[0]!.id);
          }
          const maxRepairRounds = spec.policies.maxRepairRounds;
          const background = params.wait === true ? false : Boolean(ctx?.hasUI);
          const started = await targetWs.startManagedFlow({
            ctx, originWs, flowId, roles, mandate, initialHandoff, maxRepairRounds, background,
            ...(background ? {} : { signal }),
            ...(isGraphMode ? { graphSpec: spec, graphValidation: validation } : {}),
          });
          hub.syncGlobalUi(ctx, originWs);
          return toolResult(decorateFlowDeliveryPayload({ ...(started as object), ...(targetWs.trustNotice ? { trustNotice: targetWs.trustNotice } : {}) }));
        } catch (startErr) {
          if (!targetWs.room.hasActiveLeaseOwnership() || targetWs.room.getSnapshot().flowId !== flowId) {
            try { targetWs.store.releaseProjectFlowLease(flowId, preflightLease.leaseToken); } catch {}
          }
          throw startErr;
        }
      } catch (error) {
        if (error instanceof ProjectBusyError) {
          return toolResult({
            error: error.message, started: false, busy: true,
            cwd: error.cwd, activeFlowId: error.activeFlowId, ownerPid: error.ownerPid,
          }, true);
        }
        return toolError(error);
      }
    },
  });
}
