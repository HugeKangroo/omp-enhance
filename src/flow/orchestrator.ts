import {
  findBoundaryViolations, findProtectedViolations, snapshotConfigIntegrity, snapshotWorkspace,
  type SnapshotEntry,
} from "../core/fs.ts";
import { isRoleReadOnly } from "../core/policy.ts";
import type { EnhanceStore } from "../core/store.ts";
import type {
  EpistemicItem, FlowRunResult, FlowStepResult, FlowUserSteer, HandoffEnvelope, Mandate,
  ObservedToolCall, RoleSpec, SupervisorDecision, SupervisorPulse, UsageSummary,
} from "../core/types.ts";
import { renderConditioningBlock } from "../roles/conditioning.ts";
import type { ActiveStageControls, FlowObserver } from "./state.ts";

export type { ActiveStageControls, FlowObserver } from "./state.ts";

export interface SupervisorInspectorLike {
  evaluatePulse(pulse: SupervisorPulse, supervisorRole: RoleSpec): Promise<SupervisorDecision>;
}
export interface RoleSupervisorConfig {
  role: RoleSpec; inspector: SupervisorInspectorLike;
  initialDelayMs?: number; minIntervalMs?: number; maxIntervalMs?: number;
}
export interface RoleStepContext {
  cwd: string; store: EnhanceStore; role: RoleSpec; mandate: Mandate;
  epistemicItems: readonly EpistemicItem[]; upstreamHandoff: HandoffEnvelope | null;
  userSteers?: readonly FlowUserSteer[]; toTarget: string; repairTargetRoleId?: string;
  flowId?: string | null; conditioningPrompt: string; taskPrompt: string;
  stageId?: string; round?: number; observer?: FlowObserver; supervisor?: RoleSupervisorConfig;
  signal?: AbortSignal;
  beforeSnapshot?: ReadonlyMap<string, SnapshotEntry>;
  beforeConfigSnapshot?: ReadonlyMap<string, SnapshotEntry>;
}
export interface RoleTurnOutcome {
  envelope: HandoffEnvelope | null; observedCalls: ObservedToolCall[];
  assistantText: string; usage: UsageSummary | null;
  abortedBySupervisor?: SupervisorDecision | null;
  cancelledByUser?: boolean;
  boundaryViolations?: string[];
}
export interface RoleSessionRunner {
  runRoleTurn(ctx: RoleStepContext): Promise<RoleTurnOutcome>;
}
export interface ExecuteRoleStepInput {
  cwd: string; store: EnhanceStore; role: RoleSpec; mandate: Mandate;
  upstreamHandoff: HandoffEnvelope | null; userSteers?: readonly FlowUserSteer[];
  toTarget: string; repairTargetRoleId?: string; flowId?: string | null;
  runner: RoleSessionRunner; stageId?: string; round?: number; modelLabel?: string;
  observer?: FlowObserver; supervisor?: RoleSupervisorConfig; signal?: AbortSignal;
}
export type ExecuteRoleStepResult =
  | { ok: true; envelope: HandoffEnvelope }
  | { ok: false; status: "violation"; violations: string[]; reason: string }
  | { ok: false; status: "missing_handoff"; reason: string }
  | { ok: false; status: "aborted_by_supervisor"; reason: string; decision: SupervisorDecision }
  | { ok: false; status: "cancelled"; reason: string };

function taskPromptFor(input: {
  role: RoleSpec; mandate: Mandate; upstreamHandoff: HandoffEnvelope | null; userSteers: readonly FlowUserSteer[];
}): string {
  const h = input.upstreamHandoff;
  const upstream = h ? `${h.fromRole} -> ${h.toTarget} [${h.verdict}]: ${h.summary}` : "(none)";
  const extra: string[] = [];
  if (h?.verifiedFacts?.length) extra.push(`Upstream verifiedFacts: ${h.verifiedFacts.map((f) => `${f.claim} [${f.evidenceRef}]`).join("; ")}`);
  if (h?.deletedFiles?.length) extra.push(`Upstream deletedFiles: ${h.deletedFiles.join(", ")}`);
  const steers = input.userSteers.filter((s) => !s.targetRole || s.targetRole === input.role.id);
  if (steers.length > 0) {
    extra.push(`User interjections: ${steers.map((s) => (s.targetRole ? `[@${s.targetRole}] ${s.text}` : s.text)).join(" | ")}`);
  }
  return [
    `Role: ${input.role.id} (${input.role.name})`, `Mandate goal: ${input.mandate.goal}`, `Upstream handoff: ${upstream}`,
    ...extra, "Work strictly inside your role conditioning and permitted tools.",
    "When finished, call enhance_handoff exactly once with verdict, summary, artifactPaths, openRisks,",
    "and feedbackForUpstream when the verdict is rejected. Do not claim work you did not execute.",
  ].join("\n");
}

export function resolveRepairTargetIndex(roles: readonly RoleSpec[]): number {
  const firstWritable = roles.findIndex((role) => !isRoleReadOnly(role));
  return firstWritable >= 0 ? firstWritable : 0;
}

export async function executeRoleStep(input: ExecuteRoleStepInput): Promise<ExecuteRoleStepResult> {
  if (input.signal?.aborted || input.observer?.isCancelled?.()) {
    return { ok: false, status: "cancelled", reason: "Cancelled by user." };
  }
  const stageId = input.stageId ?? `${input.role.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const before = snapshotWorkspace(input.cwd), beforeIntegrity = snapshotConfigIntegrity(input.cwd);
  const epistemicItems = input.store.listEpistemicItems(input.mandate.id);
  const userSteers = input.userSteers ?? input.observer?.getUserSteers?.() ?? [];
  const conditioningPrompt = renderConditioningBlock({
    role: input.role, mandate: input.mandate, epistemicItems, upstreamHandoff: input.upstreamHandoff, userSteers,
  });

  input.observer?.onStageStart?.({
    stageId, role: input.role, round: input.round ?? 0, toTarget: input.toTarget,
    modelLabel: input.modelLabel ?? input.role.model ?? "default",
  });

  const outcome = await input.runner.runRoleTurn({
    cwd: input.cwd, store: input.store, role: input.role, mandate: input.mandate, epistemicItems,
    upstreamHandoff: input.upstreamHandoff, userSteers, toTarget: input.toTarget,
    ...(input.repairTargetRoleId ? { repairTargetRoleId: input.repairTargetRoleId } : {}),
    ...(input.flowId ? { flowId: input.flowId } : {}),
    conditioningPrompt, taskPrompt: taskPromptFor({ role: input.role, mandate: input.mandate, upstreamHandoff: input.upstreamHandoff, userSteers }),
    stageId, round: input.round, observer: input.observer, beforeSnapshot: before, beforeConfigSnapshot: beforeIntegrity,
    ...(input.supervisor ? { supervisor: input.supervisor } : {}), ...(input.signal ? { signal: input.signal } : {}),
  });

  if (outcome.cancelledByUser || input.signal?.aborted || input.observer?.isCancelled?.()) {
    input.observer?.onStageEnd?.(stageId, { status: "aborted", outcome, reason: "Cancelled by user." });
    return { ok: false, status: "cancelled", reason: "Cancelled by user." };
  }
  if (outcome.abortedBySupervisor && !outcome.envelope) {
    input.observer?.onStageEnd?.(stageId, { status: "aborted", outcome, reason: outcome.abortedBySupervisor.reason });
    return { ok: false, status: "aborted_by_supervisor", reason: outcome.abortedBySupervisor.reason, decision: outcome.abortedBySupervisor };
  }

  const after = snapshotWorkspace(input.cwd);
  const boundaryViolations = findBoundaryViolations({ cwd: input.cwd, before, after, permissions: input.role.permissions, beforeIntegrity });
  const allViolations = [...new Set([...(outcome.boundaryViolations ?? []), ...boundaryViolations])].sort();
  if (allViolations.length > 0) {
    const protHits = findProtectedViolations(input.cwd, before, input.role.permissions.protected ?? [], after);
    const label = protHits.length > 0 ? "modified protected paths" : "violated workspace boundaries";
    const reason = `Role "${input.role.id}" ${label}: ${allViolations.join(", ")}`;
    input.observer?.onStageEnd?.(stageId, { status: "violation", outcome, reason });
    return { ok: false, status: "violation", violations: allViolations, reason };
  }
  if (!outcome.envelope) {
    const reason = `Role "${input.role.id}" finished without submitting enhance_handoff.`;
    input.observer?.onStageEnd?.(stageId, { status: "violation", outcome, reason });
    return { ok: false, status: "missing_handoff", reason };
  }
  if (outcome.usage && !outcome.envelope.observedUsage) {
    outcome.envelope = { ...outcome.envelope, observedUsage: outcome.usage };
    if (input.store.getHandoff(outcome.envelope.id)) input.store.saveHandoff(outcome.envelope);
  }
  input.observer?.onStageEnd?.(stageId, { status: outcome.envelope.verdict, outcome });
  return { ok: true, envelope: outcome.envelope };
}

export interface ExecuteRoleFlowInput {
  cwd: string; store: EnhanceStore; roles: readonly RoleSpec[]; mandate: Mandate;
  flowId?: string | null; initialHandoff?: HandoffEnvelope | null; userSteers?: readonly FlowUserSteer[];
  runner: RoleSessionRunner; maxRepairRounds?: number; startIndex?: number; initialRepairRound?: number;
  initialStageSeq?: number; initialLastRejectionSig?: string | null;
  supervisor?: RoleSupervisorConfig; observer?: FlowObserver; signal?: AbortSignal;
}

export async function executeRoleFlow(input: ExecuteRoleFlowInput): Promise<FlowRunResult> {
  if (input.roles.length < 1) throw new Error("executeRoleFlow requires at least one role.");
  const maxRepairRounds = input.maxRepairRounds ?? 2, steps: FlowStepResult[] = [];
  const repairTargetIdx = resolveRepairTargetIndex(input.roles), repairTargetRoleId = input.roles[repairTargetIdx]!.id;
  let repairRound = input.initialRepairRound ?? 0, lastRejectionSig: string | null = input.initialLastRejectionSig ?? null;
  let upstream = input.initialHandoff ?? null;
  let idx = Math.max(0, Math.min(input.startIndex ?? 0, input.roles.length - 1)), seq = input.initialStageSeq ?? 0;

  while (idx < input.roles.length) {
    input.observer?.onProgress?.({ currentIndex: idx, repairRound, lastHandoffId: upstream?.id ?? null, lastRejectionSig, nextStageSeq: seq });
    if (input.signal?.aborted || input.observer?.isCancelled?.()) {
      return { status: "cancelled", steps, finalEnvelope: upstream, reason: "Cancelled by user." };
    }
    const role = input.roles[idx]!;
    const toTarget = idx + 1 < input.roles.length ? input.roles[idx + 1]!.id : "user";
    seq += 1;
    const stageId = input.observer?.allocateStageId?.({ roleId: role.id, round: repairRound, stepIndex: idx }) ?? `step-${seq}-r${repairRound}-${idx}-${role.id}`;
    const effectiveRepairTarget = idx > repairTargetIdx ? repairTargetRoleId : "user";

    const res = await executeRoleStep({
      cwd: input.cwd, store: input.store, role, mandate: input.mandate, upstreamHandoff: upstream,
      ...(input.userSteers ? { userSteers: input.userSteers } : {}), runner: input.runner,
      toTarget, repairTargetRoleId: effectiveRepairTarget, ...(input.flowId ? { flowId: input.flowId } : {}),
      stageId, round: repairRound, observer: input.observer,
      ...(input.supervisor ? { supervisor: input.supervisor } : {}), ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!res.ok) {
      const status = res.status === "cancelled" ? "cancelled" : (res.status === "aborted_by_supervisor" ? "aborted_by_supervisor" : "violation");
      return { status, steps, finalEnvelope: upstream, reason: res.reason };
    }
    let env = res.envelope;
    if (env.verdict === "rejected" && env.toTarget !== effectiveRepairTarget) {
      env = { ...env, toTarget: effectiveRepairTarget };
      if (input.store.getHandoff(env.id)) input.store.saveHandoff(env);
    }
    steps.push({ stepIndex: idx, roleId: role.id, round: repairRound, envelope: env });
    if (env.verdict === "blocked") return { status: "blocked", steps, finalEnvelope: env, reason: env.summary };
    if (env.verdict === "rejected") {
      if (idx <= repairTargetIdx) {
        return { status: "blocked", steps, finalEnvelope: env, reason: env.feedbackForUpstream ?? env.summary };
      }
      const signature = (env.feedbackForUpstream ?? env.summary).trim().toLowerCase().replace(/\s+/g, " ");
      if (lastRejectionSig !== null && signature === lastRejectionSig) {
        return { status: "stagnated", steps, finalEnvelope: env, reason: "Identical rejection feedback repeated without progress." };
      }
      lastRejectionSig = signature;
      if (repairRound >= maxRepairRounds) {
        return { status: "rejected_max_rounds", steps, finalEnvelope: env, reason: `Exceeded maxRepairRounds (${maxRepairRounds}).` };
      }
      repairRound += 1; upstream = env; idx = repairTargetIdx;
      continue;
    }
    upstream = env; idx += 1;
    input.observer?.onProgress?.({ currentIndex: idx, repairRound, lastHandoffId: upstream?.id ?? null, lastRejectionSig, nextStageSeq: seq });
  }

  input.store.completeMandate(input.mandate.id);
  return { status: "completed", steps, finalEnvelope: upstream };
}
