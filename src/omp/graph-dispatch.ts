import type {
  FlowGraphPatch, FlowGraphSpec, FlowNodeSpec, FlowPolicies, GraphValidationResult,
} from "../core/graph-types.ts";
import { isInternalRole } from "../core/policy.ts";
import type { RoleSpec } from "../core/types.ts";
import {
  compileContractParallelVerify, compileExperimentLoop, compileFanOutJoin, compileLinearChain,
  normalizePolicies, validateFlowGraph, validateGraphPatch, type FanOutShardInput,
} from "../flow/graph.ts";
import { isGitRepo } from "../flow/worktree.ts";

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function asStrArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
  return out.length > 0 ? out : undefined;
}

export function parseNodeSpecs(rawNodes: unknown): FlowNodeSpec[] {
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) throw new Error("nodes must be a non-empty array.");
  return rawNodes.map((raw, idx) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid node at index ${idx}.`);
    const r = raw as Record<string, unknown>;
    const id = asStr(r.id);
    if (!id) throw new Error(`Node at index ${idx} requires a string id.`);
    const kind = (asStr(r.kind) ?? "role") as FlowNodeSpec["kind"];
    const dependsOn = Array.isArray(r.dependsOn) ? r.dependsOn.filter((d): d is string => typeof d === "string" && Boolean(d.trim())).map((d) => d.trim()) : [];
    const tools = asStrArr(r.tools);
    const writableScope = asStrArr(r.writableScope);
    const fallbackModels = asStrArr(r.fallbackModels);
    return {
      id,
      ...(asStr(r.title) ? { title: asStr(r.title) } : {}),
      kind,
      ...(asStr(r.role) ? { role: asStr(r.role) } : {}),
      dependsOn,
      ...(r.join === "any" || r.join === "all" ? { join: r.join } : {}),
      ...(r.brief !== undefined ? { brief: r.brief as FlowNodeSpec["brief"] } : {}),
      ...(tools ? { tools } : {}),
      ...(writableScope ? { writableScope } : {}),
      ...(r.workspace === "inherit" || r.workspace === "worktree" ? { workspace: r.workspace } : {}),
      ...(r.sessionMode === "fresh" || r.sessionMode === "reuse" || r.sessionMode === "fork" ? { sessionMode: r.sessionMode } : {}),
      ...(asStr(r.sessionGroup) ? { sessionGroup: asStr(r.sessionGroup) } : {}),
      ...(asStr(r.forkFromNodeId) ? { forkFromNodeId: asStr(r.forkFromNodeId) } : {}),
      ...(fallbackModels ? { fallbackModels } : {}),
      ...(asStr(r.repairTargetNodeId) ? { repairTargetNodeId: asStr(r.repairTargetNodeId) } : {}),
      ...(typeof r.maxAttempts === "number" ? { maxAttempts: r.maxAttempts } : {}),
      ...(typeof r.stallTimeoutSec === "number" ? { stallTimeoutSec: r.stallTimeoutSec } : {}),
      ...(r.skipOnUpstreamFail === true ? { skipOnUpstreamFail: true } : {}),
      ...(r.gate && typeof r.gate === "object" ? { gate: r.gate as FlowNodeSpec["gate"] } : {}),
      ...(r.merge && typeof r.merge === "object" ? { merge: r.merge as FlowNodeSpec["merge"] } : {}),
      ...(r.human && typeof r.human === "object" ? { human: r.human as FlowNodeSpec["human"] } : {}),
    };
  });
}

export function buildAndValidateStartGraph(input: {
  params: Record<string, unknown>;
  goal: string;
  cwd: string;
  rolesMap: ReadonlyMap<string, RoleSpec>;
  defaultMaxRepairRounds: number;
}): { spec: FlowGraphSpec; validation: GraphValidationResult; roles: RoleSpec[]; isGraphMode: boolean } {
  const { params, goal, cwd, rolesMap, defaultMaxRepairRounds } = input;
  const rawPolicies = (params.policies && typeof params.policies === "object" && !Array.isArray(params.policies)
    ? params.policies : {}) as Partial<FlowPolicies>;
  const maxRepairRounds = typeof params.maxRepairRounds === "number" ? params.maxRepairRounds : (rawPolicies.maxRepairRounds ?? defaultMaxRepairRounds);
  const git = isGitRepo(cwd);

  let spec: FlowGraphSpec;
  let isGraphMode = false;
  if (Array.isArray(params.nodes) && params.nodes.length > 0) {
    isGraphMode = true;
    spec = {
      version: 1,
      goal,
      preset: (asStr(params.preset) as FlowGraphSpec["preset"]) ?? "custom",
      nodes: parseNodeSpecs(params.nodes),
      policies: normalizePolicies({ ...rawPolicies, maxRepairRounds }),
    };
  } else if (asStr(params.preset) && asStr(params.preset) !== "linear") {
    isGraphMode = true;
    const preset = asStr(params.preset);
    if (preset === "fan_out_join" && Array.isArray(params.shards)) {
      spec = compileFanOutJoin({
        goal,
        shards: params.shards as FanOutShardInput[],
        ...(params.merge && typeof params.merge === "object" ? { merge: params.merge as any } : {}),
        ...(params.gate && typeof params.gate === "object" ? { gate: params.gate as any } : {}),
        ...(params.joinRole && typeof params.joinRole === "object" ? { joinRole: params.joinRole as any } : {}),
        policies: { ...rawPolicies, maxRepairRounds },
      });
    } else if (preset === "contract_parallel_verify" && Array.isArray(params.workers)) {
      spec = compileContractParallelVerify({
        goal,
        contract: (params.contract && typeof params.contract === "object" ? params.contract : { brief: goal }) as any,
        workers: params.workers as FanOutShardInput[],
        ...(asStr(params.gateCommand) ? { gateCommand: asStr(params.gateCommand) } : {}),
        ...(asStr(params.reviewerRole) ? { reviewerRole: asStr(params.reviewerRole) } : {}),
        ...(params.landingMode === "apply" || params.landingMode === "branch_preview" ? { landingMode: params.landingMode } : {}),
        policies: { ...rawPolicies, maxRepairRounds },
      });
    } else if (preset === "experiment_loop" && asStr(params.scorerCommand)) {
      spec = compileExperimentLoop({
        goal,
        workerRole: asStr(params.workerRole) ?? "algo",
        workerBrief: (params.workerBrief as any) ?? goal,
        scorerCommand: asStr(params.scorerCommand)!,
        ...(asStr(params.metricsPath) ? { metricsPath: asStr(params.metricsPath) } : {}),
        maxRounds: maxRepairRounds,
        policies: rawPolicies,
      });
    } else {
      throw new Error(`Preset "${preset}" requires matching parameters (shards / workers / scorerCommand) or explicit nodes.`);
    }
  } else {
    const roleIds = asStrArr(params.roles);
    if (!roleIds) throw new Error("enhance_flow start requires a non-empty roles array or nodes graph.");
    const roleSpecs = roleIds.map((id) => {
      const r = rolesMap.get(id);
      if (id === "supervisor" || (r && isInternalRole(r))) throw new Error(`Role "${id}" is an internal monitor and cannot run as a Flow stage.`);
      if (!r) throw new Error(`Unknown role "${id}".`);
      return r;
    });
    spec = compileLinearChain(roleSpecs, goal, { ...rawPolicies, maxRepairRounds });
    if (roleSpecs.some((r) => Boolean(r.workflow?.phases?.length))) isGraphMode = true;
  }

  const validation = validateFlowGraph({ spec, roles: rolesMap, isGitRepo: git });
  const roles = spec.nodes
    .filter((n) => n.kind === "role" && n.role && rolesMap.has(n.role))
    .map((n) => rolesMap.get(n.role!)!);
  return { spec: validation.normalizedSpec ?? spec, validation, roles, isGraphMode };
}

export function formatGraphWavesSummary(spec: FlowGraphSpec, validation: GraphValidationResult): string {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  return validation.waves
    .map((wave, i) => `W${i}[${wave.map((id) => {
      const n = byId.get(id);
      const wt = validation.effectiveWorkspaceByNode[id] === "worktree" ? ":wt" : "";
      return n?.kind === "role" ? `${id}(${n.role}${wt})` : `${id}(${n?.kind ?? "?"})`;
    }).join(" | ")}]`)
    .join(" → ");
}

export function parseAndValidatePatch(input: {
  rawPatch: unknown;
  currentSpec: FlowGraphSpec;
  nodeStatuses: Readonly<Record<string, string>>;
  rolesMap: ReadonlyMap<string, RoleSpec>;
  cwd: string;
}): { patch: FlowGraphPatch; validation: GraphValidationResult } {
  if (!input.rawPatch || typeof input.rawPatch !== "object" || Array.isArray(input.rawPatch)) {
    throw new Error("enhance_flow patch requires a patch object with addNodes, skipNodeIds, or rewireDeps.");
  }
  const r = input.rawPatch as Record<string, unknown>;
  const patch: FlowGraphPatch = {
    ...(Array.isArray(r.addNodes) && r.addNodes.length > 0 ? { addNodes: parseNodeSpecs(r.addNodes) } : {}),
    ...(asStrArr(r.skipNodeIds) ? { skipNodeIds: asStrArr(r.skipNodeIds) } : {}),
    ...(Array.isArray(r.rewireDeps) ? { rewireDeps: r.rewireDeps as FlowGraphPatch["rewireDeps"] } : {}),
  };
  const validation = validateGraphPatch({
    currentSpec: input.currentSpec,
    nodeStatuses: input.nodeStatuses,
    patch,
    roles: input.rolesMap,
    isGitRepo: isGitRepo(input.cwd),
  });
  return { patch, validation };
}
