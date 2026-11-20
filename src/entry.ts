import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  EnhanceSettings, EpistemicKind, EpistemicStatus, FlowRunResult, HandoffEnvelope,
  HandoffVerdict, Mandate, RoleSpec, VerifiedFact,
} from "./types.ts";
import { EnhanceStore } from "./store.ts";
import {
  cloneRoleSpec, deleteCustomRole, discoverRoles, hasBuiltinRole, renderConditioningBlock, scaffoldRoleFile,
} from "./role-loader.ts";
import { resolveRoleActiveTools, TurnTracker } from "./session-tracker.ts";
import { createAndVerifyHandoff } from "./handoff.ts";
import {
  createOmpRoleSessionRunner, executeRoleFlow, executeRoleStep, type RoleSessionRunner,
  type RoleSupervisorConfig,
} from "./orchestrator.ts";
import { cancelJob, readJobLogTail, reconcileJobs, startBackgroundJob } from "./jobs.ts";
import { createOmpSupervisorInspector, watchBackgroundJob } from "./supervisor.ts";
import { loadEnhanceSettings, modelSupportsVision, resolveModelSpec } from "./settings.ts";
import { openRoleEditor, openRoleStudioHome, type RoleStudioDeps } from "./role-studio.ts";
import { FlowRoomManager, openFlowRoomOverlay, registerRoomMessageRenderer } from "./flow-room.ts";
export interface EnhanceOptions {
  globalRolesDir?: string; builtinRolesDir?: string; pluginLockPath?: string;
  runnerFactory?: (pi: any, ctx: any) => RoleSessionRunner;
}
interface WorkspaceState {
  cwd: string; store: EnhanceStore; tracker: TurnTracker; room: FlowRoomManager;
  roles: Map<string, RoleSpec>; settings: EnhanceSettings; activeRoleId: string | null; lastSessionId?: string;
}
const EPISTEMIC_KINDS: readonly EpistemicKind[] = ["fact", "hypothesis", "inquiry", "decision"];
const EPISTEMIC_STATUSES: readonly EpistemicStatus[] = ["open", "verified", "falsified", "deferred"];
const MANDATE_STATUSES: readonly Mandate["status"][] = ["active", "completed", "archived"];
const VERDICTS: readonly HandoffVerdict[] = ["ready", "rejected", "blocked"];

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}
function asVerifiedFacts(value: unknown): VerifiedFact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const facts = value.flatMap((item): VerifiedFact[] => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const claim = asString(record.claim), evidenceRef = asString(record.evidenceRef);
    return claim && evidenceRef ? [{ claim, evidenceRef }] : [];
  });
  return facts.length > 0 ? facts : undefined;
}
const globalRolesDir = (options: EnhanceOptions): string =>
  options.globalRolesDir ?? process.env.OMP_ENHANCE_GLOBAL_ROLES_DIR ?? path.join(homedir(), ".omp", "enhance", "roles");

function schemaKit(pi: any) {
  const T = pi?.typebox?.Type, opt = (v: unknown): unknown => (T?.Optional ? T.Optional(v) : v);
  return {
    str: (): unknown => (T?.String ? T.String() : { type: "string" }),
    num: (): unknown => (T?.Number ? T.Number() : { type: "number" }),
    bool: (): unknown => (T?.Boolean ? T.Boolean() : { type: "boolean" }),
    arr: (item: unknown): unknown => (T?.Array ? T.Array(item) : { type: "array", items: item }),
    en: (values: readonly string[]): unknown => (T?.Union ? T.Union(values.map((v: string) => T.Literal(v))) : { type: "string", enum: values }),
    obj: (props: Record<string, unknown>, req: string[]): unknown => (T?.Object
      ? T.Object(Object.fromEntries(Object.entries(props).map(([k, v]) => [k, req.includes(k) ? v : opt(v)])), { additionalProperties: false })
      : { type: "object", properties: props, required: req }),
  };
}
const toolResult = (payload: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}),
});
const toolError = (error: unknown) => toolResult({ error: error instanceof Error ? error.message : String(error) }, true);
const sessionKey = (ctx: any): string =>
  ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionManager?.getSessionFile?.() ?? "__default__";
function readSessionRoleOverride(ctx: any, roles: Map<string, RoleSpec>): { found: boolean; roleId: string | null } {
  const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "custom" && e?.customType === "omp-enhance-role") {
      const id = e?.data?.roleId;
      if (id === null) return { found: true, roleId: null };
      if (typeof id === "string" && roles.has(id)) return { found: true, roleId: id };
    }
  }
  return { found: false, roleId: null };
}
function turnFailedOrAborted(event: any): boolean {
  if (event?.stopReason === "error" || event?.stopReason === "aborted" || Boolean(event?.error)) return true;
  const msgs = Array.isArray(event?.messages) ? event.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === "assistant" || m?.stopReason) return m.stopReason === "error" || m.stopReason === "aborted" || Boolean(m.errorMessage);
  }
  return false;
}
export default function ompEnhance(pi: any, options: EnhanceOptions = {}): void {
  const workspaces = new Map<string, WorkspaceState>();
  const kit = schemaKit(pi);
  registerRoomMessageRenderer(pi);
  const discover = (cwd: string): Map<string, RoleSpec> => discoverRoles({
    cwd, globalRolesDir: globalRolesDir(options), builtinRolesDir: options.builtinRolesDir,
  });

  const loadSettings = (cwd: string): EnhanceSettings =>
    loadEnhanceSettings({ cwd, pluginLockPath: options.pluginLockPath });
  const defaultRoleId = (roles: Map<string, RoleSpec>, settings: EnhanceSettings): string | null =>
    settings.defaultRole === null ? null
      : (roles.has(settings.defaultRole) ? settings.defaultRole : (roles.has("general") ? "general" : (roles.has("dev") ? "dev" : null)));

  function getWorkspace(ctx: any): WorkspaceState {
    const cwd = path.resolve(ctx?.cwd ?? process.cwd());
    const existing = workspaces.get(cwd);
    if (existing) { existing.settings = loadSettings(cwd); return existing; }
    const roles = discover(cwd), settings = loadSettings(cwd);
    const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    const state: WorkspaceState = {
      cwd, store, tracker: new TurnTracker(), room: new FlowRoomManager(pi, store),
      roles, settings, activeRoleId: defaultRoleId(roles, settings),
    };
    workspaces.set(cwd, state);
    return state;
  }
  const activeRole = (ws: WorkspaceState): RoleSpec | null => (ws.activeRoleId ? ws.roles.get(ws.activeRoleId) ?? null : null);
  const refreshRoles = (ws: WorkspaceState): Map<string, RoleSpec> => {
    ws.roles = discover(ws.cwd); ws.settings = loadSettings(ws.cwd); return ws.roles;
  };
  function syncStatusBar(ws: WorkspaceState, ctx: any): void {
    const role = activeRole(ws), snap = ws.room.getSnapshot();
    const roleBadge = role ? `enhance:${role.id}${role.model ? ` (${role.model})` : ""}` : "enhance:off";
    const flowBadge = ws.room.isRunning() ? ` · flow:${snap.roleChain.join("→")}` : snap.status === "interrupted" ? " · flow:paused" : "";
    ctx?.ui?.setStatus?.("omp-enhance", ws.settings.showStatusBar ? `${roleBadge}${flowBadge}` : undefined);
  }
  async function applyActiveRole(ws: WorkspaceState, roleId: string | null, ctx: any, persistToSession = false): Promise<void> {
    ws.activeRoleId = roleId;
    if (persistToSession) {
      ws.lastSessionId = sessionKey(ctx);
      try { pi.appendEntry?.("omp-enhance-role", { roleId }); } catch {}
    }
    const role = activeRole(ws), allNames = pi.getAllTools?.().map((t: any) => t.name) ?? [];
    await pi.setActiveTools?.(role ? resolveRoleActiveTools(role, allNames) : allNames);
    if (role?.model && role.model !== "inherit" && typeof pi.setModel === "function") {
      const resolved = resolveModelSpec(role.model, ctx);
      if (resolved) await pi.setModel(resolved);
    }
    if (role?.thinking && role.thinking !== "inherit" && typeof pi.setThinkingLevel === "function") pi.setThinkingLevel(role.thinking);
    syncStatusBar(ws, ctx);
  }
  const runnerFor = (ws: WorkspaceState, ctx: any): RoleSessionRunner =>
    options.runnerFactory?.(pi, ctx) ?? createOmpRoleSessionRunner(pi, ctx, ws.settings, ws.roles);
  function supervisorFor(ws: WorkspaceState, ctx: any, force = false): RoleSupervisorConfig | undefined {
    if (!force && !ws.settings.supervisorEnabled) return undefined;
    const role = ws.roles.get("supervisor");
    return role ? { role, inspector: createOmpSupervisorInspector(pi, ctx, ws.settings), initialDelayMs: ws.settings.supervisorInitialDelaySec * 1000 } : undefined;
  }
  function emitMessage(ctx: any, text: string): void {
    const outPath = process.env.OMP_ENHANCE_CMD_OUT;
    if (outPath) {
      mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      appendFileSync(outPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    }
    try {
      const sendOpts = { triggerTurn: false, ...(ctx?.isIdle?.() === false ? { deliverAs: "followUp" } : {}) };
      if (typeof pi.sendMessage === "function") pi.sendMessage({ customType: "omp-enhance", content: text, display: true }, sendOpts);
      else ctx?.ui?.notify?.(text, "info");
    } catch {}
  }
  function runFlowTask(ws: WorkspaceState, ctx: any, execInput: {
    roles: RoleSpec[]; mandate: Mandate; initialHandoff: HandoffEnvelope | null;
    maxRepairRounds: number; startIndex?: number; initialRepairRound?: number;
  }): Promise<FlowRunResult> {
    syncStatusBar(ws, ctx);
    return (async () => {
      try {
        const res = await executeRoleFlow({
          cwd: ws.cwd, store: ws.store, ...execInput,
          runner: runnerFor(ws, ctx), supervisor: supervisorFor(ws, ctx), observer: ws.room.createObserver(ctx),
        });
        ws.room.finishFlow(res, ctx);
        return res;
      } catch (err) { ws.room.failFlow(err, ctx); throw err; } finally { syncStatusBar(ws, ctx); }
    })();
  }
  async function startManagedFlow(input: {
    ws: WorkspaceState; ctx: any; roles: RoleSpec[]; mandate: Mandate;
    initialHandoff: HandoffEnvelope | null; maxRepairRounds: number;
    background: boolean; initiatorText?: string;
  }): Promise<{ started: true; flowId: string; background: true; status: "running"; roleChain: string[]; goal: string } | FlowRunResult> {
    const { ws, ctx, roles, mandate, initialHandoff, maxRepairRounds, background, initiatorText } = input;
    const roleChain = roles.map((r) => r.id);
    const flowId = ws.room.beginFlow({
      mandateId: mandate.id, goal: mandate.goal, roleChain, maxRepairRounds, lastHandoffId: initialHandoff?.id ?? null, initiatorText, ctx,
    });
    const runPromise = runFlowTask(ws, ctx, { roles, mandate, initialHandoff, maxRepairRounds });
    if (!background) return await runPromise;
    void runPromise.catch(() => {});
    return { started: true, flowId, background: true, status: "running", roleChain, goal: mandate.goal };
  }
  async function resumeManagedFlow(
    ws: WorkspaceState, ctx: any, background: boolean,
  ): Promise<{ resumed: true; flowId: string; startIndex: number; background: true; status: "running"; roleChain: string[] } | FlowRunResult> {
    const plan = ws.room.resumeFlow(ctx);
    const roles = plan.roleChain.map((id) => { const r = ws.roles.get(id); if (!r) throw new Error(`Unknown role "${id}".`); return r; });
    const mandate = ws.store.getMandate(plan.mandateId) ?? ws.store.getActiveMandate() ?? ws.store.upsertMandate({ goal: ws.room.getSnapshot().goal || "Resumed Flow" });
    const initialHandoff = plan.lastHandoffId ? ws.store.getHandoff(plan.lastHandoffId) : null;
    const runPromise = runFlowTask(ws, ctx, {
      roles, mandate, initialHandoff, maxRepairRounds: plan.maxRepairRounds, startIndex: plan.startIndex, initialRepairRound: plan.repairRound,
    });
    if (!background) return await runPromise;
    void runPromise.catch(() => {});
    return { resumed: true, flowId: plan.flowId, startIndex: plan.startIndex, background: true, status: "running", roleChain: plan.roleChain };
  }

  async function dispatchFollowUpFromRoom(ws: WorkspaceState, ctx: any, rawText: string): Promise<void> {
    refreshRoles(ws);
    const at = /^@([a-zA-Z0-9][a-zA-Z0-9_-]*)\s+([\s\S]+)$/.exec(rawText.trim());
    let roleIds: string[], goalText: string;
    if (at && at[1] !== "supervisor" && ws.roles.has(at[1]!)) {
      roleIds = [at[1]!]; goalText = at[2]!.trim();
    } else {
      const prev = ws.room.getSnapshot().roleChain.filter((id) => id !== "supervisor" && ws.roles.has(id));
      const fallback = activeRole(ws)?.id && activeRole(ws)?.id !== "supervisor" ? [activeRole(ws)!.id] : ["dev"];
      roleIds = prev.length > 0 ? prev : fallback.filter((id) => ws.roles.has(id));
      goalText = rawText.trim();
    }
    const roles = roleIds.map((id) => ws.roles.get(id)!).filter(Boolean);
    if (roles.length === 0 || !goalText) return;
    const mandate = ws.store.upsertMandate({ goal: goalText });
    await startManagedFlow({
      ws, ctx, roles, mandate, initialHandoff: ws.store.getLatestHandoff(mandate.id),
      maxRepairRounds: ws.settings.flowMaxRepairRounds, background: true, initiatorText: rawText.trim(),
    });
  }

  pi.on("input", (event: any, ctx: any) => {
    const text = typeof event.text === "string" ? event.text : "";
    const match = /^\/handoff\s+(\S+)/.exec(text);
    if (match && getWorkspace(ctx).roles.has(match[1]!)) return { text: text.replace(/^\/handoff/, "/enhance-handoff") };
    const atMatch = /^@([a-zA-Z0-9][a-zA-Z0-9_-]*)\s+([\s\S]+)$/.exec(text.trim());
    if (atMatch) {
      const ws = getWorkspace(ctx), roleId = atMatch[1]!, task = atMatch[2]!.trim().replace(/\s+/g, " ");
      if (roleId !== "supervisor" && task && ws.roles.has(roleId)) {
        return { text: ws.room.isRunning() ? `/flow steer [@${roleId}] ${task}` : `/flow ${roleId} ${task}` };
      }
    }
    return undefined;
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    const ws = getWorkspace(ctx); refreshRoles(ws);
    const prevSid = ws.lastSessionId; ws.lastSessionId = sessionKey(ctx);
    const ov = readSessionRoleOverride(ctx, ws.roles);
    const nextRole = ov.found ? ov.roleId : (prevSid !== undefined ? defaultRoleId(ws.roles, ws.settings) : ws.activeRoleId);
    await applyActiveRole(ws, nextRole, ctx, false);
  });
  pi.on("session_shutdown", () => { for (const ws of workspaces.values()) { ws.room.dispose(); ws.store.close(); } workspaces.clear(); });

  pi.on("before_agent_start", (event: any, ctx: any) => {
    const ws = getWorkspace(ctx);
    reconcileJobs(ws.store);
    refreshRoles(ws);
    const sid = sessionKey(ctx);
    if (sid !== ws.lastSessionId) {
      const prevSid = ws.lastSessionId; ws.lastSessionId = sid;
      const ov = readSessionRoleOverride(ctx, ws.roles);
      if (ov.found) ws.activeRoleId = ov.roleId;
      else if (prevSid !== undefined) ws.activeRoleId = defaultRoleId(ws.roles, ws.settings);
    }
    syncStatusBar(ws, ctx);
    ws.tracker.beginTurn(ws.cwd, true);
    const role = activeRole(ws);
    if (!role) return;
    const mandate = ws.store.getActiveMandate();
    const effectiveModel = role.model && role.model !== "inherit" ? resolveModelSpec(role.model, ctx) : ctx?.model;
    const block = renderConditioningBlock({ role, mandate,
      epistemicItems: mandate ? ws.store.listEpistemicItems(mandate.id) : [],
      upstreamHandoff: mandate ? ws.store.getLatestHandoff(mandate.id) : null,
      visionCapable: modelSupportsVision(effectiveModel),
    });
    const existing = Array.isArray(event.systemPrompt)
      ? event.systemPrompt : event.systemPrompt ? [event.systemPrompt] : [];
    return { systemPrompt: [...existing, block] };
  });

  pi.on("agent_end", (event: any, ctx: any) => {
    if (!turnFailedOrAborted(event)) getWorkspace(ctx).tracker.completeTurn();
  });

  pi.on("tool_call", (event: any, ctx: any) => {
    const ws = getWorkspace(ctx);
    const decision = ws.tracker.checkToolCallAllowed(ws.cwd, activeRole(ws), {
      toolName: event.toolName ?? event.name ?? "", input: event.input ?? event.args,
    });
    return decision.block ? decision : undefined;
  });

  pi.on("tool_execution_end", (event: any, ctx: any) => {
    const ws = getWorkspace(ctx);
    ws.tracker.recordToolExecutionEnd(ws.cwd, {
      toolCallId: event.toolCallId ?? event.id ?? "call", toolName: event.toolName ?? event.name ?? "unknown",
      args: event.args ?? event.input, isError: Boolean(event.isError ?? event.result?.isError),
    });
  });

  function registerTool(input: {
    name: string; label: string; description: string; approval: "read" | "write" | "exec";
    parameters: unknown; execute: (params: Record<string, unknown>, ctx: any) => Promise<unknown>;
  }): void {
    pi.registerTool({
      name: input.name, label: input.label, description: input.description,
      loadMode: "essential", approval: input.approval, parameters: input.parameters,
      execute: (_id: string, params: Record<string, unknown>, _signal: unknown, _onUpdate: unknown, ctx: any) =>
        input.execute(params, ctx),
    });
  }
  registerTool({
    name: "enhance_mandate", label: "Enhance Mandate", approval: "write",
    description: "Set or read the active Mandate, and add/update epistemic-board items.",
    parameters: kit.obj({
      action: kit.en(["set", "get", "add_item", "update_item"]), goal: kit.str(),
      constraints: kit.arr(kit.str()), acceptance: kit.arr(kit.str()), mandateId: kit.str(),
      status: kit.en([...MANDATE_STATUSES, ...EPISTEMIC_STATUSES]), kind: kit.en(EPISTEMIC_KINDS),
      statement: kit.str(), evidenceRef: kit.str(), verificationPlan: kit.str(), itemId: kit.str(),
    }, ["action"]),
    async execute(params, ctx) {
      try {
        const ws = getWorkspace(ctx);
        const action = asString(params.action) ?? "get";
        if (action === "get") {
          const mandate = ws.store.getActiveMandate();
          return toolResult({ mandate, epistemicItems: mandate ? ws.store.listEpistemicItems(mandate.id) : [] });
        }
        if (action === "set") {
          const goal = asString(params.goal);
          if (!goal) throw new Error("enhance_mandate set requires a goal.");
          const status = asString(params.status);
          if (status && !MANDATE_STATUSES.includes(status as Mandate["status"])) throw new Error(`Invalid mandate status "${status}".`);
          const mandateId = asString(params.mandateId);
          const mandate = ws.store.upsertMandate({
            ...(mandateId ? { id: mandateId } : {}), goal,
            constraints: asStringArray(params.constraints), acceptance: asStringArray(params.acceptance),
            ...(status ? { status: status as Mandate["status"] } : {}),
          });
          return toolResult({ mandate, epistemicItems: ws.store.listEpistemicItems(mandate.id) });
        }
        if (action === "add_item") {
          const mandateId = asString(params.mandateId) ?? ws.store.getActiveMandate()?.id;
          if (!mandateId) throw new Error("enhance_mandate add_item requires an active mandate.");
          const kind = asString(params.kind);
          if (!kind || !EPISTEMIC_KINDS.includes(kind as EpistemicKind)) throw new Error("add_item requires kind fact|hypothesis|inquiry|decision.");
          const statement = asString(params.statement);
          if (!statement) throw new Error("enhance_mandate add_item requires a statement.");
          const status = asString(params.status);
          if (status && !EPISTEMIC_STATUSES.includes(status as EpistemicStatus)) throw new Error(`Invalid epistemic status "${status}".`);
          const item = ws.store.addEpistemicItem({
            mandateId, kind: kind as EpistemicKind, statement,
            evidenceRef: asString(params.evidenceRef), verificationPlan: asString(params.verificationPlan),
            ...(status ? { status: status as EpistemicStatus } : {}),
          });
          return toolResult({ item });
        }
        if (action === "update_item") {
          const itemId = asString(params.itemId), status = asString(params.status);
          if (!itemId || !status || !EPISTEMIC_STATUSES.includes(status as EpistemicStatus)) throw new Error("update_item requires itemId and a valid status.");
          return toolResult({ item: ws.store.updateEpistemicStatus(itemId, status as EpistemicStatus, asString(params.evidenceRef)) });
        }
        throw new Error(`Unknown enhance_mandate action "${action}".`);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registerTool({
    name: "enhance_handoff", label: "Enhance Handoff", approval: "write",
    description: "Create a verified HandoffEnvelope for the active role; optionally delegate immediately.",
    parameters: kit.obj({
      verdict: kit.en(VERDICTS), summary: kit.str(), toTarget: kit.str(), artifactPaths: kit.arr(kit.str()),
      verifiedFacts: kit.arr(kit.obj({ claim: kit.str(), evidenceRef: kit.str() }, ["claim", "evidenceRef"])),
      openRisks: kit.arr(kit.str()), feedbackForUpstream: kit.str(), delegateNow: kit.bool(),
    }, ["verdict", "summary"]),
    async execute(params, ctx) {
      try {
        const ws = getWorkspace(ctx);
        const role = activeRole(ws) ?? ws.roles.get("general") ?? ws.roles.get("dev");
        if (!role) throw new Error("No active role and no builtin fallback role available.");
        const verdict = asString(params.verdict);
        if (!verdict || !VERDICTS.includes(verdict as HandoffVerdict)) throw new Error("enhance_handoff requires verdict ready|rejected|blocked.");
        const summary = asString(params.summary);
        if (!summary) throw new Error("enhance_handoff requires a summary.");
        const mandate = ws.store.getActiveMandate(), toTarget = asString(params.toTarget) ?? "user";
        const envelope = createAndVerifyHandoff({
          store: ws.store, role, cwd: ws.cwd, mandate, toTarget,
          parentHandoffId: mandate ? ws.store.getLatestHandoff(mandate.id)?.id ?? null : null,
          verdict: verdict as HandoffVerdict, summary, artifactPaths: asStringArray(params.artifactPaths),
          baselineSnapshot: ws.tracker.getBaselineSnapshot(), observedCalls: ws.tracker.getObservedCalls(),
          verifiedFacts: asVerifiedFacts(params.verifiedFacts), openRisks: asStringArray(params.openRisks),
          feedbackForUpstream: asString(params.feedbackForUpstream),
        });
        if (params.delegateNow === true && toTarget !== "user") {
          const target = ws.roles.get(toTarget);
          if (!target) throw new Error(`Unknown delegation target role "${toTarget}".`);
          const delegated = await executeRoleStep({
            cwd: ws.cwd, store: ws.store, role: target, upstreamHandoff: envelope,
            mandate: ws.store.getMandate(envelope.mandateId)!, toTarget: activeRole(ws)?.id ?? "user",
            runner: runnerFor(ws, ctx), supervisor: supervisorFor(ws, ctx),
          });
          return toolResult({ handoff: envelope, delegated }, !delegated.ok);
        }
        return toolResult({ handoff: envelope });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registerTool({
    name: "enhance_flow", label: "Enhance Flow", approval: "exec",
    description: "Start, resume, inspect status, steer, or cancel a Markov-isolated multi-role collaboration Flow.",
    parameters: kit.obj({
      action: kit.en(["start", "status", "steer", "cancel", "resume"]),
      roles: kit.arr(kit.str()), goal: kit.str(), message: kit.str(),
      maxRepairRounds: kit.num(), initialHandoffId: kit.str(), wait: kit.bool(),
    }, []),
    async execute(params, ctx) {
      try {
        const ws = getWorkspace(ctx);
        refreshRoles(ws);
        const action = asString(params.action) ?? "start";
        if (action === "status") return toolResult({ ...ws.room.getSnapshot(), resumable: ws.room.isResumable() });
        if (action === "resume") return toolResult(await resumeManagedFlow(ws, ctx, params.wait === true ? false : Boolean(ctx?.hasUI)));
        if (action === "cancel") {
          const cancelled = await ws.room.cancelActiveFlow(ctx);
          syncStatusBar(ws, ctx);
          return toolResult({ cancelled, status: ws.room.getSnapshot().status });
        }
        if (action === "steer") {
          const msg = asString(params.message) ?? asString(params.goal);
          if (!msg) throw new Error("enhance_flow steer requires a message.");
          const res = await ws.room.postUserSteer(msg, ctx);
          return toolResult({ ok: true, ...res, status: ws.room.getSnapshot().status });
        }
        if (action !== "start") throw new Error(`Unknown enhance_flow action "${action}".`);
        const roleIds = asStringArray(params.roles);
        if (!roleIds) throw new Error("enhance_flow start requires a non-empty roles array.");
        const roles = roleIds.map((id) => { const r = ws.roles.get(id); if (!r) throw new Error(`Unknown role "${id}".`); return r; });
        const goal = asString(params.goal);
        const mandate = goal ? ws.store.upsertMandate({ goal }) : ws.store.getActiveMandate();
        if (!mandate) throw new Error("enhance_flow requires a goal or an active mandate.");
        if (ctx?.hasUI) {
          if (ws.settings.flowRoutingMode === "manual") {
            return toolResult({
              started: false, blockedByRoutingMode: "manual",
              suggestion: `Automatic Flow dispatch is disabled (flowRoutingMode=manual). Handle directly or ask the user to run: /flow ${roleIds.join(",")} ${mandate.goal}`,
            });
          }
          if (ws.settings.flowRoutingMode === "ask" && typeof ctx?.ui?.confirm === "function") {
            const ok = await ctx.ui.confirm("启动多角色协作 Flow？", `角色链: ${roleIds.join(" → ")}\n目标: ${mandate.goal}\n(可在 /settings → Plugins → omp-enhance 切换 flowRoutingMode)`);
            if (!ok) return toolResult({ started: false, declined: true, reason: "User declined multi-role Flow dispatch; continue in single-agent mode." });
          }
        }
        const initialHandoffId = asString(params.initialHandoffId);
        const initialHandoff = initialHandoffId ? ws.store.getHandoff(initialHandoffId) : ws.store.getLatestHandoff(mandate.id);
        const maxRepairRounds = typeof params.maxRepairRounds === "number" ? params.maxRepairRounds : ws.settings.flowMaxRepairRounds;
        return toolResult(await startManagedFlow({ ws, ctx, roles, mandate, initialHandoff, maxRepairRounds, background: params.wait === true ? false : Boolean(ctx?.hasUI) }));
      } catch (error) { return toolError(error); }
    },
  });

  registerTool({
    name: "enhance_job", label: "Enhance Job", approval: "exec",
    description: "Start, watch with adaptive supervision, list, reconcile, tail, or cancel background jobs.",
    parameters: kit.obj({
      action: kit.en(["start", "watch", "list", "reconcile", "tail", "cancel"]),
      command: kit.str(), jobId: kit.str(), mandateId: kit.str(), hypothesisId: kit.str(), initialDelaySec: kit.num(), goal: kit.str(),
    }, ["action"]),
    async execute(params, ctx) {
      try {
        const ws = getWorkspace(ctx), action = asString(params.action);
        if (action === "start") {
          const command = asString(params.command);
          if (!command) throw new Error("enhance_job start requires a command.");
          return toolResult({ job: startBackgroundJob({ store: ws.store, cwd: ws.cwd, command, mandateId: asString(params.mandateId), hypothesisId: asString(params.hypothesisId) }) });
        }
        if (action === "list") return toolResult({ jobs: ws.store.listJobs() });
        if (action === "watch") {
          const jobId = asString(params.jobId), command = asString(params.command);
          const job = jobId ? ws.store.getJob(jobId) : command
            ? startBackgroundJob({ store: ws.store, cwd: ws.cwd, command, mandateId: asString(params.mandateId), hypothesisId: asString(params.hypothesisId) }) : null;
          if (!job) throw new Error(jobId ? `Unknown jobId "${jobId}".` : "enhance_job watch requires a jobId or command.");
          const supervisor = supervisorFor(ws, ctx, true);
          if (!supervisor) throw new Error("Supervisor role is unavailable.");
          const delaySec = typeof params.initialDelaySec === "number" && Number.isFinite(params.initialDelaySec) ? Math.max(0, params.initialDelaySec) : ws.settings.supervisorInitialDelaySec;
          const result = await watchBackgroundJob({
            store: ws.store, jobId: job.jobId, supervisorRole: supervisor.role, inspector: supervisor.inspector,
            goal: asString(params.goal) ?? ws.store.getActiveMandate()?.goal ?? job.command, initialDelayMs: delaySec * 1000,
          });
          return toolResult({ started: !jobId, ...result });
        }
        if (action === "reconcile") return toolResult({ jobs: reconcileJobs(ws.store) });
        if (action === "tail") {
          const job = asString(params.jobId) ? ws.store.getJob(asString(params.jobId)!) : null;
          if (!job) throw new Error("enhance_job tail requires a known jobId.");
          return toolResult({ job, tail: readJobLogTail(job) });
        }
        if (action === "cancel") {
          const jobId = asString(params.jobId);
          if (!jobId) throw new Error("enhance_job cancel requires a jobId.");
          return toolResult({ job: cancelJob(ws.store, jobId) });
        }
        throw new Error(`Unknown enhance_job action "${action}".`);
      } catch (error) { return toolError(error); }
    },
  });

  const completeRoleIds = (prefix: string, extras: readonly string[] = []) => {
    const roles = discover(pi?.cwd ?? process.cwd());
    const q = prefix.trim().toLowerCase();
    return [
      ...extras.map((v) => ({ value: v, label: v })),
      ...[...roles.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => ({
        value: r.id, label: r.id, description: `[${r.source}] ${r.description || r.name}`,
      })),
    ].filter((item) => !q || item.value.toLowerCase().startsWith(q));
  };

  const handoffHandler = async (args: string, ctx: any): Promise<void> => {
    const ws = getWorkspace(ctx);
    refreshRoles(ws);
    let targetId = args.trim().split(/\s+/)[0] ?? "";
    if (!targetId && ctx?.hasUI && typeof ctx?.ui?.select === "function") {
      const candidates = [...ws.roles.values()].filter((r) => r.id !== "supervisor").sort((a, b) => a.id.localeCompare(b.id));
      const picked: string | undefined = await ctx.ui.select(
        "Handoff current work to which isolated stage role?",
        candidates.map((r) => `${r.id} — ${r.description || r.name}`),
        { outline: true },
      );
      if (!picked) return;
      targetId = picked.split(" — ", 1)[0]?.trim() ?? "";
    }
    const target = ws.roles.get(targetId);
    if (!target) return emitMessage(ctx, targetId ? `Unknown role "${targetId}".` : "Usage: /handoff <targetRole>");
    try {
      const mandate = ws.store.getActiveMandate() ?? ws.store.upsertMandate({
        goal: "Handoff initiated from current workspace state",
      });
      const seedRole = activeRole(ws) ?? ws.roles.get("dev")!;
      const upstream = ws.store.getLatestHandoff(mandate.id) ?? createAndVerifyHandoff({
        store: ws.store, role: { ...seedRole, exit: { requireToolEvidence: false, criteria: [] } }, cwd: ws.cwd, mandate,
        toTarget: target.id, verdict: "ready", summary: "Automatic workspace snapshot handoff",
        baselineSnapshot: ws.tracker.getBaselineSnapshot(), observedCalls: ws.tracker.getObservedCalls(),
      });
      const result = await executeRoleStep({
        cwd: ws.cwd, store: ws.store, role: target,
        mandate: ws.store.getMandate(upstream.mandateId) ?? mandate, upstreamHandoff: upstream,
        toTarget: "user", runner: runnerFor(ws, ctx), supervisor: supervisorFor(ws, ctx),
      });
      emitMessage(ctx, JSON.stringify({
        ok: result.ok, targetRole: target.id, upstreamHandoffId: upstream.id,
        ...(result.ok ? { envelope: result.envelope } : { status: result.status, reason: result.reason }),
      }, null, 2));
    } catch (error) {
      emitMessage(ctx, JSON.stringify({ ok: false, targetRole: target.id, error: String(error) }, null, 2));
    }
  };

  pi.registerCommand("role", {
    description: "Open split-pane Role Studio, or switch, copy, delete, edit, create, list, show, and disable YAML roles.",
    getArgumentCompletions: (prefix: string) => {
      if (/^(?:show|edit|copy)\s+/i.test(prefix)) {
        const head = prefix.match(/^(?:show|edit|copy)\s+/i)![0];
        const rest = prefix.slice(head.length);
        if (rest.includes(" ")) return [];
        return completeRoleIds(rest).map((c) => ({ ...c, value: `${head}${c.value}` }));
      }
      if (/^delete\s+/i.test(prefix)) {
        const head = prefix.match(/^delete\s+/i)![0];
        return completeRoleIds(prefix.slice(head.length))
          .filter((c) => !hasBuiltinRole(c.value, options.builtinRolesDir))
          .map((c) => ({ ...c, value: `${head}${c.value}` }));
      }
      return completeRoleIds(prefix, ["off", "list", "studio", "edit ", "copy ", "delete ", "show ", "create "]);
    },
    handler: async (args: string, ctx: any) => {
      const ws = getWorkspace(ctx);
      refreshRoles(ws);
      const studioDeps = (): RoleStudioDeps => ({
        cwd: ws.cwd, globalRolesDir: globalRolesDir(options), builtinRolesDir: options.builtinRolesDir, pi, ctx,
        getRoles: () => ws.roles, refreshRoles: () => refreshRoles(ws),
        getSettings: () => ws.settings,
        getActiveRoleId: () => ws.activeRoleId, activateRole: (id) => applyActiveRole(ws, id, ctx, true),
        runHandoff: (id) => handoffHandler(id, ctx),
      });
      const trimmed = args.trim(), head = trimmed.split(/\s+/)[0] ?? "";
      if (ctx?.hasUI && (!trimmed || head === "studio")) return openRoleStudioHome(studioDeps());
      if (head === "edit") {
        if (!ctx?.hasUI) return emitMessage(ctx, "Interactive UI required for /role edit.");
        const editId = trimmed.slice(4).trim();
        return editId && ws.roles.has(editId)
          ? openRoleEditor(editId, studioDeps()) : openRoleStudioHome(studioDeps());
      }
      if (!trimmed || head === "list") {
        const lines = [`Roles (${ws.roles.size})`];
        for (const r of [...ws.roles.values()].sort((a, b) => a.id.localeCompare(b.id))) {
          lines.push(`${ws.activeRoleId === r.id ? "*" : " "} ${r.id} [${r.source}]${r.model ? ` (${r.model})` : ""} ${r.description}`.trimEnd());
        }
        return emitMessage(ctx, lines.join("\n"));
      }
      if (head === "show") {
        const r = ws.roles.get(trimmed.slice(4).trim());
        if (!r) return emitMessage(ctx, `Unknown role "${trimmed.slice(4).trim()}".`);
        return emitMessage(ctx, JSON.stringify({
          id: r.id, name: r.name, description: r.description, source: r.source, model: r.model ?? null,
          thinking: r.thinking ?? null, filePath: r.filePath, stance: r.stance, method: r.method, permissions: r.permissions, exit: r.exit,
        }, null, 2));
      }
      if (head === "create") {
        const tokens = trimmed.slice(6).trim().split(/\s+/).filter(Boolean);
        const positional = tokens.filter((t) => !t.startsWith("--")), [roleId, ...desc] = positional;
        if (!roleId || desc.length === 0) return emitMessage(ctx, "Usage: /role create <id> [--project] [--readonly] <description>");
        const targetDir = tokens.includes("--project") ? path.join(ws.cwd, ".omp", "roles") : globalRolesDir(options);
        const created = scaffoldRoleFile({ id: roleId, description: desc.join(" "), targetDir, readOnly: tokens.includes("--readonly") });
        refreshRoles(ws);
        return emitMessage(ctx, `Created role "${created.role.id}" [${created.source}] at ${created.filePath}`);
      }
      if (head === "copy") {
        const tokens = trimmed.slice(4).trim().split(/\s+/).filter(Boolean);
        const [srcId, newId, ...desc] = tokens.filter((t) => !t.startsWith("--"));
        if (!srcId || !newId) return emitMessage(ctx, "Usage: /role copy <sourceId> <newId> [--project] [description]");
        const srcRole = ws.roles.get(srcId);
        if (!srcRole) return emitMessage(ctx, `Unknown source role "${srcId}".`);
        try {
          const targetDir = tokens.includes("--project") ? path.join(ws.cwd, ".omp", "roles") : globalRolesDir(options);
          const cloned = cloneRoleSpec({ sourceRole: srcRole, newId, description: desc.join(" "), targetDir });
          refreshRoles(ws);
          return emitMessage(ctx, `Copied "${srcId}" to "${cloned.role.id}" [${cloned.source}] at ${cloned.filePath}`);
        } catch (err) { return emitMessage(ctx, err instanceof Error ? err.message : String(err)); }
      }
      if (head === "delete") {
        const delId = trimmed.slice(6).trim();
        if (!delId) return emitMessage(ctx, "Usage: /role delete <customRoleId>");
        try {
          deleteCustomRole({ id: delId, cwd: ws.cwd, globalRolesDir: globalRolesDir(options), builtinRolesDir: options.builtinRolesDir });
          refreshRoles(ws);
          if (ws.activeRoleId === delId) {
            const fb = ws.settings.defaultRole && ws.roles.has(ws.settings.defaultRole) ? ws.settings.defaultRole : (ws.roles.has("general") ? "general" : null);
            await applyActiveRole(ws, fb, ctx, true);
          }
          return emitMessage(ctx, `Deleted custom role "${delId}".`);
        } catch (err) { return emitMessage(ctx, err instanceof Error ? err.message : String(err)); }
      }
      if (head === "off") { await applyActiveRole(ws, null, ctx, true); return emitMessage(ctx, "Role conditioning disabled."); }
      const role = ws.roles.get(trimmed);
      if (!role) return emitMessage(ctx, `Unknown role "${trimmed}". Use /role list.`);
      await applyActiveRole(ws, role.id, ctx, true);
      emitMessage(ctx, `Active role: ${role.id} [${role.source}]`);
    },
  });

  const handoffDescription = "Hand the latest verified work (or a workspace snapshot) to an isolated stage role.";
  const handoffCompletions = (prefix: string) =>
    prefix.includes(" ") ? [] : completeRoleIds(prefix).filter((c) => c.value !== "supervisor");
  pi.registerCommand("enhance-handoff", { description: handoffDescription, getArgumentCompletions: handoffCompletions, handler: handoffHandler });

  pi.registerCommand("flow", {
    description: "Open split-pane Flow Room & Action Inspector (/flow), or start, continue, steer, inspect, and cancel multi-role Flows.",
    getArgumentCompletions: (prefix: string) => {
      if (prefix.includes(" ")) return [];
      const idx = prefix.lastIndexOf(",");
      if (idx >= 0) {
        const head = prefix.slice(0, idx + 1), tail = prefix.slice(idx + 1);
        return completeRoleIds(tail).filter((c) => c.value !== "supervisor").map((c) => ({ ...c, value: `${head}${c.value}` }));
      }
      return completeRoleIds(prefix, ["hub", "continue", "resume", "status", "steer ", "cancel"]).filter((c) => c.value !== "supervisor");
    },
    handler: async (args: string, ctx: any) => {
      const ws = getWorkspace(ctx);
      refreshRoles(ws);
      const trimmed = args.trim(), [first = "", ...restParts] = trimmed.split(/\s+/);
      if (!trimmed || first === "hub" || first === "room") {
        return ctx?.hasUI
          ? openFlowRoomOverlay({
            ctx, room: ws.room, onFollowUp: (msg) => dispatchFollowUpFromRoom(ws, ctx, msg),
            onResume: async () => { await resumeManagedFlow(ws, ctx, true); },
          })
          : emitMessage(ctx, JSON.stringify({ ...ws.room.getSnapshot(), resumable: ws.room.isResumable() }, null, 2));
      }
      if (first === "status") return emitMessage(ctx, JSON.stringify({ ...ws.room.getSnapshot(), resumable: ws.room.isResumable() }, null, 2));
      if (first === "continue" || first === "resume") {
        try {
          if (ctx?.hasUI) {
            const r = await resumeManagedFlow(ws, ctx, true) as { startIndex: number; roleChain: string[] };
            ctx?.ui?.notify?.(`已从阶段 ${r.startIndex + 1}/${r.roleChain.length} (${r.roleChain[r.startIndex]}) 断点续跑 Flow`, "info");
            return;
          }
          const result = await resumeManagedFlow(ws, ctx, false) as FlowRunResult;
          return emitMessage(ctx, JSON.stringify({
            status: result.status, reason: result.reason,
            steps: result.steps.map((s) => ({ stepIndex: s.stepIndex, roleId: s.roleId, round: s.round, verdict: s.envelope.verdict, summary: s.envelope.summary, envelopeId: s.envelope.id })),
            finalEnvelopeId: result.finalEnvelope?.id ?? null,
          }, null, 2));
        } catch (error) { return emitMessage(ctx, JSON.stringify({ status: "error", error: String(error) }, null, 2)); }
      }
      if (first === "cancel" || first === "stop") {
        const ok = await ws.room.cancelActiveFlow(ctx); syncStatusBar(ws, ctx);
        return emitMessage(ctx, ok ? "已中止当前协作 Flow。" : "当前没有运行中的协作 Flow。");
      }
      if (first === "steer") {
        const msg = restParts.join(" ").trim();
        if (!msg) return emitMessage(ctx, "Usage: /flow steer <message>");
        const res = await ws.room.postUserSteer(msg, ctx);
        return emitMessage(ctx, res.delivered ? `已实时插话至当前阶段 (${res.activeStageId}): ${msg}` : `已记录群聊留言: ${msg}`);
      }
      const roleIds = first.split(",").map((id) => id.trim()).filter(Boolean);
      if (roleIds.length === 0) return emitMessage(ctx, "Usage: /flow [hub|continue|status|steer <msg>|cancel|<role1,role2,...> [goal]]");
      try {
        const roles = roleIds.map((id) => { const r = ws.roles.get(id); if (!r) throw new Error(`Unknown role "${id}".`); return r; });
        const goal = restParts.join(" ").trim();
        const mandate = goal ? ws.store.upsertMandate({ goal }) : ws.store.getActiveMandate();
        if (!mandate) throw new Error("Provide a goal or set an active mandate first.");
        const initialHandoff = ws.store.getLatestHandoff(mandate.id);
        if (ctx?.hasUI) {
          await startManagedFlow({ ws, ctx, roles, mandate, initialHandoff, maxRepairRounds: ws.settings.flowMaxRepairRounds, background: true, initiatorText: goal || mandate.goal });
          ctx?.ui?.notify?.(`已启动协作 Flow: ${roleIds.join(" → ")} (输入 /flow 打开双栏群聊与检查器)`, "info");
          return;
        }
        const result = await startManagedFlow({ ws, ctx, roles, mandate, initialHandoff, maxRepairRounds: ws.settings.flowMaxRepairRounds, background: false, initiatorText: goal || mandate.goal }) as FlowRunResult;
        emitMessage(ctx, JSON.stringify({
          status: result.status, reason: result.reason,
          steps: result.steps.map((s) => ({ stepIndex: s.stepIndex, roleId: s.roleId, round: s.round, verdict: s.envelope.verdict, summary: s.envelope.summary, envelopeId: s.envelope.id })),
          finalEnvelopeId: result.finalEnvelope?.id ?? null,
        }, null, 2));
      } catch (error) { emitMessage(ctx, JSON.stringify({ status: "error", error: String(error) }, null, 2)); }
    },
  });

  pi.registerCommand("enhance-status", {
    description: "Show active role, settings, mandate, epistemic board, latest handoff, flow room, and jobs.",
    handler: async (_args: string, ctx: any) => {
      const ws = getWorkspace(ctx); refreshRoles(ws); reconcileJobs(ws.store);
      const mandate = ws.store.getActiveMandate();
      const latest = mandate ? ws.store.getLatestHandoff(mandate.id) : ws.store.getLatestHandoff();
      const flowSnap = ws.room.getSnapshot();
      emitMessage(ctx, JSON.stringify({
        activeRoleId: ws.activeRoleId, roleCount: ws.roles.size, settings: ws.settings,
        flow: { flowId: flowSnap.flowId, status: flowSnap.status, currentIndex: flowSnap.currentIndex, resumable: ws.room.isResumable(), roleChain: flowSnap.roleChain },
        activeMandate: mandate ? { id: mandate.id, rev: mandate.rev, goal: mandate.goal, status: mandate.status } : null,
        epistemicCount: mandate ? ws.store.listEpistemicItems(mandate.id).length : 0,
        latestHandoff: latest ? { id: latest.id, fromRole: latest.fromRole, toTarget: latest.toTarget, verdict: latest.verdict, summary: latest.summary, createdAt: latest.createdAt } : null,
        jobs: ws.store.listJobs().map((j) => ({ jobId: j.jobId, status: j.status, exitCode: j.exitCode, command: j.command })),
      }, null, 2));
    },
  });
}
