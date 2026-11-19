import type {
  EnhanceSettings, EpistemicItem, FlowRunResult, FlowStepResult, HandoffEnvelope, Mandate,
  ObservedToolCall, RoleSpec, UsageSummary, SupervisorDecision,
} from "./types.ts";
import type { EnhanceStore } from "./store.ts";
import { findProtectedViolations, snapshotWorkspace } from "./store.ts";
import { renderConditioningBlock } from "./role-loader.ts";
import { createAndVerifyHandoff } from "./handoff.ts";
import { summarizeToolCall, TurnTracker } from "./session-tracker.ts";
import { resolveRoleRuntimeConfig } from "./settings.ts";
import {
  runWithSessionSupervisor, type SessionSupervisorControl, type SupervisorInspector,
} from "./supervisor.ts";

export interface ActiveStageControls {
  steer: (message: string) => Promise<void>;
  abort: () => Promise<void>;
}
export interface FlowObserver {
  isCancelled?: () => boolean;
  bindControls?: (controls: ActiveStageControls | null) => void;
  onStageStart?: (info: { stageId: string; role: RoleSpec; round: number; toTarget: string; modelLabel: string }) => void;
  onToolStart?: (stageId: string, summary: string) => void;
  onToolEnd?: (stageId: string, call: ObservedToolCall) => void;
  onSupervisorNote?: (stageId: string, note: string) => void;
  onStageEnd?: (stageId: string, info: {
    status: "ready" | "rejected" | "blocked" | "violation" | "aborted";
    outcome: RoleTurnOutcome | null;
    reason?: string;
  }) => void;
}
export interface RoleSupervisorConfig {
  role: RoleSpec; inspector: SupervisorInspector;
  initialDelayMs?: number; minIntervalMs?: number; maxIntervalMs?: number;
}
export interface RoleStepContext {
  cwd: string; store: EnhanceStore; role: RoleSpec; mandate: Mandate;
  epistemicItems: readonly EpistemicItem[]; upstreamHandoff: HandoffEnvelope | null;
  toTarget: string; conditioningPrompt: string; taskPrompt: string;
  stageId?: string; round?: number; observer?: FlowObserver;
  supervisor?: RoleSupervisorConfig;
}
export interface RoleTurnOutcome {
  envelope: HandoffEnvelope | null; observedCalls: ObservedToolCall[];
  assistantText: string; usage: UsageSummary | null;
  abortedBySupervisor?: SupervisorDecision | null;
  cancelledByUser?: boolean;
}
export interface RoleSessionRunner { runRoleTurn(ctx: RoleStepContext): Promise<RoleTurnOutcome>; }
export interface ExecuteRoleStepInput {
  cwd: string; store: EnhanceStore; role: RoleSpec; mandate: Mandate;
  upstreamHandoff: HandoffEnvelope | null; toTarget: string; runner: RoleSessionRunner;
  stageId?: string; round?: number; observer?: FlowObserver;
  supervisor?: RoleSupervisorConfig;
}
export type ExecuteRoleStepResult =
  | { ok: true; envelope: HandoffEnvelope }
  | { ok: false; status: "violation"; violations: string[]; reason: string }
  | { ok: false; status: "missing_handoff"; reason: string }
  | { ok: false; status: "aborted_by_supervisor"; reason: string; decision: SupervisorDecision }
  | { ok: false; status: "cancelled"; reason: string };

function taskPromptFor(input: {
  role: RoleSpec;
  mandate: Mandate;
  upstreamHandoff: HandoffEnvelope | null;
}): string {
  const upstream = input.upstreamHandoff
    ? `${input.upstreamHandoff.fromRole} -> ${input.upstreamHandoff.toTarget} [${input.upstreamHandoff.verdict}]: ${input.upstreamHandoff.summary}`
    : "(none)";
  return [
    `Role: ${input.role.id} (${input.role.name})`,
    `Mandate goal: ${input.mandate.goal}`,
    `Upstream handoff: ${upstream}`,
    "Work strictly inside your role conditioning and permitted tools.",
    "When finished, call enhance_handoff exactly once with verdict, summary, artifactPaths, openRisks,",
    "and feedbackForUpstream when the verdict is rejected. Do not claim work you did not execute.",
  ].join("\n");
}

function handoffParameters(pi: any): unknown {
  const T = pi?.typebox?.Type;
  if (T?.Object) {
    const opt = (value: unknown) => (T.Optional ? T.Optional(value) : value);
    const str = () => T.String();
    return T.Object({
      verdict: T.Union([T.Literal("ready"), T.Literal("rejected"), T.Literal("blocked")]),
      summary: str(),
      artifactPaths: opt(T.Array(str())),
      verifiedFacts: opt(T.Array(T.Object({ claim: str(), evidenceRef: str() }))),
      openRisks: opt(T.Array(str())),
      feedbackForUpstream: opt(str()),
    });
  }
  return {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["ready", "rejected", "blocked"] },
      summary: { type: "string" },
      artifactPaths: { type: "array", items: { type: "string" } },
      verifiedFacts: {
        type: "array",
        items: {
          type: "object",
          properties: { claim: { type: "string" }, evidenceRef: { type: "string" } },
          required: ["claim", "evidenceRef"],
        },
      },
      openRisks: { type: "array", items: { type: "string" } },
      feedbackForUpstream: { type: "string" },
    },
    required: ["verdict", "summary"],
  };
}
export function createOmpRoleSessionRunner(pi: any, hostCtx: any, settings?: EnhanceSettings): RoleSessionRunner {
  return {
    async runRoleTurn(stepCtx: RoleStepContext): Promise<RoleTurnOutcome> {
      const childTracker = new TurnTracker();
      childTracker.resetTurn(stepCtx.cwd);
      const stageId = stepCtx.stageId ?? `${stepCtx.role.id}-${Date.now()}`;
      let submittedEnvelope: HandoffEnvelope | null = null;
      let childSession: any = null;
      let cancelledByUser = false;
      const collectObservedCalls = (): ObservedToolCall[] => {
        const calls = new Map<string, ObservedToolCall>();
        for (const call of childTracker.getObservedCalls()) calls.set(call.toolCallId, call);
        const messages: any[] = Array.isArray(childSession?.messages) ? childSession.messages : [];
        for (const message of messages) {
          if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
          if (calls.has(message.toolCallId)) continue;
          calls.set(message.toolCallId, {
            toolCallId: message.toolCallId,
            toolName: typeof message.toolName === "string" ? message.toolName : "unknown",
            isError: message.isError === true,
            touchedPaths: [],
            timestamp: typeof message.timestamp === "string" ? message.timestamp : new Date().toISOString(),
          });
        }
        return [...calls.values()];
      };

      const childHandoffTool = {
        name: "enhance_handoff", label: "Submit Role Handoff", loadMode: "essential", approval: "write",
        description: "Submit the final verified role conclusion as a HandoffEnvelope.",
        parameters: handoffParameters(pi),
        async execute(_toolCallId: string, params: any) {
          try {
            const envelope = createAndVerifyHandoff({
              store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
              parentHandoffId: stepCtx.upstreamHandoff?.id ?? null, toTarget: stepCtx.toTarget,
              verdict: params.verdict, summary: params.summary, artifactPaths: params.artifactPaths,
              baselineSnapshot: childTracker.getBaselineSnapshot(), observedCalls: collectObservedCalls(),
              verifiedFacts: params.verifiedFacts, openRisks: params.openRisks,
              feedbackForUpstream: params.feedbackForUpstream,
            });
            submittedEnvelope = envelope;
            return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }], isError: true };
          }
        },
      };

      const setWork = (msg?: string): void => { try { hostCtx?.ui?.setWorkingMessage?.(msg); } catch {} };
      const childGuardExt = (childPi: any): void => {
        childPi.on("tool_call", (ev: any) => {
          const toolName = ev.toolName ?? ev.name ?? "", input = ev.input ?? ev.args;
          const decision = childTracker.checkToolCallAllowed(stepCtx.cwd, stepCtx.role, { toolName, input });
          if (!decision.block) {
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

      let allowedTools: string[];
      if (stepCtx.role.permissions.tools) {
        allowedTools = [...new Set([...stepCtx.role.permissions.tools, "enhance_handoff"])];
      } else {
        const available = pi.getAllTools?.().map((tool: any) => tool.name) ?? ["read", "write", "edit", "grep", "bash"];
        allowedTools = [...new Set([
          ...available.filter((name: string) => name === "enhance_handoff" || !name.startsWith("enhance_")),
          "enhance_handoff",
        ])];
      }

      const { model, thinkingLevel } = resolveRoleRuntimeConfig(stepCtx.role, pi, hostCtx, settings);
      const resolvedModel = model as { provider?: string; id?: string } | undefined;
      const modelLabel = resolvedModel?.provider && resolvedModel?.id
        ? `${resolvedModel.provider}/${resolvedModel.id}` : (stepCtx.role.model ?? "default");
      stepCtx.observer?.onStageStart?.({
        stageId, role: stepCtx.role, round: stepCtx.round ?? 0, toTarget: stepCtx.toTarget, modelLabel,
      });
      const created = await pi.pi.createAgentSession({
        cwd: stepCtx.cwd, modelRegistry: hostCtx.modelRegistry,
        ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}),
        settings: pi.pi.settings, bindProcessState: false, disableExtensionDiscovery: true,
        noContextFiles: true, enableMCP: false, enableLsp: false,
        // OMP binds inline extensions only without restrictToolNames; toolNames still restricts the active set.
        customSystemPrompt: stepCtx.conditioningPrompt, customTools: [childHandoffTool],
        extensions: [childGuardExt], toolNames: allowedTools, allowRestrictedCustomTools: true,
      });

      childSession = created.session;
      stepCtx.observer?.bindControls?.({
        steer: async (msg: string) => {
          setWork(`stage:${stepCtx.role.id} ↺ steered by user`);
          await created.session.steer?.(`[User interjection in Flow room]: ${msg}`);
        },
        abort: async () => {
          cancelledByUser = true;
          setWork(`stage:${stepCtx.role.id} ✕ cancelled by user`);
          await created.session.abort?.();
        },
      });
      const finish = (abortedBySupervisor: SupervisorDecision | null = null): RoleTurnOutcome => ({
        envelope: submittedEnvelope,
        observedCalls: collectObservedCalls(),
        assistantText: created.session.getLastAssistantText?.() ?? "",
        usage: created.session.getLastAssistantMessage?.()?.usage ?? null,
        ...(abortedBySupervisor ? { abortedBySupervisor } : {}),
        ...(cancelledByUser || stepCtx.observer?.isCancelled?.() ? { cancelledByUser: true } : {}),
      });
      const runTurn = async (control: SessionSupervisorControl): Promise<RoleTurnOutcome> => {
        await created.session.prompt(stepCtx.taskPrompt);
        if (!control.aborted && !cancelledByUser && !stepCtx.observer?.isCancelled?.() && !submittedEnvelope) {
          await created.session.prompt("Submit your final role conclusion now using the enhance_handoff tool.");
        }
        return finish();
      };
      const pulse = () => {
        const calls = collectObservedCalls();
        return {
          calls: calls.length,
          summary: calls.slice(-3).map((call) => `${call.toolName}${call.isError ? ":error" : ""}`).join(", "),
        };
      };
      try {
        setWork(`stage:${stepCtx.role.id} (${stepCtx.role.name}) running...`);
        const supervisor = stepCtx.supervisor;
        if (!supervisor) return await runTurn({ aborted: false, decisions: [] });
        const supervised = await runWithSessionSupervisor({
          supervisorRole: supervisor.role, inspector: supervisor.inspector, goal: stepCtx.mandate.goal,
          initialDelayMs: supervisor.initialDelayMs, minIntervalMs: supervisor.minIntervalMs,
          maxIntervalMs: supervisor.maxIntervalMs, getPulse: pulse,
          onSteer: async (message) => {
            setWork(`stage:${stepCtx.role.id} ↺ steered by supervisor`);
            stepCtx.observer?.onSupervisorNote?.(stageId, `↺ steer: ${message}`);
            await created.session.steer?.(message);
          },
          onAbort: async () => {
            setWork(`stage:${stepCtx.role.id} ✕ aborted by supervisor`);
            stepCtx.observer?.onSupervisorNote?.(stageId, "✕ aborted by supervisor");
            await created.session.abort?.();
          },
          run: runTurn,
        });
        if (supervised.aborted) return finish(supervised.aborted);
        return supervised.result ?? finish();
      } finally {
        stepCtx.observer?.bindControls?.(null);
        setWork(undefined);
        await created.session.dispose();
      }
    },
  };
}
export async function executeRoleStep(input: ExecuteRoleStepInput): Promise<ExecuteRoleStepResult> {
  if (input.observer?.isCancelled?.()) return { ok: false, status: "cancelled", reason: "Cancelled by user." };
  const stageId = input.stageId ?? `${input.role.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const before = snapshotWorkspace(input.cwd);
  const epistemicItems = input.store.listEpistemicItems(input.mandate.id);
  const conditioningPrompt = renderConditioningBlock({
    role: input.role, mandate: input.mandate, epistemicItems, upstreamHandoff: input.upstreamHandoff,
  });
  input.observer?.onStageStart?.({
    stageId, role: input.role, round: input.round ?? 0, toTarget: input.toTarget, modelLabel: input.role.model ?? "default",
  });
  const outcome = await input.runner.runRoleTurn({
    cwd: input.cwd, store: input.store, role: input.role, mandate: input.mandate, epistemicItems,
    upstreamHandoff: input.upstreamHandoff, toTarget: input.toTarget, conditioningPrompt,
    taskPrompt: taskPromptFor(input), stageId, round: input.round, observer: input.observer,
    ...(input.supervisor ? { supervisor: input.supervisor } : {}),
  });
  if (outcome.cancelledByUser || input.observer?.isCancelled?.()) {
    input.observer?.onStageEnd?.(stageId, { status: "aborted", outcome, reason: "Cancelled by user." });
    return { ok: false, status: "cancelled", reason: "Cancelled by user." };
  }
  if (outcome.abortedBySupervisor) {
    input.observer?.onStageEnd?.(stageId, { status: "aborted", outcome, reason: outcome.abortedBySupervisor.reason });
    return {
      ok: false, status: "aborted_by_supervisor",
      reason: outcome.abortedBySupervisor.reason, decision: outcome.abortedBySupervisor,
    };
  }
  const violations = findProtectedViolations(input.cwd, before, input.role.permissions.protected ?? []);
  if (violations.length > 0) {
    const reason = `Role "${input.role.id}" modified protected paths: ${violations.join(", ")}`;
    input.observer?.onStageEnd?.(stageId, { status: "violation", outcome, reason });
    return { ok: false, status: "violation", violations, reason };
  }
  if (!outcome.envelope) {
    const reason = `Role "${input.role.id}" finished without submitting enhance_handoff.`;
    input.observer?.onStageEnd?.(stageId, { status: "violation", outcome, reason });
    return { ok: false, status: "missing_handoff", reason };
  }
  input.observer?.onStageEnd?.(stageId, { status: outcome.envelope.verdict, outcome });
  return { ok: true, envelope: outcome.envelope };
}
export interface ExecuteRoleFlowInput {
  cwd: string; store: EnhanceStore; roles: readonly RoleSpec[]; mandate: Mandate;
  initialHandoff?: HandoffEnvelope | null; runner: RoleSessionRunner;
  maxRepairRounds?: number; supervisor?: RoleSupervisorConfig; observer?: FlowObserver;
}
export async function executeRoleFlow(input: ExecuteRoleFlowInput): Promise<FlowRunResult> {
  if (input.roles.length < 1) throw new Error("executeRoleFlow requires at least one role.");
  const maxRepairRounds = input.maxRepairRounds ?? 2, steps: FlowStepResult[] = [];
  let repairRound = 0, lastRejectionSig: string | null = null;
  let upstream = input.initialHandoff ?? null, idx = 0, seq = 0;

  while (idx < input.roles.length) {
    if (input.observer?.isCancelled?.()) {
      return { status: "cancelled", steps, finalEnvelope: upstream, reason: "Cancelled by user." };
    }
    const role = input.roles[idx]!;
    const toTarget = idx + 1 < input.roles.length ? input.roles[idx + 1]!.id : "user";
    seq += 1;
    const res = await executeRoleStep({
      cwd: input.cwd, store: input.store, role, mandate: input.mandate,
      upstreamHandoff: upstream, runner: input.runner, toTarget,
      stageId: `step-${seq}-${role.id}`, round: repairRound, observer: input.observer,
      ...(input.supervisor ? { supervisor: input.supervisor } : {}),
    });
    if (!res.ok) {
      const status = res.status === "cancelled" ? "cancelled"
        : (res.status === "aborted_by_supervisor" ? "aborted_by_supervisor" : "violation");
      return { status, steps, finalEnvelope: upstream, reason: res.reason };
    }
    steps.push({ stepIndex: idx, roleId: role.id, round: repairRound, envelope: res.envelope });
    if (res.envelope.verdict === "blocked") {
      return { status: "blocked", steps, finalEnvelope: res.envelope, reason: res.envelope.summary };
    }
    if (res.envelope.verdict === "rejected") {
      if (idx === 0) {
        return {
          status: "blocked", steps, finalEnvelope: res.envelope,
          reason: res.envelope.feedbackForUpstream ?? res.envelope.summary,
        };
      }
      const signature = (res.envelope.feedbackForUpstream ?? res.envelope.summary)
        .trim().toLowerCase().replace(/\s+/g, " ");
      if (lastRejectionSig !== null && signature === lastRejectionSig) {
        return {
          status: "stagnated", steps, finalEnvelope: res.envelope,
          reason: "Identical rejection feedback repeated without progress.",
        };
      }
      lastRejectionSig = signature;
      if (repairRound >= maxRepairRounds) {
        return {
          status: "rejected_max_rounds", steps, finalEnvelope: res.envelope,
          reason: `Exceeded maxRepairRounds (${maxRepairRounds}).`,
        };
      }
      repairRound += 1; upstream = res.envelope; idx = 0; continue;
    }
    upstream = res.envelope; idx += 1;
  }
  return { status: "completed", steps, finalEnvelope: upstream };
}
