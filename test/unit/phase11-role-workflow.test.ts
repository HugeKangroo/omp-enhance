import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkToolCallAllowed } from "../../src/core/policy.ts";
import { EnhanceStore } from "../../src/core/store.ts";
import type { RoleSpec } from "../../src/core/types.ts";
import { executeFlowGraph } from "../../src/flow/executor.ts";
import { compileLinearChain, validateFlowGraph } from "../../src/flow/graph.ts";
import { buildFlowGraphSnapshot } from "../../src/flow/machine.ts";
import { createOmpRoleSessionRunner } from "../../src/omp/session.ts";
import { FlowSessionPool } from "../../src/omp/session-pool.ts";
import { ForegroundWorkflowController } from "../../src/omp/workflow-fg.ts";
import { cloneRoleSpec, discoverRoles, parseRoleYaml, serializeRoleYaml } from "../../src/roles/loader.ts";
import { renderGraphNodeInspectorSection, renderWaveOverviewBar } from "../../src/ui/flow-graph-view.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function mkWorkspace(): { cwd: string; store: EnhanceStore } {
  const cwd = mkdtempSync(path.join(tmpdir(), "omp-enhance-p11-"));
  tmpDirs.push(cwd);
  return { cwd, store: new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite")) };
}

function makeWorkflowRole(id = "algo-wf"): RoleSpec {
  const yaml = `
id: ${id}
name: Workflow Algo
description: Test role with 2-level workflow
stance: Work strictly by phases.
method:
  - Follow workflow phases
permissions:
  tools: ["read", "write", "edit", "bash"]
  writable: ["work/**"]
  protected: [".git/**"]
exit:
  require_tool_evidence: false
  criteria:
    - Done
workflow:
  session: reuse
  repair_entry: iterate
  max_repair_rounds: 2
  phases:
    - id: audit
      title: Audit Data
      tools: ["read", "write"]
      writable: ["work/bench/**"]
      exit_artifacts: ["work/bench/profile.json"]
      brief: Write work/bench/profile.json
    - id: align
      title: Align Metric
      kind: human
      prompt: "Confirm target metric?"
    - id: baseline
      title: Baseline
      writable: ["work/**"]
      exit_artifacts: ["work/bench/eval.py"]
      brief: Write work/bench/eval.py
    - id: iterate
      title: Iterate
      writable: ["work/runs/**"]
      lock_protected: ["work/bench/eval.py"]
      exit_gate:
        command: 'grep -q "score=0.9" work/runs/result.txt'
      brief: Improve model without touching work/bench/eval.py
    - id: deliver
      title: Deliver
      writable: ["work/best/**"]
      exit_artifacts: ["work/best/README.md"]
      brief: Write work/best/README.md
`;
  return parseRoleYaml(yaml, "project", `/tmp/${id}.yaml`);
}

function makeReviewer(): RoleSpec {
  return {
    id: "reviewer", name: "Reviewer", description: "Blind review", stance: "Review", method: ["Check"],
    permissions: { tools: ["read", "grep"], writable: [], protected: ["**"] },
    exit: { requireToolEvidence: false, criteria: [] },
    source: "builtin", filePath: "/tmp/reviewer.yaml", contentSha256: "rev",
  };
}

describe("Phase 11: 2-Level Isomorphic Route A (Role-Internal Workflow FSM)", () => {
  test("parses built-in algo.yaml workflow, round-trips YAML serialization & clone, and rejects illegal workflow specs", () => {
    const { cwd } = mkWorkspace();
    const roles = discoverRoles({ cwd });
    const algo = roles.get("algo")!;
    expect(algo.workflow?.phases.map((p) => p.id)).toEqual(["audit", "align_metric", "baseline", "iterate", "deliver"]);
    expect(algo.workflow?.repairEntry).toBe("iterate");

    // Round-trip serialize + parse
    const serialized = serializeRoleYaml(algo);
    const reparsed = parseRoleYaml(serialized, "builtin", algo.filePath);
    expect(reparsed.workflow).toEqual(algo.workflow);
    expect(reparsed.contentSha256).toBe(algo.contentSha256);

    // Clone preserves workflow
    const cloned = cloneRoleSpec({ sourceRole: algo, newId: "algo-custom", targetDir: path.join(cwd, ".omp", "roles") });
    expect(cloned.role.workflow?.phases.length).toBe(5);

    // Reject unknown workflow key
    expect(() =>
      parseRoleYaml(`id: bad\nstance: s\nmethod: [m]\nworkflow:\n  typo_key: 1\n  phases:\n    - id: p1\n`, "project", "/tmp/bad.yaml"),
    ).toThrow(/Unknown workflow field/);

    // Reject privilege escalation (phase tool outside base role)
    expect(() =>
      parseRoleYaml(
        `id: bad2\nstance: s\nmethod: [m]\npermissions:\n  tools: ["read"]\n  writable: []\nworkflow:\n  phases:\n    - id: p1\n      tools: ["read", "bash"]\n`,
        "project", "/tmp/bad2.yaml",
      ),
    ).toThrow(/outside base role/);

    // Reject cycle in phase depends_on
    expect(() =>
      parseRoleYaml(
        `id: cyc\nstance: s\nmethod: [m]\nworkflow:\n  phases:\n    - id: a\n      depends_on: ["b"]\n    - id: b\n      depends_on: ["a"]\n`,
        "project", "/tmp/cyc.yaml",
      ),
    ).toThrow(/Cycle detected/);
  });

  test("2-level execution shares 1 warm session across phases, bubbles human pause, isolates inner gate retries, and jumps directly to repair_entry on outer rejection", async () => {
    const { cwd, store } = mkWorkspace();
    const algoWf = makeWorkflowRole("algo-wf");
    const reviewer = makeReviewer();
    const roles = new Map<string, RoleSpec>([["algo-wf", algoWf], ["reviewer", reviewer]]);

    let algoSessionCreates = 0;
    const executedPhases: string[] = [];
    const activeToolUpdates: string[][] = [];
    let iterateCalls = 0;
    let reviewerCalls = 0;

    const pi = {
      getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }, { name: "grep" }],
      pi: {
        createAgentSession: async (opts: any) => {
          const isRev = opts.customSystemPrompt.includes("Active Role: reviewer");
          if (!isRev) algoSessionCreates += 1;
          const handoffTool = opts.customTools.find((t: any) => t.name === "enhance_handoff");
          const session = {
            messages: [] as any[],
            setActiveTools: async (tools: string[]) => { activeToolUpdates.push([...tools]); },
            prompt: async (promptText: string) => {
              if (isRev) {
                reviewerCalls += 1;
                if (reviewerCalls === 1) {
                  await handoffTool.execute("r-1", { verdict: "rejected", summary: "Need final polish", feedbackForUpstream: "Polish README metrics" });
                } else {
                  await handoffTool.execute("r-2", { verdict: "ready", summary: "Approved after targeted repair" });
                }
                return;
              }
              if (promptText.includes("Phase 1/5: audit")) {
                executedPhases.push("audit");
                mkdirSync(path.join(cwd, "work", "bench"), { recursive: true });
                writeFileSync(path.join(cwd, "work", "bench", "profile.json"), '{"rows":100}\n', "utf8");
                await handoffTool.execute("p-1", { verdict: "ready", summary: "Audit done" });
              } else if (promptText.includes("Phase 3/5: baseline")) {
                executedPhases.push("baseline");
                writeFileSync(path.join(cwd, "work", "bench", "eval.py"), "print('eval v1')\n", "utf8");
                await handoffTool.execute("p-3", { verdict: "ready", summary: "Baseline done" });
              } else if (promptText.includes("Phase 4/5: iterate")) {
                executedPhases.push("iterate");
                iterateCalls += 1;
                mkdirSync(path.join(cwd, "work", "runs"), { recursive: true });
                // First iterate attempt fails inner gate (score=0.5), proving inner retry budget does NOT consume outer budget!
                writeFileSync(path.join(cwd, "work", "runs", "result.txt"), iterateCalls === 1 ? "score=0.5\n" : "score=0.95\n", "utf8");
                await handoffTool.execute("p-4", { verdict: "ready", summary: `Iterate #${iterateCalls}` });
              } else if (promptText.includes("Phase 5/5: deliver")) {
                executedPhases.push("deliver");
                mkdirSync(path.join(cwd, "work", "best"), { recursive: true });
                writeFileSync(path.join(cwd, "work", "best", "README.md"), `# Best (iter ${iterateCalls})\n`, "utf8");
                await handoffTool.execute("p-5", { verdict: "ready", summary: "Delivered" });
              }
            },
            dispose: async () => {},
          };
          return { session };
        },
      },
    };

    const spec = compileLinearChain([algoWf, reviewer], "Optimize model end-to-end", { maxRepairRounds: 1 });
    const validation = validateFlowGraph({ spec, roles, isGitRepo: false });
    const flowId = "flow-2level";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["algo-wf", "reviewer"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 1,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });

    const pool = new FlowSessionPool(pi, { cwd });
    const runner = createOmpRoleSessionRunner(pi, { cwd }, undefined, roles);

    // Run 1: executes audit -> pauses at inner human phase `align` -> bubbles waiting_input to outer flow!
    const res1 = await executeFlowGraph({ cwd, store, flowId, mandate, spec, validation, roles, runner, sessionPool: pool });
    expect(res1.status).toBe("waiting_input");
    expect(res1.reason).toContain("Confirm target metric?");
    expect(executedPhases).toEqual(["audit"]);

    // Verify 2-level UI projection while paused
    const midSnap = buildFlowGraphSnapshot(res1.finalState);
    expect(renderWaveOverviewBar(midSnap, 120)).toContain("algo-wf(1/6:align)");
    expect(renderGraphNodeInspectorSection(midSnap, 48).join("\n")).toContain("✓ audit");

    // Run 2: resume outer flow -> drills into align -> baseline -> iterate(fail gate -> retry pass) -> deliver -> reviewer rejects -> outer repair jumps directly to `iterate` (skipping audit & baseline!) -> deliver -> reviewer approves!
    const res2 = await executeFlowGraph({
      cwd, store, flowId, mandate, spec, validation, roles, runner, sessionPool: pool,
      initialState: res1.finalState, resumeReplyText: "Optimize F1 >= 0.9",
    });
    expect(res2.status).toBe("completed");
    expect(algoSessionCreates).toBe(1); // ONE single warm OMP session shared across all phases AND outer repair!
    expect(activeToolUpdates.length).toBeGreaterThanOrEqual(3); // setActiveTools synced dynamically across phases
    expect(executedPhases).toEqual(["audit", "baseline", "iterate", "iterate", "deliver", "iterate", "deliver"]);
    expect(res2.finalState.repairRound).toBe(1); // Inner gate retry did NOT consume outer repairRound!
    expect(pool.hasWarm(flowId, "algo-wf")).toBe(false); // Cleanly disposed on outer completion
    store.close();
  });

  test("cumulative lock_protected physically blocks tampering with eval.py in iterate phase (both background and foreground /role)", async () => {
    const { cwd, store } = mkWorkspace();
    const algoWf = makeWorkflowRole("algo-lock");
    const roles = new Map<string, RoleSpec>([["algo-lock", algoWf]]);

    // 1. Background 2-level execution: tampering with locked work/bench/eval.py during iterate triggers violation!
    const spec = compileLinearChain([algoWf], "Tamper test");
    const val = validateFlowGraph({ spec, roles, isGitRepo: false });
    const flowId = "flow-lock-viol";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["algo-lock"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 1,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });

    const runner = {
      runRoleTurn: async (ctx: any) => {
        if (ctx.nodeId === "audit") {
          mkdirSync(path.join(cwd, "work", "bench"), { recursive: true });
          writeFileSync(path.join(cwd, "work", "bench", "profile.json"), "{}\n", "utf8");
        } else if (ctx.nodeId === "baseline") {
          writeFileSync(path.join(cwd, "work", "bench", "eval.py"), "print('v1')\n", "utf8");
        } else if (ctx.nodeId === "iterate") {
          // Illegal tamper on locked eval.py!
          writeFileSync(path.join(cwd, "work", "bench", "eval.py"), "print('cheated')\n", "utf8");
        }
        const ho = {
          id: `ho-${ctx.nodeId}`, mandateId: mandate.id, mandateRev: 1, parentHandoffId: null,
          fromRole: ctx.role.id, toTarget: ctx.toTarget, verdict: "ready" as const, summary: `ok ${ctx.nodeId}`,
          artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
        };
        store.saveHandoff(ho);
        return { envelope: ho, observedCalls: [], assistantText: "", usage: null };
      },
    };
    const r1 = await executeFlowGraph({ cwd, store, flowId, mandate, spec, validation: val, roles, runner });
    expect(r1.status).toBe("waiting_input");
    const r2 = await executeFlowGraph({ cwd, store, flowId, mandate, spec, validation: val, roles, runner, initialState: r1.finalState, resumeReplyText: "ok" });
    expect(r2.status).toBe("violation");
    expect(r2.reason).toContain("work/bench/eval.py");

    // 2. Foreground single-agent /role workflow progression + lock_protected enforcement
    const fg = new ForegroundWorkflowController();
    const sid = "fg-sess-1";
    const p1 = fg.getActivePhaseContext(sid, cwd, algoWf, "FG test")!;
    expect(p1.phaseId).toBe("audit");
    // In audit phase, bash is narrowed out (tools: ["read", "write"])
    expect(checkToolCallAllowed(cwd, p1.effectiveRole, { toolName: "bash", input: { command: "ls" } }).block).toBe(true);

    const mkHo = (s: string) => ({
      id: `fg-${s}`, mandateId: "m", mandateRev: 1, parentHandoffId: null, fromRole: algoWf.id, toTarget: "user",
      verdict: "ready" as const, summary: s, artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
    });
    const adv1 = fg.onPhaseHandoff({ sessionId: sid, cwd, role: algoWf, handoff: mkHo("audit") });
    expect(adv1.advanced).toBe(true);
    expect(adv1.humanPrompt).toContain("Confirm target metric?");

    // Next foreground turn without explicit confirmation (e.g. asking "现在进度如何？") MUST stay in human gate `align` (read-only)!
    const p2StillWaiting = fg.getActivePhaseContext(sid, cwd, algoWf, "FG test", true)!;
    expect(p2StillWaiting.phaseId).toBe("align");
    expect(p2StillWaiting.waitingHumanPrompt).toContain("Confirm target metric?");
    expect(checkToolCallAllowed(cwd, p2StillWaiting.effectiveRole, { toolName: "write", input: { path: "work/bench/eval.py", content: "x" } }).block).toBe(true);

    // Explicit user confirmation via enhance_handoff advances past human gate to baseline
    const adv2 = fg.onPhaseHandoff({ sessionId: sid, cwd, role: algoWf, handoff: mkHo("User confirmed F1 >= 0.9") });
    expect(adv2.advanced).toBe(true);
    expect(adv2.nextPhaseId).toBe("baseline");
    const p3 = fg.getActivePhaseContext(sid, cwd, algoWf, "FG test")!;
    expect(p3.phaseId).toBe("baseline");
    const adv3 = fg.onPhaseHandoff({ sessionId: sid, cwd, role: algoWf, handoff: mkHo("baseline") });
    expect(adv3.nextPhaseId).toBe("iterate");

    // In iterate phase, work/bench/eval.py is physically locked by lock_protected!
    const p4 = fg.getActivePhaseContext(sid, cwd, algoWf, "FG test")!;
    expect(p4.lockedProtected).toContain("work/bench/eval.py");
    const tamperDecision = checkToolCallAllowed(cwd, p4.effectiveRole, { toolName: "write", input: { path: "work/bench/eval.py", content: "hack" } });
    expect(tamperDecision.block).toBe(true);
    expect(tamperDecision.reason).toContain("protected");
    store.close();
  });
});
