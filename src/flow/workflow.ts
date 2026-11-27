import type { FlowGraphSpec, FlowMachineState, FlowNodeRuntime, FlowNodeSpec, GraphValidationResult, RoleWorkflowSpec } from "../core/graph-types.ts";
import { applyPhasePermissions, narrowRolePermissions, narrowRoleTools } from "../core/scope.ts";
import type { RoleSpec } from "../core/types.ts";
import { formatNodeBrief } from "./board.ts";
import { normalizePolicies } from "./graph-presets.ts";

export interface CompiledRoleWorkflow {
  spec: FlowGraphSpec; validation?: GraphValidationResult;
  phaseRoles: Map<string, RoleSpec>; lockedProtectedByPhase: Record<string, string[]>;
}

export function resolveWorkflowRepairEntry(workflow: RoleWorkflowSpec): string {
  if (workflow.repairEntry && workflow.phases.some((p) => p.id === workflow.repairEntry)) return workflow.repairEntry;
  const rolePhases = workflow.phases.filter((p) => (p.kind ?? "role") === "role");
  return rolePhases.at(-1)?.id ?? workflow.phases[0]!.id;
}

function expandSingleRoleNode(
  outerNode: FlowNodeSpec, baseRole: RoleSpec, outerGoal: string,
): { nodes: FlowNodeSpec[]; exitIds: string[]; repairEntryId: string; lockedById: Record<string, string[]>; phaseRoles: Map<string, RoleSpec> } {
  const wf = baseRole.workflow!;
  const toolCheck = narrowRoleTools(baseRole, outerNode.tools);
  if (!toolCheck.ok) throw new Error(`Node "${outerNode.id}": ${toolCheck.reason}`);
  const baseCheck = narrowRolePermissions(toolCheck.role, outerNode.writableScope);
  if (!baseCheck.ok) throw new Error(`Node "${outerNode.id}": ${baseCheck.reason}`);
  const scopedBase = baseCheck.role;

  const flatId = (phId: string): string => `${outerNode.id}__${phId}`;
  const finalRolePhaseId = wf.phases.filter((p) => (p.kind ?? "role") === "role").map((p) => p.id).at(-1);
  const exitAlias = new Map<string, string>(), referencedByInner = new Set<string>();
  const phaseRoles = new Map<string, RoleSpec>(), lockedById: Record<string, string[]> = {}, nodes: FlowNodeSpec[] = [];
  const outerBriefText = outerNode.brief ? formatNodeBrief(outerNode.brief, outerGoal) : undefined;
  let cumulativeLocks: string[] = [], lastRoleFlatId: string | undefined;

  for (let i = 0; i < wf.phases.length; i++) {
    const ph = wf.phases[i]!;
    const rawDeps = ph.dependsOn ?? (i === 0 ? [] : [wf.phases[i - 1]!.id]);
    for (const d of rawDeps) referencedByInner.add(d);
    const deps = rawDeps.length > 0 ? rawDeps.map((d) => exitAlias.get(d) ?? flatId(d)) : [...outerNode.dependsOn];
    const id = flatId(ph.id), kind = ph.kind ?? "role";

    if (kind === "human") {
      nodes.push({
        id, title: ph.title ?? ph.id, kind: "human", dependsOn: deps, parentGroupId: outerNode.id,
        human: { prompt: ph.prompt ?? ph.brief ?? ph.title ?? `请确认阶段 ${ph.id} 后继续。` },
      });
      exitAlias.set(ph.id, id);
      continue;
    }
    if (kind === "gate") {
      nodes.push({
        id, title: ph.title ?? `Gate: ${ph.exitGate!.command}`, kind: "gate", dependsOn: deps, parentGroupId: outerNode.id,
        ...(lastRoleFlatId ? { repairTargetNodeId: lastRoleFlatId } : {}), localRepairBudget: wf.maxRepairRounds ?? 3,
        gate: {
          command: ph.exitGate!.command,
          ...(ph.exitGate!.timeoutSec ? { timeoutSec: ph.exitGate!.timeoutSec } : {}),
          ...(ph.exitGate!.expectExitCode !== undefined ? { expectExitCode: ph.exitGate!.expectExitCode } : {}),
          ...(ph.exitGate!.parseJsonMetricsPath ? { parseJsonMetricsPath: ph.exitGate!.parseJsonMetricsPath } : {}),
          ...(lastRoleFlatId ? { repairTargetNodeId: lastRoleFlatId } : {}),
        },
      });
      exitAlias.set(ph.id, id);
      continue;
    }

    const isFinal = ph.id === finalRolePhaseId;
    const applied = applyPhasePermissions(scopedBase, ph, cumulativeLocks, isFinal);
    if (!applied.ok) throw new Error(`Node "${outerNode.id}": ${applied.reason}`);
    cumulativeLocks = applied.nextCumulativeProtected;
    lockedById[id] = [...cumulativeLocks];
    phaseRoles.set(id, { ...applied.role, id: `${baseRole.id}__${ph.id}`, name: ph.title ?? `${baseRole.name} · ${ph.id}` });
    lastRoleFlatId = id;

    const lockHint = cumulativeLocks.length > 0 ? `Locked read-only paths (DO NOT modify): ${cumulativeLocks.join(", ")}` : undefined;
    const phaseBrief = [
      ...(outerBriefText ? [`[Task Assignment]\n${outerBriefText}`] : []),
      `[Phase ${i + 1}/${wf.phases.length}: ${ph.id}${ph.title ? ` — ${ph.title}` : ""}]`,
      ph.brief ?? `Complete phase "${ph.id}" toward goal: ${outerGoal}`,
      ...(lockHint ? [lockHint] : []),
    ].join("\n");

    const sessionMode = wf.session ?? "reuse";
    const effWritable = ph.writable !== undefined ? [...ph.writable] : outerNode.writableScope ? [...outerNode.writableScope] : undefined;
    const effTools = ph.tools ? [...ph.tools] : outerNode.tools ? [...outerNode.tools] : undefined;
    nodes.push({
      id, title: ph.title ?? `${outerNode.title ?? baseRole.name} · ${ph.id}`, kind: "role", role: baseRole.id,
      dependsOn: deps, parentGroupId: outerNode.id, brief: phaseBrief,
      ...(outerNode.workspace ? { workspace: outerNode.workspace } : {}),
      ...(outerNode.workspace === "worktree" ? { worktreeGroup: outerNode.id } : {}),
      sessionMode, ...(sessionMode === "reuse" ? { sessionGroup: outerNode.id } : {}),
      ...(outerNode.tools ? { tools: [...outerNode.tools] } : {}),
      ...(effTools ? { phaseTools: effTools } : {}),
      ...(effWritable ? { writableScope: effWritable } : {}),
      ...(cumulativeLocks.length > 0 ? { lockedProtected: [...cumulativeLocks] } : {}),
      ...(ph.exitArtifacts?.length ? { requiredArtifacts: [...ph.exitArtifacts] } : {}),
      isWorkflowPhase: true, ...(isFinal ? { isFinalWorkflowPhase: true } : {}),
      ...(ph.maxAttempts !== undefined ? { maxAttempts: ph.maxAttempts } : outerNode.maxAttempts !== undefined ? { maxAttempts: outerNode.maxAttempts } : {}),
      ...(ph.fallbackModels ? { fallbackModels: [...ph.fallbackModels] } : outerNode.fallbackModels ? { fallbackModels: [...outerNode.fallbackModels] } : {}),
    });

    if (ph.exitGate) {
      const gateId = `${id}__gate`;
      nodes.push({
        id: gateId, title: `Gate (${ph.id}): ${ph.exitGate.command}`, kind: "gate", dependsOn: [id],
        parentGroupId: outerNode.id, repairTargetNodeId: id, localRepairBudget: wf.maxRepairRounds ?? 3,
        gate: {
          command: ph.exitGate.command,
          ...(ph.exitGate.timeoutSec ? { timeoutSec: ph.exitGate.timeoutSec } : {}),
          ...(ph.exitGate.expectExitCode !== undefined ? { expectExitCode: ph.exitGate.expectExitCode } : {}),
          ...(ph.exitGate.parseJsonMetricsPath ? { parseJsonMetricsPath: ph.exitGate.parseJsonMetricsPath } : {}),
          repairTargetNodeId: id,
        },
      });
      exitAlias.set(ph.id, gateId);
    } else exitAlias.set(ph.id, id);
  }

  const terminalPhases = wf.phases.filter((p) => !referencedByInner.has(p.id));
  const exitIds = (terminalPhases.length > 0 ? terminalPhases : [wf.phases.at(-1)!]).map((p) => exitAlias.get(p.id) ?? flatId(p.id));
  return { nodes, exitIds, repairEntryId: flatId(resolveWorkflowRepairEntry(wf)), lockedById, phaseRoles };
}

export function expandGraphRoleWorkflows(spec: FlowGraphSpec, roles: ReadonlyMap<string, RoleSpec>): FlowGraphSpec {
  const needsExpansion = spec.nodes.some((n) => n.kind === "role" && !n.isWorkflowPhase && Boolean(n.role && roles.get(n.role)?.workflow?.phases?.length));
  if (!needsExpansion) return spec;

  const exitIdsByOrig = new Map<string, string[]>(), repairEntryByOrig = new Map<string, string>(), expandedNodes: FlowNodeSpec[] = [];
  for (const node of spec.nodes) {
    const baseRole = node.kind === "role" && !node.isWorkflowPhase && node.role ? roles.get(node.role) : undefined;
    if (!baseRole?.workflow?.phases?.length) { expandedNodes.push({ ...node, dependsOn: [...node.dependsOn] }); continue; }
    const exp = expandSingleRoleNode(node, baseRole, spec.goal);
    exitIdsByOrig.set(node.id, exp.exitIds); repairEntryByOrig.set(node.id, exp.repairEntryId); expandedNodes.push(...exp.nodes);
  }
  const mapDeps = (ids: readonly string[]): string[] => [...new Set(ids.flatMap((d) => exitIdsByOrig.get(d) ?? [d]))];
  const rewiredNodes: FlowNodeSpec[] = expandedNodes.map((n) => {
    const nextRepair = n.repairTargetNodeId ? (repairEntryByOrig.get(n.repairTargetNodeId) ?? n.repairTargetNodeId) : undefined;
    const nextGate = n.gate ? { ...n.gate, ...(n.gate.repairTargetNodeId ? { repairTargetNodeId: repairEntryByOrig.get(n.gate.repairTargetNodeId) ?? n.gate.repairTargetNodeId } : {}) } : undefined;
    const nextMerge = n.merge ? { ...n.merge, sourceNodeIds: mapDeps(n.merge.sourceNodeIds) } : undefined;
    return { ...n, dependsOn: mapDeps(n.dependsOn), ...(nextRepair ? { repairTargetNodeId: nextRepair } : {}), ...(nextGate ? { gate: nextGate } : {}), ...(nextMerge ? { merge: nextMerge } : {}) };
  });
  return { ...spec, nodes: rewiredNodes };
}

export function migrateLegacySubStateMachine(state: FlowMachineState, roles: ReadonlyMap<string, RoleSpec>): FlowMachineState {
  const roleOf = (id?: string) => (id ? (state.roleSnapshots?.[id] ?? roles.get(id)) : undefined);
  const needsMigration = state.spec.nodes.some((n) => {
    const rt = state.nodes[n.id] as (FlowNodeRuntime & { subState?: FlowMachineState | null }) | undefined;
    return Boolean(rt?.subState) || (n.kind === "role" && !n.isWorkflowPhase && Boolean(roleOf(n.role)?.workflow?.phases?.length));
  });
  if (!needsMigration) return state;

  const exitIdsByOrig = new Map<string, string[]>(), repairEntryByOrig = new Map<string, string>();
  const nextSpecs: FlowNodeSpec[] = [], nextNodes: Record<string, FlowNodeRuntime> = {};
  for (const node of state.spec.nodes) {
    const oldRt = state.nodes[node.id] as (FlowNodeRuntime & { subState?: FlowMachineState | null }) | undefined;
    const baseRole = node.kind === "role" && !node.isWorkflowPhase ? roleOf(node.role) : undefined;
    if (!baseRole?.workflow?.phases?.length || !oldRt) {
      nextSpecs.push({ ...node, dependsOn: [...node.dependsOn] });
      if (oldRt) { const { subState: _s, ...clean } = oldRt; nextNodes[node.id] = { ...clean, triedModels: [...clean.triedModels], questionsForUser: [...clean.questionsForUser] }; }
      continue;
    }
    const exp = expandSingleRoleNode(node, baseRole, state.spec.goal);
    exitIdsByOrig.set(node.id, exp.exitIds); repairEntryByOrig.set(node.id, exp.repairEntryId);
    const sub = oldRt.subState ?? null;
    for (const expNode of exp.nodes) {
      nextSpecs.push(expNode);
      const innerId = expNode.id.slice(node.id.length + 2);
      const subRt = sub?.nodes?.[innerId];
      const fallbackStatus = oldRt.status === "succeeded" || oldRt.status === "skipped" ? oldRt.status : "pending";
      nextNodes[expNode.id] = {
        nodeId: expNode.id, status: subRt?.status ?? fallbackStatus, waveIndex: 0,
        effectiveWorkspace: oldRt.effectiveWorkspace, sessionResidency: subRt?.sessionResidency ?? "none",
        attempt: subRt?.attempt ?? 0, repairRound: subRt?.repairRound ?? 0,
        activeStageId: subRt?.activeStageId ?? null, worktreePath: oldRt.worktreePath,
        commitRef: oldRt.commitRef, ...(oldRt.commitSha ? { commitSha: oldRt.commitSha } : {}),
        currentModel: subRt?.currentModel ?? oldRt.currentModel, triedModels: [...(subRt?.triedModels ?? [])],
        lastHandoffId: subRt?.lastHandoffId ?? null, lastHandoff: subRt?.lastHandoff ?? null,
        lastGateEvidence: subRt?.lastGateEvidence ?? null, lastError: subRt?.lastError ?? null,
        lastRepairFeedback: subRt?.lastRepairFeedback ?? null,
        ...(subRt?.lastReply ? { lastReply: subRt.lastReply } : {}),
        ...(expNode.kind === "human" ? { questionPrompt: expNode.human?.prompt ?? null } : {}),
        questionsForUser: subRt?.questionsForUser?.length ? [...subRt.questionsForUser] : (subRt?.status === "waiting_input" && expNode.human?.prompt ? [expNode.human.prompt] : []),
        startedAt: subRt?.startedAt ?? null, endedAt: subRt?.endedAt ?? null,
      };
    }
  }
  const mapDeps = (ids: readonly string[]): string[] => [...new Set(ids.flatMap((d) => exitIdsByOrig.get(d) ?? [d]))];
  const rewired = nextSpecs.map((n) => ({
    ...n, dependsOn: mapDeps(n.dependsOn),
    ...(n.repairTargetNodeId ? { repairTargetNodeId: repairEntryByOrig.get(n.repairTargetNodeId) ?? n.repairTargetNodeId } : {}),
    ...(n.gate ? { gate: { ...n.gate, ...(n.gate.repairTargetNodeId ? { repairTargetNodeId: repairEntryByOrig.get(n.gate.repairTargetNodeId) ?? n.gate.repairTargetNodeId } : {}) } } : {}),
    ...(n.merge ? { merge: { ...n.merge, sourceNodeIds: mapDeps(n.merge.sourceNodeIds) } } : {}),
  }));
  const waveById: Record<string, number> = {};
  const byId = new Map(rewired.map((n) => [n.id, n]));
  const computeWave = (id: string, seen = new Set<string>()): number => {
    if (waveById[id] !== undefined) return waveById[id]!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = byId.get(id)?.dependsOn ?? [];
    const w = deps.length === 0 ? 0 : Math.max(...deps.map((d) => computeWave(d, seen) + 1));
    waveById[id] = w;
    return w;
  };
  const waves: string[][] = [];
  for (const n of rewired) {
    const w = computeWave(n.id);
    if (nextNodes[n.id]) nextNodes[n.id]!.waveIndex = w;
    while (waves.length <= w) waves.push([]);
    waves[w]!.push(n.id);
  }
  return { ...state, spec: { ...state.spec, nodes: rewired }, nodes: nextNodes, nodeOrder: rewired.map((n) => n.id), waves };
}

export function resolveLegacyTargetNodeId(state: FlowMachineState, rawTargetId?: string): string | undefined {
  if (!rawTargetId || state.nodes[rawTargetId]) return rawTargetId;
  const waitingInGroup = state.spec.nodes.filter((n) => n.parentGroupId === rawTargetId && state.nodes[n.id]?.status === "waiting_input");
  return waitingInGroup.length === 1 ? waitingInGroup[0]!.id : rawTargetId;
}

export function compileRoleWorkflow(input: { role: RoleSpec; outerGoal: string; outerWritableScope?: readonly string[] }): CompiledRoleWorkflow {
  const wf = input.role.workflow;
  if (!wf || wf.phases.length === 0) throw new Error(`Role "${input.role.id}" does not define a workflow.`);
  const exp = expandSingleRoleNode(
    { id: input.role.id, title: input.role.name, kind: "role", role: input.role.id, dependsOn: [], ...(input.outerWritableScope ? { writableScope: [...input.outerWritableScope] } : {}) },
    input.role, input.outerGoal,
  );
  const spec: FlowGraphSpec = {
    version: 1, goal: input.outerGoal, preset: "custom", nodes: exp.nodes,
    policies: normalizePolicies({ maxConcurrency: 1, maxRepairRounds: wf.maxRepairRounds ?? 3, workspaceStrategy: "inherit_only", pauseOnWaitingInput: "whole_flow", enableSessionReuse: (wf.session ?? "reuse") === "reuse" }),
  };
  return { spec, phaseRoles: exp.phaseRoles, lockedProtectedByPhase: exp.lockedById };
}
