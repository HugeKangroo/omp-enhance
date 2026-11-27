import {
  DEFAULT_FLOW_POLICIES, type FlowGraphSpec, type FlowNodeSpec, type FlowPolicies, type NodeBrief, type WorkspaceMode,
} from "../core/graph-types.ts";
import { isRoleReadOnly } from "../core/policy.ts";
import type { RoleSpec } from "../core/types.ts";

export function normalizePolicies(raw?: Partial<FlowPolicies>): FlowPolicies {
  return {
    maxConcurrency: Math.max(1, Math.min(8, Math.floor(raw?.maxConcurrency ?? DEFAULT_FLOW_POLICIES.maxConcurrency))),
    maxRepairRounds: Math.max(0, Math.min(10, Math.floor(raw?.maxRepairRounds ?? DEFAULT_FLOW_POLICIES.maxRepairRounds))),
    workspaceStrategy: raw?.workspaceStrategy ?? DEFAULT_FLOW_POLICIES.workspaceStrategy,
    pauseOnWaitingInput: raw?.pauseOnWaitingInput ?? DEFAULT_FLOW_POLICIES.pauseOnWaitingInput,
    enableSessionReuse: raw?.enableSessionReuse ?? DEFAULT_FLOW_POLICIES.enableSessionReuse,
  };
}

export function compileLinearChain(roles: readonly RoleSpec[], goal: string, policies?: Partial<FlowPolicies>): FlowGraphSpec {
  const counts = new Map<string, number>(), seen = new Map<string, number>();
  for (const r of roles) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  const firstWritableIdx = roles.findIndex((r) => !isRoleReadOnly(r));
  const nodeIds = roles.map((r) => {
    const n = (seen.get(r.id) ?? 0) + 1;
    seen.set(r.id, n);
    return (counts.get(r.id) ?? 0) > 1 ? `${r.id}-${n}` : r.id;
  });
  const firstWritableId = firstWritableIdx >= 0 ? nodeIds[firstWritableIdx] : undefined;
  const nodes: FlowNodeSpec[] = roles.map((role, idx) => ({
    id: nodeIds[idx]!, title: role.name, kind: "role", role: role.id,
    dependsOn: idx === 0 ? [] : [nodeIds[idx - 1]!], workspace: "inherit",
    sessionMode: idx === firstWritableIdx ? "reuse" : "fresh",
    ...(firstWritableIdx >= 0 && idx > firstWritableIdx && firstWritableId ? { repairTargetNodeId: firstWritableId } : {}),
  }));
  return {
    version: 1, goal, preset: "linear", nodes,
    policies: normalizePolicies({ maxConcurrency: 1, workspaceStrategy: "inherit_only", pauseOnWaitingInput: "whole_flow", ...policies }),
  };
}

export interface FanOutShardInput {
  id?: string; title?: string; role: string; brief: NodeBrief | string;
  tools?: string[]; writableScope?: string[]; workspace?: WorkspaceMode; fallbackModels?: string[];
}

export function compileFanOutJoin(input: {
  goal: string; baseName?: string; shards: readonly FanOutShardInput[];
  merge?: { id?: string; landingMode?: "apply" | "branch_preview"; conflictPolicy?: "spawn_resolver" | "ask_human" | "fail" };
  gate?: { id?: string; command: string; timeoutSec?: number };
  joinRole?: { id?: string; role: string; title?: string; brief?: NodeBrief | string };
  policies?: Partial<FlowPolicies>;
}): FlowGraphSpec {
  const base = (input.baseName ?? "shard").replace(/[^a-z0-9_-]/gi, "-").toLowerCase() || "shard";
  const shardNodes: FlowNodeSpec[] = input.shards.map((s, idx) => ({
    id: s.id ?? `${base}-${idx + 1}`, ...(s.title ? { title: s.title } : {}), kind: "role", role: s.role, dependsOn: [], brief: s.brief,
    ...(s.tools ? { tools: [...s.tools] } : {}), ...(s.writableScope ? { writableScope: [...s.writableScope] } : {}),
    ...(s.workspace ? { workspace: s.workspace } : {}), ...(s.fallbackModels ? { fallbackModels: [...s.fallbackModels] } : {}),
  }));
  const nodes: FlowNodeSpec[] = [...shardNodes];
  let tailDeps = shardNodes.map((n) => n.id);
  if (input.merge) {
    const mergeId = input.merge.id ?? "merge";
    nodes.push({
      id: mergeId, title: "Merge parallel branches", kind: "merge", dependsOn: [...tailDeps],
      merge: { sourceNodeIds: [...tailDeps], landingMode: input.merge.landingMode ?? "apply", conflictPolicy: input.merge.conflictPolicy ?? "spawn_resolver" },
    });
    tailDeps = [mergeId];
  }
  if (input.gate) {
    const gateId = input.gate.id ?? "verify-gate";
    nodes.push({
      id: gateId, title: `Gate: ${input.gate.command}`, kind: "gate", dependsOn: [...tailDeps],
      gate: { command: input.gate.command, ...(input.gate.timeoutSec ? { timeoutSec: input.gate.timeoutSec } : {}) },
    });
    tailDeps = [gateId];
  }
  if (input.joinRole) {
    nodes.push({
      id: input.joinRole.id ?? input.joinRole.role, ...(input.joinRole.title ? { title: input.joinRole.title } : {}),
      kind: "role", role: input.joinRole.role, dependsOn: [...tailDeps],
      ...(input.joinRole.brief ? { brief: input.joinRole.brief } : {}), sessionMode: "fresh",
    });
  }
  return { version: 1, goal: input.goal, preset: "fan_out_join", nodes, policies: normalizePolicies(input.policies) };
}

export function compileContractParallelVerify(input: {
  goal: string; contract: { id?: string; role?: string; brief: NodeBrief | string; writableScope?: string[] };
  workers: readonly FanOutShardInput[]; gateCommand?: string; reviewerRole?: string;
  landingMode?: "apply" | "branch_preview"; policies?: Partial<FlowPolicies>;
}): FlowGraphSpec {
  const contractId = input.contract.id ?? "contract";
  const nodes: FlowNodeSpec[] = [{
    id: contractId, title: "Contract & Architecture", kind: "role", role: input.contract.role ?? "planner",
    dependsOn: [], brief: input.contract.brief,
    ...(input.contract.writableScope ? { writableScope: [...input.contract.writableScope] } : {}), workspace: "inherit",
  }];
  const workerIds: string[] = [];
  input.workers.forEach((w, idx) => {
    const id = w.id ?? `worker-${idx + 1}`;
    workerIds.push(id);
    nodes.push({
      id, ...(w.title ? { title: w.title } : {}), kind: "role", role: w.role, dependsOn: [contractId], brief: w.brief,
      ...(w.tools ? { tools: [...w.tools] } : {}), ...(w.writableScope ? { writableScope: [...w.writableScope] } : {}),
      workspace: w.workspace ?? (input.workers.length > 1 ? "worktree" : "inherit"),
      ...(w.fallbackModels ? { fallbackModels: [...w.fallbackModels] } : {}),
    });
  });
  let tailDeps = [...workerIds];
  if (input.workers.length > 1) {
    nodes.push({
      id: "merge", title: "Merge Worktrees", kind: "merge", dependsOn: [...workerIds],
      merge: { sourceNodeIds: [...workerIds], landingMode: input.landingMode ?? "apply", conflictPolicy: "spawn_resolver" },
    });
    tailDeps = ["merge"];
  }
  if (input.gateCommand) {
    nodes.push({ id: "gate", title: `Gate: ${input.gateCommand}`, kind: "gate", dependsOn: [...tailDeps], gate: { command: input.gateCommand } });
    tailDeps = ["gate"];
  }
  if (input.reviewerRole !== undefined ? Boolean(input.reviewerRole) : true) {
    const revId = input.reviewerRole || "reviewer";
    nodes.push({ id: revId, title: "Independent Review", kind: "role", role: revId, dependsOn: [...tailDeps], workspace: "inherit", sessionMode: "fresh" });
  }
  return { version: 1, goal: input.goal, preset: "contract_parallel_verify", nodes, policies: normalizePolicies(input.policies) };
}

export function compileExperimentLoop(input: {
  goal: string; workerRole?: string; workerBrief: NodeBrief | string;
  scorerCommand: string; metricsPath?: string; maxRounds?: number; policies?: Partial<FlowPolicies>;
}): FlowGraphSpec {
  const workerId = input.workerRole ?? "algo";
  return {
    version: 1, goal: input.goal, preset: "experiment_loop",
    nodes: [
      { id: workerId, title: "Experiment Candidate", kind: "role", role: workerId, dependsOn: [], brief: input.workerBrief, workspace: "inherit", sessionMode: "reuse" },
      {
        id: "scorer-gate", title: `Scorer: ${input.scorerCommand}`, kind: "gate", dependsOn: [workerId], repairTargetNodeId: workerId,
        gate: { command: input.scorerCommand, repairTargetNodeId: workerId, ...(input.metricsPath ? { parseJsonMetricsPath: input.metricsPath } : {}) },
      },
    ],
    policies: normalizePolicies({ maxConcurrency: 1, maxRepairRounds: input.maxRounds ?? 3, workspaceStrategy: "inherit_only", ...input.policies }),
  };
}
