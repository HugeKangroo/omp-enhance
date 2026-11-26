import { randomUUID } from "node:crypto";
import type {
  FlowEvent,
  FlowGraphSpec,
  FlowMachineState,
  FlowNodeSpec,
  GraphValidationResult,
  RoleWorkflowSpec,
} from "../core/graph-types.ts";
import { applyPhasePermissions, narrowRolePermissions } from "../core/scope.ts";
import type { FlowRunResult, HandoffEnvelope, Mandate, RoleSpec } from "../core/types.ts";
import { computeDescendantMap, normalizePolicies, validateFlowGraph } from "./graph.ts";
import { cloneState } from "./machine-helpers.ts";

export interface CompiledRoleWorkflow {
  spec: FlowGraphSpec;
  validation: GraphValidationResult;
  phaseRoles: Map<string, RoleSpec>;
  lockedProtectedByPhase: Record<string, string[]>;
}

export function compileRoleWorkflow(input: {
  role: RoleSpec;
  outerGoal: string;
  outerWritableScope?: readonly string[];
}): CompiledRoleWorkflow {
  const workflow = input.role.workflow;
  if (!workflow || workflow.phases.length === 0) {
    throw new Error(`Role "${input.role.id}" does not define a workflow.`);
  }
  const baseCheck = narrowRolePermissions(input.role, input.outerWritableScope);
  if (!baseCheck.ok) throw new Error(baseCheck.reason);
  const baseRole = baseCheck.role;

  const phaseRoles = new Map<string, RoleSpec>();
  const lockedProtectedByPhase: Record<string, string[]> = {};
  const exitAlias = new Map<string, string>();
  const rolePhaseIds = workflow.phases.filter((p) => (p.kind ?? "role") === "role").map((p) => p.id);
  const finalRolePhaseId = rolePhaseIds.at(-1);

  const nodes: FlowNodeSpec[] = [];
  let cumulativeLocks: string[] = [];
  let lastRoleNodeId: string | undefined;

  for (let i = 0; i < workflow.phases.length; i++) {
    const ph = workflow.phases[i]!;
    const rawDeps = ph.dependsOn ?? (i === 0 ? [] : [workflow.phases[i - 1]!.id]);
    const deps = rawDeps.map((d) => exitAlias.get(d) ?? d);
    const kind = ph.kind ?? "role";

    if (kind === "human") {
      nodes.push({
        id: ph.id,
        title: ph.title ?? ph.id,
        kind: "human",
        dependsOn: deps,
        human: { prompt: ph.prompt ?? ph.brief ?? ph.title ?? `请确认阶段 ${ph.id} 后继续。` },
      });
      exitAlias.set(ph.id, ph.id);
      continue;
    }

    if (kind === "gate") {
      nodes.push({
        id: ph.id,
        title: ph.title ?? `Gate: ${ph.exitGate!.command}`,
        kind: "gate",
        dependsOn: deps,
        ...(lastRoleNodeId ? { repairTargetNodeId: lastRoleNodeId } : {}),
        gate: {
          command: ph.exitGate!.command,
          ...(ph.exitGate!.timeoutSec ? { timeoutSec: ph.exitGate!.timeoutSec } : {}),
          ...(ph.exitGate!.expectExitCode !== undefined ? { expectExitCode: ph.exitGate!.expectExitCode } : {}),
          ...(ph.exitGate!.parseJsonMetricsPath ? { parseJsonMetricsPath: ph.exitGate!.parseJsonMetricsPath } : {}),
          ...(lastRoleNodeId ? { repairTargetNodeId: lastRoleNodeId } : {}),
        },
      });
      exitAlias.set(ph.id, ph.id);
      continue;
    }

    const applied = applyPhasePermissions(baseRole, ph, cumulativeLocks, ph.id === finalRolePhaseId);
    if (!applied.ok) throw new Error(applied.reason);
    cumulativeLocks = applied.nextCumulativeProtected;
    lockedProtectedByPhase[ph.id] = [...cumulativeLocks];

    const syntheticRoleId = `${input.role.id}__${ph.id}`;
    phaseRoles.set(syntheticRoleId, { ...applied.role, id: syntheticRoleId, name: ph.title ?? `${input.role.name} · ${ph.id}` });
    lastRoleNodeId = ph.id;

    const lockHint = cumulativeLocks.length > 0 ? `Locked read-only paths (DO NOT modify): ${cumulativeLocks.join(", ")}` : undefined;
    const phaseBrief = [
      `[Phase ${i + 1}/${workflow.phases.length}: ${ph.id}${ph.title ? ` — ${ph.title}` : ""}]`,
      ph.brief ?? `Complete phase "${ph.id}" toward goal: ${input.outerGoal}`,
      ...(lockHint ? [lockHint] : []),
    ].join("\n");

    nodes.push({
      id: ph.id,
      title: ph.title ?? ph.id,
      kind: "role",
      role: syntheticRoleId,
      dependsOn: deps,
      workspace: "inherit",
      sessionMode: workflow.session ?? "reuse",
      brief: phaseBrief,
      ...(ph.maxAttempts !== undefined ? { maxAttempts: ph.maxAttempts } : {}),
      ...(ph.fallbackModels ? { fallbackModels: [...ph.fallbackModels] } : {}),
    });

    if (ph.exitGate) {
      const gateId = `${ph.id}__gate`;
      nodes.push({
        id: gateId,
        title: `Gate (${ph.id}): ${ph.exitGate.command}`,
        kind: "gate",
        dependsOn: [ph.id],
        repairTargetNodeId: ph.id,
        gate: {
          command: ph.exitGate.command,
          ...(ph.exitGate.timeoutSec ? { timeoutSec: ph.exitGate.timeoutSec } : {}),
          ...(ph.exitGate.expectExitCode !== undefined ? { expectExitCode: ph.exitGate.expectExitCode } : {}),
          ...(ph.exitGate.parseJsonMetricsPath ? { parseJsonMetricsPath: ph.exitGate.parseJsonMetricsPath } : {}),
          repairTargetNodeId: ph.id,
        },
      });
      exitAlias.set(ph.id, gateId);
    } else {
      exitAlias.set(ph.id, ph.id);
    }
  }

  const spec: FlowGraphSpec = {
    version: 1,
    goal: input.outerGoal,
    preset: "custom",
    nodes,
    policies: normalizePolicies({
      maxConcurrency: 1,
      maxRepairRounds: workflow.maxRepairRounds ?? 3,
      workspaceStrategy: "inherit_only",
      pauseOnWaitingInput: "whole_flow",
      enableSessionReuse: (workflow.session ?? "reuse") === "reuse",
    }),
  };
  const validation = validateFlowGraph({ spec, roles: phaseRoles, isGitRepo: false });
  if (!validation.ok) {
    throw new Error(`Invalid compiled workflow for role "${input.role.id}": ${validation.issues.map((x) => x.message).join(" | ")}`);
  }
  return { spec: validation.normalizedSpec ?? spec, validation, phaseRoles, lockedProtectedByPhase };
}

export function resolveWorkflowRepairEntry(workflow: RoleWorkflowSpec): string {
  if (workflow.repairEntry && workflow.phases.some((p) => p.id === workflow.repairEntry)) {
    return workflow.repairEntry;
  }
  const rolePhases = workflow.phases.filter((p) => (p.kind ?? "role") === "role");
  return rolePhases.at(-1)?.id ?? workflow.phases[0]!.id;
}

export function prepareOuterRepairReentry(
  prevSubState: FlowMachineState,
  workflow: RoleWorkflowSpec,
  feedback: string,
): FlowMachineState {
  const next = cloneState(prevSubState);
  const entryId = resolveWorkflowRepairEntry(workflow);
  const descMap = computeDescendantMap(next.spec.nodes);
  const dirty = new Set<string>([entryId, ...(descMap.get(entryId) ?? [])]);

  next.status = "interrupted";
  next.endedAt = null;
  next.reason = undefined;
  next.repairRound = 0;
  next.lastRejectionSig = null;

  for (const id of dirty) {
    const rt = next.nodes[id];
    if (!rt) continue;
    rt.status = id === entryId ? "failed" : "pending";
    rt.activeStageId = null;
    rt.endedAt = null;
    rt.lastError = null;
    rt.questionsForUser = [];
    rt.lastRepairFeedback = id === entryId ? feedback : null;
  }
  return next;
}

export function buildOuterEventFromSubResult(input: {
  nodeId: string;
  baseRole: RoleSpec;
  mandate: Mandate;
  upstreamHandoff: HandoffEnvelope | null;
  subRes: FlowRunResult & { finalState: FlowMachineState };
  sessionWarm: boolean;
  commitRef: string | null;
}): FlowEvent {
  const { nodeId, baseRole, mandate, upstreamHandoff, subRes, sessionWarm, commitRef } = input;
  const env: HandoffEnvelope = subRes.finalEnvelope ?? {
    id: `ho-wf-${randomUUID()}`,
    mandateId: mandate.id,
    mandateRev: mandate.rev,
    parentHandoffId: upstreamHandoff?.id ?? null,
    fromRole: baseRole.id,
    toTarget: "user",
    verdict: subRes.status === "completed" ? "ready" : subRes.status === "waiting_input" ? "needs_input" : "blocked",
    summary: subRes.reason ?? `${baseRole.id} workflow ${subRes.status}`,
    artifacts: [],
    verifiedFacts: [],
    openRisks: [],
    feedbackForUpstream: null,
    observedUsage: null,
    createdAt: new Date().toISOString(),
  };
  if (subRes.status === "completed") return { type: "NODE_SUCCEEDED", nodeId, handoff: env, sessionWarm, commitRef };
  if (subRes.status === "waiting_input") {
    const subQs = Object.values(subRes.finalState.nodes).flatMap((n) => n.questionsForUser);
    return { type: "NODE_NEEDS_INPUT", nodeId, handoff: env, questions: subQs.length ? subQs : [subRes.reason ?? env.summary], sessionWarm };
  }
  if (subRes.status === "violation") return { type: "NODE_VIOLATION", nodeId, violations: [], reason: subRes.reason ?? "Inner workflow boundary violation." };
  if (subRes.status === "cancelled") return { type: "FLOW_CANCEL", reason: subRes.reason };
  if (subRes.status === "aborted_by_supervisor") return { type: "NODE_ABORTED_BY_SUPERVISOR", nodeId, reason: subRes.reason ?? "Aborted by supervisor." };
  if (subRes.status === "failed") return { type: "NODE_HOST_ERROR", nodeId, error: subRes.reason ?? "Inner workflow failed.", retryable: false };
  return { type: "NODE_BLOCKED", nodeId, handoff: env, reason: subRes.reason ?? env.summary };
}
