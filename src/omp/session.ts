import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { canRoleDelegateTo, resolveRoleActiveTools, summarizeToolCall, TurnTracker } from "../core/policy.ts";
import { DEFAULT_ENHANCE_SETTINGS, loadEnhanceSettings, modelSupportsVision, normalizeUsageSummary, resolveDefaultGlobalRolesDir, resolveModelSpec, resolveRoleRuntimeConfig } from "../core/settings.ts";
import { EnhanceStore } from "../core/store.ts";
import type { EnhanceSettings, FlowRunResult, HandoffEnvelope, Mandate, ObservedToolCall, RoleSpec, SupervisorDecision, UsageSummary } from "../core/types.ts";
import { BoundaryViolationError, createAndVerifyHandoff } from "../flow/handoff.ts";
import { executeRoleFlow, executeRoleStep, type RoleSessionRunner, type RoleStepContext, type RoleTurnOutcome } from "../flow/orchestrator.ts";
import { FlowRoomManager } from "../flow/state.ts";
import { SessionTrackerRegistry } from "../flow/tracker.ts";
import { parseSupervisorDecision, renderSupervisorPrompt, runWithSessionSupervisor, type SessionSupervisorControl, type SupervisorInspector } from "../jobs/supervisor.ts";
import { formatRuntimeVisionHint } from "../roles/conditioning.ts";
import { discoverRolesWithDiagnostics } from "../roles/loader.ts";
import { createFlowRoomUiAdapter } from "../ui/flow-room.ts";
import { buildStageCompanionTools, schemaKit, type WorkspaceRuntime } from "./tools.ts";

const MAX_CONSULTATION_DEPTH = 3;

export const sessionKey = (ctx: any): string =>
  ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionManager?.getSessionFile?.() ?? "__default__";
export const isProjectTrusted = (ctx: any): boolean =>
  typeof ctx?.isProjectTrusted === "function" ? Boolean(ctx.isProjectTrusted()) : true;
export const defaultRoleId = (roles: Map<string, RoleSpec>, settings: EnhanceSettings): string | null =>
  settings.defaultRole === null ? null : (roles.has(settings.defaultRole) ? settings.defaultRole : (roles.has("general") ? "general" : (roles.has("dev") ? "dev" : null)));

export function turnFailedOrAborted(event: any): boolean {
  if (event?.stopReason === "error" || event?.stopReason === "aborted" || Boolean(event?.error)) return true;
  const msgs = Array.isArray(event?.messages) ? event.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === "assistant" || m?.stopReason) return m.stopReason === "error" || m.stopReason === "aborted" || Boolean(m.errorMessage);
  }
  return false;
}

export function readSessionRoleOverride(ctx: any, roles: ReadonlyMap<string, RoleSpec>): { found: boolean; roleId: string | null } {
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

export class SessionBaselineManager {
  private baseModel: unknown = undefined;
  private baseThinking: string | undefined = undefined;
  private modelOverridden = false;
  private thinkingOverridden = false;

  async applyRoleOverrides(_sessionId: string, role: RoleSpec | null, pi: any, ctx: any): Promise<void> {
    if (role?.model && role.model !== "inherit") {
      if (!this.modelOverridden) this.baseModel = ctx?.model ?? this.baseModel;
      if (typeof pi?.setModel === "function") {
        const resolved = resolveModelSpec(role.model, ctx);
        if (resolved) { await pi.setModel(resolved); this.modelOverridden = true; }
      }
    } else if (this.modelOverridden) {
      if (this.baseModel !== undefined && typeof pi?.setModel === "function") await pi.setModel(this.baseModel);
      this.modelOverridden = false;
    } else {
      this.baseModel = ctx?.model ?? this.baseModel;
    }

    if (role?.thinking && role.thinking !== "inherit") {
      if (!this.thinkingOverridden) this.baseThinking = pi?.getThinkingLevel?.() ?? this.baseThinking;
      if (typeof pi?.setThinkingLevel === "function") { pi.setThinkingLevel(role.thinking); this.thinkingOverridden = true; }
    } else if (this.thinkingOverridden) {
      if (this.baseThinking !== undefined && typeof pi?.setThinkingLevel === "function") pi.setThinkingLevel(this.baseThinking);
      this.thinkingOverridden = false;
    } else {
      this.baseThinking = pi?.getThinkingLevel?.() ?? this.baseThinking;
    }
  }

  clear(): void {
    this.baseModel = undefined;
    this.baseThinking = undefined;
    this.modelOverridden = false;
    this.thinkingOverridden = false;
  }
}

export function isolateModelRegistry<T>(registry: T): T {
  if (!registry || typeof registry !== "object") return registry;
  return new Proxy(registry as object, {
    get(target, prop) {
      if (prop === "syncExtensionSources" || prop === "clearSourceRegistrations") return () => {};
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

function extractSessionUsage(session: any): UsageSummary | null {
  const messages: any[] = Array.isArray(session?.messages) ? session.messages : [];
  let inputTokens = 0, outputTokens = 0, costUsd = 0, found = false;
  for (const msg of messages) {
    if (msg?.role !== "assistant") continue;
    const u = normalizeUsageSummary(msg.usage);
    if (u) { found = true; inputTokens += u.inputTokens; outputTokens += u.outputTokens; costUsd += u.costUsd; }
  }
  return found ? { inputTokens, outputTokens, costUsd } : normalizeUsageSummary(session?.getLastAssistantMessage?.()?.usage);
}

const lastAssistantErroredOrAborted = (session: any): boolean => {
  const last = session?.getLastAssistantMessage?.();
  return Boolean(last && (last.stopReason === "error" || last.stopReason === "aborted" || last.errorMessage)) ||
    turnFailedOrAborted({ messages: session?.messages });
};

export function createOmpSupervisorInspector(pi: any, hostCtx: any, settings?: EnhanceSettings): SupervisorInspector {
  return {
    async evaluatePulse(pulse, supervisorRole) {
      const { model, thinkingLevel } = resolveRoleRuntimeConfig(supervisorRole, pi, hostCtx, settings);
      const inMemorySession = pi?.pi?.SessionManager?.inMemory?.(hostCtx?.cwd);
      const created = await pi.pi.createAgentSession({
        cwd: hostCtx.cwd, modelRegistry: isolateModelRegistry(hostCtx.modelRegistry),
        ...(inMemorySession ? { sessionManager: inMemorySession } : {}),
        ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}),
        settings: pi.pi.settings, hasUI: false, bindProcessState: false, disableExtensionDiscovery: true,
        noContextFiles: true, enableMCP: false, enableLsp: false, restrictToolNames: true, toolNames: [],
        skills: [], rules: [], promptTemplates: [], slashCommands: [],
        customSystemPrompt: renderSupervisorPrompt(supervisorRole, pulse.targetKind),
      });
      try {
        const schema = pulse.targetKind === "job"
          ? '{"action":"continue"|"abort","reason":"...","nextCheckSec":60,"evidence":"..."}'
          : '{"action":"continue"|"steer"|"abort","reason":"...","nextCheckSec":60,"evidence":"...","steerMessage":"..."}';
        await created.session.prompt(["Runtime pulse:", JSON.stringify(pulse), `Reply ONLY with JSON: ${schema}.`].join("\n"));
        const text = created.session.getLastAssistantText?.() ?? "";
        const decision = parseSupervisorDecision(text);
        if (!decision) throw new Error(`Supervisor returned an invalid decision: ${text.slice(0, 500)}`);
        return decision;
      } finally { await created.session.dispose(); }
    },
  };
}

export function createOmpRoleSessionRunner(
  pi: any, hostCtx: any, settings?: EnhanceSettings, roles?: ReadonlyMap<string, RoleSpec>, consultationDepth = 0,
): RoleSessionRunner {
  const kit = schemaKit(pi);
  const handoffSchema = kit.obj({
    verdict: kit.en(["ready", "rejected", "blocked"]), summary: kit.str(), toTarget: kit.str(), delegateNow: kit.bool(),
    artifactPaths: kit.arr(kit.str()),
    verifiedFacts: kit.arr(kit.obj({ claim: kit.str(), evidenceRef: kit.str() }, ["claim", "evidenceRef"])),
    openRisks: kit.arr(kit.str()), feedbackForUpstream: kit.str(),
  }, ["verdict", "summary"]);

  return {
    async runRoleTurn(stepCtx: RoleStepContext): Promise<RoleTurnOutcome> {
      const childTracker = new TurnTracker();
      childTracker.resetTurn(stepCtx.cwd);
      const baselineSnap = stepCtx.beforeSnapshot ?? childTracker.getBaselineSnapshot();
      const baselineConfigSnap = stepCtx.beforeConfigSnapshot ?? childTracker.getBaselineConfigSnapshot();
      const stageId = stepCtx.stageId ?? `${stepCtx.role.id}-${Date.now()}`;
      let submittedEnvelope: HandoffEnvelope | null = null, childSession: any = null, cancelledByUser = false;
      const boundaryViolations: string[] = [];

      const collectObservedCalls = (): ObservedToolCall[] => {
        const calls = new Map<string, ObservedToolCall>();
        for (const call of childTracker.getObservedCalls()) calls.set(call.toolCallId, call);
        const messages: any[] = Array.isArray(childSession?.messages) ? childSession.messages : [];
        for (const m of messages) {
          if (m?.role !== "toolResult" || typeof m.toolCallId !== "string" || calls.has(m.toolCallId)) continue;
          calls.set(m.toolCallId, {
            toolCallId: m.toolCallId, toolName: typeof m.toolName === "string" ? m.toolName : "unknown",
            isError: m.isError === true, touchedPaths: [], timestamp: typeof m.timestamp === "string" ? m.timestamp : new Date().toISOString(),
          });
        }
        return [...calls.values()];
      };

      const childHandoffTool = {
        name: "enhance_handoff", label: "Submit Role Handoff", loadMode: "essential", approval: "write",
        description: "Submit the final verified role conclusion (or set toTarget + delegateNow=true to consult a specialist role such as vision mid-turn).",
        parameters: handoffSchema,
        async execute(_toolCallId: string, params: any) {
          try {
            const wantDelegate = params.delegateNow === true && typeof params.toTarget === "string" &&
              params.toTarget.trim() !== "" && params.toTarget.trim() !== "user";
            const consultId = wantDelegate ? params.toTarget.trim() : "";
            let consultRole: RoleSpec | undefined;
            if (wantDelegate) {
              if (consultationDepth >= MAX_CONSULTATION_DEPTH) throw new Error(`Maximum specialist consultation depth (${MAX_CONSULTATION_DEPTH}) reached.`);
              const check = canRoleDelegateTo(stepCtx.role, roles?.get(consultId));
              if (!check.allowed) throw new Error(check.reason ?? `Unknown delegation target role "${consultId}".`);
              consultRole = roles?.get(consultId);
            }
            const effectiveTarget = consultRole ? consultRole.id : (params.verdict === "rejected" ? (stepCtx.repairTargetRoleId ?? "user") : stepCtx.toTarget);
            const envelope = createAndVerifyHandoff({
              store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
              flowId: stepCtx.flowId, parentHandoffId: stepCtx.upstreamHandoff?.id ?? null,
              toTarget: effectiveTarget, verdict: params.verdict, summary: params.summary,
              artifactPaths: params.artifactPaths, baselineSnapshot: baselineSnap,
              baselineConfigSnapshot: baselineConfigSnap, enforceConfigIntegrity: true,
              observedCalls: collectObservedCalls(), verifiedFacts: params.verifiedFacts,
              openRisks: params.openRisks, feedbackForUpstream: params.feedbackForUpstream,
              observedUsage: extractSessionUsage(childSession),
            });
            if (consultRole) {
              const delegated = await executeRoleStep({
                cwd: stepCtx.cwd, store: stepCtx.store, role: consultRole, mandate: stepCtx.mandate,
                upstreamHandoff: envelope, userSteers: stepCtx.userSteers, toTarget: stepCtx.role.id,
                flowId: stepCtx.flowId, observer: stepCtx.observer, supervisor: stepCtx.supervisor, signal: stepCtx.signal,
                runner: createOmpRoleSessionRunner(pi, hostCtx, settings, roles, consultationDepth + 1),
              });
              return { content: [{ type: "text", text: JSON.stringify({ handoff: envelope, delegated }, null, 2) }], ...(!delegated.ok ? { isError: true } : {}) };
            }
            submittedEnvelope = envelope;
            return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
          } catch (error) {
            if (error instanceof BoundaryViolationError) boundaryViolations.push(...error.violations);
            return { content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2) }], isError: true };
          }
        },
      };

      const setWork = (msg?: string): void => { try { hostCtx?.ui?.setWorkingMessage?.(msg); } catch {} };
      const childGuardExt = (childPi: any): void => {
        childPi.on("tool_call", (ev: any) => {
          const toolName = ev.toolName ?? ev.name ?? "", input = ev.input ?? ev.args;
          const decision = childTracker.checkToolCallAllowed(stepCtx.cwd, stepCtx.role, { toolName, input }, roles);
          if (!decision.block) {
            childTracker.recordToolExecutionStart(toolName, input);
            const summary = summarizeToolCall(toolName, input);
            setWork(`stage:${stepCtx.role.id} → ${summary}`);
            stepCtx.observer?.onToolStart?.(stageId, summary);
          }
          return decision.block ? decision : undefined;
        });
        childPi.on("tool_execution_end", (ev: any) => {
          const call = childTracker.recordToolExecutionEnd(stepCtx.cwd, {
            toolCallId: ev.toolCallId ?? ev.id ?? "call", toolName: ev.toolName ?? ev.name ?? "unknown",
            args: ev.args ?? ev.input, isError: Boolean(ev.isError ?? ev.result?.isError),
          });
          stepCtx.observer?.onToolEnd?.(stageId, call);
        });
      };

      const available = pi.getAllTools?.().map((t: any) => t.name) ?? ["read", "write", "edit", "grep", "bash"];
      const allowedTools = resolveRoleActiveTools(stepCtx.role, available, "stage");
      const extraStageTools = buildStageCompanionTools(pi, stepCtx, settings ?? DEFAULT_ENHANCE_SETTINGS);
      const { model, thinkingLevel } = resolveRoleRuntimeConfig(stepCtx.role, pi, hostCtx, settings);
      const resolvedModel = model as { provider?: string; id?: string } | undefined;
      const modelLabel = resolvedModel?.provider && resolvedModel?.id ? `${resolvedModel.provider}/${resolvedModel.id}` : (stepCtx.role.model ?? "default");
      const vHint = !stepCtx.conditioningPrompt.includes("\nRuntimeVision: ") ? formatRuntimeVisionHint(modelSupportsVision(model), stepCtx.role.id) : null;
      const sysPrompt = vHint ? stepCtx.conditioningPrompt.replace("\nStance:\n", `\n${vHint}\nStance:\n`) : stepCtx.conditioningPrompt;
      stepCtx.observer?.onStageModelResolved?.(stageId, modelLabel);

      const inMemorySession = pi?.pi?.SessionManager?.inMemory?.(stepCtx.cwd);
      const created = await pi.pi.createAgentSession({
        cwd: stepCtx.cwd, modelRegistry: isolateModelRegistry(hostCtx.modelRegistry),
        ...(inMemorySession ? { sessionManager: inMemorySession } : {}),
        ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}),
        settings: pi.pi.settings, hasUI: false, bindProcessState: false, disableExtensionDiscovery: true,
        noContextFiles: true, enableMCP: false, enableLsp: false,
        preloadedCustomToolPaths: [], skills: [], rules: [], promptTemplates: [], slashCommands: [],
        customSystemPrompt: sysPrompt, customTools: [childHandoffTool, ...extraStageTools],
        extensions: [childGuardExt], toolNames: allowedTools, allowRestrictedCustomTools: true,
      });

      childSession = created.session;
      const onExternalAbort = () => { cancelledByUser = true; void created.session.abort?.(); };
      stepCtx.signal?.addEventListener("abort", onExternalAbort, { once: true });
      stepCtx.observer?.bindControls?.({
        steer: async (msg: string) => { setWork(`stage:${stepCtx.role.id} ↺ steered by user`); await created.session.steer?.(`[User interjection in Flow room]: ${msg}`); },
        abort: async () => { cancelledByUser = true; setWork(`stage:${stepCtx.role.id} ✕ cancelled by user`); await created.session.abort?.(); },
      }, stageId);

      const finish = (abortedBySupervisor: SupervisorDecision | null = null): RoleTurnOutcome => {
        const usage = extractSessionUsage(created.session);
        if (submittedEnvelope && usage && !submittedEnvelope.observedUsage) {
          submittedEnvelope = { ...submittedEnvelope, observedUsage: usage };
          if (stepCtx.store.getHandoff(submittedEnvelope.id)) stepCtx.store.saveHandoff(submittedEnvelope);
        }
        return {
          envelope: submittedEnvelope, observedCalls: collectObservedCalls(),
          assistantText: created.session.getLastAssistantText?.() ?? "", usage,
          ...(abortedBySupervisor && !submittedEnvelope ? { abortedBySupervisor } : {}),
          ...(cancelledByUser || stepCtx.signal?.aborted || stepCtx.observer?.isCancelled?.() ? { cancelledByUser: true } : {}),
          ...(boundaryViolations.length > 0 ? { boundaryViolations } : {}),
        };
      };

      const runTurn = async (control: SessionSupervisorControl): Promise<RoleTurnOutcome> => {
        await created.session.prompt(stepCtx.taskPrompt);
        if (
          !control.aborted && !cancelledByUser && !stepCtx.signal?.aborted &&
          !stepCtx.observer?.isCancelled?.() && !submittedEnvelope && !lastAssistantErroredOrAborted(created.session)
        ) {
          await created.session.prompt("Submit your final role conclusion now using the enhance_handoff tool.");
        }
        return finish();
      };

      try {
        setWork(`stage:${stepCtx.role.id} (${stepCtx.role.name}) running...`);
        const supervisor = stepCtx.supervisor;
        if (!supervisor) return await runTurn({ aborted: false, decisions: [] });
        const supervised = await runWithSessionSupervisor({
          supervisorRole: supervisor.role, inspector: supervisor.inspector as SupervisorInspector, goal: stepCtx.mandate.goal,
          initialDelayMs: supervisor.initialDelayMs, minIntervalMs: supervisor.minIntervalMs, maxIntervalMs: supervisor.maxIntervalMs,
          signal: stepCtx.signal,
          getPulse: () => {
            const calls = collectObservedCalls(), handoffErrs = calls.filter((c) => c.toolName === "enhance_handoff" && c.isError).length;
            return { calls: calls.length, activeTool: childTracker.getActiveTool(), summary: calls.slice(-3).map((c) => `${c.toolName}${c.isError ? (c.toolName === "enhance_handoff" && handoffErrs < 3 ? ":validation_retry" : ":error") : ""}`).join(", ") };
          },
          onSteer: async (message) => {
            const framed = message.startsWith("[Supervisor]:") ? message : `[Supervisor]: ${message}`;
            setWork(`stage:${stepCtx.role.id} ↺ steered by supervisor`);
            stepCtx.observer?.onSupervisorNote?.(stageId, `↺ steer: ${message}`);
            await created.session.steer?.(framed);
          },
          onAbort: async () => {
            setWork(`stage:${stepCtx.role.id} ✕ aborted by supervisor`);
            stepCtx.observer?.onSupervisorNote?.(stageId, "✕ aborted by supervisor");
            await created.session.abort?.();
          },
          run: runTurn,
        });
        if (supervised.aborted && !submittedEnvelope) return finish(supervised.aborted);
        return supervised.result ?? finish();
      } finally {
        stepCtx.signal?.removeEventListener("abort", onExternalAbort);
        stepCtx.observer?.bindControls?.(null, stageId);
        setWork(undefined);
        await created.session.dispose();
      }
    },
  };
}

export interface ManagedWorkspace extends WorkspaceRuntime {
  rolesBySession: Map<string, string | null>;
  baselines: SessionBaselineManager;
  lastSessionId?: string;
}

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
  const rolesBySession = new Map<string, string | null>([["__default__", defaultRoleId(roles, settings)]]);

  const runFlowTask = (fCtx: any, flowId: string, execInput: {
    roles: RoleSpec[]; mandate: Mandate; initialHandoff: HandoffEnvelope | null; maxRepairRounds: number;
    startIndex?: number; initialRepairRound?: number; initialStageSeq?: number; initialLastRejectionSig?: string | null; signal?: AbortSignal;
  }): Promise<FlowRunResult> => {
    ws.syncStatusBar(fCtx);
    return (async () => {
      try {
        const res = await executeRoleFlow({ cwd, store, flowId, ...execInput, runner: ws.runnerFor(fCtx), supervisor: ws.supervisorFor(fCtx), observer: room.createObserver(fCtx) });
        room.finishFlow(res, fCtx);
        return res;
      } catch (err) { room.failFlow(err, fCtx); throw err; }
      finally { ws.syncStatusBar(fCtx); }
    })();
  };

  const ws: ManagedWorkspace = {
    cwd, globalRolesDir: resolveGlobalDir(), builtinRolesDir: options.builtinRolesDir,
    store, trackers, room, roles, settings, rolesBySession, baselines,
    getSessionId: (c) => sessionKey(c),
    getSessionRoleId: (c) => { const sid = sessionKey(c); return rolesBySession.has(sid) ? rolesBySession.get(sid)! : (rolesBySession.get("__default__") ?? null); },
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
      rolesBySession.set(sid, roleId); rolesBySession.set("__default__", roleId); ws.lastSessionId = sid;
      if (persist) { try { pi.appendEntry?.("omp-enhance-role", { roleId }); } catch {} }
      const role = roleId ? ws.roles.get(roleId) ?? null : null, allNames = pi.getAllTools?.().map((t: any) => t.name) ?? [];
      await pi.setActiveTools?.(role ? resolveRoleActiveTools(role, allNames, "foreground") : allNames);
      await baselines.applyRoleOverrides(sid, role, pi, c);
      ws.syncStatusBar(c);
    },
    runnerFor: (c) => options.runnerFactory?.(pi, c) ?? createOmpRoleSessionRunner(pi, c, ws.settings, ws.roles),
    supervisorFor: (c) => {
      const sup = ws.settings.supervisorEnabled ? ws.roles.get("supervisor") : undefined;
      return sup ? { role: sup, inspector: createOmpSupervisorInspector(pi, c, ws.settings), initialDelayMs: ws.settings.supervisorInitialDelaySec * 1000 } : undefined;
    },
    emitMessage: (c, text) => {
      const outPath = process.env.OMP_ENHANCE_CMD_OUT;
      if (outPath) { try { mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true }); appendFileSync(outPath, text.endsWith("\n") ? text : `${text}\n`, "utf8"); } catch {} }
      try {
        const opts = { triggerTurn: false, ...(c?.isIdle?.() === false ? { deliverAs: "followUp" } : {}) };
        if (typeof pi.sendMessage === "function") pi.sendMessage({ customType: "omp-enhance", content: text, display: true }, opts);
        else c?.ui?.notify?.(text, "info");
      } catch {}
    },
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
