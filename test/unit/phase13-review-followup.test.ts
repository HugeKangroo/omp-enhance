import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FlowGraphSpec, FlowMachineState } from "../../src/core/graph-types.ts";
import { EnhanceStore } from "../../src/core/store.ts";
import type { HandoffEnvelope, ObservedToolCall, RoleSpec } from "../../src/core/types.ts";
import ompEnhance from "../../src/entry.ts";
import { executeFlowGraph } from "../../src/flow/executor.ts";
import { compileFanOutJoin, normalizePolicies, validateFlowGraph, validateGraphPatch } from "../../src/flow/graph.ts";
import { createAndVerifyHandoff } from "../../src/flow/handoff.ts";
import type { RoleSessionRunner } from "../../src/flow/orchestrator.ts";
import { createGitWorktreeManager } from "../../src/flow/worktree.ts";
import { computeSettlementKey } from "../../src/omp/hub.ts";
import { renderRoomCardLines } from "../../src/ui/flow-room.ts";

const BUILTIN_ROLES_DIR = path.resolve(import.meta.dir, "../../roles");
const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `omp-p13-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeText(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function git(cwd: string, args: readonly string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return (res.stdout ?? "").trimEnd();
}

function initGitRepo(files: Record<string, string>, opts?: { skipInitialAdd?: string[] }): { cwd: string; store: EnhanceStore } {
  const cwd = makeTmpDir("git");
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "user.email", "test@local"]);
  const skip = new Set(opts?.skipInitialAdd ?? []);
  for (const [rel, body] of Object.entries(files)) {
    if (!skip.has(rel)) writeText(path.join(cwd, rel), body);
  }
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "init"]);
  for (const rel of skip) writeText(path.join(cwd, rel), files[rel]!);
  const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
  return { cwd, store };
}

function makeRole(id: string, overrides?: Partial<RoleSpec>): RoleSpec {
  return {
    id, name: id, description: id, source: "builtin", filePath: `/tmp/${id}.yaml`, contentSha256: `sha-${id}`,
    model: "inherit", method: ["Execute cleanly"],
    permissions: { tools: ["read", "write", "edit", "bash"], writable: ["**"], protected: [".git/**"] },
    exit: { requireToolEvidence: false, criteria: [] }, stance: `role ${id}`,
    ...overrides,
  };
}

function makeHarness(opts: {
  cwd: string; globalDir: string; lockPath: string;
  runnerFactory?: () => RoleSessionRunner;
}) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const sentMessages: Array<{ msg: any; opts: any }> = [];
  const pi: any = {
    cwd: opts.cwd,
    on(ev: string, fn: any) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
    registerTool(t: any) { tools.set(t.name, t); },
    registerCommand(name: string, cmd: any) { commands.set(name, cmd); },
    registerMessageRenderer() {},
    getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }],
    setActiveTools: async () => {},
    sendMessage(msg: any, sendOpts: any) { sentMessages.push({ msg, opts: sendOpts }); },
  };
  ompEnhance(pi, {
    builtinRolesDir: BUILTIN_ROLES_DIR, globalRolesDir: opts.globalDir, pluginLockPath: opts.lockPath,
    ...(opts.runnerFactory ? { runnerFactory: opts.runnerFactory } : {}),
  });
  return {
    tools, commands, sentMessages,
    async emit(ev: string, payload: any, ctx: any) {
      let last: any;
      for (const fn of handlers.get(ev) ?? []) last = await fn(payload, ctx);
      return last;
    },
  };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch {}
  }
});

describe("Phase 13: Follow-up Review (All 13 Findings + Flattened DAG + E2E)", () => {
  test("A1: empty backend resume is rejected without fabricated text; foreground status query and same-turn double-approval stay paused", async () => {
    const cwd = makeTmpDir("a1");
    const globalDir = makeTmpDir("a1-global");
    const lockPath = path.join(makeTmpDir("a1-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));

    writeText(path.join(globalDir, "two-gates.yaml"), `id: two-gates
name: Two Gates
description: Two consecutive human gates
model: inherit
method:
  - Follow workflow phases strictly
stance: Execute cleanly after approvals.
permissions:
  tools: ["read", "write"]
  writable: ["out/**"]
  protected: [".git/**"]
exit:
  require_tool_evidence: false
  criteria: []
workflow:
  session: reuse
  phases:
    - id: gate1
      kind: human
      prompt: "第一关：请确认方案？"
    - id: gate2
      kind: human
      prompt: "第二关：请确认预算？"
    - id: work
      brief: Write out/done.txt
`);

    let workerRuns = 0;
    const h = makeHarness({
      cwd, globalDir, lockPath,
      runnerFactory: () => ({
        runRoleTurn: async (ctx) => {
          workerRuns += 1;
          writeText(path.join(ctx.cwd, "out", "done.txt"), "ok\n");
          const ho = createAndVerifyHandoff({ store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: "done" });
          return { envelope: ho, observedCalls: [], assistantText: "done", usage: null };
        },
      }),
    });
    const ctx = { cwd, hasUI: false };

    // 1. Backend: start -> paused at gate1; empty/whitespace resume MUST fail and NEVER write "已确认放行"
    const s1 = JSON.parse((await h.tools.get("enhance_flow")!.execute("s1", {
      action: "start", roles: ["two-gates"], goal: "Test A1", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(s1.status).toBe("waiting_input");
    const flowId = JSON.parse((await h.tools.get("enhance_flow")!.execute("st1", { action: "status" }, null, null, ctx)).content[0].text).flowId as string;

    const emptyRes = await h.tools.get("enhance_flow")!.execute("r-empty", {
      action: "resume", flowId, nodeId: "two-gates__gate1", wait: true,
    }, null, null, ctx);
    expect(emptyRes.isError).toBe(true);
    expect(JSON.parse(emptyRes.content[0].text).requiresReply).toBe(true);

    const wsRes = await h.tools.get("enhance_flow")!.execute("r-ws", {
      action: "resume", flowId, nodeId: "two-gates__gate1", message: "   ", wait: true,
    }, null, null, ctx);
    expect(wsRes.isError).toBe(true);
    expect(workerRuns).toBe(0);

    // Explicit approval advances gate1 ONLY -> pauses at gate2, recording verbatim reply
    const okG1 = JSON.parse((await h.tools.get("enhance_flow")!.execute("r-g1", {
      action: "resume", flowId, nodeId: "two-gates__gate1", message: "同意方案一", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(okG1.status).toBe("waiting_input");
    expect(okG1.reason).toContain("第二关");
    expect(workerRuns).toBe(0);

    const storeCheck = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    try {
      const boardTexts = storeCheck.listFlowBoardEvents(flowId).map((e) => e.text);
      expect(boardTexts.join("\n")).toContain("同意方案一");
      expect(boardTexts.join("\n")).not.toContain("已确认放行");
    } finally { storeCheck.close(); }

    // 2. Foreground: activate /role two-gates, ask "现在进度如何" -> double enhance_handoff(ready) stays blocked on gate1!
    const fgEntries: any[] = [];
    const fgCtx: any = {
      cwd, hasUI: false,
      sessionManager: { getSessionId: () => "fg-a1", getBranch: () => fgEntries, getEntries: () => fgEntries },
    };
    await h.commands.get("role")!.handler("two-gates --foreground", fgCtx);
    fgEntries.push({ id: "u1", type: "message", message: { role: "user", content: "启动两关任务" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, fgCtx);

    // User asks progress WITHOUT question mark
    fgEntries.push({ id: "u2", type: "message", message: { role: "user", content: "现在进度如何" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, fgCtx);
    const bad1 = await h.tools.get("enhance_handoff")!.execute("h1", { verdict: "ready", summary: "汇报进度" }, null, null, fgCtx);
    const bad2 = await h.tools.get("enhance_handoff")!.execute("h2", { verdict: "ready", summary: "再汇报一次" }, null, null, fgCtx);
    expect(bad1.isError).toBe(true);
    expect(bad2.isError).toBe(true);
    expect(JSON.parse(bad1.content[0].text).error).toMatch(/status\/progress query/i);
    expect(JSON.parse(bad2.content[0].text).error).toMatch(/status\/progress query/i);

    // User explicitly confirms gate1 -> advances ONLY gate1; second ready in same turn is BLOCKED on gate2!
    fgEntries.push({ id: "u3", type: "message", message: { role: "user", content: "同意第一关方案" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, fgCtx);
    const passG1 = await h.tools.get("enhance_handoff")!.execute("h3", { verdict: "ready", summary: "用户已同意" }, null, null, fgCtx);
    expect(passG1.isError).toBeUndefined();
    const passG1Json = JSON.parse(passG1.content[0].text);
    expect(passG1Json.workflowProgress).toMatchObject({ advanced: true, nextPhaseId: "gate2", userReply: "同意第一关方案" });

    const dupSameTurn = await h.tools.get("enhance_handoff")!.execute("h4", { verdict: "ready", summary: "试图连过第二关" }, null, null, fgCtx);
    expect(dupSameTurn.isError).toBe(true);
    expect(JSON.parse(dupSameTurn.content[0].text).error).toMatch(/same-turn or duplicate/i);

    // Next explicit turn unlocks gate2 -> enters work
    fgEntries.push({ id: "u4", type: "message", message: { role: "user", content: "批准预算上限 100" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, fgCtx);
    const passG2 = await h.tools.get("enhance_handoff")!.execute("h5", { verdict: "ready", summary: "第二关通过" }, null, null, fgCtx);
    expect(passG2.isError).toBeUndefined();
    expect(JSON.parse(passG2.content[0].text).workflowProgress).toMatchObject({ advanced: true, nextPhaseId: "work", userReply: "批准预算上限 100" });

    await h.emit("session_shutdown", {}, ctx);
  });

  test("A2: parallel human phases inside a single role flatten to stable nodeIds, reject ambiguous resume, and preserve both verbatim replies", async () => {
    const cwd = makeTmpDir("a2");
    const globalDir = makeTmpDir("a2-global");
    const lockPath = path.join(makeTmpDir("a2-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));

    writeText(path.join(globalDir, "dual-ask.yaml"), `id: dual-ask
name: Dual Ask
description: Parallel internal questions
model: inherit
method:
  - Ask both questions before working
stance: Collect both answers before execution.
permissions:
  tools: ["read", "write"]
  writable: ["out/**"]
  protected: [".git/**"]
exit:
  require_tool_evidence: false
  criteria: []
workflow:
  session: reuse
  phases:
    - id: ask_a
      kind: human
      depends_on: []
      prompt: "问题A：选哪套特征集？"
    - id: ask_b
      kind: human
      depends_on: []
      prompt: "问题B：最大训练时长？"
    - id: work
      depends_on: ["ask_a", "ask_b"]
      brief: Run experiment with both answers
`);

    let capturedPrompt = "";
    const h = makeHarness({
      cwd, globalDir, lockPath,
      runnerFactory: () => ({
        runRoleTurn: async (ctx) => {
          capturedPrompt = ctx.taskPrompt ?? "";
          const ho = createAndVerifyHandoff({ store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: "used both answers" });
          return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
        },
      }),
    });
    const ctx = { cwd, hasUI: false };

    const startRes = JSON.parse((await h.tools.get("enhance_flow")!.execute("s", {
      action: "start", roles: ["dual-ask"], goal: "Parallel role questions", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(startRes.status).toBe("waiting_input");
    const listRes = JSON.parse((await h.tools.get("enhance_flow")!.execute("l", { action: "list" }, null, null, ctx)).content[0].text);
    const flow = listRes.flows[0];
    expect(flow.waitingNodes.map((w: any) => w.nodeId)).toEqual(["dual-ask__ask_a", "dual-ask__ask_b"]);

    // Ambiguous resume without nodeId fails
    const ambig = await h.tools.get("enhance_flow")!.execute("r0", { action: "resume", flowId: flow.flowId, message: "答复", wait: true }, null, null, ctx);
    expect(ambig.isError).toBe(true);
    expect(JSON.parse(ambig.content[0].text).requiresNodeId).toBe(true);

    // Answer A first -> still waiting_input for B only
    const ansA = JSON.parse((await h.tools.get("enhance_flow")!.execute("r1", {
      action: "resume", flowId: flow.flowId, nodeId: "dual-ask__ask_a", message: "采用特征集 V2", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(ansA.status).toBe("waiting_input");
    const listMid = JSON.parse((await h.tools.get("enhance_flow")!.execute("l2", { action: "list" }, null, null, ctx)).content[0].text);
    expect(listMid.flows[0].waitingNodes.map((w: any) => w.nodeId)).toEqual(["dual-ask__ask_b"]);

    // Answer B -> runs work and completes with both verbatim replies on the board
    const ansB = JSON.parse((await h.tools.get("enhance_flow")!.execute("r2", {
      action: "resume", flowId: flow.flowId, nodeId: "dual-ask__ask_b", message: "最多 20 分钟", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(ansB.status).toBe("completed");
    expect(capturedPrompt).toContain("采用特征集 V2");
    expect(capturedPrompt).toContain("最多 20 分钟");
    await h.emit("session_shutdown", {}, ctx);
  });

  test("A3: consecutive human gates emit distinct coordinator notifications while identical gate settlement stays deduplicated", async () => {
    const cwd = makeTmpDir("a3");
    const globalDir = makeTmpDir("a3-global");
    const lockPath = path.join(makeTmpDir("a3-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));

    const h = makeHarness({ cwd, globalDir, lockPath });
    const ctx = { cwd, hasUI: true, isIdle: () => true };

    await h.tools.get("enhance_flow")!.execute("s", {
      action: "start", goal: "Consecutive human gates",
      nodes: [
        { id: "h1", kind: "human", dependsOn: [], human: { prompt: "确认第一步？" } },
        { id: "h2", kind: "human", dependsOn: ["h1"], human: { prompt: "确认第二步？" } },
      ],
    }, null, null, ctx);

    const eventMsgs = () => h.sentMessages.filter((m) => m.msg?.customType === "omp-enhance-flow-event");
    for (let i = 0; i < 40 && eventMsgs().length < 1; i++) await Bun.sleep(15);
    expect(eventMsgs()).toHaveLength(1);
    expect(eventMsgs()[0]!.msg.content).toContain("确认第一步？");

    const flowId = JSON.parse((await h.tools.get("enhance_flow")!.execute("l1", { action: "list" }, null, null, ctx)).content[0].text).flows[0].flowId as string;
    const snap1 = JSON.parse((await h.tools.get("enhance_flow")!.execute("st1", { action: "status", flowId }, null, null, ctx)).content[0].text);
    const key1a = computeSettlementKey(snap1);
    const key1b = computeSettlementKey(snap1);
    expect(key1a).toBe(key1b);

    // Resume h1 -> hits h2 -> MUST emit a 2nd notification despite 0 role stages!
    await h.tools.get("enhance_flow")!.execute("r1", {
      action: "resume", flowId, nodeId: "h1", message: "第一步同意",
    }, null, null, ctx);
    for (let i = 0; i < 40 && eventMsgs().length < 2; i++) await Bun.sleep(15);
    expect(eventMsgs()).toHaveLength(2);
    expect(eventMsgs()[1]!.msg.content).toContain("确认第二步？");
    const snap2 = JSON.parse((await h.tools.get("enhance_flow")!.execute("st2", { action: "status", flowId }, null, null, ctx)).content[0].text);
    expect(computeSettlementKey(snap2)).not.toBe(key1a);

    // Resume h2 -> completes -> emits 3rd notification
    await h.tools.get("enhance_flow")!.execute("r2", {
      action: "resume", flowId, nodeId: "h2", message: "第二步同意",
    }, null, null, ctx);
    for (let i = 0; i < 40 && eventMsgs().length < 3; i++) await Bun.sleep(15);
    expect(eventMsgs()).toHaveLength(3);
    expect(eventMsgs()[2]!.msg.content).toContain("completed");
    await h.emit("session_shutdown", {}, ctx);
  });

  test("A4: earlier dead-owner running checkpoint is reclaimed and resumed by flowId without touching newer Flow or live scoped lease", async () => {
    const cwd = makeTmpDir("a4");
    const globalDir = makeTmpDir("a4-global");
    const lockPath = path.join(makeTmpDir("a4-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));

    const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    const m1 = store.upsertMandate({ goal: "Older crashed flow", flowId: "flow-old" });
    const hoS1: HandoffEnvelope = {
      id: "ho-old-s1", mandateId: m1.id, mandateRev: 1, parentHandoffId: null, fromRole: "planner", toTarget: "s2",
      verdict: "ready", summary: "s1 done before crash", artifacts: [], verifiedFacts: [], openRisks: [],
      feedbackForUpstream: null, observedUsage: null, createdAt: "2026-11-26T00:00:01Z",
    };
    store.saveHandoff(hoS1);
    const oldMachine: FlowMachineState = {
      flowId: "flow-old", mandateId: m1.id, cwd, status: "running",
      spec: {
        version: 1, goal: "Older crashed flow", preset: "custom",
        nodes: [
          { id: "s1", kind: "role", role: "planner", dependsOn: [] },
          { id: "s2", kind: "role", role: "reviewer", dependsOn: ["s1"] },
        ],
        policies: normalizePolicies({}),
      },
      nodes: {
        s1: {
          nodeId: "s1", status: "succeeded", waveIndex: 0, effectiveWorkspace: "inherit", sessionResidency: "none",
          attempt: 1, repairRound: 0, activeStageId: "st-1", worktreePath: null, commitRef: null, currentModel: null,
          triedModels: [], lastHandoffId: hoS1.id, lastHandoff: hoS1, lastGateEvidence: null, lastError: null,
          lastRepairFeedback: null, questionsForUser: [], startedAt: "2026-11-26T00:00:00Z", endedAt: "2026-11-26T00:00:01Z",
        },
        s2: {
          nodeId: "s2", status: "running", waveIndex: 1, effectiveWorkspace: "inherit", sessionResidency: "none",
          attempt: 1, repairRound: 0, activeStageId: "st-2", worktreePath: null, commitRef: null, currentModel: null,
          triedModels: [], lastHandoffId: null, lastHandoff: null, lastGateEvidence: null, lastError: null,
          lastRepairFeedback: null, questionsForUser: [], startedAt: "2026-11-26T00:00:02Z", endedAt: null,
        },
      },
      nodeOrder: ["s1", "s2"], waves: [["s1"], ["s2"]], repairRound: 0, maxRepairRounds: 1, lastRejectionSig: null,
      nextStageSeq: 2, boardSeq: 0, initialHandoffId: null, lastHandoffId: hoS1.id, mergedRef: null,
      startedAt: "2026-11-26T00:00:00Z", endedAt: null,
    };
    store.saveFlowCheckpoint({
      flowId: "flow-old", mandateId: m1.id, goal: "Older crashed flow", cwd, roleChain: ["planner", "reviewer"],
      status: "running", currentIndex: 1, repairRound: 0, lastHandoffId: hoS1.id, maxRepairRounds: 1,
      ownerPid: 99999991, ownerStartToken: "dead-owner", snapshotJson: JSON.stringify({ flowId: "flow-old", status: "running", roleChain: ["planner", "reviewer"], stages: [] }),
      graphSpecJson: JSON.stringify(oldMachine.spec), machineStateJson: JSON.stringify(oldMachine), leaseMode: "read",
      updatedAt: "2026-11-26T00:00:05Z",
    });

    // Newer Flow 2 with its own live read lease!
    const m2 = store.upsertMandate({ goal: "Newer flow", flowId: "flow-new" });
    store.saveFlowCheckpoint({
      flowId: "flow-new", mandateId: m2.id, goal: "Newer flow", cwd, roleChain: ["reviewer"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 1,
      ownerPid: process.pid, snapshotJson: JSON.stringify({ flowId: "flow-new", status: "running", roleChain: ["reviewer"], stages: [] }),
      leaseMode: "read", updatedAt: "2026-11-26T00:10:00Z",
    });
    const newLease = store.acquireScopedFlowLease("flow-new", "read", process.pid);
    store.close();

    const dispatched: string[] = [];
    const h = makeHarness({
      cwd, globalDir, lockPath,
      runnerFactory: () => ({
        runRoleTurn: async (ctx) => {
          dispatched.push(ctx.nodeId ?? ctx.role.id);
          const ho = createAndVerifyHandoff({
            store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate,
            verdict: "ready", summary: "s2 recovered",
            observedCalls: [{ toolCallId: "rc1", toolName: "read", isError: false, touchedPaths: [], timestamp: new Date().toISOString() }],
          });
          return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
        },
      }),
    });
    const ctx = { cwd, hasUI: false };

    const stOld = JSON.parse((await h.tools.get("enhance_flow")!.execute("st", { action: "status", flowId: "flow-old" }, null, null, ctx)).content[0].text);
    expect(stOld.status).toBe("interrupted");
    expect(stOld.resumable).toBe(true);

    const resOld = JSON.parse((await h.tools.get("enhance_flow")!.execute("res", { action: "resume", flowId: "flow-old", wait: true }, null, null, ctx)).content[0].text);
    expect(resOld.status).toBe("completed");
    expect(dispatched).toEqual(["s2"]); // ONLY s2 re-dispatched, s1 preserved!

    const verifyStore = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    try {
      expect(verifyStore.getFlowCheckpoint("flow-new")?.status).toBe("running");
      expect(verifyStore.listActiveFlowLeases().some((l) => l.flowId === "flow-new" && l.leaseToken === newLease.leaseToken)).toBe(true);
    } finally { verifyStore.close(); }
    await h.emit("session_shutdown", {}, ctx);
  });

  test("A5: whole_flow waiting_input aborts running sibling cleanly as ready and re-dispatches it once on resume while keeping succeeded sibling", async () => {
    const cwd = makeTmpDir("a5");
    const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    const roles = new Map<string, RoleSpec>([
      ["planner", makeRole("planner", { permissions: { tools: ["read"], writable: [], protected: ["**"] } })],
      ["reviewer", makeRole("reviewer", { permissions: { tools: ["read"], writable: [], protected: ["**"] } })],
    ]);
    const spec: FlowGraphSpec = {
      version: 1, goal: "whole_flow sibling recovery", preset: "custom",
      nodes: [
        { id: "fast", kind: "role", role: "planner", dependsOn: [] },
        { id: "slow", kind: "role", role: "planner", dependsOn: [] },
        { id: "gate", kind: "human", dependsOn: ["fast"], human: { prompt: "继续并行吗？" } },
        { id: "join", kind: "role", role: "reviewer", dependsOn: ["slow", "gate"] },
      ],
      policies: normalizePolicies({ maxConcurrency: 3, pauseOnWaitingInput: "whole_flow" }),
    };
    const validation = validateFlowGraph({ spec, roles, isGitRepo: false });
    expect(validation.ok).toBe(true);
    const flowId = "flow-a5";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["fast", "slow", "gate", "join"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 1,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });

    const calls: string[] = [];
    let slowAttempts = 0;
    const runner: RoleSessionRunner = {
      async runRoleTurn(ctx) {
        calls.push(ctx.nodeId!);
        if (ctx.nodeId === "slow" && slowAttempts === 0) {
          slowAttempts += 1;
          await new Promise<void>((resolve) => {
            if (ctx.signal?.aborted) return resolve();
            ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { envelope: null, observedCalls: [], assistantText: "", usage: null, cancelledByUser: true };
        }
        const ho = createAndVerifyHandoff({ store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: `${ctx.nodeId} ok` });
        return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
      },
    };

    const paused = await executeFlowGraph({ cwd, store, flowId, mandate, spec, validation, roles, runner });
    expect(paused.status).toBe("waiting_input");
    expect(paused.finalState.nodes.fast!.status).toBe("succeeded");
    expect(paused.finalState.nodes.slow!.status).toBe("ready");
    expect(paused.finalState.nodes.gate!.status).toBe("waiting_input");

    const resumed = await executeFlowGraph({
      cwd, store, flowId, mandate, spec, validation, roles, runner,
      initialState: paused.finalState, resumeTargetNodeId: "gate", resumeReplyText: "确认继续",
    });
    expect(resumed.status).toBe("completed");
    expect(calls).toEqual(["fast", "slow", "slow", "join"]); // fast NOT re-run; slow re-dispatched once; join completed!
    store.close();
  });

  test("B1: final workflow phase unions base role required_artifacts with final phase exit_artifacts (only manifest fails, only final fails, both pass)", async () => {
    const globalDir = makeTmpDir("b1-global");
    writeText(path.join(globalDir, "strict-role.yaml"), `id: strict-role
name: Strict Role
description: Role + phase artifacts union
model: inherit
method:
  - Produce all required deliverables
stance: Deliver both role and phase artifacts.
permissions:
  tools: ["read", "write"]
  writable: ["out/**"]
  protected: [".git/**"]
exit:
  require_tool_evidence: false
  required_artifacts: ["out/final.txt"]
  criteria: []
workflow:
  session: reuse
  phases:
    - id: finish
      exit_artifacts: ["out/manifest.txt"]
      brief: Write both out/final.txt and out/manifest.txt
`);

    const runCase = async (files: string[]) => {
      const cwd = makeTmpDir("b1-case");
      const lockPath = path.join(makeTmpDir("b1-lock"), "omp-plugins.lock.json");
      writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));
      const h = makeHarness({
        cwd, globalDir, lockPath,
        runnerFactory: () => ({
          runRoleTurn: async (ctx) => {
            for (const f of files) writeText(path.join(ctx.cwd, f), "ok\n");
            try {
              const ho = createAndVerifyHandoff({
                store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate,
                verdict: "ready", summary: "done", artifactPaths: files,
              });
              return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
            } catch (err) {
              return { envelope: null, observedCalls: [], assistantText: "", usage: null, hostError: err instanceof Error ? err.message : String(err) };
            }
          },
        }),
      });
      const res = JSON.parse((await h.tools.get("enhance_flow")!.execute("s", {
        action: "start", roles: ["strict-role"], goal: "Union check", wait: true,
      }, null, null, { cwd, hasUI: false })).content[0].text);
      await h.emit("session_shutdown", {}, { cwd });
      return res;
    };

    const onlyManifest = await runCase(["out/manifest.txt"]);
    const onlyFinal = await runCase(["out/final.txt"]);
    const both = await runCase(["out/manifest.txt", "out/final.txt"]);
    expect(onlyManifest.status).toBe("failed");
    expect(onlyFinal.status).toBe("failed");
    expect(both.status).toBe("completed");
  });

  test("B2: QA rejects short-circuit skipped (||) and trailing-masked (; echo) test commands while accepting direct zero-exit test runs", () => {
    const cwd = makeTmpDir("b2");
    const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    const mandate = store.upsertMandate({ goal: "Verify QA test commands" });
    writeText(path.join(cwd, "example.test.ts"), 'import { expect, test } from "bun:test"; test("fail", () => expect(1).toBe(2));\n');
    const qaRole = makeRole("qa", { exit: { requireToolEvidence: true, requireTestExecution: true, criteria: [] } });

    const runShellCall = (cmd: string, id: string): ObservedToolCall => {
      const r = spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8" });
      return {
        toolCallId: id, toolName: "bash", command: cmd, isError: r.status !== 0, exitCode: r.status ?? 1,
        outputSnippet: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-400), touchedPaths: [], timestamp: new Date().toISOString(),
      };
    };

    // Case 1: short-circuit skipped test (exits 0 because example.test.ts exists!)
    const skipCall = runShellCall("test -f example.test.ts || bun test example.test.ts", "tc-skip");
    expect(skipCall.exitCode).toBe(0);
    expect(() => createAndVerifyHandoff({
      store, role: qaRole, cwd, mandate, verdict: "ready", summary: "claimed pass", observedCalls: [skipCall],
    })).toThrow(/masked or unverifiable/i);

    // Case 2: failing test redirected to log + masked by `; echo finished` (exits 0!)
    const maskedCall = runShellCall("bun test example.test.ts > suite.log 2>&1 && echo passed; echo finished", "tc-mask");
    expect(maskedCall.exitCode).toBe(0);
    expect(() => createAndVerifyHandoff({
      store, role: qaRole, cwd, mandate, verdict: "ready", summary: "claimed pass", observedCalls: [maskedCall],
    })).toThrow(/masked or unverifiable/i);

    // Positive control: fix test and run directly -> succeeds with full verificationEvidence!
    writeText(path.join(cwd, "example.test.ts"), 'import { expect, test } from "bun:test"; test("ok", () => expect(2).toBe(2));\n');
    const directCall = runShellCall("bun test example.test.ts", "tc-ok");
    expect(directCall.exitCode).toBe(0);
    const okHo = createAndVerifyHandoff({
      store, role: qaRole, cwd, mandate, verdict: "ready", summary: "verified pass", observedCalls: [directCall],
    });
    expect(okHo.verificationEvidence).toHaveLength(1);
    expect(okHo.verificationEvidence![0]).toMatchObject({ command: "bun test example.test.ts", exitCode: 0, toolCallId: "tc-ok" });
    store.close();
  });

  test("B3: moving preview branch while paused does NOT alter downstream gate target commit SHA", async () => {
    const { cwd, store } = initGitRepo({ "check.txt": "PASS\n" });
    const passSha = git(cwd, ["rev-parse", "HEAD"]);
    const roles = new Map<string, RoleSpec>([["dev", makeRole("dev")]]);
    const spec: FlowGraphSpec = {
      version: 1, goal: "Pin merged SHA across pause", preset: "custom",
      nodes: [
        { id: "w1", kind: "role", role: "dev", dependsOn: [], workspace: "worktree", writableScope: ["check.txt"] },
        { id: "merge", kind: "merge", dependsOn: ["w1"], merge: { sourceNodeIds: ["w1"], landingMode: "branch_preview", conflictPolicy: "fail" } },
        { id: "confirm", kind: "human", dependsOn: ["merge"], human: { prompt: "Proceed to gate?" } },
        { id: "gate", kind: "gate", dependsOn: ["confirm"], gate: { command: "grep -qx PASS check.txt" } },
      ],
      policies: normalizePolicies({ maxRepairRounds: 0 }),
    };
    const validation = validateFlowGraph({ spec, roles, isGitRepo: true });
    expect(validation.ok).toBe(true);
    const flowId = "flow-b3-pin";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["w1", "merge", "confirm", "gate"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 0,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });
    const runner: RoleSessionRunner = {
      async runRoleTurn(ctx) {
        writeText(path.join(ctx.cwd, "check.txt"), "FAIL\n");
        const ho = createAndVerifyHandoff({ store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: "wrote FAIL" });
        return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
      },
    };
    const wt = createGitWorktreeManager();
    const paused = await executeFlowGraph({ cwd, store, flowId, mandate, spec, validation, roles, runner, worktreeManager: wt });
    expect(paused.status).toBe("waiting_input");
    const origMergedSha = paused.mergedCommitSha!;
    expect(origMergedSha).toBeTruthy();
    expect(origMergedSha).not.toBe(passSha);

    // Tamper: move preview branch to PASS commit while Flow is paused!
    git(cwd, ["branch", "-f", paused.mergedRef!, passSha]);
    expect(git(cwd, ["rev-parse", paused.mergedRef!])).toBe(passSha);

    const resumed = await executeFlowGraph({
      cwd, store, flowId, mandate, spec, validation, roles, runner, worktreeManager: wt,
      initialState: paused.finalState, resumeTargetNodeId: "confirm", resumeReplyText: "Run gate",
    });
    expect(resumed.status).toBe("rejected_max_rounds"); // Original FAIL SHA STILL fails!
    expect(resumed.finalState.nodes.gate!.lastGateEvidence?.testedCommitSha).toBe(origMergedSha);
    store.close();
  });

  test("B4: writable joinRole after branch_preview commits report into delivered ref; skipping sole merge and merge join=any are rejected", async () => {
    const roles = new Map<string, RoleSpec>([["dev", makeRole("dev")]]);

    // 1. merge join="any" rejected pre-flight
    const badJoinAny = validateFlowGraph({
      spec: {
        version: 1, goal: "Bad merge join any", preset: "custom",
        nodes: [
          { id: "w1", kind: "role", role: "dev", dependsOn: [], workspace: "worktree", writableScope: ["a.txt"] },
          { id: "w2", kind: "role", role: "dev", dependsOn: [], workspace: "worktree", writableScope: ["b.txt"] },
          { id: "merge", kind: "merge", dependsOn: ["w1", "w2"], join: "any", merge: { sourceNodeIds: ["w1", "w2"], landingMode: "apply" } },
        ],
        policies: normalizePolicies({}),
      },
      roles, isGitRepo: true,
    });
    expect(badJoinAny.ok).toBe(false);
    expect(badJoinAny.issues.some((i) => i.code === "invalid_node_config")).toBe(true);

    // 2. Live GRAPH_PATCH skipping the only merge node is rejected
    const baseSpec = compileFanOutJoin({
      goal: "Patch skip merge",
      shards: [
        { id: "w1", role: "dev", brief: "a", writableScope: ["a.txt"], workspace: "worktree" },
        { id: "w2", role: "dev", brief: "b", writableScope: ["b.txt"], workspace: "worktree" },
      ],
      merge: { landingMode: "branch_preview", conflictPolicy: "fail" },
    });
    const badPatch = validateGraphPatch({
      currentSpec: baseSpec,
      nodeStatuses: { w1: "running", w2: "running", merge: "pending" },
      patch: { skipNodeIds: ["merge"] },
      roles, isGitRepo: true,
    });
    expect(badPatch.ok).toBe(false);
    expect(badPatch.issues.some((i) => i.code === "missing_merge_delivery")).toBe(true);

    // 3. Writable joinRole after branch_preview persists report.md into delivered preview ref + verified by downstream gate!
    const { cwd, store } = initGitRepo({ "README.md": "init\n" });
    const spec: FlowGraphSpec = {
      version: 1, goal: "Preview merge + writable join + gate", preset: "custom",
      nodes: [
        { id: "w1", kind: "role", role: "dev", dependsOn: [], workspace: "worktree", writableScope: ["a.txt"] },
        { id: "w2", kind: "role", role: "dev", dependsOn: [], workspace: "worktree", writableScope: ["b.txt"] },
        { id: "merge", kind: "merge", dependsOn: ["w1", "w2"], merge: { sourceNodeIds: ["w1", "w2"], landingMode: "branch_preview", conflictPolicy: "fail" } },
        { id: "join", kind: "role", role: "dev", dependsOn: ["merge"], brief: "Write report.md" },
        { id: "verify-all", kind: "gate", dependsOn: ["join"], gate: { command: "test -f a.txt && test -f b.txt && grep -qx JOIN_REPORT report.md" } },
      ],
      policies: normalizePolicies({ maxRepairRounds: 1 }),
    };
    const validation = validateFlowGraph({ spec, roles, isGitRepo: true });
    expect(validation.ok).toBe(true);
    const flowId = "flow-b4-join";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["w1", "w2", "merge", "join", "verify-all"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 1,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });
    const runner: RoleSessionRunner = {
      async runRoleTurn(ctx) {
        if (ctx.nodeId === "w1") writeText(path.join(ctx.cwd, "a.txt"), "A_OK\n");
        if (ctx.nodeId === "w2") writeText(path.join(ctx.cwd, "b.txt"), "B_OK\n");
        if (ctx.nodeId === "join") writeText(path.join(ctx.cwd, "report.md"), "JOIN_REPORT\n");
        const ho = createAndVerifyHandoff({ store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: `${ctx.nodeId} done` });
        return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
      },
    };
    const res = await executeFlowGraph({ cwd, store, flowId, mandate, spec, validation, roles, runner, worktreeManager: createGitWorktreeManager() });
    expect(res.status).toBe("completed");
    expect(res.mergedRef).toBeTruthy();
    expect(res.mergedCommitSha).toBeTruthy();
    // Cleanup finished (only main worktree remains), yet ALL 3 files are retrievable from the delivered ref!
    expect(git(cwd, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
    expect(git(cwd, ["show", `${res.mergedRef}:a.txt`])).toBe("A_OK");
    expect(git(cwd, ["show", `${res.mergedRef}:b.txt`])).toBe("B_OK");
    expect(git(cwd, ["show", `${res.mergedRef}:report.md`])).toBe("JOIN_REPORT");
    expect(git(cwd, ["rev-parse", res.mergedRef!])).toBe(res.mergedCommitSha!);
    store.close();
  });

  test("C1: monorepo subdirectory dispatch (cwd=repo/pkg) scopes worker & landing to pkg/ while leaving repo root untouched", async () => {
    const { cwd: repoRoot, store } = initGitRepo({ "label": "ROOT_LABEL\n", "pkg/label": "PKG_LABEL\n" });
    const pkgCwd = path.join(repoRoot, "pkg");
    const wt = createGitWorktreeManager();
    const prep = await wt.prepareNodeWorktree({ cwd: pkgCwd, flowId: "flow-c1", nodeId: "w1" });

    expect(readFileSync(path.join(prep.worktreePath, "label"), "utf8")).toBe("PKG_LABEL\n");
    writeText(path.join(prep.worktreePath, "label"), "PKG_MODIFIED\n");
    const ref = await wt.commitNodeWorktree({ worktreePath: prep.worktreePath, flowId: "flow-c1", nodeId: "w1", summary: "edit pkg/label" });
    expect(ref).toBeTruthy();

    const merged = await wt.mergeWorktrees({ cwd: pkgCwd, flowId: "flow-c1", nodeId: "merge", sourceRefs: { w1: ref! }, landingMode: "apply" });
    expect(merged.ok).toBe(true);
    await wt.cleanupFlowWorktrees(pkgCwd, "flow-c1");

    expect(readFileSync(path.join(repoRoot, "pkg", "label"), "utf8")).toBe("PKG_MODIFIED\n");
    expect(readFileSync(path.join(repoRoot, "label"), "utf8")).toBe("ROOT_LABEL\n");
    store.close();
  });

  test("C2: root .gitignore containing .omp-enhance/ does not break dirty base snapshot and leaves user real index untouched", async () => {
    const { cwd, store } = initGitRepo({ ".gitignore": ".omp-enhance/\n", "tracked.txt": "BASE\n", "staged.txt": "STAGED_BASE\n" });
    writeText(path.join(cwd, "tracked.txt"), "DIRTY_UNSTAGED\n");
    writeText(path.join(cwd, "staged.txt"), "USER_STAGED_VAL\n");
    git(cwd, ["add", "staged.txt"]);
    const cachedBefore = git(cwd, ["diff", "--cached"]);

    const wt = createGitWorktreeManager();
    const prep = await wt.prepareNodeWorktree({ cwd, flowId: "flow-c2", nodeId: "w1" });
    expect(readFileSync(path.join(prep.worktreePath, "tracked.txt"), "utf8")).toBe("DIRTY_UNSTAGED\n");
    expect(readFileSync(path.join(prep.worktreePath, "staged.txt"), "utf8")).toBe("USER_STAGED_VAL\n");
    // .omp-enhance/ excluded from base snapshot tree
    expect(git(cwd, ["ls-tree", "-r", "--name-only", prep.baseRef])).not.toContain(".omp-enhance");
    // User real staging index untouched
    expect(git(cwd, ["diff", "--cached"])).toBe(cachedBefore);
    await wt.cleanupFlowWorktrees(cwd, "flow-c2");
    store.close();
  });

  test("C3: pre-existing untracked file modified by worker lands cleanly as untracked; post-dispatch new user file stays protected", async () => {
    // Case A: pre-existing untracked file modified by worker -> lands cleanly, remains untracked & unstaged
    const { cwd, store } = initGitRepo({ "README.md": "hi\n", "scratch.txt": "UNTRACKED_BEFORE\n" }, { skipInitialAdd: ["scratch.txt"] });
    const wt = createGitWorktreeManager();
    const prepA = await wt.prepareNodeWorktree({ cwd, flowId: "flow-c3a", nodeId: "w1" });
    expect(readFileSync(path.join(prepA.worktreePath, "scratch.txt"), "utf8")).toBe("UNTRACKED_BEFORE\n");
    writeText(path.join(prepA.worktreePath, "scratch.txt"), "UNTRACKED_AFTER\n");
    const refA = await wt.commitNodeWorktree({ worktreePath: prepA.worktreePath, flowId: "flow-c3a", nodeId: "w1", summary: "edit scratch" });
    const resA = await wt.mergeWorktrees({ cwd, flowId: "flow-c3a", nodeId: "merge", sourceRefs: { w1: refA! }, landingMode: "apply" });
    expect(resA.ok).toBe(true);
    expect(readFileSync(path.join(cwd, "scratch.txt"), "utf8")).toBe("UNTRACKED_AFTER\n");
    expect(git(cwd, ["status", "--porcelain"])).toContain("?? scratch.txt");
    expect(git(cwd, ["diff", "--cached"])).toBe("");
    await wt.cleanupFlowWorktrees(cwd, "flow-c3a");

    // Case B: brand-new untracked file created by user AFTER dispatch -> protected as working-tree-drift!
    const prepB = await wt.prepareNodeWorktree({ cwd, flowId: "flow-c3b", nodeId: "w1" });
    writeText(path.join(prepB.worktreePath, "race.txt"), "WORKER_RACE\n");
    const refB = await wt.commitNodeWorktree({ worktreePath: prepB.worktreePath, flowId: "flow-c3b", nodeId: "w1", summary: "create race.txt" });
    writeText(path.join(cwd, "race.txt"), "USER_RACE_KEEP\n");
    const resB = await wt.mergeWorktrees({ cwd, flowId: "flow-c3b", nodeId: "merge", sourceRefs: { w1: refB! }, landingMode: "apply" });
    expect(resB.ok).toBe(false);
    expect(resB.conflicts).toContain("working-tree-drift");
    expect(readFileSync(path.join(cwd, "race.txt"), "utf8")).toBe("USER_RACE_KEEP\n");
    await wt.cleanupFlowWorktrees(cwd, "flow-c3b");
    store.close();
  });

  test("C4: existing local branch named omp-enhance falls back cleanly to resolvable flat preview branch and preserves user branch", async () => {
    const { cwd, store } = initGitRepo({ "a.txt": "BASE\n" });
    git(cwd, ["branch", "omp-enhance"]);
    const userBranchSha = git(cwd, ["rev-parse", "refs/heads/omp-enhance"]);

    const wt = createGitWorktreeManager();
    const prep = await wt.prepareNodeWorktree({ cwd, flowId: "flow-c4", nodeId: "w1" });
    writeText(path.join(prep.worktreePath, "a.txt"), "PREVIEW_DATA\n");
    const ref = await wt.commitNodeWorktree({ worktreePath: prep.worktreePath, flowId: "flow-c4", nodeId: "w1", summary: "edit a.txt" });
    const merged = await wt.mergeWorktrees({ cwd, flowId: "flow-c4", nodeId: "merge", sourceRefs: { w1: ref! }, landingMode: "branch_preview" });
    expect(merged.ok).toBe(true);
    expect(merged.mergedRef).toBe("omp-enhance-flow-c4");
    expect(merged.mergedCommitSha).toBeTruthy();

    await wt.cleanupFlowWorktrees(cwd, "flow-c4");
    expect(git(cwd, ["rev-parse", `refs/heads/${merged.mergedRef}`])).toBe(merged.mergedCommitSha!);
    expect(git(cwd, ["show", `${merged.mergedRef}:a.txt`])).toBe("PREVIEW_DATA");
    expect(git(cwd, ["rev-parse", "refs/heads/omp-enhance"])).toBe(userBranchSha);
    store.close();
  });

  test("E2E OMP Entrypoint + UX/Schema: dispatch in subdir -> human pause -> restart -> answer -> pinned gate -> cleanup -> retrieve files", async () => {
    const { cwd: repoRoot, store: initStore } = initGitRepo({ "root.txt": "ROOT\n", "pkg/app.txt": "OLD\n" });
    initStore.close();
    const pkgCwd = path.join(repoRoot, "pkg");
    const globalDir = makeTmpDir("e2e-global");
    const lockPath = path.join(makeTmpDir("e2e-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));

    const runnerFactory = (): RoleSessionRunner => ({
      async runRoleTurn(ctx) {
        if (ctx.nodeId === "w1") writeText(path.join(ctx.cwd, "app.txt"), "NEW_PKG_VAL\n");
        const ho = createAndVerifyHandoff({ store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: "updated pkg/app.txt" });
        return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
      },
    });

    // Instance 1: verify cleaned tool schema (no native_task / spawn_resolver / fork), start Flow -> pauses at confirm
    const h1 = makeHarness({ cwd: pkgCwd, globalDir, lockPath, runnerFactory });
    const schemaStr = JSON.stringify(h1.tools.get("enhance_flow")!.parameters);
    expect(schemaStr).not.toContain("native_task");
    expect(schemaStr).not.toContain("spawn_resolver");
    expect(schemaStr).not.toContain('"fork"');

    const ctx1 = { cwd: pkgCwd, hasUI: false };
    const started = JSON.parse((await h1.tools.get("enhance_flow")!.execute("e2e-s", {
      action: "start", goal: "Monorepo E2E preview delivery", wait: true,
      nodes: [
        { id: "w1", kind: "role", role: "dev", dependsOn: [], workspace: "worktree", writableScope: ["app.txt"] },
        { id: "merge", kind: "merge", dependsOn: ["w1"], merge: { sourceNodeIds: ["w1"], landingMode: "branch_preview", conflictPolicy: "fail" } },
        { id: "confirm", kind: "human", dependsOn: ["merge"], human: { prompt: "请确认是否验证并交付预览分支？" } },
        { id: "gate", kind: "gate", dependsOn: ["confirm"], gate: { command: "grep -qx NEW_PKG_VAL app.txt" } },
      ],
    }, null, null, ctx1)).content[0].text);
    expect(started.status).toBe("waiting_input");
    const flowId = JSON.parse((await h1.tools.get("enhance_flow")!.execute("e2e-st", { action: "status" }, null, null, ctx1)).content[0].text).flowId as string;
    await h1.emit("session_shutdown", {}, ctx1);

    // Instance 2 (fresh restart!): resume with verbatim reply -> gate verifies pinned SHA -> cleans up -> files retrievable!
    const h2 = makeHarness({ cwd: pkgCwd, globalDir, lockPath, runnerFactory });
    const ctx2 = { cwd: pkgCwd, hasUI: false };
    const resumed = JSON.parse((await h2.tools.get("enhance_flow")!.execute("e2e-r", {
      action: "resume", flowId, nodeId: "confirm", message: "确认交付预览分支", wait: true,
    }, null, null, ctx2)).content[0].text);
    expect(resumed.status).toBe("completed");
    expect(resumed.mergedRef).toBeTruthy();
    expect(resumed.mergedCommitSha).toBeTruthy();

    // Check permanent summary card renders DAG wave bar + delivery ref/SHA
    const finalSnap = JSON.parse((await h2.tools.get("enhance_flow")!.execute("e2e-st2", { action: "status", flowId }, null, null, ctx2)).content[0].text);
    const card = renderRoomCardLines(finalSnap, 100, true).join("\n");
    expect(card).toContain("W0[✓ w1:wt]");
    expect(card).toContain("交付引用:");
    expect(card).toContain(resumed.mergedRef);
    expect(card).toContain(resumed.mergedCommitSha.slice(0, 12));

    // Verify worktrees cleaned, repo root untouched, delivered pkg/app.txt matches, and verbatim reply saved on board!
    expect(git(repoRoot, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
    expect(readFileSync(path.join(repoRoot, "root.txt"), "utf8")).toBe("ROOT\n");
    expect(readFileSync(path.join(repoRoot, "pkg", "app.txt"), "utf8")).toBe("OLD\n");
    expect(git(repoRoot, ["show", `${resumed.mergedRef}:pkg/app.txt`])).toBe("NEW_PKG_VAL");
    expect(git(repoRoot, ["rev-parse", resumed.mergedRef])).toBe(resumed.mergedCommitSha);

    const checkStore = new EnhanceStore(path.join(pkgCwd, ".omp-enhance", "state.sqlite"));
    try {
      const boardText = checkStore.listFlowBoardEvents(flowId).map((e) => e.text).join("\n");
      expect(boardText).toContain("确认交付预览分支");
      const gateHo = checkStore.listHandoffs(checkStore.getFlowCheckpoint(flowId)!.mandateId).find((ho) => ho.fromRole === "gate");
      expect(gateHo?.verificationEvidence?.[0]?.testedCommitSha).toBe(resumed.mergedCommitSha);
    } finally { checkStore.close(); }
    await h2.emit("session_shutdown", {}, ctx2);
  });
});
