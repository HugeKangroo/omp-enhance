import path from "node:path";
import {
  loadEnhanceSettings,
  modelSupportsVision,
  resolveDefaultGlobalRolesDir,
  resolveModelSpec,
} from "./core/settings.ts";
import type { RoleSessionRunner } from "./flow/orchestrator.ts";
import { reconcileJobs } from "./jobs/runner.ts";
import { registerEnhanceCommands } from "./omp/commands.ts";
import { turnFailedOrAborted } from "./omp/session.ts";
import { registerEnhanceTools } from "./omp/tools.ts";
import {
  branchOverrideSignature,
  createManagedWorkspace,
  defaultRoleId,
  isProjectTrusted,
  readSessionRoleOverride,
  sessionKey,
  type ManagedWorkspace,
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
  const workspaces = new Map<string, ManagedWorkspace>();
  registerRoomMessageRenderer(pi);

  function getWorkspace(ctx: any): ManagedWorkspace {
    const cwd = path.resolve(ctx?.cwd ?? process.cwd());
    const trusted = isProjectTrusted(ctx);
    const existing = workspaces.get(cwd);
    if (existing) {
      existing.settings = loadEnhanceSettings({ cwd, pluginLockPath: options.pluginLockPath, isProjectTrusted: trusted });
      return existing;
    }
    const created = createManagedWorkspace(pi, cwd, trusted, options);
    workspaces.set(cwd, created);
    return created;
  }

  pi.on("input", (event: any, ctx: any) => {
    try {
      const text = typeof event?.text === "string" ? event.text : "";
      const atMatch = /^@([a-zA-Z0-9][a-zA-Z0-9_-]*)\s+([\s\S]+)$/.exec(text.trim());
      if (atMatch) {
        const ws = getWorkspace(ctx); ws.refresh(ctx);
        const roleId = atMatch[1]!, task = atMatch[2]!.trim();
        if (roleId !== "supervisor" && task && ws.roles.has(roleId)) {
          return { text: ws.room.isRunning() ? `/flow steer [@${roleId}] ${task}` : `/flow ${roleId} ${task}` };
        }
      }
    } catch {}
    return undefined;
  });

  const onSessionLifecycle = async (_ev: any, ctx: any): Promise<void> => {
    try { await getWorkspace(ctx).syncSessionLifecycle(ctx); } catch {}
  };
  for (const lifecycleEvent of ["session_start", "session_switch", "session_branch", "session_tree"] as const) {
    pi.on(lifecycleEvent, onSessionLifecycle);
  }

  pi.on("session_shutdown", () => {
    for (const ws of workspaces.values()) {
      try { ws.room.dispose(); } catch {}
      try { ws.store.close(); } catch {}
      ws.trackers.clear();
      ws.baselines.clear();
    }
    workspaces.clear();
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      const ws = getWorkspace(ctx);
      reconcileJobs(ws.store); ws.refresh(ctx);
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
      ws.syncStatusBar(ctx);
      ws.trackers.get(sid).beginTurn(ws.cwd, true);
      const role = ws.getActiveRole(ctx);
      if (!role) return;
      const mandate = ws.store.getActiveMandate({ sessionId: sid });
      const effectiveModel =
        role.model && role.model !== "inherit" ? resolveModelSpec(role.model, ctx, pi) : ctx?.model;
      const block = renderConditioningBlock({
        role, mandate, epistemicItems: mandate ? ws.store.listEpistemicItems(mandate.id) : [],
        upstreamHandoff: mandate ? ws.store.getLatestHandoff(mandate.id) : null,
        visionCapable: modelSupportsVision(effectiveModel),
      });
      const existing = Array.isArray(event?.systemPrompt) ? event.systemPrompt : event?.systemPrompt ? [event.systemPrompt] : [];
      return { systemPrompt: [...existing, block] };
    } catch { return undefined; }
  });

  pi.on("agent_end", (event: any, ctx: any) => {
    try {
      const tracker = getWorkspace(ctx).trackers.get(sessionKey(ctx));
      if (turnFailedOrAborted(event)) tracker.markTurnFailed();
      else tracker.completeTurn();
    } catch {}
  });

  pi.on("tool_call", (event: any, ctx: any) => {
    try {
      const ws = getWorkspace(ctx), tracker = ws.trackers.get(sessionKey(ctx));
      const toolName = event?.toolName ?? event?.name ?? "", input = event?.input ?? event?.args;
      const decision = tracker.checkToolCallAllowed(ws.cwd, ws.getActiveRole(ctx), { toolName, input }, ws.roles);
      return decision.block ? decision : undefined;
    } catch { return undefined; }
  });

  pi.on("tool_execution_start", (event: any, ctx: any) => {
    try {
      const ws = getWorkspace(ctx);
      ws.trackers.get(sessionKey(ctx)).recordToolExecutionStart(
        event?.toolName ?? event?.name ?? "",
        event?.args ?? event?.input,
      );
    } catch {}
  });

  pi.on("tool_execution_end", (event: any, ctx: any) => {
    try {
      const ws = getWorkspace(ctx);
      ws.trackers.get(sessionKey(ctx)).recordToolExecutionEnd(ws.cwd, {
        toolCallId: event?.toolCallId ?? event?.id ?? "call", toolName: event?.toolName ?? event?.name ?? "unknown",
        args: event?.args ?? event?.input, isError: Boolean(evHasError(event)),
      });
    } catch {}
  });

  registerEnhanceTools(pi, getWorkspace);
  registerEnhanceCommands(pi, getWorkspace, {
    globalRolesDir: options.globalRolesDir ?? resolveDefaultGlobalRolesDir(),
    builtinRolesDir: options.builtinRolesDir,
  });
}

function evHasError(event: any): boolean {
  return Boolean(event?.isError ?? event?.result?.isError);
}
