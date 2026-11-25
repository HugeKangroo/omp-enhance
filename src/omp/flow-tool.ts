import { canRoleUseCompanionTool, isInternalRole } from "../core/policy.ts";
import { ProjectBusyError } from "../core/store.ts";
import type { HandoffEnvelope } from "../core/types.ts";
import { isCheckpointResumable, parseDirectedSteer, snapshotFromCheckpoint } from "../flow/state.ts";
import type { WorkspaceHub } from "./hub.ts";
import type { ManagedWorkspace } from "./workspace.ts";

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const asStringArray = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((it): it is string => typeof it === "string" && it.trim().length > 0);
  return items.length > 0 ? items : undefined;
};

const NON_TERMINAL_FLOW_STATUSES = new Set(["running", "waiting_input", "interrupted", "failed"]);

const toolResult = (payload: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  ...(isError ? { isError: true } : {}),
});
const toolError = (error: unknown) =>
  toolResult({ error: error instanceof Error ? error.message : String(error) }, true);

export async function executeCancelFlow(
  hub: WorkspaceHub,
  originWs: ManagedWorkspace,
  params: { flowId?: string; cwd?: string },
  ctx: any,
): Promise<{ cancelled: boolean; cwd: string; flowId: string | null; status: string; reason?: string }> {
  const reqFlowId = params.flowId?.trim() || undefined;
  const reqCwd = params.cwd?.trim() || undefined;
  const targetWs = hub.resolveFlowWorkspace(originWs, { flowId: reqFlowId, cwd: reqCwd }, ctx, (w) => w.room.hasActiveLeaseOwnership());

  if (reqFlowId) {
    if (targetWs.room.hasActiveLeaseOwnership() && targetWs.room.getSnapshot().flowId === reqFlowId) {
      const cancelled = await targetWs.room.cancelActiveFlow(ctx);
      hub.syncGlobalUi(ctx, originWs);
      const snap = targetWs.room.getSnapshot();
      return { cancelled, cwd: targetWs.cwd, flowId: reqFlowId, status: snap.status };
    }
    const tx = targetWs.store.cancelFlowCheckpoint(reqFlowId);
    if (!tx.checkpoint) throw new Error(tx.reason ?? `Unknown flowId "${reqFlowId}".`);
    if (!targetWs.room.isRunning() && targetWs.room.getSnapshot().flowId === reqFlowId) {
      targetWs.room.syncFromCheckpoint(tx.checkpoint, ctx);
    }
    hub.syncGlobalUi(ctx, originWs);
    return {
      cancelled: tx.cancelled,
      cwd: targetWs.cwd,
      flowId: reqFlowId,
      status: tx.checkpoint.status,
      ...(tx.reason ? { reason: tx.reason } : {}),
    };
  }

  if (targetWs.room.hasActiveLeaseOwnership()) {
    const cancelled = await targetWs.room.cancelActiveFlow(ctx);
    hub.syncGlobalUi(ctx, originWs);
    const snap = targetWs.room.getSnapshot();
    return { cancelled, cwd: targetWs.cwd, flowId: snap.flowId, status: snap.status };
  }
  const activeLease = !targetWs.store.isClosed() ? targetWs.store.getProjectFlowLease() : null;
  if (activeLease) {
    return {
      cancelled: false,
      cwd: targetWs.cwd,
      flowId: activeLease.flowId,
      status: "running",
      reason: `Flow "${activeLease.flowId}" is actively running in another OMP window (pid=${activeLease.ownerPid}).`,
    };
  }
  const snap = targetWs.room.getSnapshot();
  return {
    cancelled: false,
    cwd: targetWs.cwd,
    flowId: snap.flowId,
    status: snap.status,
    reason: "No running Flow in target workspace.",
  };
}

export function registerFlowTool(
  registerTool: (input: {
    name: string; label: string; description: string; approval?: "read" | "write" | "exec"; parameters: unknown;
    execute: (params: Record<string, unknown>, ctx: any, signal?: AbortSignal) => Promise<unknown>;
  }) => void,
  kit: {
    str: () => unknown; num: () => unknown; bool: () => unknown;
    arr: (item: unknown) => unknown; en: (values: readonly string[]) => unknown;
    obj: (props: Record<string, unknown>, req: string[]) => unknown;
  },
  hub: WorkspaceHub,
): void {
  registerTool({
    name: "enhance_flow",
    label: "Enhance Flow",
    approval: "exec",
    description: "Start, resume, list/inspect status, steer, or cancel Markov-isolated specialist Flows across one or multiple project directories (cwd).",
    parameters: kit.obj({
      action: kit.en(["start", "status", "list", "steer", "cancel", "resume"]),
      cwd: kit.str(), flowId: kit.str(), roles: kit.arr(kit.str()), goal: kit.str(),
      message: kit.str(), maxRepairRounds: kit.num(), initialHandoffId: kit.str(), wait: kit.bool(),
    }, []),
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
              return toolResult({ cwd: targetWs.cwd, ...targetWs.room.getSnapshot(), resumable: targetWs.room.isResumable() });
            }
            const cp = !targetWs.store.isClosed() ? targetWs.store.getFlowCheckpoint(reqFlowId) : null;
            if (cp) {
              return toolResult({ cwd: targetWs.cwd, ...snapshotFromCheckpoint(cp, targetWs.cwd), resumable: isCheckpointResumable(cp) });
            }
            if (targetWs.room.getSnapshot().flowId === reqFlowId) {
              return toolResult({ cwd: targetWs.cwd, ...targetWs.room.getSnapshot(), resumable: targetWs.room.isResumable() });
            }
            throw new Error(`Unknown flowId "${reqFlowId}".`);
          }
          if (reqCwd) {
            const targetWs = hub.resolveTargetWorkspace(originWs, reqCwd, ctx);
            hub.markFlowSnapshotObserved(targetWs);
            if (!targetWs.room.hasActiveLeaseOwnership() && !targetWs.store.isClosed()) {
              const latest = targetWs.store.getLatestFlowCheckpoint();
              if (latest) {
                return toolResult({
                  cwd: targetWs.cwd, ...snapshotFromCheckpoint(latest, targetWs.cwd), resumable: isCheckpointResumable(latest),
                  ...(targetWs.trustNotice ? { trustNotice: targetWs.trustNotice } : {}),
                });
              }
            }
            return toolResult({
              cwd: targetWs.cwd, ...targetWs.room.getSnapshot(), resumable: targetWs.room.isResumable(),
              ...(targetWs.trustNotice ? { trustNotice: targetWs.trustNotice } : {}),
            });
          }
          hub.markAllSettledFlowsObserved();
          const latestOrigin = !originWs.room.hasActiveLeaseOwnership() && !originWs.store.isClosed()
            ? originWs.store.getLatestFlowCheckpoint()
            : null;
          const baseSnap = latestOrigin ? snapshotFromCheckpoint(latestOrigin, originWs.cwd) : originWs.room.getSnapshot();
          const baseResumable = latestOrigin ? isCheckpointResumable(latestOrigin) : originWs.room.isResumable();
          return toolResult({
            cwd: originWs.cwd, ...baseSnap, resumable: baseResumable,
            flows: hub.getAllFlowSummaries(), runningJobs: hub.getAllRunningJobs(),
          });
        }

        if (action === "cancel") {
          return toolResult(await executeCancelFlow(hub, originWs, { flowId: reqFlowId, cwd: reqCwd }, ctx));
        }

        if (action === "steer") {
          const perm = canRoleUseCompanionTool(activeRole, "enhance_flow", "steer");
          if (!perm.allowed) throw new Error(perm.reason);
          const msg = asString(params.message) ?? asString(params.goal);
          if (!msg) throw new Error("enhance_flow steer requires a message.");
          const targetWs = hub.resolveFlowWorkspace(
            originWs, { flowId: reqFlowId, cwd: reqCwd }, ctx,
            (w) => w.room.hasActiveLeaseOwnership() || w.room.isResumable() ||
              (!w.store.isClosed() && w.store.listFlowCheckpoints(20).some((c) => NON_TERMINAL_FLOW_STATUSES.has(c.status))),
          );

          let resolvedFlowId = reqFlowId;
          if (!resolvedFlowId && !targetWs.store.isClosed()) {
            const nonTerminal = targetWs.store.listFlowCheckpoints(50).filter((c) => NON_TERMINAL_FLOW_STATUSES.has(c.status));
            if (nonTerminal.length > 1) {
              const choices = nonTerminal.map((c) => `${c.flowId} [${c.status}: ${c.goal}]`).join("; ");
              return toolResult({
                ok: false, ambiguous: true, requiresFlowId: true, cwd: targetWs.cwd,
                candidates: nonTerminal.map((c) => ({ flowId: c.flowId, status: c.status, goal: c.goal, roleChain: c.roleChain })),
                error: `Multiple active/paused Flows exist in ${targetWs.cwd}; specify flowId (${choices}).`,
              }, true);
            }
            if (nonTerminal.length === 1) resolvedFlowId = nonTerminal[0]!.flowId;
          }
          if (!resolvedFlowId) resolvedFlowId = targetWs.room.getSnapshot().flowId ?? undefined;
          if (!resolvedFlowId) throw new Error(`No active or resumable Flow found in ${targetWs.cwd}.`);

          if (targetWs.room.hasActiveLeaseOwnership() && targetWs.room.getSnapshot().flowId === resolvedFlowId) {
            const res = await targetWs.room.postUserSteer(msg, ctx);
            const snap = targetWs.room.getSnapshot();
            return toolResult({ ok: true, cwd: targetWs.cwd, flowId: resolvedFlowId, ...res, status: snap.status });
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
            ok: true,
            deliveryState: "saved_pending_delivery",
            delivered: false,
            savedToCheckpoint: true,
            steerId: appended.steerId,
            ...(targetRole ? { queuedForRole: targetRole } : {}),
            cwd: targetWs.cwd,
            flowId: resolvedFlowId,
            status: liveCp.status,
            activeStageId: null,
          });
        }

        if (action === "resume") {
          const perm = canRoleUseCompanionTool(activeRole, "enhance_flow", "resume");
          if (!perm.allowed) throw new Error(perm.reason);
          const targetWs = hub.resolveFlowWorkspace(
            originWs, { flowId: reqFlowId, cwd: reqCwd }, ctx,
            (w) => (!w.store.isClosed() && w.store.listFlowCheckpoints(10).some((cp) => isCheckpointResumable(cp))) || w.room.isResumable(),
          );
          targetWs.refresh(ctx);
          const targetFlowId = reqFlowId ?? (
            !targetWs.store.isClosed()
              ? (targetWs.store.listFlowCheckpoints(10).find((c) => isCheckpointResumable(c))?.flowId ??
                  (targetWs.room.isResumable() ? targetWs.room.getSnapshot().flowId : null))
              : (targetWs.room.isResumable() ? targetWs.room.getSnapshot().flowId : null)
          );
          if (!targetFlowId) throw new Error("当前没有可断点续跑的中断/失败 Flow。");
          const cp = !targetWs.store.isClosed() ? targetWs.store.getFlowCheckpoint(targetFlowId) : null;
          if (reqFlowId && !cp && targetWs.room.getSnapshot().flowId !== reqFlowId) throw new Error(`Unknown flowId "${reqFlowId}".`);
          if (cp && !isCheckpointResumable(cp)) throw new Error(`Flow "${cp.flowId}" 当前状态为 ${cp.status}，无法断点续跑。`);

          const msg = asString(params.message);
          let savedReply = false;
          if (msg) {
            const { text: steerText, targetRole } = parseDirectedSteer(msg);
            if (!targetWs.store.isClosed() && cp) {
              targetWs.store.appendFlowSteer(targetFlowId, { text: steerText, targetRole: targetRole ?? null });
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
            const res = await targetWs.resumeManagedFlow(ctx, background, background ? undefined : signal, originWs, targetFlowId);
            hub.syncGlobalUi(ctx, originWs);
            return toolResult({ ...(res as object), ...(targetWs.trustNotice ? { trustNotice: targetWs.trustNotice } : {}) });
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

        if (action !== "start") throw new Error(`Unknown enhance_flow action "${action}".`);

        const targetWs = hub.resolveTargetWorkspace(originWs, reqCwd, ctx);
        targetWs.refresh(ctx);
        const roleIds = asStringArray(params.roles);
        if (!roleIds) throw new Error("enhance_flow start requires a non-empty roles array.");
        const roles = roleIds.map((id) => {
          const r = targetWs.roles.get(id);
          if (id === "supervisor" || (r && isInternalRole(r))) throw new Error(`Role "${id}" is an internal monitor and cannot run as a Flow stage.`);
          if (!r) throw new Error(`Unknown role "${id}".`);
          return r;
        });
        const perm = canRoleUseCompanionTool(activeRole, "enhance_flow", "start", roles);
        if (!perm.allowed) throw new Error(perm.reason);
        if (targetWs.room.hasActiveLeaseOwnership()) {
          const activeId = targetWs.room.getSnapshot().flowId ?? "unknown";
          return toolResult({
            error: `项目 ${targetWs.cwd} 已有正在运行的协作 Flow (${activeId})；可通过 steer 留言、/flow 查看或 cancel 取消。`,
            started: false, busy: true, cwd: targetWs.cwd, activeFlowId: activeId, ownerPid: process.pid,
          }, true);
        }

        const sid = originWs.getSessionId(ctx), goal = asString(params.goal);
        const priorSessionMandate = targetWs.store.getActiveMandate({ sessionId: sid });
        const existingMandate = goal ? null : priorSessionMandate;
        const previewGoal = goal ?? existingMandate?.goal;
        if (!previewGoal) throw new Error("enhance_flow requires a goal or an active mandate.");

        if (originWs.settings.flowRoutingMode === "manual") {
          return toolResult({
            started: false, blockedByRoutingMode: "manual",
            suggestion: "Automatic Flow dispatch is disabled (flowRoutingMode=manual). Enable auto or ask in /settings → Plugins → omp-enhance.",
          });
        }
        if (originWs.settings.flowRoutingMode === "ask" && ctx?.hasUI) {
          if (typeof ctx?.ui?.confirm !== "function") return toolResult({ started: false, declined: true, reason: "Interactive confirmation unavailable under flowRoutingMode=ask." });
          const ok = (await ctx.ui.confirm("启动后台专员协作 Flow？", `目录: ${targetWs.cwd}\n专员链: ${roleIds.join(" → ")}\n目标: ${previewGoal}`)) === true;
          if (!ok) return toolResult({ started: false, declined: true, reason: "User declined multi-role Flow dispatch." });
        }

        const flowId = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const preflightLease = targetWs.store.acquireProjectFlowLease(flowId, process.pid);
        try {
          const mandate = goal ? targetWs.store.upsertMandate({ goal, flowId }) : existingMandate!;
          const initialHandoffId = asString(params.initialHandoffId);
          let initialHandoff: HandoffEnvelope | null = initialHandoffId
            ? (targetWs.store.getHandoff(initialHandoffId) ?? (originWs !== targetWs ? originWs.store.getHandoff(initialHandoffId) : null))
            : (!goal ? targetWs.store.getLatestHandoff(mandate.id) : (priorSessionMandate ? targetWs.store.getLatestHandoff(priorSessionMandate.id) : null));
          if (!initialHandoff && targetWs.cwd === originWs.cwd) {
            initialHandoff = hub.seedLocalChangesHandoff(originWs, sid, mandate, roles[0]!.id);
          }
          const maxRepairRounds = typeof params.maxRepairRounds === "number" ? params.maxRepairRounds : targetWs.settings.flowMaxRepairRounds;
          const background = params.wait === true ? false : Boolean(ctx?.hasUI);
          const started = await targetWs.startManagedFlow({
            ctx, originWs, flowId, roles, mandate, initialHandoff, maxRepairRounds, background, ...(background ? {} : { signal }),
          });
          hub.syncGlobalUi(ctx, originWs);
          return toolResult({ ...(started as object), ...(targetWs.trustNotice ? { trustNotice: targetWs.trustNotice } : {}) });
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
