import { canRoleDelegateTo, isRoleReadOnly, resolveRoleActiveTools, summarizeToolCall, TurnTracker } from "../core/policy.ts";
import { DEFAULT_ENHANCE_SETTINGS, modelSupportsVision, normalizeUsageSummary, resolveRoleRuntimeConfig } from "../core/settings.ts";
import type { EnhanceSettings, HandoffEnvelope, ObservedToolCall, RoleSpec, SupervisorDecision, UsageSummary } from "../core/types.ts";
import { BoundaryViolationError, createAndVerifyHandoff } from "../flow/handoff.ts";
import { executeRoleStep, type RoleSessionRunner, type RoleStepContext, type RoleTurnOutcome } from "../flow/orchestrator.ts";
import { cancelJobsByIds } from "../jobs/runner.ts";
import { parseSupervisorDecision, renderSupervisorPrompt, runWithSessionSupervisor, type SessionSupervisorControl, type SupervisorInspector } from "../jobs/supervisor.ts";
import { formatRuntimeVisionHint } from "../roles/conditioning.ts";
import { buildStageCompanionTools, schemaKit } from "./tools.ts";

const MAX_CONSULTATION_DEPTH = 3;

export function sanitizeHostError(raw: string): string {
  const redacted = raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*([=:])\s*([^\s"',;}\]]+)/gi, "$1$2[REDACTED]")
    .replace(/(https?:\/\/)([^/@\s:]+):([^/@\s]+)@/gi, "$1[REDACTED]:[REDACTED]@")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > 600 ? `${redacted.slice(0, 599)}…` : redacted;
}

export function extractSessionHostError(session: any): string | null {
  const inspectMsg = (m: any): string | null => {
    if (!m || m.stopReason === "aborted") return null;
    const rawErr = typeof m.errorMessage === "string" && m.errorMessage.trim()
      ? m.errorMessage
      : typeof m.error === "string" && m.error.trim()
        ? m.error
        : typeof m.error?.message === "string" && m.error.message.trim()
          ? m.error.message
          : m.stopReason === "error"
            ? "Model turn terminated with stopReason=error"
            : null;
    return rawErr ? sanitizeHostError(rawErr) : null;
  };
  const fromLast = inspectMsg(session?.getLastAssistantMessage?.());
  if (fromLast) return fromLast;
  const msgs: any[] = Array.isArray(session?.messages) ? session.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === "assistant" || m?.stopReason || m?.errorMessage || m?.error) {
      const hit = inspectMsg(m);
      if (hit) return hit;
    }
  }
  return null;
}

export function turnFailedOrAborted(event: any): boolean {
  if (event?.stopReason === "error" || event?.stopReason === "aborted" || Boolean(event?.error)) return true;
  const msgs = Array.isArray(event?.messages) ? event.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === "assistant" || m?.stopReason) return m.stopReason === "error" || m.stopReason === "aborted" || Boolean(m.errorMessage);
  }
  return false;
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

const childSettingOverride = (key: string): unknown =>
  key === "advisor.enabled" || key === "autolearn.enabled" ? false : key === "memory.backend" ? "off" : undefined;

export function createChildSettingsProxy(rawSettings: any): any {
  if (!rawSettings || typeof rawSettings !== "object") {
    return { advisor: { enabled: false }, memory: { backend: "off", enabled: false }, autolearn: { enabled: false }, get: childSettingOverride };
  }
  if (typeof rawSettings.overlay === "function") {
    try { return rawSettings.overlay({ "advisor.enabled": false, "memory.backend": "off", "autolearn.enabled": false }); }
    catch { try { return rawSettings.overlay({ "advisor.enabled": false, "memory.backend": "off" }); } catch {} }
  }
  const obj = (v: unknown) => (v && typeof v === "object" ? v : {});
  return new Proxy(rawSettings as object, {
    get(target: any, prop) {
      if (prop === "advisor") return { ...obj(target?.advisor), enabled: false };
      if (prop === "memory") return { ...obj(target?.memory), backend: "off", enabled: false };
      if (prop === "autolearn") return { ...obj(target?.autolearn), enabled: false };
      if (prop === "get") return (k: string) => childSettingOverride(k) ?? (typeof target?.get === "function" ? target.get(k) : undefined);
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function countActiveAsyncJobs(session: any, hostCtx?: any): number {
  for (const source of [session, hostCtx]) {
    if (!source) continue;
    const snap = source?.getAsyncJobSnapshot?.();
    if (Array.isArray(snap?.running)) return snap.running.length;
    if (typeof snap?.running === "number" && Number.isFinite(snap.running)) return Math.max(0, snap.running);
    if (typeof snap?.active === "number" && Number.isFinite(snap.active)) return Math.max(0, snap.active);
    const running = source?.asyncJobManager?.getRunningJobs?.();
    if (Array.isArray(running)) return running.length;
  }
  return 0;
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
      const supId = `enhance-sup-${pulse.checkNumber}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const created = await pi.pi.createAgentSession({
        cwd: hostCtx.cwd, agentId: supId, parentTaskPrefix: supId, taskDepth: 1,
        modelRegistry: isolateModelRegistry(hostCtx.modelRegistry),
        ...(inMemorySession ? { sessionManager: inMemorySession } : {}),
        ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}),
        settings: createChildSettingsProxy(pi.pi.settings),
        hasUI: false, autoApprove: true, enableMemory: false, bindProcessState: false, disableExtensionDiscovery: true,
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
    verdict: kit.en(["ready", "needs_input", "rejected", "blocked"]),
    summary: kit.str(), toTarget: kit.str(), delegateNow: kit.bool(),
    artifactPaths: kit.arr(kit.str()),
    verifiedFacts: kit.arr(kit.obj({ claim: kit.str(), evidenceRef: kit.str() }, ["claim", "evidenceRef"])),
    openRisks: kit.arr(kit.str()), questionsForUser: kit.arr(kit.str()), feedbackForUpstream: kit.str(),
  }, ["verdict", "summary"]);

  return {
    async runRoleTurn(stepCtx: RoleStepContext): Promise<RoleTurnOutcome> {
      let cancelledByUser = false, supervisorAborted = false, abortSent = false, thrownHostError: string | null = null;
      const isCancelledNow = (): boolean =>
        cancelledByUser || Boolean(stepCtx.signal?.aborted) || Boolean(stepCtx.observer?.isCancelled?.());
      if (isCancelledNow()) {
        return { envelope: null, observedCalls: [], assistantText: "", usage: null, cancelledByUser: true };
      }

      const childTracker = new TurnTracker();
      childTracker.beginTurn(stepCtx.cwd, false);
      const baselineSnap = stepCtx.beforeSnapshot ?? childTracker.getBaselineSnapshot(stepCtx.cwd);
      const baselineConfigSnap = stepCtx.beforeConfigSnapshot ?? childTracker.getBaselineConfigSnapshot(stepCtx.cwd);
      const stageId = stepCtx.stageId ?? `${stepCtx.role.id}-${Date.now()}`;
      const stageStartedJobIds = new Set<string>();
      let submittedEnvelope: HandoffEnvelope | null = null, childSession: any = null;
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
        name: "enhance_handoff", label: "Submit Role Handoff", loadMode: "essential",
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
            const questionsForUser = Array.isArray(params.questionsForUser)
              ? params.questionsForUser.filter((q: unknown): q is string => typeof q === "string" && q.trim().length > 0)
              : undefined;
            const envelope = createAndVerifyHandoff({
              store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
              flowId: stepCtx.flowId, parentHandoffId: stepCtx.upstreamHandoff?.id ?? null,
              toTarget: effectiveTarget, verdict: params.verdict, summary: params.summary,
              artifactPaths: params.artifactPaths, baselineSnapshot: baselineSnap,
              baselineConfigSnapshot: baselineConfigSnap, enforceConfigIntegrity: true,
              observedCalls: collectObservedCalls(), verifiedFacts: params.verifiedFacts,
              openRisks: params.openRisks, questionsForUser, feedbackForUpstream: params.feedbackForUpstream,
              observedUsage: extractSessionUsage(childSession), isConsultation: Boolean(consultRole),
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

      const childGuardExt = (childPi: any): void => {
        childPi.on("tool_call", (ev: any) => {
          const toolName = ev.toolName ?? ev.name ?? "", input = ev.input ?? ev.args;
          const decision = childTracker.checkToolCallAllowed(stepCtx.cwd, stepCtx.role, { toolName, input }, roles);
          return decision.block ? decision : undefined;
        });
        childPi.on("tool_execution_start", (ev: any) => {
          const toolName = ev.toolName ?? ev.name ?? "", input = ev.args ?? ev.input;
          childTracker.recordToolExecutionStart(toolName, input);
          stepCtx.observer?.onToolStart?.(stageId, summarizeToolCall(toolName, input));
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
      const extraStageTools = buildStageCompanionTools(
        pi, stepCtx, settings ?? DEFAULT_ENHANCE_SETTINGS, (jobId) => stageStartedJobIds.add(jobId),
      );
      const { model, thinkingLevel } = resolveRoleRuntimeConfig(stepCtx.role, pi, hostCtx, settings);
      const resolvedModel = model as { provider?: string; id?: string } | undefined;
      const modelLabel = resolvedModel?.provider && resolvedModel?.id ? `${resolvedModel.provider}/${resolvedModel.id}` : (stepCtx.role.model ?? "default");
      const vHint = !stepCtx.conditioningPrompt.includes("\nRuntimeVision: ") ? formatRuntimeVisionHint(modelSupportsVision(model), stepCtx.role.id) : null;
      const sysPrompt = vHint ? stepCtx.conditioningPrompt.replace("\nStance:\n", `\n${vHint}\nStance:\n`) : stepCtx.conditioningPrompt;
      stepCtx.observer?.onStageModelResolved?.(stageId, modelLabel);

      const inMemorySession = pi?.pi?.SessionManager?.inMemory?.(stepCtx.cwd);
      const stageAgentId = `enhance-stage-${stageId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      const created = await pi.pi.createAgentSession({
        cwd: stepCtx.cwd, agentId: stageAgentId, parentTaskPrefix: stageAgentId, taskDepth: 1,
        modelRegistry: isolateModelRegistry(hostCtx.modelRegistry),
        ...(inMemorySession ? { sessionManager: inMemorySession } : {}),
        ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}),
        settings: createChildSettingsProxy(pi.pi.settings),
        hasUI: false, autoApprove: true, enableMemory: false, bindProcessState: false, disableExtensionDiscovery: true,
        noContextFiles: false, enableMCP: false, enableLsp: allowedTools.includes("lsp"),
        preloadedCustomToolPaths: [], promptTemplates: [], slashCommands: [],
        customSystemPrompt: sysPrompt, customTools: [childHandoffTool, ...extraStageTools],
        preloadedPreparedExtensions: [
          { path: "<enhance-guard>", resolvedPath: "<enhance-guard>", factory: childGuardExt, error: null },
        ],
        restrictToolNames: true, toolNames: allowedTools, allowRestrictedCustomTools: true,
      });

      childSession = created.session;
      const triggerSessionAbort = async (): Promise<void> => {
        cancelledByUser = true;
        if (abortSent) return;
        abortSent = true;
        await created.session.abort?.();
      };
      const onExternalAbort = () => { void triggerSessionAbort(); };

      try {
        if (isCancelledNow()) {
          cancelledByUser = true;
          return { envelope: null, observedCalls: [], assistantText: "", usage: null, cancelledByUser: true };
        }
        stepCtx.signal?.addEventListener("abort", onExternalAbort, { once: true });
        stepCtx.observer?.bindControls?.({
          steer: async (msg: string) => { await created.session.steer?.(`[User interjection in Flow room]: ${msg}`); },
          abort: async () => { await triggerSessionAbort(); },
        }, stageId);

        const finish = (abortedBySupervisor: SupervisorDecision | null = null): RoleTurnOutcome => {
          const usage = extractSessionUsage(created.session);
          if (submittedEnvelope && usage && !submittedEnvelope.observedUsage) {
            submittedEnvelope = { ...submittedEnvelope, observedUsage: usage };
            if (stepCtx.store.getHandoff(submittedEnvelope.id)) stepCtx.store.saveHandoff(submittedEnvelope);
          }
          const cancelled = isCancelledNow();
          const hostError = !submittedEnvelope && !cancelled && !abortedBySupervisor
            ? (thrownHostError ?? extractSessionHostError(created.session))
            : null;
          return {
            envelope: submittedEnvelope, observedCalls: collectObservedCalls(),
            assistantText: created.session.getLastAssistantText?.() ?? "", usage,
            ...(abortedBySupervisor && !submittedEnvelope ? { abortedBySupervisor } : {}),
            ...(cancelled ? { cancelledByUser: true } : {}),
            ...(boundaryViolations.length > 0 ? { boundaryViolations } : {}),
            ...(hostError ? { hostError } : {}),
          };
        };

        const runTurn = async (control: SessionSupervisorControl): Promise<RoleTurnOutcome> => {
          try {
            await created.session.prompt(stepCtx.taskPrompt);
            if (
              !control.aborted && !isCancelledNow() &&
              !submittedEnvelope && !lastAssistantErroredOrAborted(created.session)
            ) {
              await created.session.prompt("Submit your final role conclusion now using the enhance_handoff tool.");
            }
          } catch (err) {
            if (!isCancelledNow() && !supervisorAborted && !control.aborted) {
              thrownHostError = sanitizeHostError(err instanceof Error ? err.message : String(err));
            }
          }
          return finish();
        };

        const supervisor = stepCtx.supervisor;
        if (!supervisor) return await runTurn({ aborted: false, decisions: [] });
        const supervised = await runWithSessionSupervisor({
          supervisorRole: supervisor.role, inspector: supervisor.inspector as SupervisorInspector, goal: stepCtx.mandate.goal,
          initialDelayMs: supervisor.initialDelayMs, minIntervalMs: supervisor.minIntervalMs, maxIntervalMs: supervisor.maxIntervalMs,
          signal: stepCtx.signal,
          getPulse: () => {
            const calls = collectObservedCalls(), handoffErrs = calls.filter((c) => c.toolName === "enhance_handoff" && c.isError).length;
            return {
              calls: calls.length, activeTool: childTracker.getActiveTool(),
              summary: calls.slice(-3).map((c) => `${c.toolName}${c.isError ? (c.toolName === "enhance_handoff" && handoffErrs < 3 ? ":validation_retry" : ":error") : ""}`).join(", "),
              roleId: stepCtx.role.id, readOnly: isRoleReadOnly(stepCtx.role), allowedTools,
              activeAsyncJobs: countActiveAsyncJobs(childSession, hostCtx),
            };
          },
          onSteer: async (message) => {
            const framed = message.startsWith("[Supervisor]:") ? message : `[Supervisor]: ${message}`;
            stepCtx.observer?.onSupervisorNote?.(stageId, `↺ steer: ${message}`);
            await created.session.steer?.(framed);
          },
          onAbort: async () => {
            supervisorAborted = true; abortSent = true;
            stepCtx.observer?.onSupervisorNote?.(stageId, "✕ aborted by supervisor");
            await created.session.abort?.();
          },
          run: runTurn,
        });
        if (supervised.aborted && !submittedEnvelope) { supervisorAborted = true; return finish(supervised.aborted); }
        return supervised.result ?? finish();
      } finally {
        stepCtx.signal?.removeEventListener("abort", onExternalAbort);
        stepCtx.observer?.bindControls?.(null, stageId);
        const stageAborted = (supervisorAborted && !submittedEnvelope) || isCancelledNow();
        if (stageAborted && stageStartedJobIds.size > 0) cancelJobsByIds(stepCtx.store, stageStartedJobIds);
        await created.session.dispose();
      }
    },
  };
}
