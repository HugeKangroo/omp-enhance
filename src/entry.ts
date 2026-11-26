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
import { ForegroundWorkflowController } from "./omp/workflow-fg.ts";
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
  const fgWorkflow = new ForegroundWorkflowController();
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
      const userTurn = extractLatestUserTurn(event, ctx);
      if (userTurn) fgWorkflow.observeUserTurn(sid, userTurn);
      const mandate = ws.store.getActiveMandate({ sessionId: sid });
      const fgPhase = fgWorkflow.getActivePhaseContext(sid, ws.cwd, role, mandate?.goal);
      const effectiveRole = fgPhase?.effectiveRole ?? role;
      const effectiveModel =
        effectiveRole.model && effectiveRole.model !== "inherit" ? resolveModelSpec(effectiveRole.model, ctx, pi) : ctx?.model;
      const baseBlock = renderConditioningBlock({
        role: effectiveRole,
        mandate,
        epistemicItems: mandate ? ws.store.listEpistemicItems(mandate.id) : [],
        upstreamHandoff: mandate ? ws.store.getLatestHandoff(mandate.id) : null,
        visionCapable: modelSupportsVision(effectiveModel),
        ...(canRoleDispatch(effectiveRole)
          ? { availableRoles: [...ws.roles.values()], activeWorkloads: hub.collectActiveWorkloads() }
          : {}),
      });
      const block = fgPhase ? `${baseBlock}\n\n${fgPhase.promptNote}` : baseBlock;
      if (fgPhase && ws.settings.showStatusBar) {
        try { ctx?.ui?.setStatus?.("omp-enhance", `enhance:${role.id} [${fgPhase.badge}]`); } catch {}
      }
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
      const sid = sessionKey(ctx);
      const fgPhase = fgWorkflow.getActivePhaseContext(sid, ws.cwd, role);
      const effectiveRole = fgPhase?.effectiveRole ?? role;
      const tracker = ws.trackers.get(sid);
      const toolName = event?.toolName ?? event?.name ?? "", input = event?.input ?? event?.args;
      const decision = tracker.checkToolCallAllowed(ws.cwd, effectiveRole, { toolName, input }, ws.roles);
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

  registerEnhanceTools(pi, hub, fgWorkflow);
  registerEnhanceCommands(pi, hub, {
    globalRolesDir: options.globalRolesDir ?? resolveDefaultGlobalRolesDir(),
    builtinRolesDir: options.builtinRolesDir,
  });
}

function evHasError(event: any): boolean {
  return Boolean(event?.isError ?? event?.result?.isError);
}

function extractMsgText(msg: any): string {
  if (!msg) return "";
  if (typeof msg === "string") return msg.trim();
  if (typeof msg.content === "string") return msg.content.trim();
  if (Array.isArray(msg.content)) {
    return msg.content.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n").trim();
  }
  return typeof msg.text === "string" ? msg.text.trim() : "";
}

let fgTurnSeq = 0;

function extractLatestUserTurn(event: any, ctx: any): { turnKey: string; userText: string } | null {
  const fn = ctx?.sessionManager?.getBranch ?? ctx?.sessionManager?.getEntries;
  if (typeof fn === "function") {
    try {
      const entries: any[] = fn.call(ctx.sessionManager) ?? [];
      let userCount = 0, lastKey = "", lastText = "";
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i], m = e?.type === "message" ? e.message : e;
        if (m?.role === "user") { userCount += 1; lastKey = typeof e?.id === "string" ? e.id : `u-${userCount}`; lastText = extractMsgText(m); }
      }
      if (userCount > 0) return { turnKey: lastKey, userText: lastText };
    } catch {}
  }
  const direct = extractMsgText(event?.userMessage ?? event?.prompt ?? event?.message);
  return direct ? { turnKey: `ev-${++fgTurnSeq}`, userText: direct } : null;
}
