import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EnhanceStore, ProjectBusyError } from "../../src/core/store.ts";
import type { RoleSpec } from "../../src/core/types.ts";
import { renderBoardContextForNode } from "../../src/flow/board.ts";
import { executeFlowGraph } from "../../src/flow/executor.ts";
import { compileExperimentLoop, compileFanOutJoin, compileLinearChain, validateFlowGraph } from "../../src/flow/graph.ts";
import { createOmpRoleSessionRunner } from "../../src/omp/session.ts";
import { FlowSessionPool } from "../../src/omp/session-pool.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function mkWorkspace(): { cwd: string; store: EnhanceStore } {
  const cwd = mkdtempSync(path.join(tmpdir(), "omp-enhance-p9-"));
  tmpDirs.push(cwd);
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

describe("Phase 2: Flow Board, Scoped Leases, Session Pool, Model Switch, and Zero-Token Gate", () => {
  test("scoped SQLite leases allow concurrent read Flows while keeping write_main exclusive", () => {
    const { store } = mkWorkspace();
    const r1 = store.acquireScopedFlowLease("flow-ro-1", "read");
    const r2 = store.acquireScopedFlowLease("flow-ro-2", "read");
    expect(r1.leaseKey).toBe("read:flow-ro-1");
    expect(r2.leaseKey).toBe("read:flow-ro-2");
    expect(store.listActiveFlowLeases().length).toBe(2);

    const w1 = store.acquireScopedFlowLease("flow-main-1", "write_main");
    expect(w1.leaseKey).toBe("active_flow");
    expect(() => store.acquireScopedFlowLease("flow-main-2", "write_main")).toThrow(ProjectBusyError);

    // Worktree write lease can coexist with read leases without colliding on active_flow
    const wt1 = store.acquireScopedFlowLease("flow-wt-1", "write_worktree");
    expect(wt1.leaseKey).toBe("worktree:flow-wt-1");

    store.releaseProjectFlowLease("flow-ro-1", r1.leaseToken);
    store.releaseProjectFlowLease("flow-main-1", w1.leaseToken);
    expect(store.listActiveFlowLeases().map((l) => l.flowId).sort()).toEqual(["flow-ro-2", "flow-wt-1"]);
    store.close();
  });

  test("zero-token gate rejects failing code, wakes warm dev session (createAgentSession called once!), and passes on repair", async () => {
    const { cwd, store } = mkWorkspace();
    const roles = new Map<string, RoleSpec>([["dev", makeRole("dev", false)]]);
    writeFileSync(path.join(cwd, "check.txt"), "broken\n", "utf8");

    let createCount = 0;
    let promptCount = 0;
    const pi = {
      getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }],
      pi: {
        createAgentSession: async (opts: any) => {
          createCount += 1;
          const handoffTool = opts.customTools.find((t: any) => t.name === "enhance_handoff");
          const session = {
            messages: [] as any[],
            prompt: async () => {
              promptCount += 1;
              if (promptCount === 1) {
                writeFileSync(path.join(cwd, "check.txt"), "still-broken\n", "utf8");
                await handoffTool.execute("tc-1", { verdict: "ready", summary: "First attempt" });
              } else {
                writeFileSync(path.join(cwd, "check.txt"), "OK\n", "utf8");
                await handoffTool.execute("tc-2", { verdict: "ready", summary: "Fixed check.txt to OK" });
              }
            },
            dispose: async () => {},
          };
          return { session };
        },
      },
    };

    const spec = compileExperimentLoop({
      goal: "Make check.txt contain OK",
      workerRole: "dev",
      workerBrief: "Edit check.txt",
      scorerCommand: 'grep -q "^OK$" check.txt',
      maxRounds: 2,
    });
    const validation = validateFlowGraph({ spec, roles, isGitRepo: false });
    expect(validation.ok).toBe(true);

    const flowId = "flow-gate-reuse";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["dev", "scorer-gate"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 2,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });

    const pool = new FlowSessionPool(pi, { cwd });
    const runner = createOmpRoleSessionRunner(pi, { cwd }, undefined, roles);
    const res = await executeFlowGraph({
      cwd, store, flowId, mandate, spec, validation, roles, runner, sessionPool: pool,
    });

    expect(res.status).toBe("completed");
    expect(res.finalState.repairRound).toBe(1);
    expect(createCount).toBe(1); // Warm session reused across repair round!
    expect(promptCount).toBe(2);
    expect(res.finalState.nodes["scorer-gate"]!.lastGateEvidence?.exitCode).toBe(0);
    expect(pool.hasWarm(flowId, "dev")).toBe(false); // Disposed cleanly on flow completion

    const board = store.listFlowBoardEvents(flowId);
    expect(board.some((e) => e.kind === "gate_result" && e.text.includes("FAIL"))).toBe(true);
    expect(board.some((e) => e.kind === "gate_result" && e.text.includes("PASS"))).toBe(true);
    expect(board.some((e) => e.kind === "repair_feedback" && e.target === "dev")).toBe(true);
    store.close();
  });

  test("stream stall triggers in-place session.setModel() switch and completes without losing session", async () => {
    const { cwd, store } = mkWorkspace();
    const roles = new Map<string, RoleSpec>([["planner", makeRole("planner", true)]]);

    let createCount = 0;
    const switchedTo: string[] = [];
    const pi = {
      getAllTools: () => [{ name: "read" }, { name: "grep" }],
      pi: {
        createAgentSession: async (opts: any) => {
          createCount += 1;
          const handoffTool = opts.customTools.find((t: any) => t.name === "enhance_handoff");
          let activeModel = "primary";
          let abortPending: (() => void) | null = null;
          const session = {
            messages: [] as any[],
            setModel: async (m: any) => { activeModel = String(m); switchedTo.push(activeModel); },
            abort: async () => { abortPending?.(); },
            prompt: async () => {
              if (activeModel === "primary") {
                // Simulate hung upstream stream until stall watchdog aborts it
                await new Promise<void>((resolve) => { abortPending = resolve; });
                return;
              }
              await handoffTool.execute("tc-ok", { verdict: "ready", summary: `Completed on ${activeModel}` });
            },
            dispose: async () => {},
          };
          return { session };
        },
      },
    };

    const spec = compileLinearChain([roles.get("planner")!], "Inspect with stall fallback");
    spec.nodes[0]!.sessionMode = "reuse";
    spec.nodes[0]!.fallbackModels = ["backup-model"];
    spec.nodes[0]!.stallTimeoutSec = 0.08; // 80ms for fast deterministic test
    const validation = validateFlowGraph({ spec, roles, isGitRepo: false });
    const flowId = "flow-stall-switch";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["planner"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 1,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });

    const pool = new FlowSessionPool(pi, { cwd });
    const runner = createOmpRoleSessionRunner(pi, { cwd }, undefined, roles);
    const res = await executeFlowGraph({
      cwd, store, flowId, mandate, spec, validation, roles, runner, sessionPool: pool,
    });

    expect(res.status).toBe("completed");
    expect(createCount).toBe(1);
    expect(switchedTo).toEqual(["backup-model"]);
    expect(res.finalEnvelope?.summary).toContain("backup-model");
    store.close();
  });

  test("parallel read-only fan-out writes shared Flow Board findings visible to downstream join node", async () => {
    const { cwd, store } = mkWorkspace();
    const roles = new Map<string, RoleSpec>([
      ["planner", makeRole("planner", true)],
      ["reviewer", makeRole("reviewer", true)],
    ]);
    const spec = compileFanOutJoin({
      goal: "Parallel audit",
      shards: [
        { id: "scan-a", role: "planner", brief: "Scan module A" },
        { id: "scan-b", role: "planner", brief: "Scan module B" },
      ],
      joinRole: { id: "rev", role: "reviewer" },
    });
    const validation = validateFlowGraph({ spec, roles, isGitRepo: false });
    const flowId = "flow-board-ctx";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["scan-a", "scan-b", "rev"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 1,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });

    let reviewerSawBoard = "";
    const runner = {
      runRoleTurn: async (ctx: any) => {
        if (ctx.nodeId === "rev") reviewerSawBoard = ctx.taskPrompt;
        const ho = {
          id: `ho-${ctx.nodeId}`, mandateId: mandate.id, mandateRev: 1, parentHandoffId: null,
          fromRole: ctx.role.id, toTarget: ctx.toTarget, verdict: "ready" as const,
          summary: `Finding from ${ctx.nodeId}`, artifacts: [], verifiedFacts: [], openRisks: [],
          feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
        };
        store.saveHandoff(ho);
        return { envelope: ho, observedCalls: [], assistantText: ho.summary, usage: null };
      },
    };

    const res = await executeFlowGraph({ cwd, store, flowId, mandate, spec, validation, roles, runner });
    expect(res.status).toBe("completed");
    expect(reviewerSawBoard).toContain("Finding from scan-a");
    expect(reviewerSawBoard).toContain("Finding from scan-b");
    const rendered = renderBoardContextForNode({ store, flowId, nodeSpec: spec.nodes[2]! });
    expect(rendered).toContain("Shared Flow Board");
    store.close();
  });
});
