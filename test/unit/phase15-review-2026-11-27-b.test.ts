import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildBlindReviewBundle,
  detectBlindReviewLeaks,
  PILOT_CASES,
  scoreCaseOutput,
  type PilotTrialRecord,
} from "../../scripts/eval-ci-diagnosis.ts";
import { computeWorkspaceFingerprint, snapshotWorkspace } from "../../src/core/fs.ts";
import { EnhanceStore } from "../../src/core/store.ts";
import type { ObservedToolCall, RoleSpec } from "../../src/core/types.ts";
import ompEnhance from "../../src/entry.ts";
import { createAndVerifyHandoff } from "../../src/flow/handoff.ts";
import type { RoleSessionRunner } from "../../src/flow/orchestrator.ts";
import { discoverRoles } from "../../src/roles/loader.ts";

const tempDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `omp-p15-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function writeText(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function git(cwd: string, args: readonly string[]): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@local",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@local",
    },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  return (res.stdout ?? "").trim();
}

function initGitRepo(prefix: string): string {
  const dir = makeTmpDir(prefix);
  git(dir, ["init", "-q"]);
  writeText(path.join(dir, "README.md"), "base\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function makeHarness(options: {
  cwd: string;
  globalDir: string;
  lockPath: string;
  runner?: RoleSessionRunner;
}) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const tools = new Map<string, any>();
  const messages: Array<{ content: string; customType?: string }> = [];
  const pi: any = {
    cwd: options.cwd,
    on: (ev: string, fn: (e: any, c: any) => any) => {
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
    },
    registerCommand: (name: string, def: any) => commands.set(name, def),
    registerTool: (def: any) => tools.set(def.name, def),
    registerMessageRenderer: () => {},
    sendMessage: (msg: any) => messages.push({ content: String(msg?.content ?? ""), customType: msg?.customType }),
    getAllTools: () => [{ name: "read" }, { name: "grep" }, { name: "write" }, { name: "edit" }, { name: "bash" }],
    setActiveTools: async () => {},
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
  };
  ompEnhance(pi, {
    globalRolesDir: options.globalDir,
    pluginLockPath: options.lockPath,
    ...(options.runner ? { runnerFactory: () => options.runner! } : {}),
  });
  const emit = async (ev: string, payload: any, ctx: any): Promise<any[]> => {
    const out: any[] = [];
    for (const fn of handlers.get(ev) ?? []) out.push(await fn(payload, ctx));
    return out;
  };
  return { pi, commands, tools, messages, emit };
}

function makeHandoff(ctx: any, summary: string, overrides?: Partial<any>) {
  const ho = {
    id: `ho-${ctx.nodeId ?? ctx.role.id}-${Math.random().toString(36).slice(2, 6)}`,
    mandateId: ctx.mandate.id,
    mandateRev: ctx.mandate.rev,
    parentHandoffId: null,
    fromRole: ctx.role.id,
    toTarget: ctx.toTarget ?? "user",
    verdict: "ready" as const,
    summary,
    artifacts: [],
    verifiedFacts: [],
    openRisks: [],
    feedbackForUpstream: null,
    observedUsage: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  ctx.store.saveHandoff(ho);
  return { envelope: ho, observedCalls: [], assistantText: summary, usage: null };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 15: Review 2026-11-27b Regression Suite (6d59c16 Follow-up)", () => {
  test("1. P1-1: cross-project waiting Flows require flowId/cwd when both Alpha and Beta wait on decide", async () => {
    const alphaDir = makeTmpDir("alpha");
    const betaDir = makeTmpDir("beta");
    const globalDir = makeTmpDir("global-p1");
    const lockPath = path.join(makeTmpDir("lock-p1"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto" } } }));

    const dispatched: Array<{ cwd: string; nodeId: string }> = [];
    const runner: RoleSessionRunner = {
      runRoleTurn: async (ctx) => {
        dispatched.push({ cwd: ctx.cwd, nodeId: ctx.nodeId ?? ctx.role.id });
        return makeHandoff(ctx, `Done ${ctx.nodeId} in ${path.basename(ctx.cwd)}`);
      },
    };
    const h = makeHarness({ cwd: alphaDir, globalDir, lockPath, runner });
    const ctx = { cwd: alphaDir, hasUI: false };

    const startAlpha = JSON.parse((await h.tools.get("enhance_flow")!.execute("sa", {
      action: "start", goal: "Alpha release approval", wait: true,
      nodes: [
        { id: "decide", kind: "human", dependsOn: [], human: { prompt: "是否批准 Alpha 发布？" } },
        { id: "after", kind: "role", role: "planner", dependsOn: ["decide"] },
      ],
    }, null, null, ctx)).content[0].text);
    expect(startAlpha.status).toBe("waiting_input");

    const startBeta = JSON.parse((await h.tools.get("enhance_flow")!.execute("sb", {
      action: "start", cwd: betaDir, goal: "Beta migration approval", wait: true,
      nodes: [
        { id: "decide", kind: "human", dependsOn: [], human: { prompt: "是否批准 Beta 迁移？" } },
        { id: "after", kind: "role", role: "planner", dependsOn: ["decide"] },
      ],
    }, null, null, ctx)).content[0].text);
    expect(startBeta.status).toBe("waiting_input");

    // Omitting flowId and cwd MUST report cross-project ambiguity without advancing Alpha OR Beta!
    const ambig1 = await h.tools.get("enhance_flow")!.execute("r1", {
      action: "resume", message: "仅同意 Beta 项目", wait: true,
    }, null, null, ctx);
    expect(ambig1.isError).toBe(true);
    const ambigPayload1 = JSON.parse(ambig1.content[0].text);
    expect(ambigPayload1.ambiguous).toBe(true);
    expect(ambigPayload1.requiresFlowId).toBe(true);
    expect(ambigPayload1.candidates.map((c: any) => c.cwd).sort()).toEqual([alphaDir, betaDir].sort());
    expect(dispatched).toEqual([]);

    // Even passing nodeId="decide" without flowId/cwd MUST stay ambiguous!
    const ambig2 = await h.tools.get("enhance_flow")!.execute("r2", {
      action: "resume", nodeId: "decide", message: "仅同意 Beta 项目", wait: true,
    }, null, null, ctx);
    expect(ambig2.isError).toBe(true);
    expect(JSON.parse(ambig2.content[0].text).ambiguous).toBe(true);
    expect(dispatched).toEqual([]);

    // Steer omitting flowId/cwd across 2 active/waiting projects MUST also report ambiguity!
    const ambigSteer = await h.tools.get("enhance_flow")!.execute("st1", {
      action: "steer", message: "加急处理",
    }, null, null, ctx);
    expect(ambigSteer.isError).toBe(true);
    expect(JSON.parse(ambigSteer.content[0].text).ambiguous).toBe(true);

    // Explicitly targeting Beta advances ONLY Beta; Alpha remains waiting_input!
    const okBeta = JSON.parse((await h.tools.get("enhance_flow")!.execute("rb", {
      action: "resume", cwd: betaDir, nodeId: "decide", message: "同意 Beta 迁移", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(okBeta.status).toBe("completed");
    expect(dispatched).toEqual([{ cwd: betaDir, nodeId: "after" }]);

    const statusAlpha = JSON.parse((await h.tools.get("enhance_flow")!.execute("sta", {
      action: "status", cwd: alphaDir,
    }, null, null, ctx)).content[0].text);
    expect(statusAlpha.status).toBe("waiting_input");
    await h.emit("session_shutdown", {}, ctx);
  });

  test("2. P1-2: unified human policy enforces strict options/hold/cancel in backend and distinguishes input vs approval in foreground", async () => {
    const cwd = makeTmpDir("human-policy");
    const globalDir = makeTmpDir("global-p2");
    const lockPath = path.join(makeTmpDir("lock-p2"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto" } } }));

    // Custom foreground role with strict approval options gate
    writeText(path.join(cwd, ".omp", "roles", "strict-gate.yaml"), `id: strict-gate
name: Strict Gate
description: Foreground strict approval gate
stance: Strictly wait for approval option.
method:
  - Ask user
exit:
  require_tool_evidence: false
  criteria: []
workflow:
  session: reuse
  phases:
    - id: approve
      kind: human
      prompt: "是否批准进入交付？"
      options: ["同意", "暂缓"]
      allow_free_text: false
    - id: finish
      brief: Deliver final output
`);

    const dispatched: string[] = [];
    const runner: RoleSessionRunner = {
      runRoleTurn: async (ctx) => {
        dispatched.push(ctx.nodeId ?? ctx.role.id);
        return makeHandoff(ctx, `Executed ${ctx.nodeId}`);
      },
    };
    const h = makeHarness({ cwd, globalDir, lockPath, runner });
    const ctx = { cwd, hasUI: false };

    // 2a) Backend strict approval gate: allowFreeText=false, options=["同意", "暂缓", "取消"]
    const s1 = JSON.parse((await h.tools.get("enhance_flow")!.execute("start-strict", {
      action: "start", goal: "Strict option approval", wait: true,
      nodes: [
        {
          id: "approve", kind: "human", dependsOn: [],
          human: { prompt: "是否批准执行发布？", options: ["同意", "暂缓", "取消"], allowFreeText: false },
        },
        { id: "deploy", kind: "role", role: "planner", dependsOn: ["approve"] },
      ],
    }, null, null, ctx)).content[0].text);
    expect(s1.status).toBe("waiting_input");
    const flowId1 = JSON.parse((await h.tools.get("enhance_flow")!.execute("st-s1", { action: "status" }, null, null, ctx)).content[0].text).flowId;

    // Out-of-list clarification MUST be rejected as invalid; deploy does NOT run!
    const badClarify = await h.tools.get("enhance_flow")!.execute("res-bad", {
      action: "resume", flowId: flowId1, nodeId: "approve", message: "先解释一下回滚策略", wait: true,
    }, null, null, ctx);
    expect(badClarify.isError).toBe(true);
    expect(JSON.parse(badClarify.content[0].text)).toMatchObject({ resumed: false, invalidReply: true, decision: "invalid", status: "waiting_input" });
    expect(dispatched).toEqual([]);

    // Hold option ("暂缓") MUST keep node waiting_input and NOT run deploy!
    const holdRes = await h.tools.get("enhance_flow")!.execute("res-hold", {
      action: "resume", flowId: flowId1, nodeId: "approve", message: "暂缓", wait: true,
    }, null, null, ctx);
    expect(holdRes.isError).toBeUndefined();
    expect(JSON.parse(holdRes.content[0].text)).toMatchObject({ resumed: false, held: true, decision: "hold", status: "waiting_input" });
    expect(dispatched).toEqual([]);

    // Explicit proceed option ("同意") advances and runs deploy ONCE!
    const okProceed = JSON.parse((await h.tools.get("enhance_flow")!.execute("res-ok", {
      action: "resume", flowId: flowId1, nodeId: "approve", message: "同意", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(okProceed.status).toBe("completed");
    expect(dispatched).toEqual(["deploy"]);

    // 2b) Cancel option ("取消") stops downstream and settles flow as cancelled!
    const s2 = JSON.parse((await h.tools.get("enhance_flow")!.execute("start-cancel", {
      action: "start", goal: "Cancel option test", wait: true,
      nodes: [
        {
          id: "approve", kind: "human", dependsOn: [],
          human: { prompt: "是否批准删除旧表？", options: ["同意", "暂缓", "取消"], allowFreeText: false },
        },
        { id: "drop", kind: "role", role: "planner", dependsOn: ["approve"] },
      ],
    }, null, null, ctx)).content[0].text);
    expect(s2.status).toBe("waiting_input");
    const flowId2 = JSON.parse((await h.tools.get("enhance_flow")!.execute("st-s2", { action: "status" }, null, null, ctx)).content[0].text).flowId;
    const cancelRes = JSON.parse((await h.tools.get("enhance_flow")!.execute("res-cancel", {
      action: "resume", flowId: flowId2, nodeId: "approve", message: "取消", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(cancelRes.status).toBe("cancelled");
    expect(dispatched).toEqual(["deploy"]); // "drop" NEVER ran!

    // 2c) Foreground algo align_metric (input mode): accepts negative-constraint metric spec, still blocks status queries/deferrals!
    const algoEntries: any[] = [];
    const algoCtx: any = { cwd, hasUI: false, sessionManager: { getSessionId: () => "fg-algo-p15", getBranch: () => algoEntries, getEntries: () => algoEntries } };
    await h.commands.get("role")!.handler("algo --foreground", algoCtx);
    algoEntries.push({ id: "u1", type: "message", message: { role: "user", content: "开始数据体检" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, algoCtx);
    // Satisfy audit phase exit artifact
    writeText(path.join(cwd, "algo_work", "benchmark", "data_profile.json"), JSON.stringify({ rows: 100 }));
    await h.emit("tool_execution_end", { toolCallId: "t1", toolName: "read", isError: false }, algoCtx);
    const auditDone = await h.tools.get("enhance_handoff")!.execute("a-done", { verdict: "ready", summary: "数据体检完成" }, null, null, algoCtx);
    expect(auditDone.isError).toBeUndefined();
    expect(JSON.parse(auditDone.content[0].text).workflowProgress.nextPhaseId).toBe("align_metric");
    await h.emit("agent_end", {}, algoCtx);

    // Status query & pure deferral stay blocked on align_metric
    for (const [i, msg] of ["现在进度如何", "可以说一下进度吗？", "先等等再定"].entries()) {
      algoEntries.push({ id: `u-blk-${i}`, type: "message", message: { role: "user", content: msg } });
      await h.emit("before_agent_start", { systemPrompt: [] }, algoCtx);
      const blk = await h.tools.get("enhance_handoff")!.execute(`a-blk-${i}`, { verdict: "ready", summary: "尝试推进" }, null, null, algoCtx);
      expect(blk.isError).toBe(true);
      await h.emit("agent_end", {}, algoCtx);
    }

    // Negative-constraint metric parameter MUST pass input mode!
    algoEntries.push({ id: "u-metric", type: "message", message: { role: "user", content: "不要优化均值，以 P99 延迟为准" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, algoCtx);
    const metricPass = await h.tools.get("enhance_handoff")!.execute("a-metric", { verdict: "ready", summary: "已锁定 P99 延迟指标" }, null, null, algoCtx);
    expect(metricPass.isError).toBeUndefined();
    expect(JSON.parse(metricPass.content[0].text).workflowProgress).toMatchObject({
      advanced: true, nextPhaseId: "baseline", userReply: "不要优化均值，以 P99 延迟为准",
    });

    // 2d) Foreground strict approval gate blocks negation/deferral/out-of-list and accepts "同意"
    const sgEntries: any[] = [];
    const sgCtx: any = { cwd, hasUI: false, sessionManager: { getSessionId: () => "fg-strict-p15", getBranch: () => sgEntries, getEntries: () => sgEntries } };
    await h.commands.get("role")!.handler("strict-gate --foreground", sgCtx);
    sgEntries.push({ id: "sg1", type: "message", message: { role: "user", content: "开始" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, sgCtx);
    for (const [i, msg] of ["先不要批准，我还要看材料", "暂缓", "先说明细节"].entries()) {
      sgEntries.push({ id: `sg-blk-${i}`, type: "message", message: { role: "user", content: msg } });
      await h.emit("before_agent_start", { systemPrompt: [] }, sgCtx);
      const blk = await h.tools.get("enhance_handoff")!.execute(`sg-b-${i}`, { verdict: "ready", summary: "尝试推进" }, null, null, sgCtx);
      expect(blk.isError).toBe(true);
    }
    sgEntries.push({ id: "sg-ok", type: "message", message: { role: "user", content: "同意" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, sgCtx);
    const sgOk = await h.tools.get("enhance_handoff")!.execute("sg-ok", { verdict: "ready", summary: "用户同意" }, null, null, sgCtx);
    expect(sgOk.isError).toBeUndefined();
    expect(JSON.parse(sgOk.content[0].text).workflowProgress).toMatchObject({ advanced: true, nextPhaseId: "finish" });
    await h.emit("session_shutdown", {}, ctx);
  });

  test("3. P1-3: branch_preview followed by parallel workers and apply lands ALL 3 files and clears ephemeral mergedRef", async () => {
    const runScenario = async (finalLanding: "apply" | "branch_preview") => {
      const repoDir = initGitRepo(`landing-${finalLanding}`);
      const globalDir = makeTmpDir(`global-${finalLanding}`);
      const lockPath = path.join(makeTmpDir(`lock-${finalLanding}`), "omp-plugins.lock.json");
      writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto" } } }));

      let reviewerObservedFiles: string[] = [];
      const runner: RoleSessionRunner = {
        runRoleTurn: async (ctx) => {
          if (ctx.nodeId === "w1") writeText(path.join(ctx.cwd, "product.txt"), "PRODUCT_V1\n");
          if (ctx.nodeId === "w_docs") writeText(path.join(ctx.cwd, "docs.txt"), "DOCS_V1\n");
          if (ctx.nodeId === "w_tests") writeText(path.join(ctx.cwd, "tests.txt"), "TESTS_V1\n");
          if (ctx.nodeId === "rev") {
            reviewerObservedFiles = ["product.txt", "docs.txt", "tests.txt"].filter((f) => existsSync(path.join(ctx.cwd, f)));
          }
          return makeHandoff(ctx, `Completed ${ctx.nodeId}`);
        },
      };
      const h = makeHarness({ cwd: repoDir, globalDir, lockPath, runner });
      const ctx = { cwd: repoDir, hasUI: false };
      const res = JSON.parse((await h.tools.get("enhance_flow")!.execute("start-land", {
        action: "start", goal: `Preview then ${finalLanding}`, wait: true,
        nodes: [
          { id: "w1", kind: "role", role: "dev", workspace: "worktree", writableScope: ["product.txt"], dependsOn: [] },
          { id: "m1", kind: "merge", dependsOn: ["w1"], merge: { sourceNodeIds: ["w1"], landingMode: "branch_preview" } },
          { id: "w_docs", kind: "role", role: "dev", workspace: "worktree", writableScope: ["docs.txt"], dependsOn: ["m1"] },
          { id: "w_tests", kind: "role", role: "dev", workspace: "worktree", writableScope: ["tests.txt"], dependsOn: ["m1"] },
          { id: "m2", kind: "merge", dependsOn: ["w_docs", "w_tests"], merge: { sourceNodeIds: ["w_docs", "w_tests"], landingMode: finalLanding } },
          { id: "rev", kind: "role", role: "reviewer", dependsOn: ["m2"] },
        ],
      }, null, null, ctx)).content[0].text);
      const st = JSON.parse((await h.tools.get("enhance_flow")!.execute("st-land", { action: "status" }, null, null, ctx)).content[0].text);
      await h.emit("session_shutdown", {}, ctx);
      return { repoDir, res, st, reviewerObservedFiles };
    };

    // Case A: apply — all 3 files MUST exist on disk, reviewer saw all 3, and no deleted refs/omp-enhance/* leaked!
    const applied = await runScenario("apply");
    expect(applied.res.status).toBe("completed");
    expect(applied.res.mergedRef).toBeUndefined();
    expect(applied.st.graphSnapshot.mergedRef).toBeNull();
    expect(readFileSync(path.join(applied.repoDir, "product.txt"), "utf8")).toBe("PRODUCT_V1\n");
    expect(readFileSync(path.join(applied.repoDir, "docs.txt"), "utf8")).toBe("DOCS_V1\n");
    expect(readFileSync(path.join(applied.repoDir, "tests.txt"), "utf8")).toBe("TESTS_V1\n");
    expect(applied.reviewerObservedFiles).toEqual(["product.txt", "docs.txt", "tests.txt"]);
    expect(git(applied.repoDir, ["for-each-ref", "refs/omp-enhance/"])).toBe("");

    // Case B: branch_preview control — main working tree untouched, persistent branch has all 3 files!
    const preview = await runScenario("branch_preview");
    expect(preview.res.status).toBe("completed");
    expect(preview.res.mergedRef).toMatch(/^omp-enhance/);
    expect(existsSync(path.join(preview.repoDir, "product.txt"))).toBe(false);
    expect(existsSync(path.join(preview.repoDir, "docs.txt"))).toBe(false);
    expect(existsSync(path.join(preview.repoDir, "tests.txt"))).toBe(false);
    expect(git(preview.repoDir, ["show", `${preview.res.mergedRef}:product.txt`])).toBe("PRODUCT_V1");
    expect(git(preview.repoDir, ["show", `${preview.res.mergedRef}:docs.txt`])).toBe("DOCS_V1");
    expect(git(preview.repoDir, ["show", `${preview.res.mergedRef}:tests.txt`])).toBe("TESTS_V1");
    expect(preview.reviewerObservedFiles).toEqual(["product.txt", "docs.txt", "tests.txt"]);
  });

  test("4. P1-4: QA blocks masked piped failing test even after smoke passes, and enforces declarative requiredChecks", () => {
    const cwd = makeTmpDir("qa-pipe");
    const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    const roles = discoverRoles({ cwd, globalRolesDir: makeTmpDir("qa-g") });
    const qaRole = roles.get("qa")!;
    const mandate = store.upsertMandate({ goal: "Verify smoke + edge tests" });

    writeText(path.join(cwd, "smoke.test.ts"), 'import { expect, test } from "bun:test"; test("smoke", () => expect(1).toBe(1));\n');
    writeText(path.join(cwd, "edge.test.ts"), 'import { expect, test } from "bun:test"; test("edge", () => expect(1).toBe(2));\n');

    const runBash = (command: string, toolCallId: string): ObservedToolCall => {
      const r = spawnSync("bash", ["-lc", command], { cwd, encoding: "utf8" });
      const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
      return {
        toolCallId, toolName: "bash", command, isError: (r.status ?? 1) !== 0, exitCode: r.status ?? 1,
        outputSnippet: out, touchedPaths: [], timestamp: new Date().toISOString(),
        testedTreeFingerprint: computeWorkspaceFingerprint(cwd),
      };
    };

    const smokeCall = runBash("bun test smoke.test.ts", "c-smoke");
    expect(smokeCall.exitCode).toBe(0);
    const pipedEdgeCall = runBash("bun test edge.test.ts | tee edge.log", "c-edge-pipe");
    expect(pipedEdgeCall.exitCode).toBe(0); // tee masked the failure!
    expect(pipedEdgeCall.outputSnippet).toMatch(/1 fail/i);

    // Must BLOCK ready even though smoke.test.ts passed!
    expect(() =>
      createAndVerifyHandoff({
        store, role: qaRole, cwd, mandate, verdict: "ready", summary: "Claimed QA ready",
        observedCalls: [smokeCall, pipedEdgeCall],
      }),
    ).toThrow(/failing or unverifiable/i);

    // Fix edge.test.ts and re-run edge.test.ts directly -> now passes!
    writeText(path.join(cwd, "edge.test.ts"), 'import { expect, test } from "bun:test"; test("edge", () => expect(2).toBe(2));\n');
    const directEdgePass = runBash("bun test edge.test.ts", "c-edge-ok");
    expect(directEdgePass.exitCode).toBe(0);
    const updatedSmoke = runBash("bun test smoke.test.ts", "c-smoke-2");
    const okEnv = createAndVerifyHandoff({
      store, role: qaRole, cwd, mandate, verdict: "ready", summary: "Smoke and edge both verified",
      observedCalls: [smokeCall, pipedEdgeCall, directEdgePass, updatedSmoke],
    });
    expect(okEnv.verdict).toBe("ready");

    // Declarative requiredChecks: running only smoke MUST fail; running both MUST pass!
    const strictRole: RoleSpec = {
      ...qaRole,
      exit: { ...qaRole.exit, requiredChecks: ["bun test smoke.test.ts", "bun test edge.test.ts"] },
    };
    expect(() =>
      createAndVerifyHandoff({
        store, role: strictRole, cwd, mandate, verdict: "ready", summary: "Only ran smoke",
        observedCalls: [updatedSmoke],
      }),
    ).toThrow(/required check\(s\) were not verified.*bun test edge\.test\.ts/i);

    const strictPass = createAndVerifyHandoff({
      store, role: strictRole, cwd, mandate, verdict: "ready", summary: "Both required checks passed",
      observedCalls: [updatedSmoke, directEdgePass],
    });
    expect(strictPass.verdict).toBe("ready");
    store.close();
  });

  test("5. P1-5: concurrent GRAPH_PATCH calls serialize atomically without overwriting each other", async () => {
    const cwd = makeTmpDir("patch-race");
    const globalDir = makeTmpDir("global-p5");
    const lockPath = path.join(makeTmpDir("lock-p5"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto" } } }));

    let releaseW1!: () => void;
    const w1Started = new Promise<void>((r) => { releaseW1 = r; });
    let holdW1Resolve!: () => void;
    const holdW1 = new Promise<void>((r) => { holdW1Resolve = r; });
    const ranNodes: string[] = [];

    const runner: RoleSessionRunner = {
      runRoleTurn: async (ctx) => {
        ranNodes.push(ctx.nodeId ?? ctx.role.id);
        if (ctx.nodeId === "w1") {
          releaseW1();
          await holdW1;
        }
        return makeHandoff(ctx, `Done ${ctx.nodeId}`);
      },
    };
    const h = makeHarness({ cwd, globalDir, lockPath, runner });
    const ctx = { cwd, hasUI: false };

    const flowPromise = h.tools.get("enhance_flow")!.execute("start-race", {
      action: "start", goal: "Concurrent patch serialization", wait: true,
      nodes: [{ id: "w1", kind: "role", role: "planner", dependsOn: [] }],
    }, null, null, ctx);

    await w1Started;
    const flowId = JSON.parse((await h.tools.get("enhance_flow")!.execute("st-live", { action: "status" }, null, null, ctx)).content[0].text).flowId;

    // Fire TWO concurrent patches simultaneously!
    const [pA, pB, pDup] = await Promise.all([
      h.tools.get("enhance_flow")!.execute("pa", {
        action: "patch", flowId,
        patch: { addNodes: [{ id: "rev_a", kind: "role", role: "reviewer", dependsOn: ["w1"] }] },
      }, null, null, ctx),
      h.tools.get("enhance_flow")!.execute("pb", {
        action: "patch", flowId,
        patch: { addNodes: [{ id: "rev_b", kind: "role", role: "reviewer", dependsOn: ["w1"] }] },
      }, null, null, ctx),
      // Duplicate nodeId colliding with rev_a MUST fail cleanly without corrupting live state!
      h.tools.get("enhance_flow")!.execute("pdup", {
        action: "patch", flowId,
        patch: { addNodes: [{ id: "rev_a", kind: "role", role: "reviewer", dependsOn: ["w1"] }] },
      }, null, null, ctx),
    ]);

    expect(JSON.parse(pA.content[0].text).patched).toBe(true);
    expect(JSON.parse(pB.content[0].text).patched).toBe(true);
    expect(pDup.isError).toBe(true);
    expect(JSON.parse(pDup.content[0].text)).toMatchObject({ patched: false, invalidGraph: true });

    holdW1Resolve();
    const done = JSON.parse((await flowPromise).content[0].text);
    expect(done.status).toBe("completed");
    expect(ranNodes.sort()).toEqual(["rev_a", "rev_b", "w1"]);

    const finalSnap = JSON.parse((await h.tools.get("enhance_flow")!.execute("st-final", { action: "status", flowId }, null, null, ctx)).content[0].text);
    expect(finalSnap.graphSnapshot.nodes.map((n: any) => `${n.nodeId}:${n.status}`).sort()).toEqual([
      "rev_a:succeeded", "rev_b:succeeded", "w1:succeeded",
    ]);
    await h.emit("session_shutdown", {}, ctx);
  });

  test("6. P2-6: live GRAPH_PATCH snapshots newly installed role while preserving frozen snapshot for existing roles", async () => {
    const cwd = makeTmpDir("patch-new-role");
    const globalDir = makeTmpDir("global-p6");
    const lockPath = path.join(makeTmpDir("lock-p6"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto" } } }));

    writeText(path.join(globalDir, "auditor.yaml"), `id: auditor
name: Auditor V1
description: Existing role
stance: STANCE_V1_FROZEN
method:
  - Inspect
permissions:
  tools: ["read"]
  writable: []
  protected: ["**"]
exit:
  require_tool_evidence: false
  criteria: []
`);

    let onW1Ready!: () => void;
    const w1Ready = new Promise<void>((r) => { onW1Ready = r; });
    let releaseW1!: () => void;
    const w1Hold = new Promise<void>((r) => { releaseW1 = r; });
    const observedStanceByNode: Record<string, string> = {};

    const runner: RoleSessionRunner = {
      runRoleTurn: async (ctx) => {
        observedStanceByNode[ctx.nodeId ?? ctx.role.id] = ctx.role.stance.trim();
        if (ctx.nodeId === "w1") {
          onW1Ready();
          await w1Hold;
        }
        return makeHandoff(ctx, `Done ${ctx.nodeId}`);
      },
    };
    const h = makeHarness({ cwd, globalDir, lockPath, runner });
    const ctx = { cwd, hasUI: false };

    const flowPromise = h.tools.get("enhance_flow")!.execute("start-p6", {
      action: "start", goal: "Hot-install new role mid-flow", wait: true,
      nodes: [{ id: "w1", kind: "role", role: "auditor", dependsOn: [] }],
    }, null, null, ctx);

    await w1Ready;
    const flowId = JSON.parse((await h.tools.get("enhance_flow")!.execute("st-p6", { action: "status" }, null, null, ctx)).content[0].text).flowId;

    // Mutate existing role on disk AND install a brand-new role AFTER Flow start!
    writeText(path.join(globalDir, "auditor.yaml"), `id: auditor
name: Auditor V2
description: Mutated role
stance: STANCE_V2_MUTATED
method:
  - Inspect
permissions:
  tools: ["read"]
  writable: []
  protected: ["**"]
exit:
  require_tool_evidence: false
  criteria: []
`);
    writeText(path.join(globalDir, "late-checker.yaml"), `id: late-checker
name: Late Checker
description: Installed after flow started
stance: STANCE_LATE_NEW
method:
  - Check late
permissions:
  tools: ["read"]
  writable: []
  protected: ["**"]
exit:
  require_tool_evidence: false
  criteria: []
`);

    const patchRes = await h.tools.get("enhance_flow")!.execute("patch-p6", {
      action: "patch", flowId,
      patch: {
        addNodes: [
          { id: "check_late", kind: "role", role: "late-checker", dependsOn: ["w1"] },
          { id: "check_orig", kind: "role", role: "auditor", dependsOn: ["w1"] },
        ],
      },
    }, null, null, ctx);
    expect(patchRes.isError).toBeUndefined();
    expect(JSON.parse(patchRes.content[0].text).patched).toBe(true);

    releaseW1();
    const done = JSON.parse((await flowPromise).content[0].text);
    expect(done.status).toBe("completed");
    expect(observedStanceByNode).toEqual({
      w1: "STANCE_V1_FROZEN",
      check_orig: "STANCE_V1_FROZEN",
      check_late: "STANCE_LATE_NEW",
    });
    await h.emit("session_shutdown", {}, ctx);
  });

  test("7. Cross-project trusted peer role visibility exposes trusted project roles and hides untrusted ones", async () => {
    const gameDir = makeTmpDir("game");
    const filmDir = makeTmpDir("film");
    const untrustedDir = makeTmpDir("untrusted");
    const globalDir = makeTmpDir("global-p7");
    const lockPath = path.join(makeTmpDir("lock-p7"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto" } } }));

    writeText(path.join(filmDir, ".omp", "roles", "shot-reader.yaml"), `id: shot-reader
name: 镜头分析专员
description: 读取影视工程时间线与镜头表
stance: Read-only film shot analysis.
method:
  - Inspect shots
permissions:
  tools: ["read"]
  writable: []
  protected: ["**"]
exit:
  require_tool_evidence: false
  criteria: []
`);
    writeText(path.join(untrustedDir, ".omp", "roles", "secret-bot.yaml"), `id: secret-bot
name: 未信任专员
description: Untrusted role that must stay hidden
stance: Never leak.
method:
  - Hidden
permissions:
  tools: ["read"]
  writable: []
  protected: ["**"]
exit:
  require_tool_evidence: false
  criteria: []
`);

    const h1 = makeHarness({ cwd: gameDir, globalDir, lockPath });
    const ctx1 = { cwd: gameDir, hasUI: false };
    // Trust filmDir via /coord trust, touch untrustedDir via status (without trusting it)
    await h1.commands.get("coord")!.handler(`trust ${filmDir}`, ctx1);
    await h1.tools.get("enhance_flow")!.execute("st-untrusted", { action: "status", cwd: untrustedDir }, null, null, ctx1);

    const promptRes1 = await h1.emit("before_agent_start", { systemPrompt: [] }, ctx1);
    const sys1 = promptRes1[0]?.systemPrompt?.join("\n") ?? "";
    expect(sys1).toContain("## Trusted Peer Project Roles");
    expect(sys1).toContain("shot-reader");
    expect(sys1).toContain(filmDir);
    expect(sys1).not.toContain("secret-bot");
    expect(sys1).not.toContain(untrustedDir);
    await h1.emit("session_shutdown", {}, ctx1);

    // Fresh session restart in gameDir: trusted-projects.json alone surfaces filmDir's shot-reader WITHOUT touching filmDir's SQLite!
    const filmDbBefore = existsSync(path.join(filmDir, ".omp-enhance", "state.sqlite"));
    const h2 = makeHarness({ cwd: gameDir, globalDir, lockPath });
    const ctx2 = { cwd: gameDir, hasUI: false };
    const promptRes2 = await h2.emit("before_agent_start", { systemPrompt: [] }, ctx2);
    const sys2 = promptRes2[0]?.systemPrompt?.join("\n") ?? "";
    expect(sys2).toContain("shot-reader");
    expect(sys2).not.toContain("secret-bot");
    expect(existsSync(path.join(filmDir, ".omp-enhance", "state.sqlite"))).toBe(filmDbBefore);
    await h2.emit("session_shutdown", {}, ctx2);
  });

  test("8. CI evaluator rejects opposite-conclusion & deferred answers and prevents blind-review leakage", () => {
    const root = makeTmpDir("ci-eval");
    const c1Dir = path.join(root, "c1");
    const c2Dir = path.join(root, "c2");
    mkdirSync(c1Dir, { recursive: true });
    mkdirSync(c2Dir, { recursive: true });
    PILOT_CASES[0]!.setup(c1Dir);
    PILOT_CASES[1]!.setup(c2Dir);

    // Case 1 opposite conclusion mentioning real files & keywords MUST fail!
    const c1Wrong = scoreCaseOutput(
      PILOT_CASES[0]!,
      c1Dir,
      "检查 src/settlement/window.ts:10 和 ci/failing-build-418.log:1 后，已排除时区与 UTC 偏移问题，根因是连接池太小，建议跑 TZ=UTC bun test test/settlement.test.ts 复验。",
    );
    expect(c1Wrong.passed).toBe(false);
    expect(c1Wrong.noContradictionOrNonAnswer).toBe(false);

    // Case 2 opposite conclusion MUST fail!
    const c2Wrong = scoreCaseOutput(
      PILOT_CASES[1]!,
      c2Dir,
      "检查 src/config/loader.ts:8 和 ci/failing-build-502.log:3 后，已排除 WEBHOOK_MAX_RETRIES 字符串类型问题，根因是连接池太小，建议检查 retry 配置。",
    );
    expect(c2Wrong.passed).toBe(false);
    expect(c2Wrong.noContradictionOrNonAnswer).toBe(false);

    // Lazy coordinator deferral ("下轮再调查") MUST fail!
    const lazyReply = scoreCaseOutput(
      PILOT_CASES[0]!,
      c1Dir,
      "已查看 src/settlement/window.ts:10 和 ci/failing-build-418.log:1（UTC 时区），下轮再调查并运行 TZ=UTC bun test test/settlement.test.ts。",
    );
    expect(lazyReply.passed).toBe(false);
    expect(lazyReply.noContradictionOrNonAnswer).toBe(false);

    // Blind review bundle MUST strip internalTraceSummary and pass leak detector!
    const trials: PilotTrialRecord[] = [
      {
        trialId: "trial-111111", caseId: PILOT_CASES[0]!.id, arm: "coord-planner-reviewer", model: "test",
        durationMs: 100, inputTokens: 10, outputTokens: 10, costUsd: 0, failed: false,
        responseText: "根因位于 src/settlement/window.ts:10，详见 ci/failing-build-418.log:1。",
        internalTraceSummary: "[planner handoff]: secret planner trace\n[reviewer handoff]: secret reviewer trace",
        score: lazyReply,
      },
      {
        trialId: "trial-222222", caseId: PILOT_CASES[0]!.id, arm: "coord-autonomous", model: "test",
        durationMs: 90, inputTokens: 8, outputTokens: 8, costUsd: 0, failed: false,
        responseText: "自主排查定位到 src/settlement/window.ts:10 与 ci/failing-build-418.log:1。",
        score: lazyReply,
      },
    ];
    const bundle = buildBlindReviewBundle(trials);
    expect(bundle.blindItems).toHaveLength(2);
    for (const item of bundle.blindItems) {
      expect(item.responseText).not.toContain("[planner handoff]");
      expect(item.responseText).not.toContain("[reviewer handoff]");
      expect(detectBlindReviewLeaks(item)).toEqual([]);
    }
    expect(detectBlindReviewLeaks({
      candidateId: "bad", caseId: PILOT_CASES[0]!.id, caseTitle: "t", logRelPath: "ci/a.log",
      responseText: "Summary\n[planner handoff]: leaked",
    })).toEqual(["[planner handoff]"]);
  });
});
