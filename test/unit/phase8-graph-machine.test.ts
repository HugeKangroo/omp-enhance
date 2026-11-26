import { describe, expect, test } from "bun:test";
import { globScopesMayOverlap, narrowRolePermissions } from "../../src/core/scope.ts";
import type { HandoffEnvelope, RoleSpec, VerificationEvidenceRecord } from "../../src/core/types.ts";
import {
  compileContractParallelVerify,
  compileExperimentLoop,
  compileFanOutJoin,
  compileLinearChain,
  validateFlowGraph,
  validateGraphPatch,
} from "../../src/flow/graph.ts";
import { buildFlowGraphSnapshot, createInitialFlowState, transitionFlow } from "../../src/flow/machine.ts";

function makeRole(id: string, opts?: { writable?: string[]; protected?: string[]; internal?: boolean }): RoleSpec {
  return {
    id,
    name: id.toUpperCase(),
    description: `${id} role`,
    ...(opts?.internal ? { internal: true } : {}),
    stance: "work",
    method: ["do"],
    permissions: {
      tools: opts?.writable?.length === 0 ? ["read", "grep"] : ["read", "write", "edit", "bash"],
      ...(opts?.writable !== undefined ? { writable: opts.writable } : {}),
      ...(opts?.protected ? { protected: opts.protected } : {}),
    },
    exit: { requireToolEvidence: false, criteria: [] },
    source: "builtin",
    filePath: `/tmp/${id}.yaml`,
    contentSha256: "abc",
  };
}

function makeRolesMap(): Map<string, RoleSpec> {
  return new Map([
    ["planner", makeRole("planner", { writable: [], protected: ["**"] })],
    ["dev", makeRole("dev", { protected: [".git/**", ".omp/**"] })],
    ["algo", makeRole("algo", { writable: ["algo_work/**"], protected: [".git/**"] })],
    ["qa", makeRole("qa", { writable: ["test/**"], protected: [".git/**"] })],
    ["reviewer", makeRole("reviewer", { writable: [], protected: ["**"] })],
    ["supervisor", makeRole("supervisor", { writable: [], protected: ["**"], internal: true })],
  ]);
}

function fakeHandoff(fromRole: string, verdict: HandoffEnvelope["verdict"] = "ready", summary = "ok"): HandoffEnvelope {
  return {
    id: `ho-${fromRole}-${Math.random().toString(36).slice(2, 6)}`,
    mandateId: "m-1",
    mandateRev: 1,
    parentHandoffId: null,
    fromRole,
    toTarget: "user",
    verdict,
    summary,
    artifacts: [],
    verifiedFacts: [],
    openRisks: [],
    feedbackForUpstream: verdict === "rejected" ? summary : null,
    observedUsage: null,
    createdAt: "2026-11-25T12:00:00Z",
  };
}

const NOW = "2026-11-25T12:00:00Z";

describe("Phase 1: core/scope permission narrowing & collision checks", () => {
  test("narrowRolePermissions prevents privilege escalation and protected overlap", () => {
    const roles = makeRolesMap();
    const okDev = narrowRolePermissions(roles.get("dev")!, ["src/core/**"]);
    expect(okDev.ok).toBe(true);
    if (okDev.ok) expect(okDev.role.permissions.writable).toEqual(["src/core/**"]);

    const escRo = narrowRolePermissions(roles.get("planner")!, ["src/**"]);
    expect(escRo.ok).toBe(false);

    const escProtected = narrowRolePermissions(roles.get("dev")!, [".git/**"]);
    expect(escProtected.ok).toBe(false);

    const escAlgo = narrowRolePermissions(roles.get("algo")!, ["src/core/**"]);
    expect(escAlgo.ok).toBe(false);

    const okAlgo = narrowRolePermissions(roles.get("algo")!, ["algo_work/exp1/**"]);
    expect(okAlgo.ok).toBe(true);

    const escTraversal = narrowRolePermissions(roles.get("dev")!, ["../outside/**"]);
    expect(escTraversal.ok).toBe(false);
  });

  test("globScopesMayOverlap distinguishes disjoint prefixes and conservative wildcards", () => {
    expect(globScopesMayOverlap(["src/core/**"], ["src/ui/**"])).toBe(false);
    expect(globScopesMayOverlap(["src/flow/a.ts"], ["src/flow/b.ts"])).toBe(false);
    expect(globScopesMayOverlap(["**/*.ts"], ["**/*.md"])).toBe(false);
    expect(globScopesMayOverlap(["src/flow/**"], ["src/flow/machine.ts"])).toBe(true);
    expect(globScopesMayOverlap(undefined, ["src/ui/**"])).toBe(true);
    expect(globScopesMayOverlap([], ["src/ui/**"])).toBe(false);
  });
});

describe("Phase 1: flow/graph compiler & static linter", () => {
  test("detects cycles, unknown roles, internal roles, and overlapping inherit writers", () => {
    const roles = makeRolesMap();
    const cyclic = validateFlowGraph({
      roles,
      spec: {
        version: 1,
        goal: "cycle",
        nodes: [
          { id: "a", kind: "role", role: "dev", dependsOn: ["b"] },
          { id: "b", kind: "role", role: "dev", dependsOn: ["a"] },
        ],
        policies: { maxConcurrency: 2, maxRepairRounds: 2, workspaceStrategy: "auto_worktree", pauseOnWaitingInput: "branch_only", enableSessionReuse: true },
      },
    });
    expect(cyclic.ok).toBe(false);
    expect(cyclic.issues.some((i) => i.code === "cycle_detected")).toBe(true);

    const supRes = validateFlowGraph({
      roles,
      spec: {
        version: 1,
        goal: "internal",
        nodes: [{ id: "sup", kind: "role", role: "supervisor", dependsOn: [] }],
        policies: { maxConcurrency: 1, maxRepairRounds: 1, workspaceStrategy: "inherit_only", pauseOnWaitingInput: "whole_flow", enableSessionReuse: true },
      },
    });
    expect(supRes.ok).toBe(false);
    expect(supRes.issues.some((i) => i.code === "internal_role_forbidden")).toBe(true);

    const collide = validateFlowGraph({
      roles,
      isGitRepo: false,
      spec: compileFanOutJoin({
        goal: "collide",
        shards: [
          { id: "w1", role: "dev", brief: "a", writableScope: ["src/**"] },
          { id: "w2", role: "dev", brief: "b", writableScope: ["src/core/**"] },
        ],
      }),
    });
    expect(collide.ok).toBe(false);
    expect(collide.issues.some((i) => i.code === "write_collision")).toBe(true);
  });

  test("auto-upgrades concurrent git writers to worktree and computes waves + leaseMode", () => {
    const roles = makeRolesMap();
    const spec = compileContractParallelVerify({
      goal: "Parallel refactor",
      contract: { brief: "Lock contract" },
      workers: [
        { id: "core-fix", role: "dev", brief: "Fix core", writableScope: ["src/core/**"] },
        { id: "ui-fix", role: "dev", brief: "Fix ui", writableScope: ["src/ui/**"] },
      ],
      gateCommand: "bun run check",
    });
    const res = validateFlowGraph({ spec, roles, isGitRepo: true });
    expect(res.ok).toBe(true);
    expect(res.waves).toEqual([["contract"], ["core-fix", "ui-fix"], ["merge"], ["gate"], ["reviewer"]]);
    expect(res.effectiveWorkspaceByNode["core-fix"]).toBe("worktree");
    expect(res.effectiveWorkspaceByNode["ui-fix"]).toBe("worktree");
    expect(res.effectiveWorkspaceByNode["contract"]).toBe("inherit");
    expect(res.leaseMode).toBe("write_worktree");

    const roSpec = compileLinearChain([roles.get("planner")!, roles.get("reviewer")!], "Read-only audit");
    const roRes = validateFlowGraph({ spec: roSpec, roles, isGitRepo: true });
    expect(roRes.ok).toBe(true);
    expect(roRes.leaseMode).toBe("read");
  });
});

describe("Phase 1: flow/machine pure HFSM transitions", () => {
  test("parallel fan-out, targeted invalidation preserves healthy sibling, and warm session reuse", () => {
    const roles = makeRolesMap();
    const isRo = (id: string) => id === "planner" || id === "reviewer";
    const spec = compileContractParallelVerify({
      goal: "Build core + ui",
      contract: { brief: "Lock schema" },
      workers: [
        { id: "core-fix", role: "dev", brief: "Core", writableScope: ["src/core/**"] },
        { id: "ui-fix", role: "dev", brief: "UI", writableScope: ["src/ui/**"] },
      ],
      gateCommand: "bun run check",
    });
    const val = validateFlowGraph({ spec, roles, isGitRepo: true });
    expect(val.ok).toBe(true);

    let st = createInitialFlowState({ flowId: "f-1", mandateId: "m-1", cwd: "/repo", spec, validation: val, nowIso: NOW });
    let out = transitionFlow(st, { type: "FLOW_START" }, NOW, { isRoleReadOnly: isRo });
    st = out.state;
    expect(st.status).toBe("running");
    expect(out.commands.some((c) => c.type === "DISPATCH_ROLE_NODE" && c.nodeId === "contract")).toBe(true);

    // Complete Wave 0 -> triggers PREPARE_WORKTREE for both Wave 1 workers concurrently
    out = transitionFlow(st, { type: "NODE_SUCCEEDED", nodeId: "contract", handoff: fakeHandoff("planner"), sessionWarm: false }, NOW, { isRoleReadOnly: isRo });
    st = out.state;
    const wtCmds = out.commands.filter((c) => c.type === "PREPARE_WORKTREE").map((c) => c.nodeId).sort();
    expect(wtCmds).toEqual(["core-fix", "ui-fix"]);

    // Worktrees ready -> dispatches both workers
    out = transitionFlow(st, { type: "NODE_WORKTREE_READY", nodeId: "core-fix", worktreePath: "/wt/core" }, NOW, { isRoleReadOnly: isRo });
    st = out.state;
    expect(out.commands.some((c) => c.type === "DISPATCH_ROLE_NODE" && c.nodeId === "core-fix" && c.worktreePath === "/wt/core")).toBe(true);
    out = transitionFlow(st, { type: "NODE_WORKTREE_READY", nodeId: "ui-fix", worktreePath: "/wt/ui" }, NOW, { isRoleReadOnly: isRo });
    st = out.state;

    // Both finish with warm sessions and commit refs -> triggers merge node
    out = transitionFlow(st, { type: "NODE_SUCCEEDED", nodeId: "core-fix", handoff: fakeHandoff("dev"), sessionWarm: true, commitRef: "refs/omp/core" }, NOW, { isRoleReadOnly: isRo });
    st = out.state;
    expect(st.nodes["merge"]!.status).toBe("pending");
    out = transitionFlow(st, { type: "NODE_SUCCEEDED", nodeId: "ui-fix", handoff: fakeHandoff("dev"), sessionWarm: true, commitRef: "refs/omp/ui" }, NOW, { isRoleReadOnly: isRo });
    st = out.state;
    expect(out.commands.some((c) => c.type === "RUN_MERGE_NODE" && c.nodeId === "merge")).toBe(true);

    // Merge succeeds -> gate runs
    out = transitionFlow(st, { type: "MERGE_COMPLETED", nodeId: "merge", ok: true, mergedRef: "refs/omp/merged", summary: "Clean merge" }, NOW, { isRoleReadOnly: isRo });
    st = out.state;
    expect(out.commands.some((c) => c.type === "RUN_GATE_NODE" && c.nodeId === "gate")).toBe(true);

    // Gate succeeds -> reviewer runs
    const ev: VerificationEvidenceRecord = { command: "bun run check", exitCode: 0, outputSnippet: "ok", testedTreeFingerprint: "fp1", toolCallId: "gate-1" };
    out = transitionFlow(st, { type: "GATE_COMPLETED", nodeId: "gate", passed: true, evidence: ev }, NOW, { isRoleReadOnly: isRo });
    st = out.state;
    expect(out.commands.some((c) => c.type === "DISPATCH_ROLE_NODE" && c.nodeId === "reviewer")).toBe(true);

    // Reviewer rejects ONLY core-fix -> core-fix re-dispatched with reuseSession=true, ui-fix stays succeeded!
    out = transitionFlow(st, {
      type: "NODE_REJECTED",
      nodeId: "reviewer",
      handoff: fakeHandoff("reviewer", "rejected", "Fix null check in core"),
      targetNodeId: "core-fix",
      feedback: "Fix null check in core",
    }, NOW, { isRoleReadOnly: isRo });
    st = out.state;
    expect(st.repairRound).toBe(1);
    expect(st.nodes["ui-fix"]!.status).toBe("succeeded");
    expect(st.nodes["ui-fix"]!.commitRef).toBe("refs/omp/ui");
    expect(st.nodes["merge"]!.status).toBe("pending");
    expect(st.nodes["gate"]!.status).toBe("pending");
    expect(st.nodes["reviewer"]!.status).toBe("pending");
    const redispatch = out.commands.find((c) => c.type === "DISPATCH_ROLE_NODE" && c.nodeId === "core-fix");
    expect(redispatch && redispatch.type === "DISPATCH_ROLE_NODE" && redispatch.reuseSession).toBe(true);
    expect(redispatch && redispatch.type === "DISPATCH_ROLE_NODE" && redispatch.repairFeedback).toContain("null check");

    const snap = buildFlowGraphSnapshot(st);
    expect(snap.waves.length).toBe(5);
    expect(snap.nodes.find((n) => n.nodeId === "ui-fix")?.status).toBe("succeeded");
  });

  test("stream stall triggers in-place model switch before failing, and gate loop stops at maxRepairRounds", () => {
    const roles = makeRolesMap();
    const spec = compileExperimentLoop({
      goal: "Optimize accuracy",
      workerBrief: "Run baseline + candidate",
      scorerCommand: "bun run score",
      maxRounds: 1,
    });
    spec.nodes[0]!.fallbackModels = ["fast-model"];
    const val = validateFlowGraph({ spec, roles, isGitRepo: true });
    let st = createInitialFlowState({ flowId: "f-2", mandateId: "m-2", cwd: "/repo", spec, validation: val, nowIso: NOW });

    st = transitionFlow(st, { type: "FLOW_START" }, NOW).state;
    st = transitionFlow(st, { type: "NODE_DISPATCHED", nodeId: "algo", attempt: 1, stageId: st.nodes["algo"]!.activeStageId!, modelLabel: "primary-model" }, NOW).state;

    // Stall -> triggers SWITCH_MODEL_AND_RESUME instead of failing
    let out = transitionFlow(st, { type: "NODE_STALLED", nodeId: "algo", idleSec: 125, currentModel: "primary-model" }, NOW);
    st = out.state;
    expect(st.status).toBe("running");
    expect(out.commands.some((c) => c.type === "SWITCH_MODEL_AND_RESUME" && c.nextModel === "fast-model")).toBe(true);

    // Succeed algo -> scorer-gate runs and fails twice -> hits maxRepairRounds
    st = transitionFlow(st, { type: "NODE_SUCCEEDED", nodeId: "algo", handoff: fakeHandoff("algo"), sessionWarm: true }, NOW).state;
    const failEv1: VerificationEvidenceRecord = { command: "bun run score", exitCode: 1, outputSnippet: "metric=0.60", testedTreeFingerprint: "fp1", toolCallId: "g1" };
    out = transitionFlow(st, { type: "GATE_COMPLETED", nodeId: "scorer-gate", passed: false, evidence: failEv1, feedback: "score 0.60 < 0.80" }, NOW);
    st = out.state;
    expect(st.repairRound).toBe(1);
    expect(st.nodes["algo"]!.status).toBe("running");

    st = transitionFlow(st, { type: "NODE_SUCCEEDED", nodeId: "algo", handoff: fakeHandoff("algo"), sessionWarm: true }, NOW).state;
    const failEv2: VerificationEvidenceRecord = { command: "bun run score", exitCode: 1, outputSnippet: "metric=0.72", testedTreeFingerprint: "fp2", toolCallId: "g2" };
    out = transitionFlow(st, { type: "GATE_COMPLETED", nodeId: "scorer-gate", passed: false, evidence: failEv2, feedback: "score 0.72 < 0.80" }, NOW);
    st = out.state;
    expect(st.status).toBe("rejected_max_rounds");
    expect(out.commands.some((c) => c.type === "DISPOSE_SESSION" && c.nodeId === "algo")).toBe(true);
  });

  test("supports runtime GRAPH_PATCH and branch_only waiting_input resume", () => {
    const roles = makeRolesMap();
    const spec = compileFanOutJoin({
      goal: "Dual explore",
      shards: [
        { id: "s1", role: "planner", brief: "Inspect A" },
        { id: "s2", role: "planner", brief: "Inspect B" },
      ],
    });
    const val = validateFlowGraph({ spec, roles, isGitRepo: true });
    let st = createInitialFlowState({ flowId: "f-3", mandateId: "m-3", cwd: "/repo", spec, validation: val, nowIso: NOW });
    st = transitionFlow(st, { type: "FLOW_START" }, NOW).state;

    // s1 asks user; s2 is still running -> flow stays running under branch_only!
    let out = transitionFlow(st, { type: "NODE_NEEDS_INPUT", nodeId: "s1", handoff: fakeHandoff("planner", "needs_input", "Pick env"), questions: ["Prod or staging?"], sessionWarm: true }, NOW);
    st = out.state;
    expect(st.status).toBe("running");
    expect(st.nodes["s1"]!.status).toBe("waiting_input");

    // s2 finishes -> no runnable nodes remain, so flow settles into waiting_input!
    out = transitionFlow(st, { type: "NODE_SUCCEEDED", nodeId: "s2", handoff: fakeHandoff("planner") }, NOW);
    st = out.state;
    expect(st.status).toBe("waiting_input");
    expect(out.commands.some((c) => c.type === "WAKE_COORDINATOR" && c.kind === "needs_input")).toBe(true);

    // Dynamically patch graph to add a downstream reviewer node, then resume s1 with answer
    const patch = { addNodes: [{ id: "rev", kind: "role" as const, role: "reviewer", dependsOn: ["s1", "s2"] }] };
    const patchedVal = validateGraphPatch({
      currentSpec: st.spec,
      nodeStatuses: Object.fromEntries(Object.entries(st.nodes).map(([k, v]) => [k, v.status])),
      patch,
      roles,
      isGitRepo: true,
    });
    expect(patchedVal.ok).toBe(true);
    st = transitionFlow(st, { type: "GRAPH_PATCH", patch, validated: patchedVal }, NOW).state;
    expect(st.nodes["rev"]!.status).toBe("pending");

    out = transitionFlow(st, { type: "FLOW_RESUME", replyText: "Staging" }, NOW);
    st = out.state;
    expect(st.status).toBe("running");
    const dis = out.commands.find((c) => c.type === "DISPATCH_ROLE_NODE" && c.nodeId === "s1");
    expect(dis && dis.type === "DISPATCH_ROLE_NODE" && dis.replyText).toBe("Staging");
    expect(dis && dis.type === "DISPATCH_ROLE_NODE" && dis.reuseSession).toBe(true);

    out = transitionFlow(st, { type: "NODE_SUCCEEDED", nodeId: "s1", handoff: fakeHandoff("planner") }, NOW);
    st = out.state;
    expect(out.commands.some((c) => c.type === "DISPATCH_ROLE_NODE" && c.nodeId === "rev")).toBe(true);
  });
});
