import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveRoleActiveTools } from "../core/policy.ts";
import {
  extractModelSpecThinking, loadEnhanceSettings, resolveDefaultGlobalRolesDir, resolveModelSpec,
} from "../core/settings.ts";
import { EnhanceStore } from "../core/store.ts";
import type { EnhanceSettings, FlowRunResult, HandoffEnvelope, Mandate, RoleSpec } from "../core/types.ts";
import { executeRoleFlow, type RoleSessionRunner } from "../flow/orchestrator.ts";
import { FlowRoomManager } from "../flow/state.ts";
import { SessionTrackerRegistry } from "../flow/tracker.ts";
import { discoverRolesWithDiagnostics } from "../roles/loader.ts";
import { createFlowRoomUiAdapter } from "../ui/flow-room.ts";
import { createOmpRoleSessionRunner, createOmpSupervisorInspector } from "./session.ts";
import type { WorkspaceRuntime } from "./tools.ts";

export const sessionKey = (ctx: any): string =>
  ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionManager?.getSessionFile?.() ?? "__default__";

export const isProjectTrusted = (ctx: any): boolean =>
  typeof ctx?.isProjectTrusted === "function" ? Boolean(ctx.isProjectTrusted()) : true;

export const defaultRoleId = (roles: Map<string, RoleSpec>, settings: EnhanceSettings): string | null =>
  settings.defaultRole === null ? null
    : (roles.has(settings.defaultRole) ? settings.defaultRole : (roles.has("general") ? "general" : (roles.has("dev") ? "dev" : null)));

export function readSessionRoleOverride(
  ctx: any, roles: ReadonlyMap<string, RoleSpec>,
): { found: boolean; roleId: string | null } {
  const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "custom" && e?.customType === "omp-enhance-role") {
      const id = e?.data?.roleId;
      if (id === null) return { found: true, roleId: null };
      return typeof id === "string" && roles.has(id) ? { found: true, roleId: id } : { found: false, roleId: null };
    }
  }
  return { found: false, roleId: null };
}

export function branchOverrideSignature(ctx: any): string {
  const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "custom" && e?.customType === "omp-enhance-role") {
      const id = e?.data?.roleId, entryId = typeof e?.id === "string" ? e.id : String(i);
      return `override:${entryId}:${id === null ? "off" : String(id ?? "")}`;
    }
  }
  return "none";
}

function sameModel(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ma = a as { provider?: unknown; id?: unknown }, mb = b as { provider?: unknown; id?: unknown };
  return Boolean(ma.id && ma.provider === mb.provider && ma.id === mb.id);
}

export class SessionBaselineManager {
  private baseModel: unknown = undefined;
  private baseThinking: string | undefined = undefined;
  private modelOverridden = false;
  private overriddenModel: unknown = undefined;
  private thinkingOverridden = false;
  private overriddenThinking: string | undefined = undefined;

  reconcileManualChanges(pi: any, ctx: any): void {
    const curModel = ctx?.model;
    if (curModel !== undefined) {
      if (this.modelOverridden) {
        if (!sameModel(curModel, this.overriddenModel)) {
          this.baseModel = curModel; this.modelOverridden = false; this.overriddenModel = undefined;
        }
      } else { this.baseModel = curModel; }
    }
    const curThinking = pi?.getThinkingLevel?.();
    if (typeof curThinking === "string") {
      if (this.thinkingOverridden) {
        if (curThinking !== this.overriddenThinking) {
          this.baseThinking = curThinking; this.thinkingOverridden = false; this.overriddenThinking = undefined;
        }
      } else { this.baseThinking = curThinking; }
    }
  }

  async applyRoleOverrides(_sessionId: string, role: RoleSpec | null, pi: any, ctx: any): Promise<void> {
    this.reconcileManualChanges(pi, ctx);
    let resolvedModel: unknown = undefined;
    if (role?.model && role.model !== "inherit") {
      if (!this.modelOverridden) this.baseModel = ctx?.model ?? this.baseModel;
      resolvedModel = resolveModelSpec(role.model, ctx, pi);
      if (resolvedModel && typeof pi?.setModel === "function") {
        await pi.setModel(resolvedModel);
        this.modelOverridden = true; this.overriddenModel = resolvedModel;
      }
    } else if (this.modelOverridden) {
      if (this.baseModel !== undefined && typeof pi?.setModel === "function") await pi.setModel(this.baseModel);
      this.modelOverridden = false; this.overriddenModel = undefined;
    }

    const effectiveThinking = role?.thinking && role.thinking !== "inherit"
      ? role.thinking
      : (role?.model && role.model !== "inherit" ? extractModelSpecThinking(role.model, pi, ctx, resolvedModel) : undefined);

    if (effectiveThinking) {
      if (!this.thinkingOverridden) this.baseThinking = pi?.getThinkingLevel?.() ?? this.baseThinking;
      if (typeof pi?.setThinkingLevel === "function") {
        pi.setThinkingLevel(effectiveThinking);
        this.thinkingOverridden = true; this.overriddenThinking = effectiveThinking;
      }
    } else if (this.thinkingOverridden) {
      if (this.baseThinking !== undefined && typeof pi?.setThinkingLevel === "function") pi.setThinkingLevel(this.baseThinking);
      this.thinkingOverridden = false; this.overriddenThinking = undefined;
    }
  }

  clear(): void {
    this.baseModel = undefined; this.baseThinking = undefined;
    this.modelOverridden = false; this.overriddenModel = undefined;
    this.thinkingOverridden = false; this.overriddenThinking = undefined;
  }
}

export function emitMessage(pi: any, ctx: any, text: string, options?: { excludeFromContext?: boolean }): void {
  const outPath = process.env.OMP_ENHANCE_CMD_OUT;
  if (outPath) {
    try {
      mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      appendFileSync(outPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    } catch {}
  }
  try {
    const excludeFromContext = options?.excludeFromContext ?? true;
    const opts = { triggerTurn: false, ...(ctx?.isIdle?.() === false ? { deliverAs: "followUp" } : {}) };
    if (typeof pi?.sendMessage === "function") {
      pi.sendMessage({
        customType: "omp-enhance", content: text, display: true,
        ...(excludeFromContext ? { excludeFromContext: true } : {}),
      }, opts);
    } else {
      ctx?.ui?.notify?.(text, "info");
    }
  } catch {}
}

export interface ManagedWorkspace extends WorkspaceRuntime {
  rolesBySession: Map<string, string | null>;
  baselines: SessionBaselineManager;
  lastSessionId?: string;
  lastBranchOverrideSig?: string;
  syncSessionLifecycle(ctx: any): Promise<void>;
}

export type WorkspaceState = ManagedWorkspace;

export function createManagedWorkspace(
  pi: any, cwd: string, trusted: boolean,
  options: { globalRolesDir?: string; builtinRolesDir?: string; pluginLockPath?: string; runnerFactory?: (pi: any, ctx: any) => RoleSessionRunner },
): ManagedWorkspace {
  const resolveGlobalDir = () => options.globalRolesDir ?? resolveDefaultGlobalRolesDir();
  const { roles } = discoverRolesWithDiagnostics({ cwd, globalRolesDir: resolveGlobalDir(), builtinRolesDir: options.builtinRolesDir, isProjectTrusted: trusted });
  const settings = loadEnhanceSettings({ cwd, pluginLockPath: options.pluginLockPath, isProjectTrusted: trusted });
  const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
  const trackers = new SessionTrackerRegistry(), baselines = new SessionBaselineManager();
  const room = new FlowRoomManager(createFlowRoomUiAdapter(pi), store);
  const rolesBySession = new Map<string, string | null>();

  const runFlowTask = (fCtx: any, flowId: string, execInput: {
    roles: RoleSpec[]; mandate: Mandate; initialHandoff: HandoffEnvelope | null; maxRepairRounds: number;
    startIndex?: number; initialRepairRound?: number; initialStageSeq?: number; initialLastRejectionSig?: string | null; signal?: AbortSignal;
  }): Promise<FlowRunResult> => {
    ws.syncStatusBar(fCtx);
    return (async () => {
      try {
        const res = await executeRoleFlow({ cwd, store, flowId, ...execInput, runner: ws.runnerFor(fCtx), supervisor: ws.supervisorFor(fCtx), observer: room.createObserver(fCtx) });
        room.finishFlow(res, fCtx); return res;
      } catch (err) { room.failFlow(err, fCtx); throw err; }
      finally { ws.syncStatusBar(fCtx); }
    })();
  };

  const ws: ManagedWorkspace = {
    cwd, globalRolesDir: resolveGlobalDir(), builtinRolesDir: options.builtinRolesDir,
    store, trackers, room, roles, settings, rolesBySession, baselines,
    getSessionId: (c) => sessionKey(c),
    getSessionRoleId: (c) => {
      const sid = sessionKey(c);
      if (rolesBySession.has(sid)) return rolesBySession.get(sid)!;
      const ov = readSessionRoleOverride(c, ws.roles);
      return ov.found ? ov.roleId : defaultRoleId(ws.roles, ws.settings);
    },
    getActiveRole: (c) => { const id = ws.getSessionRoleId(c); return id ? ws.roles.get(id) ?? null : null; },
    refresh: (c) => {
      const isTrusted = c === undefined ? true : isProjectTrusted(c);
      ws.globalRolesDir = resolveGlobalDir();
      ws.roles = discoverRolesWithDiagnostics({ cwd, globalRolesDir: ws.globalRolesDir, builtinRolesDir: options.builtinRolesDir, isProjectTrusted: isTrusted }).roles;
      ws.settings = loadEnhanceSettings({ cwd, pluginLockPath: options.pluginLockPath, isProjectTrusted: isTrusted });
      return ws.roles;
    },
    syncStatusBar: (c) => {
      const role = ws.getActiveRole(c), snap = room.getSnapshot();
      const roleBadge = role ? `enhance:${role.id}${role.model ? ` (${role.model})` : ""}` : "enhance:off";
      const flowBadge = room.isRunning() ? ` · flow:${snap.roleChain.join("→")}` : snap.status === "interrupted" ? " · flow:paused" : "";
      c?.ui?.setStatus?.("omp-enhance", ws.settings.showStatusBar ? `${roleBadge}${flowBadge}` : undefined);
    },
    applyActiveRole: async (roleId, c, persist = false) => {
      const sid = sessionKey(c);
      rolesBySession.set(sid, roleId);
      if (persist) { try { pi.appendEntry?.("omp-enhance-role", { roleId }); } catch {} }
      ws.lastSessionId = sid; ws.lastBranchOverrideSig = branchOverrideSignature(c);
      const role = roleId ? ws.roles.get(roleId) ?? null : null, allNames = pi.getAllTools?.().map((t: any) => t.name) ?? [];
      await pi.setActiveTools?.(role ? resolveRoleActiveTools(role, allNames, "foreground") : allNames);
      await baselines.applyRoleOverrides(sid, role, pi, c);
      ws.syncStatusBar(c);
    },
    syncSessionLifecycle: async (c) => {
      ws.refresh(c);
      const sid = sessionKey(c);
      ws.trackers.reset(sid, ws.cwd);
      const ov = readSessionRoleOverride(c, ws.roles);
      await ws.applyActiveRole(ov.found ? ov.roleId : defaultRoleId(ws.roles, ws.settings), c, false);
    },
    runnerFor: (c) => options.runnerFactory?.(pi, c) ?? createOmpRoleSessionRunner(pi, c, ws.settings, ws.roles),
    supervisorFor: (c) => {
      const sup = ws.settings.supervisorEnabled ? ws.roles.get("supervisor") : undefined;
      return sup ? { role: sup, inspector: createOmpSupervisorInspector(pi, c, ws.settings), initialDelayMs: ws.settings.supervisorInitialDelaySec * 1000 } : undefined;
    },
    emitMessage: (c, text, emitOpts) => emitMessage(pi, c, text, emitOpts),
    startManagedFlow: async ({ ctx: c, flowId: explicitId, roles: rList, mandate, initialHandoff, maxRepairRounds, background, initiatorText, signal }) => {
      const roleChain = rList.map((r) => r.id);
      const flowId = room.beginFlow({ flowId: explicitId, mandateId: mandate.id, goal: mandate.goal, roleChain, maxRepairRounds, lastHandoffId: initialHandoff?.id ?? null, initiatorText, ctx: c });
      const p = runFlowTask(c, flowId, { roles: rList, mandate, initialHandoff, maxRepairRounds, signal });
      if (!background) return await p;
      void p.catch(() => {});
      return { started: true, flowId, background: true, status: "running", roleChain, goal: mandate.goal };
    },
    resumeManagedFlow: async (c, background, signal) => {
      const plan = room.resumeFlow(c);
      const rList = plan.roleChain.map((id) => { const r = ws.roles.get(id); if (!r) throw new Error(`Unknown role "${id}".`); return r; });
      const mandate = store.getMandate(plan.mandateId) ?? store.upsertMandate({ goal: room.getSnapshot().goal || "Resumed Flow", flowId: plan.flowId });
      const initialHandoff = plan.lastHandoffId ? store.getHandoff(plan.lastHandoffId) : null;
      const p = runFlowTask(c, plan.flowId, { roles: rList, mandate, initialHandoff, maxRepairRounds: plan.maxRepairRounds, startIndex: plan.startIndex, initialRepairRound: plan.repairRound, initialStageSeq: plan.initialStageSeq, initialLastRejectionSig: plan.lastRejectionSig, signal });
      if (!background) return await p;
      void p.catch(() => {});
      return { resumed: true, flowId: plan.flowId, startIndex: plan.startIndex, background: true, status: "running", roleChain: plan.roleChain };
    },
    dispatchFollowUpFromRoom: async (c, rawText) => {
      ws.refresh(c);
      const at = /^@([a-zA-Z0-9][a-zA-Z0-9_-]*)\s+([\s\S]+)$/.exec(rawText.trim());
      const prev = room.getSnapshot().roleChain.filter((id) => id !== "supervisor" && ws.roles.has(id));
      const activeId = ws.getActiveRole(c)?.id, fallback = activeId && activeId !== "supervisor" ? [activeId] : ["dev"];
      const roleIds = at && at[1] !== "supervisor" && ws.roles.has(at[1]!) ? [at[1]!] : (prev.length > 0 ? prev : fallback.filter((id) => ws.roles.has(id)));
      const goalText = (at && at[1] !== "supervisor" && ws.roles.has(at[1]!) ? at[2]! : rawText).trim();
      const rList = roleIds.map((id) => ws.roles.get(id)!).filter(Boolean);
      if (rList.length === 0 || !goalText) return;
      const prevHandoffId = room.getLastHandoffId();
      const initialHandoff = prevHandoffId ? store.getHandoff(prevHandoffId) : null;
      const flowId = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const mandate = store.upsertMandate({ goal: goalText, flowId });
      await ws.startManagedFlow({ ctx: c, flowId, roles: rList, mandate, initialHandoff, maxRepairRounds: ws.settings.flowMaxRepairRounds, background: true, initiatorText: rawText.trim() });
    },
  };
  return ws;
}
