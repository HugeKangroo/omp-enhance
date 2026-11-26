import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EnhanceStore } from "../../src/core/store.ts";
import type { RoleSpec } from "../../src/core/types.ts";
import { executeFlowGraph } from "../../src/flow/executor.ts";
import { compileContractParallelVerify, compileFanOutJoin, validateFlowGraph, validateGraphPatch } from "../../src/flow/graph.ts";
import { buildFlowGraphSnapshot } from "../../src/flow/machine.ts";
import { createGitWorktreeManager, isGitRepo } from "../../src/flow/worktree.ts";
import { buildAndValidateStartGraph } from "../../src/omp/graph-dispatch.ts";
import { renderConcurrentWidgetSummary, renderGraphNodeInspectorSection, renderWaveOverviewBar } from "../../src/ui/flow-graph-view.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function initGitRepo(): { cwd: string; store: EnhanceStore } {
  const cwd = mkdtempSync(path.join(tmpdir(), "omp-enhance-wt-"));
  tmpDirs.push(cwd);
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(path.join(cwd, "src", "b.ts"), "export const b = 1;\n", "utf8");
  writeFileSync(path.join(cwd, "shared.txt"), "line1\nline2\n", "utf8");
  spawnSync("git", ["init"], { cwd });
  spawnSync("git", ["config", "user.name", "Test"], { cwd });
  spawnSync("git", ["config", "user.email", "test@local"], { cwd });
  spawnSync("git", ["add", "-A"], { cwd });
  spawnSync("git", ["commit", "-m", "init"], { cwd });
  return { cwd, store: new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite")) };
}

function makeRole(id: string, ro = false): RoleSpec {
  return {
    id, name: id.toUpperCase(), description: id, stance: "work", method: ["do"],
    permissions: { tools: ro ? ["read", "grep"] : ["read", "write", "edit", "bash"], ...(ro ? { writable: [], protected: ["**"] } : { protected: [".git/**"] }) },
    exit: { requireToolEvidence: false, criteria: [] },
    source: "builtin", filePath: `/tmp/${id}.yaml`, contentSha256: "abc",
  };
}

describe("Phase 3: Git Worktree Isolation, Merge, Dirty Base, and Scope Enforcement", () => {
  test("parallel worktrees inherit dirty working tree changes, merge cleanly, pass gate, land into main cwd, and clean up all worktrees", async () => {
    const { cwd, store } = initGitRepo();
    expect(isGitRepo(cwd)).toBe(true);
    // Create uncommitted local change in main working tree (dirty tree test!)
    writeFileSync(path.join(cwd, "src", "local.ts"), "export const dirtyLocal = true;\n", "utf8");

    const roles = new Map<string, RoleSpec>([
      ["planner", makeRole("planner", true)],
      ["dev", makeRole("dev", false)],
      ["reviewer", makeRole("reviewer", true)],
    ]);
    const spec = compileContractParallelVerify({
      goal: "Parallel updates to a.ts and b.ts",
      contract: { brief: "Confirm a.ts and b.ts boundaries" },
      workers: [
        { id: "fix-a", role: "dev", brief: "Update src/a.ts", writableScope: ["src/a.ts"] },
        { id: "fix-b", role: "dev", brief: "Update src/b.ts", writableScope: ["src/b.ts"] },
      ],
      gateCommand: 'grep -q "a = 42" src/a.ts && grep -q "b = 99" src/b.ts',
    });
    const validation = validateFlowGraph({ spec, roles, isGitRepo: true });
    expect(validation.ok).toBe(true);

    const flowId = "flow-wt-parallel";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: spec.nodes.map((n) => n.id),
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 2,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });

    const seenDirtyLocal: Record<string, boolean> = {};
    const runner = {
      runRoleTurn: async (ctx: any) => {
        if (ctx.nodeId === "fix-a") {
          seenDirtyLocal["fix-a"] = existsSync(path.join(ctx.cwd, "src", "local.ts"));
          writeFileSync(path.join(ctx.cwd, "src", "a.ts"), "export const a = 42;\n", "utf8");
        } else if (ctx.nodeId === "fix-b") {
          seenDirtyLocal["fix-b"] = existsSync(path.join(ctx.cwd, "src", "local.ts"));
          writeFileSync(path.join(ctx.cwd, "src", "b.ts"), "export const b = 99;\n", "utf8");
        }
        const ho = {
          id: `ho-${ctx.nodeId}`, mandateId: mandate.id, mandateRev: 1, parentHandoffId: null,
          fromRole: ctx.role.id, toTarget: ctx.toTarget, verdict: "ready" as const,
          summary: `Done ${ctx.nodeId}`, artifacts: [], verifiedFacts: [], openRisks: [],
          feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
        };
        store.saveHandoff(ho);
        return { envelope: ho, observedCalls: [], assistantText: ho.summary, usage: null };
      },
    };

    const res = await executeFlowGraph({
      cwd, store, flowId, mandate, spec, validation, roles, runner,
      worktreeManager: createGitWorktreeManager(),
    });

    expect(res.status).toBe("completed");
    expect(seenDirtyLocal).toEqual({ "fix-a": true, "fix-b": true });
    expect(readFileSync(path.join(cwd, "src", "a.ts"), "utf8")).toContain("a = 42");
    expect(readFileSync(path.join(cwd, "src", "b.ts"), "utf8")).toContain("b = 99");
    expect(readFileSync(path.join(cwd, "src", "local.ts"), "utf8")).toContain("dirtyLocal");

    // Verify all ephemeral worktrees cleaned up
    const wtList = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" }).stdout;
    const worktreeLines = wtList.split("\n").filter((l) => l.startsWith("worktree "));
    expect(worktreeLines.length).toBe(1);
    store.close();
  });

  test("conflicting parallel edits pause cleanly in waiting_input with exact conflicted file list and leave main tree untouched", async () => {
    const { cwd, store } = initGitRepo();
    const roles = new Map<string, RoleSpec>([["dev", makeRole("dev", false)]]);
    const spec = compileFanOutJoin({
      goal: "Conflicting edits",
      shards: [
        { id: "w1", role: "dev", brief: "Edit shared", writableScope: ["shared.txt"], workspace: "worktree" },
        { id: "w2", role: "dev", brief: "Edit shared differently", writableScope: ["shared.txt"], workspace: "worktree" },
      ],
      merge: { landingMode: "apply", conflictPolicy: "ask_human" },
    });
    const validation = validateFlowGraph({ spec, roles, isGitRepo: true });
    expect(validation.ok).toBe(true);

    const flowId = "flow-wt-conflict";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["w1", "w2", "merge"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 1,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });

    const runner = {
      runRoleTurn: async (ctx: any) => {
        writeFileSync(path.join(ctx.cwd, "shared.txt"), ctx.nodeId === "w1" ? "from-w1\nline2\n" : "from-w2\nline2\n", "utf8");
        const ho = {
          id: `ho-${ctx.nodeId}`, mandateId: mandate.id, mandateRev: 1, parentHandoffId: null,
          fromRole: "dev", toTarget: "merge", verdict: "ready" as const, summary: `Edited by ${ctx.nodeId}`,
          artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
        };
        store.saveHandoff(ho);
        return { envelope: ho, observedCalls: [], assistantText: ho.summary, usage: null };
      },
    };

    const wtMgr = createGitWorktreeManager();
    const res = await executeFlowGraph({ cwd, store, flowId, mandate, spec, validation, roles, runner, worktreeManager: wtMgr });
    expect(res.status).toBe("waiting_input");
    expect(res.reason).toContain("shared.txt");
    expect(readFileSync(path.join(cwd, "shared.txt"), "utf8")).toBe("line1\nline2\n"); // Main tree untouched!
    await wtMgr.cleanupFlowWorktrees(cwd, flowId);
    store.close();
  });

  test("narrowed writableScope blocks out-of-scope edits as violation and L2 graph preflight rejects bad graphs", async () => {
    const { cwd, store } = initGitRepo();
    const roles = new Map<string, RoleSpec>([["dev", makeRole("dev", false)]]);

    // Preflight lint catches cyclic graph before execution
    const bad = buildAndValidateStartGraph({
      params: {
        nodes: [
          { id: "a", kind: "role", role: "dev", dependsOn: ["b"] },
          { id: "b", kind: "role", role: "dev", dependsOn: ["a"] },
        ],
      },
      goal: "bad", cwd, rolesMap: roles, defaultMaxRepairRounds: 2,
    });
    expect(bad.validation.ok).toBe(false);
    expect(bad.validation.issues.some((i) => i.code === "cycle_detected")).toBe(true);

    // Runtime hard enforcement: scoped to src/a.ts, writes src/b.ts -> violation!
    const spec = compileFanOutJoin({
      goal: "Scoped edit",
      shards: [{ id: "only-a", role: "dev", brief: "Only edit src/a.ts", writableScope: ["src/a.ts"], workspace: "inherit" }],
    });
    const val = validateFlowGraph({ spec, roles, isGitRepo: true });
    const flowId = "flow-scope-viol";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["only-a"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 1,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });
    const runner = {
      runRoleTurn: async (ctx: any) => {
        writeFileSync(path.join(ctx.cwd, "src", "b.ts"), "export const b = 999;\n", "utf8"); // out of writableScope!
        const ho = {
          id: "ho-viol", mandateId: mandate.id, mandateRev: 1, parentHandoffId: null,
          fromRole: "dev", toTarget: "user", verdict: "ready" as const, summary: "touched b",
          artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
        };
        return { envelope: ho, observedCalls: [], assistantText: "", usage: null };
      },
    };
    const res = await executeFlowGraph({ cwd, store, flowId, mandate, spec, validation: val, roles, runner });
    expect(res.status).toBe("violation");
    expect(res.reason).toContain("src/b.ts");
    store.close();
  });

  test("live GRAPH_PATCH dynamically appends downstream node mid-execution and DAG UI renders wave overview & concurrent status", async () => {
    const { cwd, store } = initGitRepo();
    const roles = new Map<string, RoleSpec>([
      ["planner", makeRole("planner", true)],
      ["reviewer", makeRole("reviewer", true)],
    ]);
    const spec = compileFanOutJoin({
      goal: "Dynamic patch & DAG UI test",
      shards: [
        { id: "scan-1", role: "planner", brief: "Scan 1" },
        { id: "scan-2", role: "planner", brief: "Scan 2" },
      ],
    });
    const val = validateFlowGraph({ spec, roles, isGitRepo: true });
    const flowId = "flow-live-patch";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["scan-1", "scan-2"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 1,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });

    let livePatch: ((patch: any, validated: any) => boolean) | null = null;
    let latestState: any = null;
    let midRunWidget = "";
    const ranNodes: string[] = [];

    const runner = {
      runRoleTurn: async (ctx: any) => {
        ranNodes.push(ctx.nodeId);
        if (ctx.nodeId === "scan-1" && latestState) {
          midRunWidget = renderConcurrentWidgetSummary(buildFlowGraphSnapshot(latestState)) ?? "";
          if (livePatch) {
            const patch = { addNodes: [{ id: "dyn-rev", kind: "role" as const, role: "reviewer", dependsOn: ["scan-1", "scan-2"] }] };
            const pv = validateGraphPatch({
              currentSpec: latestState.spec,
              nodeStatuses: Object.fromEntries(Object.entries(latestState.nodes).map(([k, v]: any) => [k, v.status])),
              patch, roles, isGitRepo: true,
            });
            expect(pv.ok).toBe(true);
            expect(livePatch(patch, pv)).toBe(true);
          }
        }
        const ho = {
          id: `ho-${ctx.nodeId}`, mandateId: mandate.id, mandateRev: 1, parentHandoffId: null,
          fromRole: ctx.role.id, toTarget: "user", verdict: "ready" as const, summary: `Done ${ctx.nodeId}`,
          artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
        };
        store.saveHandoff(ho);
        return { envelope: ho, observedCalls: [], assistantText: ho.summary, usage: null };
      },
    };

    const res = await executeFlowGraph({
      cwd, store, flowId, mandate, spec, validation: val, roles, runner,
      onStateChange: (st) => { latestState = st; },
      registerLivePatchHandler: (h) => { livePatch = h; },
    });

    expect(res.status).toBe("completed");
    expect(ranNodes).toContain("dyn-rev");
    expect(midRunWidget).toContain("并行中");
    const snap = buildFlowGraphSnapshot(res.finalState);
    const bar = renderWaveOverviewBar(snap, 120);
    expect(bar).toContain("W0[");
    expect(bar).toContain("W1[");
    expect(bar).toContain("dyn-rev");
    const inspector = renderGraphNodeInspectorSection(snap, 40).join("\n");
    expect(inspector).toContain("任务图");
    expect(inspector).toContain("dyn-rev");
    store.close();
  });
});
