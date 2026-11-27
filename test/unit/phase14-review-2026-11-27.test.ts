import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FlowGraphSpec, FlowMachineState } from "../../src/core/graph-types.ts";
import { EnhanceStore } from "../../src/core/store.ts";
import type { ObservedToolCall, RoleSpec } from "../../src/core/types.ts";
import ompEnhance from "../../src/entry.ts";
import { executeFlowGraph } from "../../src/flow/executor.ts";
import { normalizePolicies, validateFlowGraph } from "../../src/flow/graph.ts";
import { createAndVerifyHandoff } from "../../src/flow/handoff.ts";
import type { RoleSessionRunner } from "../../src/flow/orchestrator.ts";
import { createGitWorktreeManager } from "../../src/flow/worktree.ts";
import { discoverRoles } from "../../src/roles/loader.ts";
import { openRoleEditor } from "../../src/ui/role-studio.ts";

const BUILTIN_ROLES_DIR = path.resolve(import.meta.dir, "../../roles");
const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `omp-p14-${prefix}-`));
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

function initGitRepo(files: Record<string, string>): { cwd: string; store: EnhanceStore } {
  const cwd = makeTmpDir("git");
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "user.email", "test@local"]);
  for (const [rel, body] of Object.entries(files)) writeText(path.join(cwd, rel), body);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "init"]);
  return { cwd, store: new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite")) };
}

function makeRole(id: string, overrides?: Partial<RoleSpec>): RoleSpec {
  return {
    id, name: id, description: id, source: "builtin", filePath: `/tmp/${id}.yaml`, contentSha256: `sha-${id}`,
    model: "inherit", method: ["Execute cleanly"], stance: `role ${id}`,
    permissions: { tools: ["read", "write", "edit", "bash"], writable: ["**"], protected: [".git/**"] },
    exit: { requireToolEvidence: false, criteria: [] },
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
  const emitted: string[] = [];
  const pi: any = {
    cwd: opts.cwd,
    on(ev: string, fn: any) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
    registerTool(t: any) { tools.set(t.name, t); },
    registerCommand(name: string, cmd: any) { commands.set(name, cmd); },
    registerMessageRenderer() {},
    getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }],
    setActiveTools: async () => {},
    sendMessage(msg: any) { if (typeof msg?.content === "string") emitted.push(msg.content); },
  };
  ompEnhance(pi, {
    builtinRolesDir: BUILTIN_ROLES_DIR, globalRolesDir: opts.globalDir, pluginLockPath: opts.lockPath,
    ...(opts.runnerFactory ? { runnerFactory: opts.runnerFactory } : {}),
  });
  return {
    tools, commands, emitted,
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

describe("Phase 14: Review 2026-11-27 Regression Suite (All 13 Items + Node Tools Narrowing)", () => {
  test("#1: omitted flowId on resume with 2 waiting_input Flows returns ambiguous candidates instead of advancing the wrong Flow", async () => {
    const cwd = makeTmpDir("r1");
    const globalDir = makeTmpDir("r1-g");
    const lockPath = path.join(makeTmpDir("r1-l"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));
    const h = makeHarness({ cwd, globalDir, lockPath });
    const ctx = { cwd, hasUI: false };

    await h.tools.get("enhance_flow")!.execute("sa", {
      action: "start", goal: "发票汇总", wait: true,
      nodes: [{ id: "decide", kind: "human", dependsOn: [], human: { prompt: "发票按月汇总吗？" } }],
    }, null, null, ctx);
    const flowA = JSON.parse((await h.tools.get("enhance_flow")!.execute("la", { action: "list" }, null, null, ctx)).content[0].text).flows[0].flowId as string;

    await h.tools.get("enhance_flow")!.execute("sb", {
      action: "start", goal: "清理过期备份", wait: true,
      nodes: [{ id: "decide", kind: "human", dependsOn: [], human: { prompt: "确定清理过期备份吗？" } }],
    }, null, null, ctx);
    const allFlows = JSON.parse((await h.tools.get("enhance_flow")!.execute("lb", { action: "list" }, null, null, ctx)).content[0].text).flows as any[];
    const flowB = allFlows.find((f) => f.flowId !== flowA)!.flowId as string;

    // Omitting flowId MUST return ambiguous candidates; neither A nor B advances!
    const ambig = await h.tools.get("enhance_flow")!.execute("r-ambig", {
      action: "resume", nodeId: "decide", message: "发票按月汇总", wait: true,
    }, null, null, ctx);
    expect(ambig.isError).toBe(true);
    const ambigBody = JSON.parse(ambig.content[0].text);
    expect(ambigBody).toMatchObject({ ambiguous: true, requiresFlowId: true });
    expect(ambigBody.candidates.map((c: any) => c.flowId).sort()).toEqual([flowA, flowB].sort());

    expect(JSON.parse((await h.tools.get("enhance_flow")!.execute("qa1", { action: "status", flowId: flowA }, null, null, ctx)).content[0].text).status).toBe("waiting_input");
    expect(JSON.parse((await h.tools.get("enhance_flow")!.execute("qb1", { action: "status", flowId: flowB }, null, null, ctx)).content[0].text).status).toBe("waiting_input");

    // Explicit flowId=A advances ONLY A; B stays waiting_input!
    const okA = JSON.parse((await h.tools.get("enhance_flow")!.execute("ra", {
      action: "resume", flowId: flowA, nodeId: "decide", message: "发票按月汇总", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(okA.status).toBe("completed");
    expect(JSON.parse((await h.tools.get("enhance_flow")!.execute("qb2", { action: "status", flowId: flowB }, null, null, ctx)).content[0].text).status).toBe("waiting_input");
    await h.emit("session_shutdown", {}, ctx);
  });

  test("#2: foreground human gate blocks status questions ('可以说一下进度吗？'), deferrals ('先不要批准，我还要看材料'), and same-turn double approvals", async () => {
    const cwd = makeTmpDir("r2");
    const globalDir = makeTmpDir("r2-g");
    const lockPath = path.join(makeTmpDir("r2-l"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));
    writeText(path.join(globalDir, "deliver-gate.yaml"), `id: deliver-gate
name: Deliver Gate
description: Approval gate test
model: inherit
method: [Wait for explicit approval]
stance: Respect human gate.
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
    - id: approve_deliver
      kind: human
      prompt: "是否批准进入交付？"
    - id: approve_release
      kind: human
      prompt: "是否批准发布？"
    - id: work
      brief: Finish work
`);
    const h = makeHarness({ cwd, globalDir, lockPath });
    const entries: any[] = [];
    const fgCtx: any = { cwd, hasUI: false, sessionManager: { getSessionId: () => "fg-r2", getBranch: () => entries, getEntries: () => entries } };
    await h.commands.get("role")!.handler("deliver-gate --foreground", fgCtx);

    entries.push({ id: "u1", type: "message", message: { role: "user", content: "开始任务" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, fgCtx);

    for (const [idx, msg] of ["现在进度如何", "可以说一下进度吗？", "先不要批准，我还要看材料"].entries()) {
      entries.push({ id: `u-block-${idx}`, type: "message", message: { role: "user", content: msg } });
      await h.emit("before_agent_start", { systemPrompt: [] }, fgCtx);
      const res = await h.tools.get("enhance_handoff")!.execute(`h-b-${idx}`, { verdict: "ready", summary: "模型尝试推进" }, null, null, fgCtx);
      expect(res.isError).toBe(true);
    }

    // Explicit approval advances ONLY gate 1 -> gate 2; 2nd ready in SAME turn is blocked!
    entries.push({ id: "u-ok", type: "message", message: { role: "user", content: "同意进入交付" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, fgCtx);
    const ok1 = await h.tools.get("enhance_handoff")!.execute("h-ok1", { verdict: "ready", summary: "已批准交付" }, null, null, fgCtx);
    expect(ok1.isError).toBeUndefined();
    expect(JSON.parse(ok1.content[0].text).workflowProgress).toMatchObject({ advanced: true, nextPhaseId: "approve_release", userReply: "同意进入交付" });

    const dup = await h.tools.get("enhance_handoff")!.execute("h-dup", { verdict: "ready", summary: "尝试同轮跳过第二关" }, null, null, fgCtx);
    expect(dup.isError).toBe(true);
    await h.emit("session_shutdown", {}, fgCtx);
  });

  test("#3: editing thinking level on algo in Role Studio preserves all 5 workflow phases, permissions, and dispatch behavior", async () => {
    const cwd = makeTmpDir("r3");
    const globalDir = makeTmpDir("r3-g");
    const lockPath = path.join(makeTmpDir("r3-l"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));

    let roles = discoverRoles({ cwd, globalRolesDir: globalDir, builtinRolesDir: BUILTIN_ROLES_DIR });
    const origAlgo = roles.get("algo")!;
    expect(origAlgo.workflow?.phases.map((p) => p.id)).toEqual(["audit", "align_metric", "baseline", "iterate", "deliver"]);

    const selectAnswers = ["推理档位: inherit", "low", "返回"];
    let selIdx = 0;
    const ui = {
      select: async (_title: string, items: string[]) => {
        const want = selectAnswers[selIdx++];
        return items.find((it) => it === want || it.startsWith(want!)) ?? "返回";
      },
      notify: () => {},
    };
    await openRoleEditor("algo", {
      cwd, globalRolesDir: globalDir, builtinRolesDir: BUILTIN_ROLES_DIR, pi: {}, ctx: { cwd, hasUI: true, ui },
      getRoles: () => roles, refreshRoles: () => { roles = discoverRoles({ cwd, globalRolesDir: globalDir, builtinRolesDir: BUILTIN_ROLES_DIR }); return roles; },
      getActiveRoleId: () => null, activateRole: async () => {},
    });

    const reloaded = discoverRoles({ cwd, globalRolesDir: globalDir, builtinRolesDir: BUILTIN_ROLES_DIR }).get("algo")!;
    expect(reloaded.thinking).toBe("low");
    expect(reloaded.workflow?.phases.map((p) => p.id)).toEqual(["audit", "align_metric", "baseline", "iterate", "deliver"]);
    expect(reloaded.exit.requireAlgoDeliverables).toBe(origAlgo.exit.requireAlgoDeliverables);
    expect(reloaded.permissions.protected).toEqual(origAlgo.permissions.protected);

    // Real dispatch starts at algo__audit and pauses at algo__align_metric!
    const seenNodes: string[] = [];
    const h = makeHarness({
      cwd, globalDir, lockPath,
      runnerFactory: () => ({
        runRoleTurn: async (ctx) => {
          seenNodes.push(ctx.nodeId ?? ctx.role.id);
          writeText(path.join(ctx.cwd, "algo_work", "benchmark", "data_profile.json"), JSON.stringify({ rows: 100 }));
          const ho = createAndVerifyHandoff({
            store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: "audited",
            artifactPaths: ["algo_work/benchmark/data_profile.json"],
            observedCalls: [{ toolCallId: "c1", toolName: "read", isError: false, touchedPaths: [], timestamp: new Date().toISOString() }],
          });
          return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
        },
      }),
    });
    const res = JSON.parse((await h.tools.get("enhance_flow")!.execute("s-algo", {
      action: "start", roles: ["algo"], goal: "Optimize RMSE", wait: true,
    }, null, null, { cwd, hasUI: false })).content[0].text);
    expect(res.status).toBe("waiting_input");
    expect(seenNodes).toEqual(["algo__audit"]);
    await h.emit("session_shutdown", {}, { cwd });
  });

  test("#4: deleting [project] custom role preserves same-named [global] role and falls back cleanly across projects", async () => {
    const cwd1 = makeTmpDir("r4-p1");
    const cwd2 = makeTmpDir("r4-p2");
    const globalDir = makeTmpDir("r4-g");
    const roleYaml = (tag: string) => `id: shared-spec\nname: Shared ${tag}\ndescription: ${tag}\nmodel: inherit\nmethod:\n  - ${tag}\nstance: ${tag}\npermissions:\n  tools: ["read"]\n  writable: []\n  protected: ["**"]\nexit:\n  require_tool_evidence: false\n  criteria: []\n`;
    const globalFile = path.join(globalDir, "shared-spec.yaml");
    const projFile = path.join(cwd1, ".omp", "roles", "shared-spec.yaml");
    writeText(globalFile, roleYaml("GLOBAL_V1"));
    writeText(projFile, roleYaml("PROJECT_V1"));

    let roles = discoverRoles({ cwd: cwd1, globalRolesDir: globalDir, builtinRolesDir: BUILTIN_ROLES_DIR, isProjectTrusted: true });
    expect(roles.get("shared-spec")?.source).toBe("project");

    const confirmCalls: Array<{ title: string; msg: string }> = [];
    let step = 0;
    await openRoleEditor("shared-spec", {
      cwd: cwd1, globalRolesDir: globalDir, builtinRolesDir: BUILTIN_ROLES_DIR, pi: {},
      ctx: {
        cwd: cwd1, hasUI: true,
        ui: {
          select: async (_t: string, items: string[]) => (step++ === 0 ? items.find((i) => i === "删除自定义角色") : "返回"),
          confirm: async (title: string, msg: string) => { confirmCalls.push({ title, msg }); return true; },
          notify: () => {},
        },
      },
      getRoles: () => roles,
      refreshRoles: () => { roles = discoverRoles({ cwd: cwd1, globalRolesDir: globalDir, builtinRolesDir: BUILTIN_ROLES_DIR, isProjectTrusted: true }); return roles; },
      getActiveRoleId: () => null, activateRole: async () => {},
    });

    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]!.msg).toContain("[project]");
    expect(confirmCalls[0]!.msg).toContain(projFile);
    expect(confirmCalls[0]!.msg).toContain("回退到全局");

    expect(existsSync(projFile)).toBe(false);
    expect(existsSync(globalFile)).toBe(true);
    expect(discoverRoles({ cwd: cwd1, globalRolesDir: globalDir, builtinRolesDir: BUILTIN_ROLES_DIR, isProjectTrusted: true }).get("shared-spec")).toMatchObject({
      source: "global", method: ["GLOBAL_V1"],
    });
    expect(discoverRoles({ cwd: cwd2, globalRolesDir: globalDir, builtinRolesDir: BUILTIN_ROLES_DIR }).get("shared-spec")).toMatchObject({
      source: "global", method: ["GLOBAL_V1"],
    });
  });

  test("#5: second window sees running/completed Flow consistently in /flow status, /coord status, and /flow overlay without stealing lease", async () => {
    const cwd = makeTmpDir("r5");
    const globalDir = makeTmpDir("r5-g");
    const lockPath = path.join(makeTmpDir("r5-l"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));

    let releasePlanner!: () => void;
    let plannerStarted!: () => void;
    const startedP = new Promise<void>((r) => { plannerStarted = r; });

    const winA = makeHarness({
      cwd, globalDir, lockPath,
      runnerFactory: () => ({
        runRoleTurn: async (ctx) => {
          plannerStarted();
          await new Promise<void>((r) => { releasePlanner = r; });
          const ho = createAndVerifyHandoff({
            store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: "planned",
            observedCalls: [{ toolCallId: "p1", toolName: "read", isError: false, touchedPaths: [], timestamp: new Date().toISOString() }],
          });
          return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
        },
      }),
    });
    const ctxA = { cwd, hasUI: true, isIdle: () => true };
    const startOut = JSON.parse((await winA.tools.get("enhance_flow")!.execute("sa", {
      action: "start", roles: ["planner"], goal: "Audit billing module",
    }, null, null, ctxA)).content[0].text);
    expect(startOut.started).toBe(true);
    await startedP;

    // Independent Window B observes the SAME workspace
    const winB = makeHarness({ cwd, globalDir, lockPath });
    const bNotes: string[] = [];
    let overlayText = "";
    const ctxB: any = {
      cwd, hasUI: true,
      ui: {
        notify: (m: string) => bNotes.push(m),
        custom: async (factory: any) => {
          const comp = factory({ requestRender() {} }, { fg: (_c: string, s: string) => s }, {}, () => {});
          overlayText = comp.render(100).join("\n");
          comp.dispose?.();
        },
      },
    };
    await winB.commands.get("flow")!.handler("status", ctxB);
    await winB.commands.get("coord")!.handler("status", ctxB);
    await winB.commands.get("flow")!.handler("", ctxB);

    const flowStatusText = winB.emitted[0] ?? bNotes[0] ?? "";
    const coordStatusText = winB.emitted[1] ?? bNotes[1] ?? "";
    expect(flowStatusText).toContain("running");
    expect(flowStatusText).toContain("Audit billing module");
    expect(coordStatusText).toContain("running");
    expect(coordStatusText).toContain("另一窗口");
    expect(overlayText).toContain("执行中");
    expect(overlayText).toContain("另一窗口");
    expect(overlayText).not.toContain("待命");

    // Window A MUST still hold the lease untouched!
    const inspectStore = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    try { expect(inspectStore.getProjectFlowLease()?.flowId).toBe(startOut.flowId); } finally { inspectStore.close(); }

    releasePlanner();
    for (let i = 0; i < 40; i++) {
      const st = JSON.parse((await winA.tools.get("enhance_flow")!.execute("st", { action: "status", flowId: startOut.flowId }, null, null, ctxA)).content[0].text);
      if (st.status === "completed") break;
      await Bun.sleep(15);
    }
    winB.emitted.length = 0;
    await winB.commands.get("coord")!.handler("status", ctxB);
    expect(winB.emitted[0] ?? "").toContain("completed");

    await winB.emit("session_shutdown", {}, ctxB);
    await winA.emit("session_shutdown", {}, ctxA);
  });

  test("#6: flowRoutingMode='ask' in headless mode returns requiresConfirmation with 0 starts, and confirmed=true starts once", async () => {
    const cwd = makeTmpDir("r6");
    const globalDir = makeTmpDir("r6-g");
    const lockPath = path.join(makeTmpDir("r6-l"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "ask", supervisorEnabled: false } } }));

    let runs = 0;
    const h = makeHarness({
      cwd, globalDir, lockPath,
      runnerFactory: () => ({
        runRoleTurn: async (ctx) => {
          runs += 1;
          const ho = createAndVerifyHandoff({
            store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: "done",
            observedCalls: [{ toolCallId: "c1", toolName: "read", isError: false, touchedPaths: [], timestamp: new Date().toISOString() }],
          });
          return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
        },
      }),
    });
    const ctx = { cwd, hasUI: false };

    const unconfirmed = JSON.parse((await h.tools.get("enhance_flow")!.execute("s1", {
      action: "start", roles: ["planner"], goal: "Check schema", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(unconfirmed).toMatchObject({ started: false, requiresConfirmation: true, goal: "Check schema" });
    expect(unconfirmed.planSummary).toContain("planner");
    expect(runs).toBe(0);
    expect(existsSync(path.join(cwd, ".omp-enhance", "state.sqlite"))).toBe(false);

    const confirmed = JSON.parse((await h.tools.get("enhance_flow")!.execute("s2", {
      action: "start", roles: ["planner"], goal: "Check schema", wait: true, confirmed: true,
    }, null, null, ctx)).content[0].text);
    expect(confirmed.status).toBe("completed");
    expect(runs).toBe(1);
    await h.emit("session_shutdown", {}, ctx);
  });

  test("#7: upgrading from legacy 4352c93 nested subState checkpoint pauses at 2nd human gate with 0 worker calls", async () => {
    const cwd = makeTmpDir("r7");
    const globalDir = makeTmpDir("r7-g");
    const lockPath = path.join(makeTmpDir("r7-l"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));
    writeText(path.join(globalDir, "legacy-wf.yaml"), `id: legacy-wf
name: Legacy WF
description: Two gates then work
model: inherit
method: [Wait for both approvals]
stance: Legacy workflow
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
    - id: format
      kind: human
      prompt: "确认输出格式？"
    - id: budget
      kind: human
      prompt: "确认预算上限？"
    - id: work
      brief: Generate report
`);

    // Seed exact 4352c93-style nested subState checkpoint into SQLite!
    const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    const flowId = "flow-legacy-4352c93";
    const mandate = store.upsertMandate({ goal: "Legacy upgrade", flowId });
    const legacySpec: FlowGraphSpec = {
      version: 1, goal: "Legacy upgrade", preset: "custom",
      nodes: [{ id: "legacy-wf", kind: "role", role: "legacy-wf", dependsOn: [] }],
      policies: normalizePolicies({ maxConcurrency: 1, pauseOnWaitingInput: "whole_flow" }),
    };
    const legacySubState: any = {
      flowId: `${flowId}::legacy-wf`, mandateId: mandate.id, cwd, status: "waiting_input",
      spec: {
        version: 1, goal: "Legacy upgrade", preset: "custom",
        nodes: [
          { id: "format", kind: "human", dependsOn: [], human: { prompt: "确认输出格式？" } },
          { id: "budget", kind: "human", dependsOn: ["format"], human: { prompt: "确认预算上限？" } },
          { id: "work", kind: "role", role: "legacy-wf", dependsOn: ["budget"] },
        ],
        policies: normalizePolicies({}),
      },
      nodes: {
        format: { nodeId: "format", status: "waiting_input", waveIndex: 0, effectiveWorkspace: "inherit", sessionResidency: "none", attempt: 1, repairRound: 0, activeStageId: "s-1", worktreePath: null, commitRef: null, currentModel: null, triedModels: [], lastHandoffId: null, lastHandoff: null, lastGateEvidence: null, lastError: null, lastRepairFeedback: null, questionsForUser: ["确认输出格式？"], startedAt: "2026-11-26T00:00:00Z", endedAt: null },
        budget: { nodeId: "budget", status: "pending", waveIndex: 1, effectiveWorkspace: "inherit", sessionResidency: "none", attempt: 0, repairRound: 0, activeStageId: null, worktreePath: null, commitRef: null, currentModel: null, triedModels: [], lastHandoffId: null, lastHandoff: null, lastGateEvidence: null, lastError: null, lastRepairFeedback: null, questionsForUser: [], startedAt: null, endedAt: null },
        work: { nodeId: "work", status: "pending", waveIndex: 2, effectiveWorkspace: "inherit", sessionResidency: "none", attempt: 0, repairRound: 0, activeStageId: null, worktreePath: null, commitRef: null, currentModel: null, triedModels: [], lastHandoffId: null, lastHandoff: null, lastGateEvidence: null, lastError: null, lastRepairFeedback: null, questionsForUser: [], startedAt: null, endedAt: null },
      },
      nodeOrder: ["format", "budget", "work"], waves: [["format"], ["budget"], ["work"]],
      repairRound: 0, maxRepairRounds: 2, lastRejectionSig: null, nextStageSeq: 1, boardSeq: 0,
      initialHandoffId: null, lastHandoffId: null, mergedRef: null, startedAt: "2026-11-26T00:00:00Z", endedAt: null,
    };
    const legacyOuterState: any = {
      flowId, mandateId: mandate.id, cwd, status: "waiting_input", spec: legacySpec,
      nodes: {
        "legacy-wf": {
          nodeId: "legacy-wf", status: "waiting_input", waveIndex: 0, effectiveWorkspace: "inherit", sessionResidency: "none",
          attempt: 1, repairRound: 0, activeStageId: "outer-1", worktreePath: null, commitRef: null, currentModel: null,
          triedModels: [], lastHandoffId: null, lastHandoff: null, lastGateEvidence: null, lastError: null, lastRepairFeedback: null,
          questionsForUser: ["确认输出格式？"], subState: legacySubState, startedAt: "2026-11-26T00:00:00Z", endedAt: null,
        },
      },
      nodeOrder: ["legacy-wf"], waves: [["legacy-wf"]], repairRound: 0, maxRepairRounds: 2,
      lastRejectionSig: null, nextStageSeq: 1, boardSeq: 0, initialHandoffId: null, lastHandoffId: null, mergedRef: null,
      startedAt: "2026-11-26T00:00:00Z", endedAt: null,
    };
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: "Legacy upgrade", cwd, roleChain: ["legacy-wf"], status: "waiting_input",
      currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 2,
      snapshotJson: JSON.stringify({ flowId, status: "waiting_input", roleChain: ["legacy-wf"], stages: [] }),
      graphSpecJson: JSON.stringify(legacySpec), machineStateJson: JSON.stringify(legacyOuterState),
      updatedAt: "2026-11-26T00:00:01Z",
    });
    store.close();

    let workerCalls = 0;
    const h = makeHarness({
      cwd, globalDir, lockPath,
      runnerFactory: () => ({
        runRoleTurn: async (ctx) => {
          workerCalls += 1;
          const ho = createAndVerifyHandoff({ store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: "built PDF" });
          return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
        },
      }),
    });
    const ctx = { cwd, hasUI: false };

    // Answering "PDF 格式" MUST stop at budget gate with 0 worker calls!
    const afterFormat = JSON.parse((await h.tools.get("enhance_flow")!.execute("r1", {
      action: "resume", flowId, nodeId: "legacy-wf", message: "PDF 格式", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(afterFormat.status).toBe("waiting_input");
    expect(afterFormat.reason).toContain("确认预算上限？");
    expect(workerCalls).toBe(0);

    // Answering budget gate runs worker once and completes!
    const afterBudget = JSON.parse((await h.tools.get("enhance_flow")!.execute("r2", {
      action: "resume", flowId, nodeId: "legacy-wf__budget", message: "预算 200", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(afterBudget.status).toBe("completed");
    expect(workerCalls).toBe(1);
    await h.emit("session_shutdown", {}, ctx);
  });

  test("#8: live GRAPH_PATCH appending a workflow role executes all expanded phases and human gates", async () => {
    const cwd = makeTmpDir("r8");
    const globalDir = makeTmpDir("r8-g");
    const lockPath = path.join(makeTmpDir("r8-l"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));
    writeText(path.join(globalDir, "gated-worker.yaml"), `id: gated-worker
name: Gated Worker
description: 2 gates + work
model: inherit
method: [Wait for approvals]
stance: Respect phases.
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
    - id: g1
      kind: human
      prompt: "补丁第一关？"
    - id: g2
      kind: human
      prompt: "补丁第二关？"
    - id: exec
      brief: Execute patched work
`);

    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstP = new Promise<void>((r) => { firstEntered = r; });
    const ranNodes: string[] = [];

    const h = makeHarness({
      cwd, globalDir, lockPath,
      runnerFactory: () => ({
        runRoleTurn: async (ctx) => {
          ranNodes.push(ctx.nodeId!);
          if (ctx.nodeId === "step1") {
            firstEntered();
            await new Promise<void>((r) => { releaseFirst = r; });
          }
          const ho = createAndVerifyHandoff({
            store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: "ok",
            observedCalls: [{ toolCallId: `c-${ctx.nodeId}`, toolName: "read", isError: false, touchedPaths: [], timestamp: new Date().toISOString() }],
          });
          return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
        },
      }),
    });
    const ctx = { cwd, hasUI: true, isIdle: () => true };

    const started = JSON.parse((await h.tools.get("enhance_flow")!.execute("s", {
      action: "start", goal: "Patch workflow role",
      nodes: [{ id: "step1", kind: "role", role: "planner", dependsOn: [] }],
    }, null, null, ctx)).content[0].text);
    const flowId = started.flowId as string;
    await firstP;

    const patched = JSON.parse((await h.tools.get("enhance_flow")!.execute("p", {
      action: "patch", flowId,
      patch: { addNodes: [{ id: "pw", kind: "role", role: "gated-worker", dependsOn: ["step1"] }] },
    }, null, null, ctx)).content[0].text);
    expect(patched.patched).toBe(true);
    releaseFirst();

    for (let i = 0; i < 40; i++) {
      const st = JSON.parse((await h.tools.get("enhance_flow")!.execute("st", { action: "status", flowId }, null, null, ctx)).content[0].text);
      if (st.status === "waiting_input") break;
      await Bun.sleep(15);
    }
    const st1 = JSON.parse((await h.tools.get("enhance_flow")!.execute("st1", { action: "status", flowId }, null, null, ctx)).content[0].text);
    expect(st1.status).toBe("waiting_input");
    expect(st1.reason).toContain("补丁第一关？");
    expect(ranNodes).toEqual(["step1"]);

    const r1 = JSON.parse((await h.tools.get("enhance_flow")!.execute("r1", {
      action: "resume", flowId, nodeId: "pw__g1", message: "通过第一关", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(r1.status).toBe("waiting_input");
    expect(r1.reason).toContain("补丁第二关？");
    expect(ranNodes).toEqual(["step1"]);

    const r2 = JSON.parse((await h.tools.get("enhance_flow")!.execute("r2", {
      action: "resume", flowId, nodeId: "pw__g2", message: "通过第二关", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(r2.status).toBe("completed");
    expect(ranNodes).toEqual(["step1", "pw__exec"]);
    await h.emit("session_shutdown", {}, ctx);
  });

  test("#9: targeted resume on unready downstream node after upstream failure is blocked with unmetDependencies and 0 impl calls", async () => {
    const cwd = makeTmpDir("r9");
    const globalDir = makeTmpDir("r9-g");
    const lockPath = path.join(makeTmpDir("r9-l"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));

    let checkTries = 0;
    const called: string[] = [];
    const h = makeHarness({
      cwd, globalDir, lockPath,
      runnerFactory: () => ({
        runRoleTurn: async (ctx) => {
          called.push(ctx.nodeId!);
          if (ctx.nodeId === "check" && checkTries++ === 0) {
            return { envelope: null, observedCalls: [], assistantText: "", usage: null, hostError: "transient network error", retryableHostError: false };
          }
          const ho = createAndVerifyHandoff({
            store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: "ok",
            observedCalls: [{ toolCallId: `c-${ctx.nodeId}`, toolName: "read", isError: false, touchedPaths: [], timestamp: new Date().toISOString() }],
          });
          return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
        },
      }),
    });
    const ctx = { cwd, hasUI: false };

    const failed = JSON.parse((await h.tools.get("enhance_flow")!.execute("s", {
      action: "start", goal: "Guarded resume", wait: true,
      nodes: [
        { id: "check", kind: "role", role: "planner", dependsOn: [], maxAttempts: 1 },
        { id: "approve", kind: "human", dependsOn: ["check"], human: { prompt: "批准实施？" } },
        { id: "impl", kind: "role", role: "dev", dependsOn: ["approve"] },
      ],
    }, null, null, ctx)).content[0].text);
    expect(failed.status).toBe("failed");
    const flowId = JSON.parse((await h.tools.get("enhance_flow")!.execute("st", { action: "status" }, null, null, ctx)).content[0].text).flowId as string;

    // Targeted resume on pending downstream `impl` MUST fail without calling `impl`!
    const badResume = await h.tools.get("enhance_flow")!.execute("r-bad", {
      action: "resume", flowId, nodeId: "impl", wait: true,
    }, null, null, ctx);
    expect(badResume.isError).toBe(true);
    const badBody = JSON.parse(badResume.content[0].text);
    expect(badBody.unmetDependencies.some((u: any) => u.nodeId === "approve")).toBe(true);
    expect(called).toEqual(["check"]);

    // Normal resume retries `check` and stops cleanly at `approve`!
    const okRetry = JSON.parse((await h.tools.get("enhance_flow")!.execute("r-ok", {
      action: "resume", flowId, wait: true,
    }, null, null, ctx)).content[0].text);
    expect(okRetry.status).toBe("waiting_input");
    expect(called).toEqual(["check", "check"]);
    await h.emit("session_shutdown", {}, ctx);
  });

  test("#10: workflow-enabled role preserves each node's distinct brief (owns, nonGoals, acceptance, contextRefs)", async () => {
    const cwd = makeTmpDir("r10");
    const globalDir = makeTmpDir("r10-g");
    const lockPath = path.join(makeTmpDir("r10-l"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));
    writeText(path.join(globalDir, "wf-writer.yaml"), `id: wf-writer
name: WF Writer
description: Workflow writer
model: inherit
method: [Draft then verify]
stance: Follow assigned brief.
permissions:
  tools: ["read", "write"]
  writable: ["docs/**"]
  protected: [".git/**"]
exit:
  require_tool_evidence: false
  criteria: []
workflow:
  session: reuse
  phases:
    - id: draft
      brief: Draft according to brief
`);

    const promptByNode = new Map<string, string>();
    const h = makeHarness({
      cwd, globalDir, lockPath,
      runnerFactory: () => ({
        runRoleTurn: async (ctx) => {
          promptByNode.set(ctx.nodeId!, ctx.taskPrompt);
          const ho = createAndVerifyHandoff({ store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: "ok" });
          return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
        },
      }),
    });
    const ctx = { cwd, hasUI: false };

    const res = JSON.parse((await h.tools.get("enhance_flow")!.execute("s", {
      action: "start", goal: "Two distinct workflow briefs", wait: true,
      nodes: [
        {
          id: "doc-a", kind: "role", role: "wf-writer", dependsOn: [], writableScope: ["docs/a.md"],
          brief: { owns: "OWN_ALPHA", nonGoals: ["NO_BETA_TOUCH"], acceptance: ["ACCEPT_A_1"], contextRefs: ["ref/a.md"] },
        },
        {
          id: "doc-b", kind: "role", role: "wf-writer", dependsOn: [], writableScope: ["docs/b.md"],
          brief: { owns: "OWN_BETA", nonGoals: ["NO_ALPHA_TOUCH"], acceptance: ["ACCEPT_B_1"], contextRefs: ["ref/b.md"] },
        },
      ],
    }, null, null, ctx)).content[0].text);
    expect(res.status).toBe("completed");

    const promptA = promptByNode.get("doc-a__draft") ?? "";
    const promptB = promptByNode.get("doc-b__draft") ?? "";
    for (const tok of ["OWN_ALPHA", "NO_BETA_TOUCH", "ACCEPT_A_1", "ref/a.md"]) expect(promptA).toContain(tok);
    expect(promptA).not.toContain("OWN_BETA");
    for (const tok of ["OWN_BETA", "NO_ALPHA_TOUCH", "ACCEPT_B_1", "ref/b.md"]) expect(promptB).toContain(tok);
    expect(promptB).not.toContain("OWN_ALPHA");
    await h.emit("session_shutdown", {}, ctx);
  });

  test("#11: QA blocks ready when smoke passes but edge test fails; fixing & re-running edge passes AND preserves initial failure record", () => {
    const cwd = makeTmpDir("r11");
    const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    const mandate = store.upsertMandate({ goal: "Verify all executed tests" });
    writeText(path.join(cwd, "smoke.test.ts"), 'import { expect, test } from "bun:test"; test("smoke", () => expect(1).toBe(1));\n');
    writeText(path.join(cwd, "edge.test.ts"), 'import { expect, test } from "bun:test"; test("edge", () => expect(1).toBe(2));\n');
    const qaRole = makeRole("qa", { exit: { requireToolEvidence: true, requireTestExecution: true, criteria: [] } });

    const runCall = (cmd: string, id: string): ObservedToolCall => {
      const r = spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8" });
      return {
        toolCallId: id, toolName: "bash", command: cmd, isError: r.status !== 0, exitCode: r.status ?? 1,
        outputSnippet: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-400), touchedPaths: [], timestamp: new Date().toISOString(),
      };
    };

    const smokeOk = runCall("bun test smoke.test.ts", "tc-smoke");
    const edgeFail = runCall("bun test edge.test.ts", "tc-edge-fail");
    expect(smokeOk.exitCode).toBe(0);
    expect(edgeFail.exitCode).not.toBe(0);

    // Smoke passed, edge failed -> ready MUST throw!
    expect(() => createAndVerifyHandoff({
      store, role: qaRole, cwd, mandate, verdict: "ready", summary: "smoke passed", observedCalls: [smokeOk, edgeFail],
    })).toThrow(/bun test edge\.test\.ts/i);

    // Fix edge test, re-run edge -> ready succeeds AND keeps first failure record!
    writeText(path.join(cwd, "edge.test.ts"), 'import { expect, test } from "bun:test"; test("edge", () => expect(2).toBe(2));\n');
    const editCall: ObservedToolCall = { toolCallId: "tc-edit", toolName: "write", isError: false, touchedPaths: ["edge.test.ts"], timestamp: new Date().toISOString() };
    const edgePass = runCall("bun test edge.test.ts", "tc-edge-pass");
    expect(edgePass.exitCode).toBe(0);

    const okHo = createAndVerifyHandoff({
      store, role: qaRole, cwd, mandate, verdict: "ready", summary: "edge fixed and passed",
      observedCalls: [smokeOk, edgeFail, editCall, edgePass],
    });
    expect(okHo.verificationEvidence?.some((e) => e.toolCallId === "tc-edge-fail" && e.exitCode !== 0)).toBe(true);
    expect(okHo.verificationEvidence?.some((e) => e.toolCallId === "tc-edge-pass" && e.exitCode === 0)).toBe(true);
    store.close();
  });

  test("#12: concurrent writable nodes after branch_preview without final merge are rejected; with final merge, both files survive in both finish orders", async () => {
    const roles = new Map<string, RoleSpec>([["dev", makeRole("dev")]]);

    // 1. Without final merge -> rejected pre-flight!
    const unsafeSpec: FlowGraphSpec = {
      version: 1, goal: "Unsafe parallel preview writes", preset: "custom",
      nodes: [
        { id: "w1", kind: "role", role: "dev", dependsOn: [], workspace: "worktree", writableScope: ["base.txt"] },
        { id: "m1", kind: "merge", dependsOn: ["w1"], merge: { sourceNodeIds: ["w1"], landingMode: "branch_preview", conflictPolicy: "fail" } },
        { id: "w_docs", kind: "role", role: "dev", dependsOn: ["m1"], writableScope: ["docs.txt"] },
        { id: "w_tests", kind: "role", role: "dev", dependsOn: ["m1"], writableScope: ["tests.txt"] },
      ],
      policies: normalizePolicies({}),
    };
    const badVal = validateFlowGraph({ spec: unsafeSpec, roles, isGitRepo: true });
    expect(badVal.ok).toBe(false);
    expect(badVal.issues.some((i) => i.code === "missing_merge_delivery" || i.code === "write_collision")).toBe(true);

    // 2. With final merge -> BOTH finish orders deliver base.txt + docs.txt + tests.txt in ONE SHA!
    for (const slowNode of ["w_docs", "w_tests"] as const) {
      const { cwd, store } = initGitRepo({ "README.md": "init\n" });
      const safeSpec: FlowGraphSpec = {
        version: 1, goal: `Safe parallel preview (${slowNode} slow)`, preset: "custom",
        nodes: [
          { id: "w1", kind: "role", role: "dev", dependsOn: [], workspace: "worktree", writableScope: ["base.txt"] },
          { id: "m1", kind: "merge", dependsOn: ["w1"], merge: { sourceNodeIds: ["w1"], landingMode: "branch_preview", conflictPolicy: "fail" } },
          { id: "w_docs", kind: "role", role: "dev", dependsOn: ["m1"], workspace: "worktree", writableScope: ["docs.txt"] },
          { id: "w_tests", kind: "role", role: "dev", dependsOn: ["m1"], workspace: "worktree", writableScope: ["tests.txt"] },
          { id: "m2", kind: "merge", dependsOn: ["w_docs", "w_tests"], merge: { sourceNodeIds: ["w_docs", "w_tests"], landingMode: "branch_preview", conflictPolicy: "fail" } },
        ],
        policies: normalizePolicies({ maxConcurrency: 3 }),
      };
      const val = validateFlowGraph({ spec: safeSpec, roles, isGitRepo: true });
      expect(val.ok).toBe(true);
      const flowId = `flow-r12-${slowNode}`;
      const mandate = store.upsertMandate({ goal: safeSpec.goal, flowId });
      store.saveFlowCheckpoint({
        flowId, mandateId: mandate.id, goal: safeSpec.goal, cwd, roleChain: ["w1", "m1", "w_docs", "w_tests", "m2"],
        status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 1,
        snapshotJson: "{}", updatedAt: new Date().toISOString(),
      });
      const runner: RoleSessionRunner = {
        async runRoleTurn(ctx) {
          if (ctx.nodeId === slowNode) await Bun.sleep(40);
          if (ctx.nodeId === "w1") writeText(path.join(ctx.cwd, "base.txt"), "BASE_FROM_W1\n");
          if (ctx.nodeId === "w_docs") writeText(path.join(ctx.cwd, "docs.txt"), "DOCS_OK\n");
          if (ctx.nodeId === "w_tests") writeText(path.join(ctx.cwd, "tests.txt"), "TESTS_OK\n");
          const ho = createAndVerifyHandoff({ store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: `${ctx.nodeId} ok` });
          return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
        },
      };
      const res = await executeFlowGraph({ cwd, store, flowId, mandate, spec: safeSpec, validation: val, roles, runner, worktreeManager: createGitWorktreeManager() });
      expect(res.status).toBe("completed");
      expect(res.mergedCommitSha).toBeTruthy();
      expect(git(cwd, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
      expect(git(cwd, ["show", `${res.mergedCommitSha}:base.txt`])).toBe("BASE_FROM_W1");
      expect(git(cwd, ["show", `${res.mergedCommitSha}:docs.txt`])).toBe("DOCS_OK");
      expect(git(cwd, ["show", `${res.mergedCommitSha}:tests.txt`])).toBe("TESTS_OK");
      store.close();
    }
  });

  test("#13 + node-level tools narrowing: frozen role snapshot isolates old paused Flow from YAML edits while new Flow adopts v2; node tools strictly narrow", async () => {
    const cwd = makeTmpDir("r13");
    const globalDir = makeTmpDir("r13-g");
    const lockPath = path.join(makeTmpDir("r13-l"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));

    const specYaml = (ver: string) => `id: policy-writer
name: Policy Writer ${ver}
description: Refund writer
model: inherit
method:
  - METHOD_${ver}
stance: Stance ${ver}
permissions:
  tools: ["read", "write", "bash"]
  writable: ["docs/**"]
  protected: [".git/**"]
exit:
  require_tool_evidence: false
  criteria: []
`;
    const yamlPath = path.join(globalDir, "policy-writer.yaml");
    writeText(yamlPath, specYaml("V1"));

    let flow1PausedOnce = false;
    const seenByGoal: Record<string, { method: string[]; tools?: string[] }> = {};
    const h = makeHarness({
      cwd, globalDir, lockPath,
      runnerFactory: () => ({
        runRoleTurn: async (ctx) => {
          if (ctx.mandate.goal === "Old Flow" && !flow1PausedOnce) {
            flow1PausedOnce = true;
            const ho = createAndVerifyHandoff({
              store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "needs_input",
              summary: "Need wording check", questionsForUser: ["Use formal tone?"],
            });
            return { envelope: ho, observedCalls: [], assistantText: "pause", usage: null };
          }
          seenByGoal[ctx.mandate.goal] = { method: [...ctx.role.method], tools: ctx.role.permissions.tools };
          const ho = createAndVerifyHandoff({ store: ctx.store, role: ctx.role, cwd: ctx.cwd, mandate: ctx.mandate, verdict: "ready", summary: "done" });
          return { envelope: ho, observedCalls: [], assistantText: "ok", usage: null };
        },
      }),
    });
    const ctx = { cwd, hasUI: false };

    // 1. Old Flow starts on V1 and pauses
    const oldPaused = JSON.parse((await h.tools.get("enhance_flow")!.execute("f1", {
      action: "start", goal: "Old Flow", wait: true,
      nodes: [{ id: "w1", kind: "role", role: "policy-writer", dependsOn: [], tools: ["read", "write"], writableScope: ["docs/refunds.md"] }],
    }, null, null, ctx)).content[0].text);
    expect(oldPaused.status).toBe("waiting_input");
    const oldFlowId = JSON.parse((await h.tools.get("enhance_flow")!.execute("st1", { action: "status" }, null, null, ctx)).content[0].text).flowId as string;

    // 2. User updates policy-writer.yaml to V2 while Old Flow is suspended
    writeText(yamlPath, specYaml("V2"));

    // 3. New Flow starts -> adopts V2 AND honors node-level tools narrowing (no bash!)
    const newDone = JSON.parse((await h.tools.get("enhance_flow")!.execute("f2", {
      action: "start", goal: "New Flow", wait: true,
      nodes: [{ id: "w2", kind: "role", role: "policy-writer", dependsOn: [], tools: ["read", "write"], writableScope: ["docs/refunds.md"] }],
    }, null, null, ctx)).content[0].text);
    expect(newDone.status).toBe("completed");
    expect(seenByGoal["New Flow"]).toEqual({ method: ["METHOD_V2"], tools: ["read", "write"] });

    // 4. Resume Old Flow -> STILL uses frozen V1 method + narrowed tools!
    const oldDone = JSON.parse((await h.tools.get("enhance_flow")!.execute("r1", {
      action: "resume", flowId: oldFlowId, message: "Use formal tone", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(oldDone.status).toBe("completed");
    expect(seenByGoal["Old Flow"]).toEqual({ method: ["METHOD_V1"], tools: ["read", "write"] });

    // 5. Node-level tools escalation (asking for bash on read-only reviewer) MUST be rejected pre-flight!
    const escalated = await h.tools.get("enhance_flow")!.execute("f-bad-tools", {
      action: "start", goal: "Illegal escalation", wait: true,
      nodes: [{ id: "rev", kind: "role", role: "reviewer", dependsOn: [], tools: ["read", "bash"] }],
    }, null, null, ctx);
    expect(escalated.isError).toBe(true);
    expect(JSON.parse(escalated.content[0].text).invalidGraph).toBe(true);
    await h.emit("session_shutdown", {}, ctx);
  });
});
