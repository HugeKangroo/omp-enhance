import path from "node:path";
import { isCompanionTool, isInternalRole, resolveRoleActiveTools } from "../core/policy.ts";
import {
  extractModelSpecThinking, loadEnhanceSettings, resolveDefaultGlobalRolesDir, resolveModelSpec,
} from "../core/settings.ts";
import { EnhanceStore } from "../core/store.ts";
import { markMachineStateInterrupted } from "../core/store-schema.ts";
import type { EnhanceSettings, FlowGraphPatch, FlowGraphSpec, FlowRunResult, GraphValidationResult, HandoffEnvelope, Mandate, RoleSpec } from "../core/types.ts";
import { executeFlowGraph, type LivePatchHandler, type LivePatchResult } from "../flow/executor.ts";
import { validateFlowGraph } from "../flow/graph.ts";
import { executeRoleFlow, type RoleSessionRunner, type RoleSupervisorConfig } from "../flow/orchestrator.ts";
import { FlowRoomManager, isCheckpointResumable, snapshotFromCheckpoint } from "../flow/state.ts";
import { SessionTrackerRegistry } from "../flow/tracker.ts";
import { migrateLegacySubStateMachine } from "../flow/workflow.ts";
import { createGitWorktreeManager, isGitRepo } from "../flow/worktree.ts";
import { discoverRolesWithDiagnostics } from "../roles/loader.ts";
import { createFlowRoomUiAdapter, type FlowMonitorTarget } from "../ui/flow-room.ts";
import { emitWorkspaceMessage } from "./hub-helpers.ts";
import { createOmpRoleSessionRunner, createOmpSupervisorInspector } from "./session.ts";
import { FlowSessionPool } from "./session-pool.ts";
import type { TrustEvaluation } from "./trust.ts";

export interface EmitMessageOptions { excludeFromContext?: boolean; cmdOutText?: string; }
export interface WorkspaceRuntime {
  cwd: string; globalRolesDir: string; builtinRolesDir?: string; isTrusted: boolean; trustNotice?: string;
  store: EnhanceStore; trackers: SessionTrackerRegistry; room: FlowRoomManager; roles: Map<string, RoleSpec>; settings: EnhanceSettings;
  getSessionId(ctx: any): string; getSessionRoleId(ctx: any): string | null; getActiveRole(ctx: any): RoleSpec | null;
  applyActiveRole(roleId: string | null, ctx: any, persistToSession?: boolean): Promise<void>;
  refresh(ctx?: any): Map<string, RoleSpec>; syncStatusBar(ctx: any): void;
  runnerFor(ctx: any): RoleSessionRunner; supervisorFor(ctx: any): RoleSupervisorConfig | undefined;
  emitMessage(ctx: any, text: string, options?: EmitMessageOptions): void;
  patchActiveFlow?(expectedFlowId: string, patch: FlowGraphPatch, patchRoles?: ReadonlyMap<string, RoleSpec>): Promise<LivePatchResult>;
  startManagedFlow(input: {
    ctx: any; originWs?: ManagedWorkspace; flowId?: string; roles: RoleSpec[]; mandate: Mandate;
    initialHandoff: HandoffEnvelope | null; maxRepairRounds: number; background: boolean; initiatorText?: string;
    signal?: AbortSignal; graphSpec?: FlowGraphSpec; graphValidation?: GraphValidationResult;
  }): Promise<{ started: true; flowId: string; cwd: string; background: true; status: "running"; roleChain: string[]; goal: string } | FlowRunResult>;
  resumeManagedFlow(
    ctx: any, background: boolean, signal?: AbortSignal, originWs?: ManagedWorkspace, targetFlowId?: string,
    opts?: { targetNodeId?: string; replyText?: string },
  ): Promise<{ resumed: true; flowId: string; cwd: string; startIndex: number; background: true; status: "running"; roleChain: string[] } | FlowRunResult>;
}
export interface BackgroundFlowSettlement {
  targetWs: ManagedWorkspace; originWs: ManagedWorkspace; ctx: any; flowId: string; mandate: Mandate; roleChain: string[]; result?: FlowRunResult; error?: unknown;
}
export interface WorkspaceHubHooks {
  syncGlobalUi?: (ctx: any, ws: ManagedWorkspace) => void; getActiveTargets?: () => readonly FlowMonitorTarget[];
  onBackgroundFlowSettled?: (settlement: BackgroundFlowSettlement) => void; evaluateTrust?: (targetCwd: string, ctx?: any) => TrustEvaluation;
}

export const sessionKey = (ctx: any): string =>
  ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionManager?.getSessionFile?.() ?? "__default__";

export const isProjectTrusted = (ctx: any, targetCwd?: string): boolean => {
  if (typeof ctx?.isProjectTrusted !== "function") return true;
  return targetCwd && ctx.isProjectTrusted.length >= 1
    ? Boolean(ctx.isProjectTrusted(path.resolve(targetCwd)))
    : Boolean(ctx.isProjectTrusted());
};

function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b]);
  return a ?? b;
}

export const defaultRoleId = (roles: Map<string, RoleSpec>, settings: EnhanceSettings): string | null => {
  if (settings.defaultRole === null) return null;
  const configured = roles.get(settings.defaultRole);
  if (configured && !isInternalRole(configured)) return configured.id;
  return roles.has("coordinator") ? "coordinator" : null;
};

export function readSessionRoleOverride(
  ctx: any, roles: ReadonlyMap<string, RoleSpec>,
): { found: boolean; roleId: string | null } {
  const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "custom" && e?.customType === "omp-enhance-role") {
      const id = e?.data?.roleId;
      if (id === null) return { found: true, roleId: null };
      const role = typeof id === "string" ? roles.get(id) : undefined;
      return role && !isInternalRole(role) ? { found: true, roleId: role.id } : { found: false, roleId: null };
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

const bindCtxToCwd = (ctx: any, cwd: string): any =>
  ctx && typeof ctx === "object" && ctx.cwd !== cwd ? Object.create(ctx, { cwd: { value: cwd, enumerable: true } }) : (ctx ?? { cwd });

export class SessionBaselineManager {
  private baseModel: unknown = undefined;
  private baseThinking: string | undefined = undefined;
  private baseActiveTools: string[] | undefined = undefined;
  private modelOverridden = false;
  private overriddenModel: unknown = undefined;
  private thinkingOverridden = false;
  private overriddenThinking: string | undefined = undefined;
  private toolsOverridden = false;

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

  async applyToolOverrides(role: RoleSpec | null, pi: any): Promise<void> {
    if (!role) {
      if (this.toolsOverridden) {
        if (this.baseActiveTools !== undefined) {
          await pi.setActiveTools?.([...this.baseActiveTools]);
        }
        this.toolsOverridden = false;
        return;
      }
      if (typeof pi?.getActiveTools === "function") {
        const curActive = pi.getActiveTools();
        if (Array.isArray(curActive) && curActive.some((n) => isCompanionTool(n))) {
          await pi.setActiveTools?.(curActive.filter((n) => !isCompanionTool(n)));
        }
      }
      return;
    }
    if (!this.toolsOverridden) {
      const initialActive: string[] | undefined = typeof pi?.getActiveTools === "function"
        ? pi.getActiveTools()
        : pi?.getAllTools?.().map((t: any) => t.name);
      this.baseActiveTools = Array.isArray(initialActive)
        ? initialActive.filter((n) => !isCompanionTool(n))
        : undefined;
      this.toolsOverridden = true;
    }
    const allNames: string[] = pi?.getAllTools?.().map((t: any) => t.name) ?? [];
    await pi.setActiveTools?.(resolveRoleActiveTools(role, allNames, "foreground"));
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
    this.baseModel = undefined; this.baseThinking = undefined; this.baseActiveTools = undefined;
    this.modelOverridden = false; this.overriddenModel = undefined;
    this.thinkingOverridden = false; this.overriddenThinking = undefined;
    this.toolsOverridden = false;
  }
}

export { emitWorkspaceMessage as emitMessage };

export interface ManagedWorkspace extends WorkspaceRuntime {
  rolesBySession: Map<string, string | null>;
  baselines: SessionBaselineManager;
  lastSessionId?: string;
  lastBranchOverrideSig?: string;
  syncSessionLifecycle(ctx: any): Promise<void>;
}

export type WorkspaceState = ManagedWorkspace;

export function createManagedWorkspace(
  pi: any, cwd: string, initialTrust: boolean | TrustEvaluation,
  options: { globalRolesDir?: string; builtinRolesDir?: string; pluginLockPath?: string; runnerFactory?: (pi: any, ctx: any) => RoleSessionRunner },
  hooks?: WorkspaceHubHooks,
): ManagedWorkspace {
  const resolveGlobalDir = () => options.globalRolesDir ?? resolveDefaultGlobalRolesDir();
  const initTrusted = typeof initialTrust === "boolean" ? initialTrust : initialTrust.trusted;
  const initNotice = typeof initialTrust === "boolean" ? undefined : initialTrust.trustNotice;
  const seenWarnings = new Set<string>();
  const warnOnce = (ctxForWarn?: any) => (warning: string): void => {
    if (seenWarnings.has(warning)) return;
    seenWarnings.add(warning);
    try { ctxForWarn?.ui?.notify?.(warning, "warning"); } catch {}
  };
  const { roles } = discoverRolesWithDiagnostics({ cwd, globalRolesDir: resolveGlobalDir(), builtinRolesDir: options.builtinRolesDir, isProjectTrusted: initTrusted });
  const settings = loadEnhanceSettings({ cwd, pluginLockPath: options.pluginLockPath, isProjectTrusted: initTrusted, onWarning: warnOnce() });
  const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
  const trackers = new SessionTrackerRegistry(), baselines = new SessionBaselineManager();
  const room = new FlowRoomManager(createFlowRoomUiAdapter(pi, hooks?.getActiveTargets), store, cwd);
  const rolesBySession = new Map<string, string | null>();

  const sessionPool = new FlowSessionPool(pi, { cwd });
  const worktreeManager = createGitWorktreeManager();
  let activePatchTarget: { flowId: string; handler: LivePatchHandler } | null = null;

  const runFlowTask = (fCtx: any, originWs: ManagedWorkspace, background: boolean, flowId: string, execInput: {
    roles: RoleSpec[]; mandate: Mandate; initialHandoff: HandoffEnvelope | null; maxRepairRounds: number;
    startIndex?: number; initialRepairRound?: number; initialStageSeq?: number; initialLastRejectionSig?: string | null; signal?: AbortSignal;
    graphSpec?: FlowGraphSpec; graphValidation?: GraphValidationResult; resumeGraph?: boolean; resumeTargetNodeId?: string; resumeReplyText?: string;
  }): Promise<FlowRunResult> => {
    const roleChain = execInput.graphSpec ? execInput.graphSpec.nodes.map((n) => n.id) : execInput.roles.map((r) => r.id);
    ws.syncStatusBar(fCtx);
    return (async () => {
      try {
        let res: FlowRunResult;
        if (execInput.graphSpec) {
          const rawPersisted = execInput.resumeGraph ? room.getPersistedMachineState() : null;
          const effRoles = new Map(ws.roles);
          for (const [k, v] of Object.entries(rawPersisted?.roleSnapshots ?? {})) effRoles.set(k, v);
          const migratedPersisted = rawPersisted ? migrateLegacySubStateMachine(rawPersisted, effRoles) : null;
          const persistedState = migratedPersisted?.status === "running"
            ? markMachineStateInterrupted(migratedPersisted, new Date().toISOString())
            : migratedPersisted;
          const effSpec = persistedState?.spec ?? execInput.graphSpec;
          const val = execInput.graphValidation ?? validateFlowGraph({ spec: effSpec, roles: effRoles, isGitRepo: isGitRepo(cwd) });
          res = await executeFlowGraph({
            cwd, store, flowId, mandate: execInput.mandate, spec: effSpec, validation: val,
            initialState: persistedState, roles: effRoles, runner: ws.runnerFor(fCtx),
            ...(execInput.resumeTargetNodeId ? { resumeTargetNodeId: execInput.resumeTargetNodeId } : {}),
            ...(execInput.resumeReplyText ? { resumeReplyText: execInput.resumeReplyText } : {}),
            initialHandoff: execInput.initialHandoff, observer: room.createObserver(fCtx), supervisor: ws.supervisorFor(fCtx),
            signal: execInput.signal, sessionPool, worktreeManager, onStateChange: (st, opts) => room.setGraphState(st, opts),
            registerLivePatchHandler: (h) => { activePatchTarget = h ? { flowId, handler: h } : null; },
          });
        } else {
          res = await executeRoleFlow({ cwd, store, flowId, ...execInput, runner: ws.runnerFor(fCtx), supervisor: ws.supervisorFor(fCtx), observer: room.createObserver(fCtx) });
        }
        room.finishFlow(res, fCtx);
        if (background && res.status !== "cancelled") {
          hooks?.onBackgroundFlowSettled?.({ targetWs: ws, originWs, ctx: fCtx, flowId, mandate: execInput.mandate, roleChain, result: res });
        }
        return res;
      } catch (err) {
        room.failFlow(err, fCtx);
        if (background) hooks?.onBackgroundFlowSettled?.({ targetWs: ws, originWs, ctx: fCtx, flowId, mandate: execInput.mandate, roleChain, error: err });
        throw err;
      } finally {
        ws.syncStatusBar(fCtx);
      }
    })();
  };

  const ws: ManagedWorkspace = {
    cwd, globalRolesDir: resolveGlobalDir(), builtinRolesDir: options.builtinRolesDir,
    isTrusted: initTrusted, ...(initNotice ? { trustNotice: initNotice } : {}),
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
      if (hooks?.evaluateTrust) {
        const ev = hooks.evaluateTrust(cwd, c);
        ws.isTrusted = ev.trusted; ws.trustNotice = ev.trustNotice;
      } else if (c !== undefined) {
        ws.isTrusted = isProjectTrusted(c, cwd); ws.trustNotice = undefined;
      }
      ws.globalRolesDir = resolveGlobalDir();
      ws.roles = discoverRolesWithDiagnostics({ cwd, globalRolesDir: ws.globalRolesDir, builtinRolesDir: options.builtinRolesDir, isProjectTrusted: ws.isTrusted }).roles;
      ws.settings = loadEnhanceSettings({ cwd, pluginLockPath: options.pluginLockPath, isProjectTrusted: ws.isTrusted, onWarning: warnOnce(c) });
      return ws.roles;
    },
    syncStatusBar: (c) => {
      if (hooks?.syncGlobalUi) { hooks.syncGlobalUi(c, ws); return; }
      const role = ws.getActiveRole(c), snap = room.getSnapshot();
      const hasBg = room.isRunning() || snap.status === "waiting_input";
      if (!role && !hasBg) {
        c?.ui?.setStatus?.("omp-enhance", undefined);
        c?.ui?.setWidget?.("omp-enhance-flow", undefined);
        return;
      }
      if (!ws.settings.showStatusBar) { c?.ui?.setStatus?.("omp-enhance", undefined); return; }
      const roleBadge = role ? `enhance:${role.id}${role.model ? ` (${role.model})` : ""}` : "enhance:bg";
      const flowBadge = room.isRunning() ? ` · flow:${snap.roleChain.join("→")}` : snap.status === "waiting_input" ? " · waiting_input" : "";
      c?.ui?.setStatus?.("omp-enhance", `${roleBadge}${flowBadge}`);
    },
    applyActiveRole: async (roleId, c, persist = false) => {
      const sid = sessionKey(c);
      const validRole = roleId ? ws.roles.get(roleId) ?? null : null;
      const effectiveId = validRole && !isInternalRole(validRole) ? validRole.id : null;
      const role = effectiveId ? validRole : null;
      rolesBySession.set(sid, effectiveId);
      if (persist) {
        ws.trackers.reset(sid, ws.cwd);
        try { pi.appendEntry?.("omp-enhance-role", { roleId: effectiveId }); } catch {}
      }
      ws.lastSessionId = sid; ws.lastBranchOverrideSig = branchOverrideSignature(c);
      await baselines.applyToolOverrides(role, pi);
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
    runnerFor: (c) => {
      const scopedCtx = bindCtxToCwd(c, cwd);
      return options.runnerFactory?.(pi, scopedCtx) ?? createOmpRoleSessionRunner(pi, scopedCtx, ws.settings, ws.roles, 0, ws.isTrusted);
    },
    supervisorFor: (c) => {
      const sup = ws.settings.supervisorEnabled ? ws.roles.get("supervisor") : undefined;
      if (!sup) return undefined;
      return { role: sup, inspector: createOmpSupervisorInspector(pi, bindCtxToCwd(c, cwd), ws.settings), initialDelayMs: ws.settings.supervisorInitialDelaySec * 1000 };
    },
    emitMessage: (c, text, emitOpts) => emitWorkspaceMessage(pi, c, text, emitOpts),
    patchActiveFlow: async (expectedFlowId, patch, patchRoles) => {
      if (!activePatchTarget || activePatchTarget.flowId !== expectedFlowId) {
        return { patched: false, error: `Flow "${expectedFlowId}" is no longer active and could not be patched.` };
      }
      return await activePatchTarget.handler(patch, patchRoles ?? ws.roles);
    },
    startManagedFlow: async ({ ctx: c, originWs, flowId: explicitId, roles: rList, mandate, initialHandoff, maxRepairRounds, background, initiatorText, signal, graphSpec, graphValidation }) => {
      const roleChain = graphSpec ? graphSpec.nodes.map((n) => n.id) : rList.map((r) => r.id);
      const roleSnapshots: Record<string, RoleSpec> = {};
      for (const r of rList) roleSnapshots[r.id] = structuredClone(r);
      const flowId = room.beginFlow({
        flowId: explicitId, mandateId: mandate.id, goal: mandate.goal, roleChain, maxRepairRounds,
        lastHandoffId: initialHandoff?.id ?? null, initiatorText, roleSnapshots, ctx: c,
        ...(graphValidation ? { leaseMode: graphValidation.leaseMode } : {}),
      });
      const effSignal = combineAbortSignals(signal, room.getAbortSignal());
      const p = runFlowTask(c, originWs ?? ws, background, flowId, { roles: rList, mandate, initialHandoff, maxRepairRounds, signal: effSignal, graphSpec, graphValidation });
      if (!background) return await p;
      void p.catch(() => {});
      return { started: true, flowId, cwd, background: true, status: "running", roleChain, goal: mandate.goal };
    },
    resumeManagedFlow: async (c, background, signal, originWs, targetFlowId, opts) => {
      const effectiveFlowId = targetFlowId ?? room.getSnapshot().flowId;
      let cp = effectiveFlowId && !store.isClosed() ? store.getFlowCheckpoint(effectiveFlowId) : null;
      if (cp?.status === "running" && (!room.hasActiveLeaseOwnership() || room.getSnapshot().flowId !== cp.flowId)) {
        cp = store.reclaimDeadCheckpoint(cp.flowId) ?? cp;
      }
      if (targetFlowId && !cp && room.getSnapshot().flowId !== targetFlowId) {
        throw new Error(`Unknown flowId "${targetFlowId}".`);
      }
      if (cp ? !isCheckpointResumable(cp) : !room.isResumable()) {
        throw new Error(cp ? `Flow "${cp.flowId}" 当前状态为 ${cp.status}，无法断点续跑。` : "当前没有可断点续跑的中断/失败 Flow。");
      }
      let persistedSpec: FlowGraphSpec | undefined;
      if (cp?.graphSpecJson) { try { persistedSpec = JSON.parse(cp.graphSpecJson) as FlowGraphSpec; } catch {} }
      const snapRoles = cp ? snapshotFromCheckpoint(cp, cwd).roleSnapshots : room.getSnapshot().roleSnapshots;
      let machineRoleSnaps: Record<string, RoleSpec> | undefined;
      if (cp?.machineStateJson) { try { machineRoleSnaps = (JSON.parse(cp.machineStateJson) as { roleSnapshots?: Record<string, RoleSpec> }).roleSnapshots; } catch {} }
      const frozenRoles: Record<string, RoleSpec> = { ...(snapRoles ?? {}), ...(machineRoleSnaps ?? {}) };
      const chainToValidate = persistedSpec
        ? persistedSpec.nodes.filter((n) => n.kind === "role" && n.role).map((n) => n.role!)
        : (cp ? cp.roleChain : room.getSnapshot().roleChain);
      const rList = chainToValidate.map((id) => {
        const live = ws.roles.get(id);
        if (id === "supervisor" || (live && isInternalRole(live))) throw new Error(`Role "${id}" is an internal monitor and cannot run as a Flow stage.`);
        if (!live) throw new Error(`Unknown role "${id}" in Flow "${effectiveFlowId ?? "flow"}". Restore the role before resuming.`);
        return frozenRoles[id] ?? live;
      });
      const plan = room.resumeFlow(c, targetFlowId);
      let mandate: Mandate, initialHandoff: HandoffEnvelope | null;
      try {
        mandate = store.getMandate(plan.mandateId) ?? store.upsertMandate({ goal: room.getSnapshot().goal || "Resumed Flow", flowId: plan.flowId });
        initialHandoff = plan.lastHandoffId ? store.getHandoff(plan.lastHandoffId) : null;
      } catch (setupErr) { room.failFlow(setupErr, c); throw setupErr; }
      const effSignal = combineAbortSignals(signal, room.getAbortSignal());
      const p = runFlowTask(c, originWs ?? ws, background, plan.flowId, {
        roles: rList, mandate, initialHandoff, maxRepairRounds: plan.maxRepairRounds,
        startIndex: plan.startIndex, initialRepairRound: plan.repairRound, initialStageSeq: plan.initialStageSeq,
        initialLastRejectionSig: plan.lastRejectionSig, signal: effSignal,
        ...(persistedSpec ? { graphSpec: persistedSpec, resumeGraph: true } : {}),
        ...(opts?.targetNodeId ? { resumeTargetNodeId: opts.targetNodeId } : {}),
        ...(opts?.replyText ? { resumeReplyText: opts.replyText } : {}),
      });
      if (!background) return await p;
      void p.catch(() => {});
      return { resumed: true, flowId: plan.flowId, cwd, startIndex: plan.startIndex, background: true, status: "running", roleChain: plan.roleChain };
    },
  };
  return ws;
}
