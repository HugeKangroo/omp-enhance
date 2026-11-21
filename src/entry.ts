import path from "node:path";
import {
  loadEnhanceSettings, modelSupportsVision, resolveDefaultGlobalRolesDir, resolveModelSpec,
} from "./core/settings.ts";
import type { RoleSessionRunner } from "./flow/orchestrator.ts";
import { reconcileJobs } from "./jobs/runner.ts";
import { registerEnhanceCommands } from "./omp/commands.ts";
import {
  createManagedWorkspace, defaultRoleId, isProjectTrusted, readSessionRoleOverride,
  sessionKey, turnFailedOrAborted, type ManagedWorkspace,
} from "./omp/session.ts";
import { registerEnhanceTools } from "./omp/tools.ts";
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

  pi.on("session_start", async (_ev: any, ctx: any) => {
    try {
      const ws = getWorkspace(ctx); ws.refresh(ctx);
      const prevSid = ws.lastSessionId, sid = sessionKey(ctx);
      ws.trackers.reset(sid, ws.cwd);
      const ov = readSessionRoleOverride(ctx, ws.roles);
      const next = ov.found ? ov.roleId : (prevSid !== undefined ? defaultRoleId(ws.roles, ws.settings) : ws.getSessionRoleId(ctx));
      await ws.applyActiveRole(next, ctx, false);
    } catch {}
  });

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
      if (sid !== ws.lastSessionId) {
        const prevSid = ws.lastSessionId;
        const ov = readSessionRoleOverride(ctx, ws.roles);
        const next = ov.found ? ov.roleId : (prevSid !== undefined ? defaultRoleId(ws.roles, ws.settings) : ws.getSessionRoleId(ctx));
        ws.trackers.reset(sid, ws.cwd);
        await ws.applyActiveRole(next, ctx, false);
      }
      ws.syncStatusBar(ctx);
      ws.trackers.get(sid).beginTurn(ws.cwd, true);
      const role = ws.getActiveRole(ctx);
      if (!role) return;
      const mandate = ws.store.getActiveMandate({ sessionId: sid });
      const effectiveModel = role.model && role.model !== "inherit" ? resolveModelSpec(role.model, ctx) : ctx?.model;
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
    try { if (!turnFailedOrAborted(event)) getWorkspace(ctx).trackers.get(sessionKey(ctx)).completeTurn(); } catch {}
  });

  pi.on("tool_call", (event: any, ctx: any) => {
    try {
      const ws = getWorkspace(ctx), tracker = ws.trackers.get(sessionKey(ctx));
      const toolName = event?.toolName ?? event?.name ?? "", input = event?.input ?? event?.args;
      const decision = tracker.checkToolCallAllowed(ws.cwd, ws.getActiveRole(ctx), { toolName, input }, ws.roles);
      if (!decision.block) tracker.recordToolExecutionStart(toolName, input);
      return decision.block ? decision : undefined;
    } catch { return undefined; }
  });

  pi.on("tool_execution_end", (event: any, ctx: any) => {
    try {
      const ws = getWorkspace(ctx);
      ws.trackers.get(sessionKey(ctx)).recordToolExecutionEnd(ws.cwd, {
        toolCallId: event?.toolCallId ?? event?.id ?? "call", toolName: event?.toolName ?? event?.name ?? "unknown",
        args: event?.args ?? event?.input, isError: Boolean(event?.isError ?? event?.result?.isError),
      });
    } catch {}
  });

  registerEnhanceTools(pi, getWorkspace);
  registerEnhanceCommands(pi, getWorkspace, {
    globalRolesDir: options.globalRolesDir ?? resolveDefaultGlobalRolesDir(),
    builtinRolesDir: options.builtinRolesDir,
  });
}
