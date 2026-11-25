import { canRoleDispatch } from "./core/policy.ts";
import {
  modelSupportsVision,
  resolveDefaultGlobalRolesDir,
  resolveModelSpec,
} from "./core/settings.ts";
import type { RoleSessionRunner } from "./flow/orchestrator.ts";
import { reconcileJobs } from "./jobs/runner.ts";
import { registerEnhanceCommands } from "./omp/commands.ts";
import { createWorkspaceHub } from "./omp/hub.ts";
import { turnFailedOrAborted } from "./omp/session.ts";
import { registerEnhanceTools } from "./omp/tools.ts";
import {
  branchOverrideSignature,
  defaultRoleId,
  readSessionRoleOverride,
  sessionKey,
} from "./omp/workspace.ts";
import { renderConditioningBlock } from "./roles/conditioning.ts";
import { registerRoomMessageRenderer } from "./ui/flow-room.ts";

export interface EnhanceOptions {
  globalRolesDir?: string;
  builtinRolesDir?: string;
  pluginLockPath?: string;
  runnerFactory?: (pi: any, ctx: any) => RoleSessionRunner;
}

export default function ompEnhance(pi: any, options: EnhanceOptions = {}): void {
  const hub = createWorkspaceHub(pi, options);
  registerRoomMessageRenderer(pi);

  const onSessionLifecycle = async (_ev: any, ctx: any): Promise<void> => {
    try { await hub.getWorkspace(ctx).syncSessionLifecycle(ctx); } catch {}
  };
  for (const lifecycleEvent of ["session_start", "session_switch", "session_branch", "session_tree"] as const) {
    pi.on(lifecycleEvent, onSessionLifecycle);
  }

  pi.on("session_shutdown", () => {
    hub.disposeAll();
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      hub.setForegroundTurnActive(true);
      const ws = hub.getWorkspace(ctx);
      if (!ws.store.isClosed()) reconcileJobs(ws.store);
      ws.refresh(ctx);
      const sid = sessionKey(ctx);
      const curBranchSig = branchOverrideSignature(ctx);
      if (ws.lastSessionId === undefined) {
        const ov = readSessionRoleOverride(ctx, ws.roles);
        await ws.applyActiveRole(ov.found ? ov.roleId : ws.getSessionRoleId(ctx), ctx, false);
      } else if (sid !== ws.lastSessionId || curBranchSig !== ws.lastBranchOverrideSig) {
        ws.trackers.reset(sid, ws.cwd);
        const ov = readSessionRoleOverride(ctx, ws.roles);
        const next = ov.found
          ? ov.roleId
          : ws.rolesBySession.has(sid)
            ? ws.rolesBySession.get(sid)!
            : defaultRoleId(ws.roles, ws.settings);
        await ws.applyActiveRole(next, ctx, false);
      } else {
        ws.baselines.reconcileManualChanges(pi, ctx);
      }
      hub.syncGlobalUi(ctx, ws);
      const role = ws.getActiveRole(ctx);
      if (!role) return undefined;

      ws.trackers.get(sid).beginTurn(ws.cwd, true);
      const mandate = ws.store.getActiveMandate({ sessionId: sid });
      const effectiveModel =
        role.model && role.model !== "inherit" ? resolveModelSpec(role.model, ctx, pi) : ctx?.model;
      const block = renderConditioningBlock({
        role,
        mandate,
        epistemicItems: mandate ? ws.store.listEpistemicItems(mandate.id) : [],
        upstreamHandoff: mandate ? ws.store.getLatestHandoff(mandate.id) : null,
        visionCapable: modelSupportsVision(effectiveModel),
        ...(canRoleDispatch(role)
          ? { availableRoles: [...ws.roles.values()], activeWorkloads: hub.collectActiveWorkloads() }
          : {}),
      });
      const existing = Array.isArray(event?.systemPrompt) ? event.systemPrompt : event?.systemPrompt ? [event.systemPrompt] : [];
      return { systemPrompt: [...existing, block] };
    } catch {
      return undefined;
    }
  });

  pi.on("agent_end", (event: any, ctx: any) => {
    try {
      hub.setForegroundTurnActive(false);
      const ws = hub.getWorkspace(ctx);
      if (ws.getActiveRole(ctx)) {
        const tracker = ws.trackers.get(sessionKey(ctx));
        if (turnFailedOrAborted(event)) tracker.markTurnFailed();
        else tracker.completeTurn();
      }
      hub.flushPendingWakeups(ctx);
    } catch {}
  });

  pi.on("tool_call", (event: any, ctx: any) => {
    try {
      const ws = hub.getWorkspace(ctx);
      const role = ws.getActiveRole(ctx);
      if (!role) return undefined;
      const tracker = ws.trackers.get(sessionKey(ctx));
      const toolName = event?.toolName ?? event?.name ?? "", input = event?.input ?? event?.args;
      const decision = tracker.checkToolCallAllowed(ws.cwd, role, { toolName, input }, ws.roles);
      return decision.block ? decision : undefined;
    } catch { return undefined; }
  });

  pi.on("tool_execution_start", (event: any, ctx: any) => {
    try {
      const ws = hub.getWorkspace(ctx);
      if (!ws.getActiveRole(ctx)) return;
      ws.trackers.get(sessionKey(ctx)).recordToolExecutionStart(
        event?.toolName ?? event?.name ?? "",
        event?.args ?? event?.input,
        event?.toolCallId ?? event?.id,
      );
    } catch {}
  });

  pi.on("tool_execution_end", (event: any, ctx: any) => {
    try {
      const ws = hub.getWorkspace(ctx);
      if (!ws.getActiveRole(ctx)) return;
      ws.trackers.get(sessionKey(ctx)).recordToolExecutionEnd(ws.cwd, {
        toolCallId: event?.toolCallId ?? event?.id ?? "call", toolName: event?.toolName ?? event?.name ?? "unknown",
        args: event?.args, input: event?.input, result: event?.result, output: event?.output, details: event?.details,
        exitCode: typeof event?.exitCode === "number" ? event.exitCode : undefined,
        isError: Boolean(evHasError(event)),
      });
    } catch {}
  });

  registerEnhanceTools(pi, hub);
  registerEnhanceCommands(pi, hub, {
    globalRolesDir: options.globalRolesDir ?? resolveDefaultGlobalRolesDir(),
    builtinRolesDir: options.builtinRolesDir,
  });
}

function evHasError(event: any): boolean {
  return Boolean(event?.isError ?? event?.result?.isError);
}
