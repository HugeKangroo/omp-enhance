import type {
  FlowGraphPatch,
  FlowGraphSpec,
  FlowLeaseMode,
  FlowNodeSpec,
  GraphValidationIssue,
  GraphValidationResult,
  WorkspaceMode,
} from "../core/graph-types.ts";
import { isInternalRole, isRoleReadOnly } from "../core/policy.ts";
import { globScopesMayOverlap, resolveEffectiveWritableScope, resolveNodeEffectiveRole } from "../core/scope.ts";
import type { RoleSpec } from "../core/types.ts";
import { normalizePolicies } from "./graph-presets.ts";
import { expandGraphRoleWorkflows } from "./workflow.ts";

export {
  compileContractParallelVerify,
  compileExperimentLoop,
  compileFanOutJoin,
  compileLinearChain,
  normalizePolicies,
  type FanOutShardInput,
} from "./graph-presets.ts";

const NODE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function computeAncestorMap(nodes: readonly FlowNodeSpec[]): Map<string, Set<string>> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const out = new Set<string>();
    if (stack.has(id)) return out;
    stack.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      out.add(dep);
      for (const anc of visit(dep, stack)) out.add(anc);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const n of nodes) visit(n.id, new Set());
  return memo;
}

export function computeDescendantMap(nodes: readonly FlowNodeSpec[]): Map<string, Set<string>> {
  const ancMap = computeAncestorMap(nodes);
  const desc = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
  for (const [nodeId, ancs] of ancMap) for (const a of ancs) desc.get(a)?.add(nodeId);
  return desc;
}

function validateNodeConfigs(
  nodes: readonly FlowNodeSpec[],
  byId: ReadonlyMap<string, FlowNodeSpec>,
  roles: ReadonlyMap<string, RoleSpec>,
  issues: GraphValidationIssue[],
  writableRoleByNode: Map<string, RoleSpec>,
): void {
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) issues.push({ code: "missing_dep", nodeId: node.id, message: `Node "${node.id}" depends on unknown node "${dep}".` });
      if (dep === node.id) issues.push({ code: "cycle_detected", nodeId: node.id, message: `Node "${node.id}" cannot depend on itself.` });
    }
    if (node.repairTargetNodeId && !byId.has(node.repairTargetNodeId)) {
      issues.push({ code: "invalid_repair_target", nodeId: node.id, message: `Node "${node.id}" references unknown repairTargetNodeId "${node.repairTargetNodeId}".` });
    }
    if (node.forkFromNodeId && !byId.has(node.forkFromNodeId)) {
      issues.push({ code: "invalid_fork_source", nodeId: node.id, message: `Node "${node.id}" references unknown forkFromNodeId "${node.forkFromNodeId}".` });
    }
    if (node.kind === "role") {
      const role = node.role ? roles.get(node.role) : undefined;
      if (!node.role) issues.push({ code: "invalid_node_config", nodeId: node.id, message: `Role node "${node.id}" requires a role id.` });
      else if (!role) issues.push({ code: "unknown_role", nodeId: node.id, message: `Node "${node.id}" references unknown role "${node.role}".` });
      else if (isInternalRole(role)) issues.push({ code: "internal_role_forbidden", nodeId: node.id, message: `Node "${node.id}" cannot run internal monitor role "${role.id}".` });
      else {
        const narrowed = resolveNodeEffectiveRole(role, node);
        if (!narrowed.ok) issues.push({ code: "scope_violation", nodeId: node.id, message: `Node "${node.id}": ${narrowed.reason}` });
        else if (!isRoleReadOnly(narrowed.role)) writableRoleByNode.set(node.id, narrowed.role);
      }
    } else if (node.kind === "gate") {
      if (!node.gate?.command?.trim()) issues.push({ code: "invalid_node_config", nodeId: node.id, message: `Gate node "${node.id}" requires a non-empty gate.command.` });
      if (node.gate?.repairTargetNodeId && !byId.has(node.gate.repairTargetNodeId)) {
        issues.push({ code: "invalid_repair_target", nodeId: node.id, message: `Gate "${node.id}" references unknown repairTargetNodeId "${node.gate.repairTargetNodeId}".` });
      }
    } else if (node.kind === "merge") {
      if (node.join === "any") issues.push({ code: "invalid_node_config", nodeId: node.id, message: `Merge node "${node.id}" cannot use join="any" (all write sources must complete before merge).` });
      if (!node.merge?.sourceNodeIds?.length) issues.push({ code: "invalid_merge_source", nodeId: node.id, message: `Merge node "${node.id}" requires non-empty merge.sourceNodeIds.` });
      else for (const src of node.merge.sourceNodeIds) if (!byId.has(src)) issues.push({ code: "invalid_merge_source", nodeId: node.id, message: `Merge node "${node.id}" references unknown sourceNodeId "${src}".` });
    } else if (node.kind === "human") {
      if (!node.human?.prompt?.trim()) issues.push({ code: "invalid_node_config", nodeId: node.id, message: `Human node "${node.id}" requires a non-empty human.prompt.` });
    }
  }
}

export function validateFlowGraph(input: {
  spec: FlowGraphSpec;
  roles: ReadonlyMap<string, RoleSpec>;
  isGitRepo?: boolean;
  skippedNodeIds?: ReadonlySet<string>;
}): GraphValidationResult {
  const { roles } = input;
  const isGitRepo = input.isGitRepo ?? true;
  const issues: GraphValidationIssue[] = [];
  const waveByNode: Record<string, number> = {};
  const effectiveWorkspaceByNode: Record<string, WorkspaceMode> = {};

  if (!input.spec.nodes || input.spec.nodes.length === 0) {
    issues.push({ code: "empty_graph", message: "Flow graph must contain at least one node." });
    return { ok: false, issues, waveByNode, waves: [], effectiveWorkspaceByNode, hasWritableNodes: false, usesWorktree: false, leaseMode: "read" };
  }
  let spec = input.spec;
  try { spec = expandGraphRoleWorkflows(input.spec, roles); }
  catch (err) {
    issues.push({ code: "scope_violation", message: err instanceof Error ? err.message : String(err) });
    return { ok: false, issues, waveByNode, waves: [], effectiveWorkspaceByNode, hasWritableNodes: false, usesWorktree: false, leaseMode: "read" };
  }
  const policies = normalizePolicies(spec.policies);

  const byId = new Map<string, FlowNodeSpec>();
  for (const node of spec.nodes) {
    if (!NODE_ID_RE.test(node.id)) issues.push({ code: "invalid_node_id", nodeId: node.id, message: `Invalid node id "${node.id}". Use 1-32 lowercase [a-z0-9_-] starting with a-z0-9.` });
    if (byId.has(node.id)) issues.push({ code: "duplicate_node_id", nodeId: node.id, message: `Duplicate node id "${node.id}".` });
    else byId.set(node.id, node);
    effectiveWorkspaceByNode[node.id] = node.workspace ?? "inherit";
  }

  const writableRoleByNode = new Map<string, RoleSpec>();
  validateNodeConfigs(spec.nodes, byId, roles, issues, writableRoleByNode);

  // Kahn's topological sort + wave assignment
  const inDeg = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const n of spec.nodes) { inDeg.set(n.id, 0); children.set(n.id, []); }
  for (const n of spec.nodes) {
    for (const dep of n.dependsOn) {
      if (byId.has(dep) && dep !== n.id) { inDeg.set(n.id, (inDeg.get(n.id) ?? 0) + 1); children.get(dep)!.push(n.id); }
    }
  }
  const queue = spec.nodes.filter((n) => (inDeg.get(n.id) ?? 0) === 0).map((n) => { waveByNode[n.id] = 0; return n.id; });
  const topo: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topo.push(id);
    const curWave = waveByNode[id] ?? 0;
    for (const childId of children.get(id) ?? []) {
      waveByNode[childId] = Math.max(waveByNode[childId] ?? 0, curWave + 1);
      const nextDeg = (inDeg.get(childId) ?? 1) - 1;
      inDeg.set(childId, nextDeg);
      if (nextDeg === 0) queue.push(childId);
    }
  }
  if (topo.length < byId.size) {
    issues.push({ code: "cycle_detected", message: `Cycle detected in Flow dependsOn edges involving: ${spec.nodes.filter((n) => !topo.includes(n.id)).map((n) => n.id).join(", ")}.` });
  }

  const ancestors = computeAncestorMap(spec.nodes);
  for (const node of spec.nodes) {
    if (node.forkFromNodeId && byId.has(node.forkFromNodeId) && !ancestors.get(node.id)?.has(node.forkFromNodeId)) {
      issues.push({ code: "invalid_fork_source", nodeId: node.id, message: `Node "${node.id}" forkFromNodeId "${node.forkFromNodeId}" must be a transitive ancestor.` });
    }
    if (node.kind === "merge" && node.merge?.sourceNodeIds) {
      for (const src of node.merge.sourceNodeIds) {
        if (byId.has(src) && !ancestors.get(node.id)?.has(src)) {
          issues.push({ code: "invalid_merge_source", nodeId: node.id, message: `Merge node "${node.id}" must depend on sourceNodeId "${src}".` });
        }
      }
    }
  }

  const writableIds = [...writableRoleByNode.keys()];
  for (let i = 0; i < writableIds.length; i++) {
    for (let j = i + 1; j < writableIds.length; j++) {
      const aId = writableIds[i]!, bId = writableIds[j]!;
      if (ancestors.get(aId)?.has(bId) || ancestors.get(bId)?.has(aId)) continue;
      const nodeA = byId.get(aId)!, nodeB = byId.get(bId)!;
      const overlaps = globScopesMayOverlap(
        resolveEffectiveWritableScope(writableRoleByNode.get(aId)!, nodeA.writableScope),
        resolveEffectiveWritableScope(writableRoleByNode.get(bId)!, nodeB.writableScope),
      );
      if (policies.workspaceStrategy === "auto_worktree" && isGitRepo) {
        if (nodeA.workspace !== "inherit") effectiveWorkspaceByNode[aId] = "worktree";
        if (nodeB.workspace !== "inherit") effectiveWorkspaceByNode[bId] = "worktree";
      }
      if (effectiveWorkspaceByNode[aId] === "inherit" && effectiveWorkspaceByNode[bId] === "inherit" && overlaps) {
        issues.push({
          code: "write_collision", nodeId: aId, otherNodeId: bId,
          message: `Concurrent write nodes "${aId}" and "${bId}" have overlapping writable scopes (${isGitRepo ? 'set workspace="worktree", narrow writableScope, or serialize via dependsOn' : "non-Git repo requires disjoint writableScope or sequential dependsOn"}).`,
        });
      }
    }
  }

  for (const node of spec.nodes) {
    if (effectiveWorkspaceByNode[node.id] === "worktree" && node.parentGroupId) {
      for (const peer of spec.nodes) {
        if (peer.parentGroupId === node.parentGroupId && peer.kind === "role") effectiveWorkspaceByNode[peer.id] = "worktree";
      }
    }
  }
  for (const node of spec.nodes) {
    if (effectiveWorkspaceByNode[node.id] === "worktree" && !isGitRepo) {
      issues.push({ code: "worktree_requires_git", nodeId: node.id, message: `Node "${node.id}" requires workspace="worktree", but target directory is not a Git repository.` });
    }
  }
  const activeMerges = spec.nodes.filter((n) => n.kind === "merge" && !input.skippedNodeIds?.has(n.id));
  const mergedSources = new Set(activeMerges.flatMap((n) => n.merge?.sourceNodeIds ?? []));
  const coveredGroups = new Set(
    [...mergedSources].map((sid) => byId.get(sid)?.parentGroupId).filter((g): g is string => Boolean(g)),
  );
  for (const id of writableIds) {
    if (input.skippedNodeIds?.has(id)) continue;
    const node = byId.get(id)!;
    const groupCovered = Boolean(node.parentGroupId && coveredGroups.has(node.parentGroupId));
    if (effectiveWorkspaceByNode[id] === "worktree" && !mergedSources.has(id) && !groupCovered) {
      issues.push({
        code: "missing_merge_delivery",
        nodeId: id,
        message: `Writable worktree node "${id}" has no downstream merge node to deliver its changes (add a merge node covering "${id}", or serialize via dependsOn / workspace="inherit").`,
      });
    }
  }

  const waves: string[][] = [];
  for (const id of topo) {
    const w = waveByNode[id] ?? 0;
    while (waves.length <= w) waves.push([]);
    waves[w]!.push(id);
  }
  const hasWritableNodes = writableRoleByNode.size > 0;
  const usesWorktree = Object.values(effectiveWorkspaceByNode).some((w) => w === "worktree");
  const leaseMode: FlowLeaseMode = !hasWritableNodes ? "read" : usesWorktree ? "write_worktree" : "write_main";
  const normalizedSpec: FlowGraphSpec = {
    ...spec,
    policies,
    nodes: spec.nodes.map((n) => {
      const ws = effectiveWorkspaceByNode[n.id] ?? n.workspace ?? "inherit";
      return { ...n, workspace: ws, ...(ws === "worktree" && n.parentGroupId ? { worktreeGroup: n.parentGroupId } : {}) };
    }),
  };
  return { ok: issues.length === 0, issues, waveByNode, waves, effectiveWorkspaceByNode, hasWritableNodes, usesWorktree, leaseMode, ...(issues.length === 0 ? { normalizedSpec } : {}) };
}

export function validateGraphPatch(input: {
  currentSpec: FlowGraphSpec;
  nodeStatuses: Readonly<Record<string, string>>;
  patch: FlowGraphPatch;
  roles: ReadonlyMap<string, RoleSpec>;
  isGitRepo?: boolean;
}): GraphValidationResult {
  const { currentSpec, nodeStatuses, patch, roles, isGitRepo } = input;
  const nextNodes = currentSpec.nodes.map((n) => ({ ...n, dependsOn: [...n.dependsOn] }));
  const issues: GraphValidationIssue[] = [];

  for (const skipId of patch.skipNodeIds ?? []) {
    const st = nodeStatuses[skipId];
    if (!st) issues.push({ code: "missing_dep", nodeId: skipId, message: `Cannot skip unknown node "${skipId}".` });
    else if (st !== "pending" && st !== "ready") issues.push({ code: "invalid_node_config", nodeId: skipId, message: `Cannot skip node "${skipId}" in status "${st}".` });
  }
  for (const rw of patch.rewireDeps ?? []) {
    const target = nextNodes.find((n) => n.id === rw.nodeId), st = nodeStatuses[rw.nodeId];
    if (!target) issues.push({ code: "missing_dep", nodeId: rw.nodeId, message: `Cannot rewire unknown node "${rw.nodeId}".` });
    else if (st && st !== "pending" && st !== "ready") issues.push({ code: "invalid_node_config", nodeId: rw.nodeId, message: `Cannot rewire node "${rw.nodeId}" in status "${st}".` });
    else target.dependsOn = [...rw.dependsOn];
  }
  for (const add of patch.addNodes ?? []) nextNodes.push({ ...add, dependsOn: [...add.dependsOn] });

  const skippedNodeIds = new Set<string>([
    ...Object.entries(nodeStatuses).filter(([, s]) => s === "skipped").map(([k]) => k),
    ...(patch.skipNodeIds ?? []),
  ]);
  const base = validateFlowGraph({ spec: { ...currentSpec, nodes: nextNodes }, roles, isGitRepo, skippedNodeIds });
  return issues.length > 0 ? { ...base, ok: false, issues: [...issues, ...base.issues] } : base;
}
