import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildIntentBlindBundle,
  detectIntentBlindLeaks,
  INTENT_CASES,
} from "../../scripts/eval-ambiguous-intent.ts";
import {
  buildBlindReviewBundle,
  detectBlindReviewLeaks,
  PILOT_CASES,
  scoreCaseOutput,
} from "../../scripts/eval-ci-diagnosis.ts";
import {
  buildSimBlindBundle,
  detectSimBlindLeaks,
  SIM_CASES,
} from "../../scripts/eval-sim-ops.ts";
import { computeWorkspaceFingerprint, snapshotWorkspace } from "../../src/core/fs.ts";
import { EnhanceStore } from "../../src/core/store.ts";
import type { ObservedToolCall } from "../../src/core/types.ts";
import ompEnhance from "../../src/entry.ts";
import { extractUnderlyingTestCmd } from "../../src/flow/evidence.ts";
import { createAndVerifyHandoff } from "../../src/flow/handoff.ts";
import type { RoleSessionRunner } from "../../src/flow/orchestrator.ts";
import { discoverRoles } from "../../src/roles/loader.ts";

const tempDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `omp-p17-${prefix}-`));
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
    parentHandoffId: ctx.upstreamHandoff?.id ?? null,
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

function runRealBashCall(cwd: string, toolCallId: string, command: string, stageId?: string): ObservedToolCall {
  const res = spawnSync("bash", ["-lc", command], { cwd, encoding: "utf8" });
  const output = [res.stdout?.trim(), res.stderr?.trim()].filter(Boolean).join("\n");
  return {
    toolCallId,
    toolName: "bash",
    command,
    isError: (res.status ?? 1) !== 0,
    exitCode: res.status ?? 1,
    outputSnippet: output.slice(0, 600),
    touchedPaths: [],
    testedTreeFingerprint: computeWorkspaceFingerprint(cwd),
    ...(stageId ? { stageId } : {}),
    timestamp: new Date().toISOString(),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 17 — Review 2026-11-28 Regression Suite (6 P1 + 4 P2 + Evaluators)", () => {
  test("1. P1-1: approval rejects '否' and negative free text fail-closed, flags ambiguous options, and keeps input-mode P99 negations working", async () => {
    const cwd = makeTmpDir("p1-1");
    const globalDir = makeTmpDir("p1-1-global");
    const lockPath = path.join(makeTmpDir("p1-1-lock"), "lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto" } } }));

    const runner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        writeText(path.join(stepCtx.cwd, "side-effect.txt"), "executed\n");
        return makeHandoff(stepCtx, "Side effect written");
      },
    };
    const h = makeHarness({ cwd, globalDir, lockPath, runner });
    const ctx = { cwd, hasUI: false };
    const flowTool = h.tools.get("enhance_flow")!;

    // 1a) Options ["是", "否"] WITHOUT optionActions: answering "否" MUST cancel and write NO side-effect!
    const s1 = JSON.parse((await flowTool.execute("s1", {
      action: "start", goal: "Yes/No default approval", wait: true,
      nodes: [
        { id: "approve", kind: "human", dependsOn: [], human: { prompt: "是否批准执行？", options: ["是", "否"], allowFreeText: false } },
        { id: "exec", kind: "role", role: "dev", dependsOn: ["approve"] },
      ],
    }, null, null, ctx)).content[0].text);
    expect(s1.status).toBe("waiting_input");
    const flow1 = JSON.parse((await flowTool.execute("st1", { action: "status" }, null, null, ctx)).content[0].text).flowId;

    const noRes = JSON.parse((await flowTool.execute("r1", {
      action: "resume", flowId: flow1, nodeId: "approve", message: "否", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(noRes.status).toBe("cancelled");
    expect(existsSync(path.join(cwd, "side-effect.txt"))).toBe(false);

    // 1b) Open-ended approval: "不能执行，预算没批。" MUST stay waiting_input with ZERO side effects; explicit "批准执行" proceeds!
    const s2 = JSON.parse((await flowTool.execute("s2", {
      action: "start", goal: "Open approval test", wait: true,
      nodes: [
        { id: "approve", kind: "human", dependsOn: [], human: { prompt: "是否批准上线发布？", mode: "approval" } },
        { id: "exec", kind: "role", role: "dev", dependsOn: ["approve"] },
      ],
    }, null, null, ctx)).content[0].text);
    expect(s2.status).toBe("waiting_input");
    const flow2 = JSON.parse((await flowTool.execute("st2", { action: "status" }, null, null, ctx)).content[0].text).flowId;

    const denied = JSON.parse((await flowTool.execute("r2-deny", {
      action: "resume", flowId: flow2, nodeId: "approve", message: "不能执行，预算没批。", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(denied).toMatchObject({ resumed: false, held: true, decision: "hold", status: "waiting_input" });
    expect(existsSync(path.join(cwd, "side-effect.txt"))).toBe(false);

    // Ambiguous neutral remark also stays paused (fail-closed)
    const neutral = JSON.parse((await flowTool.execute("r2-neutral", {
      action: "resume", flowId: flow2, nodeId: "approve", message: "我先同步下财务同事", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(neutral).toMatchObject({ resumed: false, held: true, status: "waiting_input" });
    expect(existsSync(path.join(cwd, "side-effect.txt"))).toBe(false);

    // Explicit approval executes downstream once
    const approved = JSON.parse((await flowTool.execute("r2-ok", {
      action: "resume", flowId: flow2, nodeId: "approve", message: "预算已批，批准执行", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(approved.status).toBe("completed");
    expect(existsSync(path.join(cwd, "side-effect.txt"))).toBe(true);

    // 1c) Ambiguous approval options without optionActions rejected at graph validation time
    const ambig = await flowTool.execute("s3-ambig", {
      action: "start", goal: "Ambiguous options", wait: true,
      nodes: [
        { id: "approve", kind: "human", dependsOn: [], human: { prompt: "是否批准发布？", options: ["同意", "先观察两小时"] } },
      ],
    }, null, null, ctx);
    expect(ambig.isError).toBe(true);
    expect(String(ambig.content[0].text)).toContain("optionActions");

    // 1d) Positive control: mode="input" still accepts negation constraints ("不要优化均值，以 P99 延迟为准")
    const s4 = JSON.parse((await flowTool.execute("s4-input", {
      action: "start", goal: "Input constraint", wait: true,
      nodes: [
        { id: "metric", kind: "human", dependsOn: [], human: { prompt: "请明确优化指标与延迟约束", mode: "input" } },
        { id: "work", kind: "role", role: "planner", dependsOn: ["metric"] },
      ],
    }, null, null, ctx)).content[0].text);
    expect(s4.status).toBe("waiting_input");
    const flow4 = JSON.parse((await flowTool.execute("st4", { action: "status" }, null, null, ctx)).content[0].text).flowId;
    const inputRes = JSON.parse((await flowTool.execute("r4-ok", {
      action: "resume", flowId: flow4, nodeId: "metric", message: "不要优化均值，以 P99 延迟为准", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(inputRes.status).toBe("completed");
  });

  test("2. P1-2: two independent apply merges in the same Flow preserve BOTH files in both completion orders", async () => {
    for (const order of ["left-first", "right-first"] as const) {
      const cwd = initGitRepo(`p1-2-${order}`);
      const globalDir = makeTmpDir(`p1-2-g-${order}`);
      const lockPath = path.join(makeTmpDir(`p1-2-l-${order}`), "lock.json");

      const runner: RoleSessionRunner = {
        async runRoleTurn(stepCtx) {
          if (stepCtx.nodeId === "left") {
            if (order === "right-first") await Bun.sleep(120);
            writeText(path.join(stepCtx.cwd, "left.txt"), `left-${order}\n`);
            return makeHandoff(stepCtx, "Wrote left.txt");
          }
          if (stepCtx.nodeId === "right") {
            if (order === "left-first") await Bun.sleep(120);
            writeText(path.join(stepCtx.cwd, "right.txt"), `right-${order}\n`);
            return makeHandoff(stepCtx, "Wrote right.txt");
          }
          return makeHandoff(stepCtx, "ok");
        },
      };

      const h = makeHarness({ cwd, globalDir, lockPath, runner });
      const res = JSON.parse((await h.tools.get("enhance_flow")!.execute(`start-${order}`, {
        action: "start", goal: `Dual independent apply (${order})`, wait: true,
        nodes: [
          { id: "left", kind: "role", role: "dev", workspace: "worktree", writableScope: ["left.txt"], dependsOn: [] },
          { id: "right", kind: "role", role: "dev", workspace: "worktree", writableScope: ["right.txt"], dependsOn: [] },
          { id: "apply-left", kind: "merge", dependsOn: ["left"], merge: { sourceNodeIds: ["left"], landingMode: "apply" } },
          { id: "apply-right", kind: "merge", dependsOn: ["right"], merge: { sourceNodeIds: ["right"], landingMode: "apply" } },
        ],
      }, null, null, { cwd, hasUI: false })).content[0].text);

      expect(res.status).toBe("completed");
      expect(existsSync(path.join(cwd, "left.txt"))).toBe(true);
      expect(existsSync(path.join(cwd, "right.txt"))).toBe(true);
      expect(readFileSync(path.join(cwd, "left.txt"), "utf8")).toBe(`left-${order}\n`);
      expect(readFileSync(path.join(cwd, "right.txt"), "utf8")).toBe(`right-${order}\n`);
    }
  });

  test("3. P1-3: approved preview with zero new downstream edits (gate or no-change specialist) still lands files and returns mergedCommitSha", async () => {
    for (const mode of ["gate", "no-change-specialist"] as const) {
      const cwd = initGitRepo(`p1-3-${mode}`);
      const globalDir = makeTmpDir(`p1-3-g-${mode}`);
      const lockPath = path.join(makeTmpDir(`p1-3-l-${mode}`), "lock.json");

      const runner: RoleSessionRunner = {
        async runRoleTurn(stepCtx) {
          if (stepCtx.nodeId === "build") {
            writeText(path.join(stepCtx.cwd, "product.txt"), `artifact-${mode}\n`);
            return makeHandoff(stepCtx, "Built product.txt");
          }
          // Specialist verifies preview file without making new edits
          expect(readFileSync(path.join(stepCtx.cwd, "product.txt"), "utf8")).toBe(`artifact-${mode}\n`);
          return makeHandoff(stepCtx, "Verified product.txt without changes");
        },
      };

      const h = makeHarness({ cwd, globalDir, lockPath, runner });
      const verifyNode = mode === "gate"
        ? { id: "check", kind: "gate", dependsOn: ["preview"], gate: { command: `test -f product.txt && grep -q "artifact-${mode}" product.txt` } }
        : { id: "check", kind: "role", role: "dev", dependsOn: ["preview"], brief: "Inspect product.txt and keep as-is if valid" };

      const res = JSON.parse((await h.tools.get("enhance_flow")!.execute(`start-${mode}`, {
        action: "start", goal: `Preview then zero-delta apply (${mode})`, wait: true,
        nodes: [
          { id: "build", kind: "role", role: "dev", workspace: "worktree", dependsOn: [] },
          { id: "preview", kind: "merge", dependsOn: ["build"], merge: { sourceNodeIds: ["build"], landingMode: "branch_preview" } },
          verifyNode,
          { id: "final-apply", kind: "merge", dependsOn: ["check"], merge: { sourceNodeIds: ["check"], landingMode: "apply" } },
        ],
      }, null, null, { cwd, hasUI: false })).content[0].text);

      expect(res.status).toBe("completed");
      expect(existsSync(path.join(cwd, "product.txt"))).toBe(true);
      expect(readFileSync(path.join(cwd, "product.txt"), "utf8")).toBe(`artifact-${mode}\n`);
      const previewSha = res.finalState.nodes.preview.commitSha;
      expect(typeof previewSha).toBe("string");
      expect(res.mergedCommitSha).toBe(previewSha);
      expect(git(cwd, ["show", `${previewSha}:product.txt`])).toBe(`artifact-${mode}`);
    }
  });

  test("4. P1-4: QA preserves env vars and cwd in check identity so TZ=UTC never satisfies TZ=America/Los_Angeles", () => {
    const cwd = makeTmpDir("p1-4");
    writeText(path.join(cwd, "test", "tz.test.ts"), `import { expect, test } from "bun:test";
test("tz check", () => {
  expect(process.env.TZ).toBe("UTC");
});
`);
    const utcCmd = "TZ=UTC bun test test/tz.test.ts";
    const laCmd = "TZ=America/Los_Angeles bun test test/tz.test.ts";
    expect(extractUnderlyingTestCmd(utcCmd)).not.toBe(extractUnderlyingTestCmd(laCmd));
    expect(extractUnderlyingTestCmd("cd pkg-a && bun test")).not.toBe(extractUnderlyingTestCmd("cd pkg-b && bun test"));
    expect(extractUnderlyingTestCmd("bun test foo.test.ts | tee out.log")).toBe("bun test foo.test.ts");

    const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    const mandate = store.upsertMandate({ goal: "Verify settlement under UTC and LA" });
    const baseQa = discoverRoles({ cwd, isProjectTrusted: true }).get("qa")!;
    const qaRole = { ...baseQa, exit: { ...baseQa.exit, requiredChecks: [utcCmd, laCmd] } };

    // Running ONLY TZ=UTC passes UTC but MUST fail handoff because TZ=America/Los_Angeles was never run!
    const utcCall = runRealBashCall(cwd, "tc-utc", utcCmd, "stage-1");
    expect(utcCall.exitCode).toBe(0);
    expect(() => createAndVerifyHandoff({
      store, role: qaRole, cwd, mandate, stageId: "stage-1", toTarget: "user", verdict: "ready",
      summary: "Only ran UTC", observedCalls: [utcCall], baselineSnapshot: snapshotWorkspace(cwd),
    })).toThrow(/TZ=America\/Los_Angeles/);

    // Running TZ=America/Los_Angeles against failing test produces exit 1 and still blocks ready
    const laFailCall = runRealBashCall(cwd, "tc-la-fail", laCmd, "stage-1");
    expect(laFailCall.exitCode).toBe(1);
    expect(() => createAndVerifyHandoff({
      store, role: qaRole, cwd, mandate, stageId: "stage-1", toTarget: "user", verdict: "ready",
      summary: "LA failed", observedCalls: [utcCall, laFailCall], baselineSnapshot: snapshotWorkspace(cwd),
    })).toThrow(/failing or unverifiable/i);

    // Fix test so both timezones pass -> running both real checks now succeeds!
    writeText(path.join(cwd, "test", "tz.test.ts"), `import { expect, test } from "bun:test";
test("tz check", () => {
  expect(["UTC", "America/Los_Angeles"]).toContain(process.env.TZ ?? "");
});
`);
    const utcPass2 = runRealBashCall(cwd, "tc-utc-2", utcCmd, "stage-2");
    const laPass2 = runRealBashCall(cwd, "tc-la-2", laCmd, "stage-2");
    expect(utcPass2.exitCode).toBe(0);
    expect(laPass2.exitCode).toBe(0);
    const ho = createAndVerifyHandoff({
      store, role: qaRole, cwd, mandate, stageId: "stage-2", toTarget: "user", verdict: "ready",
      summary: "Both UTC and LA verified", observedCalls: [utcPass2, laPass2], baselineSnapshot: snapshotWorkspace(cwd),
    });
    expect(ho.verificationEvidence?.length).toBe(2);
    store.close();
  });

  test("5. P1-5: workflow final phase unions role + phase + outer requiredChecks and exposes all of them in first-turn prompt", async () => {
    const cwd = makeTmpDir("p1-5");
    const globalDir = makeTmpDir("p1-5-global");
    const lockPath = path.join(makeTmpDir("p1-5-lock"), "lock.json");

    writeText(path.join(cwd, "test", "base.test.ts"), `import { expect, test } from "bun:test"; test("base", () => expect(1).toBe(1));\n`);
    writeText(path.join(cwd, "test", "smoke.test.ts"), `import { expect, test } from "bun:test"; test("smoke", () => expect(1).toBe(1));\n`);
    writeText(path.join(cwd, "test", "engine.test.ts"), `import { expect, test } from "bun:test"; test("engine", () => expect(1).toBe(1));\n`);
    writeText(path.join(cwd, ".omp", "roles", "wf-qa.yaml"), `id: wf-qa
name: Workflow QA
description: Two-phase QA with base + phase required checks
stance: Verify all checks honestly.
method:
  - Run required checks
permissions:
  tools: ["read", "bash"]
  writable: []
  protected: ["**"]
exit:
  require_tool_evidence: true
  require_test_execution: true
  required_checks:
    - "bun test test/base.test.ts"
  criteria:
    - "All checks pass"
workflow:
  session: reuse
  phases:
    - id: verify
      brief: Run smoke and outer required checks
      required_checks:
        - "bun test test/smoke.test.ts"
`);

    const firstTurnPrompts: string[] = [];
    const runWithCmds = async (cmdsToRun: string[]) => {
      const runner: RoleSessionRunner = {
        async runRoleTurn(stepCtx) {
          firstTurnPrompts.push(stepCtx.conditioningPrompt);
          const calls = cmdsToRun.map((cmd, idx) => runRealBashCall(stepCtx.cwd, `c-${idx}`, cmd, stepCtx.stageId));
          const ho = createAndVerifyHandoff({
            store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
            stageId: stepCtx.stageId, toTarget: stepCtx.toTarget, verdict: "ready", summary: "Checks attempted",
            observedCalls: calls, baselineSnapshot: snapshotWorkspace(stepCtx.cwd),
          });
          return { envelope: ho, observedCalls: calls, assistantText: "done", usage: null };
        },
      };
      const h = makeHarness({ cwd, globalDir, lockPath, runner });
      return JSON.parse((await h.tools.get("enhance_flow")!.execute("start", {
        action: "start", goal: "Verify workflow + outer checks", wait: true, maxRepairRounds: 0,
        nodes: [{
          id: "qa-step", kind: "role", role: "wf-qa", dependsOn: [],
          requiredChecks: ["bun test test/engine.test.ts"],
        }],
      }, null, null, { cwd, hasUI: false, isProjectTrusted: true })).content[0].text);
    };

    // Missing outer engine check -> fails!
    const missOuter = await runWithCmds(["bun test test/base.test.ts", "bun test test/smoke.test.ts"]);
    expect(missOuter.status).not.toBe("completed");
    expect(String(missOuter.reason ?? "")).toContain("bun test test/engine.test.ts");

    // First-turn prompt MUST list ALL 3 merged required checks!
    expect(firstTurnPrompts[0]).toContain("bun test test/base.test.ts");
    expect(firstTurnPrompts[0]).toContain("bun test test/smoke.test.ts");
    expect(firstTurnPrompts[0]).toContain("bun test test/engine.test.ts");

    // Missing inner smoke check -> fails!
    const missInner = await runWithCmds(["bun test test/base.test.ts", "bun test test/engine.test.ts"]);
    expect(missInner.status).not.toBe("completed");
    expect(String(missInner.reason ?? "")).toContain("bun test test/smoke.test.ts");

    // Running all 3 real commands -> completes!
    const allPass = await runWithCmds(["bun test test/base.test.ts", "bun test test/smoke.test.ts", "bun test test/engine.test.ts"]);
    expect(allPass.status).toBe("completed");
  });

  test("6. P1-6: resuming a cancelled Flow after restart respects dependsOn so review B never runs before plan A", async () => {
    const cwd = makeTmpDir("p1-6");
    const globalDir = makeTmpDir("p1-6-global");
    const lockPath = path.join(makeTmpDir("p1-6-lock"), "lock.json");

    let planStarted!: () => void;
    const planStartedReady = new Promise<void>((r) => { planStarted = r; });

    const runner1: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        if (stepCtx.nodeId === "plan") {
          planStarted();
          await new Promise<void>((resolve) => {
            if (stepCtx.signal?.aborted) { resolve(); return; }
            stepCtx.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { envelope: null, observedCalls: [], assistantText: "", usage: null, cancelledByUser: true };
        }
        return makeHandoff(stepCtx, `Unexpected early run of ${stepCtx.nodeId}`);
      },
    };

    const h1 = makeHarness({ cwd, globalDir, lockPath, runner: runner1 });
    const ctx = { cwd, hasUI: false };
    const flowPromise = h1.tools.get("enhance_flow")!.execute("s", {
      action: "start", goal: "Plan then review", wait: true,
      nodes: [{ id: "plan", kind: "role", role: "planner", dependsOn: [] }],
    }, null, null, ctx);

    await planStartedReady;
    const flowId = JSON.parse((await h1.tools.get("enhance_flow")!.execute("st0", { action: "status" }, null, null, ctx)).content[0].text).flowId as string;

    // Live-patch review B depending on plan A while A is still running without a handoff
    const patched = JSON.parse((await h1.tools.get("enhance_flow")!.execute("p", {
      action: "patch", flowId,
      patch: { addNodes: [{ id: "review", kind: "role", role: "reviewer", dependsOn: ["plan"] }] },
    }, null, null, ctx)).content[0].text);
    expect(patched.patched).toBe(true);

    // Cancel Flow before A finishes
    await h1.tools.get("enhance_flow")!.execute("c", { action: "cancel", flowId }, null, null, ctx);
    const cancelledRes = JSON.parse((await flowPromise).content[0].text);
    expect(cancelledRes.status).toBe("cancelled");
    await h1.emit("session_shutdown", {}, ctx);

    // Restart with fresh harness and resume by flowId!
    const executionOrder: string[] = [];
    let reviewUpstreamSummary: string | null = null;
    let planHandoffId = "";
    const runner2: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        executionOrder.push(stepCtx.nodeId ?? stepCtx.role.id);
        if (stepCtx.nodeId === "plan") {
          await Bun.sleep(60); // Slower than review to expose any race if B ran early!
          const res = makeHandoff(stepCtx, "Fresh persisted plan A");
          planHandoffId = res.envelope.id;
          return res;
        }
        if (stepCtx.nodeId === "review") {
          reviewUpstreamSummary = stepCtx.upstreamHandoff?.summary ?? null;
          // Verify A's handoff is already persisted in SQLite before B starts!
          expect(planHandoffId).not.toBe("");
          expect(stepCtx.store.getHandoff(planHandoffId)?.summary).toBe("Fresh persisted plan A");
          return makeHandoff(stepCtx, "Reviewed plan A");
        }
        return makeHandoff(stepCtx, "ok");
      },
    };
    const h2 = makeHarness({ cwd, globalDir, lockPath, runner: runner2 });
    const resumed = JSON.parse((await h2.tools.get("enhance_flow")!.execute("res", {
      action: "resume", flowId, wait: true,
    }, null, null, ctx)).content[0].text);
    expect(resumed.status).toBe("completed");
    expect(executionOrder).toEqual(["plan", "review"]);
    expect(reviewUpstreamSummary as unknown as string).toBe("Fresh persisted plan A");
  });

  test("7. P2-1: foreground cancel ends workflow in shared state machine so subsequent '同意' cannot advance to publish", async () => {
    const cwd = makeTmpDir("p2-1");
    const globalDir = makeTmpDir("p2-1-global");
    const lockPath = path.join(makeTmpDir("p2-1-lock"), "lock.json");

    writeText(path.join(cwd, ".omp", "roles", "pub-gate.yaml"), `id: pub-gate
name: Publish Gate
description: Approval gate with explicit reject -> cancel
stance: Require user approval before publishing.
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
      prompt: "是否批准发布？"
      options: ["同意", "暂缓", "拒绝"]
      allow_free_text: false
      option_actions:
        同意: proceed
        暂缓: hold
        拒绝: cancel
    - id: publish
      brief: Publish release
`);

    const h = makeHarness({ cwd, globalDir, lockPath });

    // Session A: hold ("暂缓") pauses, then "同意" advances to publish
    const entA: any[] = [];
    const ctxA: any = { cwd, hasUI: false, isProjectTrusted: true, sessionManager: { getSessionId: () => "fg-hold", getBranch: () => entA, getEntries: () => entA } };
    await h.commands.get("role")!.handler("pub-gate --foreground", ctxA);
    entA.push({ id: "a1", type: "message", message: { role: "user", content: "准备发布" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, ctxA);
    entA.push({ id: "a2", type: "message", message: { role: "user", content: "暂缓" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, ctxA);
    const holdRes = await h.tools.get("enhance_handoff")!.execute("h-hold", { verdict: "ready", summary: "用户暂缓" }, null, null, ctxA);
    expect(holdRes.isError).toBe(true);
    expect(JSON.parse(holdRes.content[0].text).held).toBe(true);
    entA.push({ id: "a3", type: "message", message: { role: "user", content: "同意" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, ctxA);
    const okRes = await h.tools.get("enhance_handoff")!.execute("h-ok", { verdict: "ready", summary: "用户同意" }, null, null, ctxA);
    expect(okRes.isError).toBeUndefined();
    expect(JSON.parse(okRes.content[0].text).workflowProgress.nextPhaseId).toBe("publish");

    // Session B: cancel ("拒绝") terminates workflow; next turn "同意" MUST NOT advance to publish!
    const entB: any[] = [];
    const ctxB: any = { cwd, hasUI: false, isProjectTrusted: true, sessionManager: { getSessionId: () => "fg-cancel", getBranch: () => entB, getEntries: () => entB } };
    await h.commands.get("role")!.handler("pub-gate --foreground", ctxB);
    entB.push({ id: "b1", type: "message", message: { role: "user", content: "准备发布" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, ctxB);
    entB.push({ id: "b2", type: "message", message: { role: "user", content: "拒绝" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, ctxB);
    const cancelRes = await h.tools.get("enhance_handoff")!.execute("h-cancel", { verdict: "ready", summary: "用户拒绝" }, null, null, ctxB);
    expect(cancelRes.isError).toBe(true);
    expect(JSON.parse(cancelRes.content[0].text).cancelled).toBe(true);

    entB.push({ id: "b3", type: "message", message: { role: "user", content: "同意" } });
    await h.emit("before_agent_start", { systemPrompt: [] }, ctxB);
    const afterCancel = await h.tools.get("enhance_handoff")!.execute("h-after", { verdict: "ready", summary: "尝试恢复" }, null, null, ctxB);
    expect(afterCancel.isError).toBe(true);
    const afterParsed = JSON.parse(afterCancel.content[0].text);
    expect(afterParsed.cancelled).toBe(true);
    expect(afterParsed.workflowProgress?.nextPhaseId).toBeUndefined();
  });

  test("8. P2-2: Flow completed in Window 2 does NOT reappear in Window 1's waiting candidates", async () => {
    const projA = makeTmpDir("p2-2-a");
    const projB = makeTmpDir("p2-2-b");
    const globalDir = makeTmpDir("p2-2-global");
    const lockPath = path.join(makeTmpDir("p2-2-lock"), "lock.json");

    const runner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) { return makeHandoff(stepCtx, `Done in ${path.basename(stepCtx.cwd)}`); },
    };
    const h1 = makeHarness({ cwd: projA, globalDir, lockPath, runner });
    const ctx1 = { cwd: projA, hasUI: false };
    const flow1 = h1.tools.get("enhance_flow")!;

    await flow1.execute("sa", {
      action: "start", cwd: projA, goal: "Wait A", wait: true,
      nodes: [
        { id: "ask", kind: "human", dependsOn: [], human: { prompt: "是否批准 A？" } },
        { id: "go", kind: "role", role: "planner", dependsOn: ["ask"] },
      ],
    }, null, null, ctx1);
    const flowIdA = JSON.parse((await flow1.execute("sta", { action: "status", cwd: projA }, null, null, ctx1)).content[0].text).flowId;

    await flow1.execute("sb", {
      action: "start", cwd: projB, goal: "Wait B", wait: true,
      nodes: [
        { id: "ask", kind: "human", dependsOn: [], human: { prompt: "是否批准 B？" } },
        { id: "go", kind: "role", role: "planner", dependsOn: ["ask"] },
      ],
    }, null, null, ctx1);
    const flowIdB = JSON.parse((await flow1.execute("stb", { action: "status", cwd: projB }, null, null, ctx1)).content[0].text).flowId;

    // Window 2 completes Flow A directly!
    const h2 = makeHarness({ cwd: projA, globalDir, lockPath, runner });
    const doneA = JSON.parse((await h2.tools.get("enhance_flow")!.execute("w2-res", {
      action: "resume", cwd: projA, flowId: flowIdA, nodeId: "ask", message: "同意", wait: true,
    }, null, null, { cwd: projA, hasUI: false })).content[0].text);
    expect(doneA.status).toBe("completed");

    // Back in Window 1 (whose in-memory snapshot for projA was stale waiting_input):
    // Omitting flowId/cwd MUST NOT show completed A as waiting — it cleanly resumes ONLY B!
    const resB = JSON.parse((await flow1.execute("w1-res-b", {
      action: "resume", message: "同意", wait: true,
    }, null, null, ctx1)).content[0].text);
    expect(resB.ambiguous).toBeUndefined();
    expect(resB.status).toBe("completed");
    const stB = JSON.parse((await flow1.execute("stb2", { action: "status", cwd: projB, flowId: flowIdB }, null, null, ctx1)).content[0].text);
    expect(stB.status).toBe("completed");
  });

  test("9. P2-3: live GRAPH_PATCH refuses patched:true when checkpoint SQLite write fails, then succeeds durably on retry", async () => {
    const cwd = makeTmpDir("p2-3");
    const globalDir = makeTmpDir("p2-3-global");
    const lockPath = path.join(makeTmpDir("p2-3-lock"), "lock.json");

    let nodeRunning!: () => void;
    const nodeRunningReady = new Promise<void>((r) => { nodeRunning = r; });
    let releaseWork!: () => void;
    const workGate = new Promise<void>((r) => { releaseWork = r; });
    const dispatched: string[] = [];

    const runner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        dispatched.push(stepCtx.nodeId ?? stepCtx.role.id);
        if (stepCtx.nodeId === "work") {
          nodeRunning();
          await workGate;
        }
        return makeHandoff(stepCtx, `Done ${stepCtx.nodeId}`);
      },
    };
    const h = makeHarness({ cwd, globalDir, lockPath, runner });
    const ctx = { cwd, hasUI: false };

    const flowPromise = h.tools.get("enhance_flow")!.execute("s", {
      action: "start", goal: "Durable patch test", wait: true,
      nodes: [{ id: "work", kind: "role", role: "planner", dependsOn: [] }],
    }, null, null, ctx);
    await nodeRunningReady;
    const flowId = JSON.parse((await h.tools.get("enhance_flow")!.execute("st0", { action: "status" }, null, null, ctx)).content[0].text).flowId as string;

    // Inject transient SQLite write failure ONLY when saving a checkpoint containing 'added-rev'
    const dbPath = path.join(cwd, ".omp-enhance", "state.sqlite");
    const faultDb = new Database(dbPath);
    faultDb.exec(`
      CREATE TRIGGER fail_added_rev_patch
      BEFORE UPDATE ON flow_runs
      WHEN NEW.graph_spec_json LIKE '%added-rev%'
      BEGIN
        SELECT RAISE(ABORT, 'injected_checkpoint_write_error');
      END;
    `);

    const failedPatch = await h.tools.get("enhance_flow")!.execute("p-fail", {
      action: "patch", flowId,
      patch: { addNodes: [{ id: "added-rev", kind: "role", role: "reviewer", dependsOn: ["work"] }] },
    }, null, null, ctx);
    expect(failedPatch.isError).toBe(true);
    const failJson = JSON.parse(failedPatch.content[0].text);
    expect(failJson.patched).toBe(false);
    expect(failJson.retryable).toBe(true);

    // Second SQLite connection sees OLD graph without added-rev
    const checkBefore = faultDb.query("SELECT graph_spec_json, machine_state_json FROM flow_runs WHERE flow_id = ?").get(flowId) as any;
    expect(String(checkBefore.graph_spec_json)).not.toContain("added-rev");
    expect(String(checkBefore.machine_state_json)).not.toContain("added-rev");

    // Clear fault and retry patch -> MUST persist BEFORE returning patched:true
    faultDb.exec("DROP TRIGGER fail_added_rev_patch;");
    const okPatch = JSON.parse((await h.tools.get("enhance_flow")!.execute("p-ok", {
      action: "patch", flowId,
      patch: { addNodes: [{ id: "added-rev", kind: "role", role: "reviewer", dependsOn: ["work"] }] },
    }, null, null, ctx)).content[0].text);
    expect(okPatch.patched).toBe(true);

    const checkAfter = faultDb.query("SELECT graph_spec_json, machine_state_json FROM flow_runs WHERE flow_id = ?").get(flowId) as any;
    expect(String(checkAfter.graph_spec_json)).toContain("added-rev");
    expect(String(checkAfter.machine_state_json)).toContain("added-rev");
    faultDb.close();

    releaseWork();
    const done = JSON.parse((await flowPromise).content[0].text);
    expect(done.status).toBe("completed");
    expect(dispatched).toEqual(["work", "added-rev"]);
  });

  test("10. P2-4: deleted role is rejected consistently by both GRAPH_PATCH and resume, and restoring resumes with frozen snapshot", async () => {
    const cwd = makeTmpDir("p2-4");
    const globalDir = makeTmpDir("p2-4-global");
    const lockPath = path.join(makeTmpDir("p2-4-lock"), "lock.json");

    const mkRoleYaml = (id: string, stance = "v1-frozen-stance") => `id: ${id}
name: Role ${id}
description: Custom project role ${id}
stance: ${stance}
method:
  - Analyze
permissions:
  tools: ["read"]
  writable: []
  protected: ["**"]
exit:
  require_tool_evidence: false
  criteria: []
`;
    const unusedPath = path.join(globalDir, "temp-unused.yaml");
    const usedPath = path.join(globalDir, "temp-used.yaml");
    writeText(unusedPath, mkRoleYaml("temp-unused"));
    writeText(usedPath, mkRoleYaml("temp-used", "v1-frozen-stance"));

    let runningReady!: () => void;
    const isRunning = new Promise<void>((r) => { runningReady = r; });
    let finishStep1!: () => void;
    const step1Gate = new Promise<void>((r) => { finishStep1 = r; });

    const runner1: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        if (stepCtx.nodeId === "step1") {
          runningReady();
          await step1Gate;
        }
        return makeHandoff(stepCtx, `Done ${stepCtx.nodeId}`);
      },
    };
    const h1 = makeHarness({ cwd, globalDir, lockPath, runner: runner1 });
    const ctx = { cwd, hasUI: false, isProjectTrusted: true };

    const flowPromise = h1.tools.get("enhance_flow")!.execute("s", {
      action: "start", goal: "Deleted role policy test", wait: true,
      nodes: [
        { id: "step1", kind: "role", role: "planner", dependsOn: [] },
        { id: "ask", kind: "human", dependsOn: ["step1"], human: { prompt: "是否继续执行已引用角色？" } },
        { id: "step2", kind: "role", role: "temp-used", dependsOn: ["ask"] },
      ],
    }, null, null, ctx);
    await isRunning;
    const flowId = JSON.parse((await h1.tools.get("enhance_flow")!.execute("st0", { action: "status" }, null, null, ctx)).content[0].text).flowId as string;

    // Delete BOTH custom roles from disk mid-Flow
    rmSync(unusedPath, { force: true });
    rmSync(usedPath, { force: true });

    // Attempting to patch in deleted unreferenced role MUST be rejected!
    const badPatch = await h1.tools.get("enhance_flow")!.execute("p-bad", {
      action: "patch", flowId,
      patch: { addNodes: [{ id: "bad", kind: "role", role: "temp-unused", dependsOn: ["step1"] }] },
    }, null, null, ctx);
    expect(badPatch.isError).toBe(true);
    expect(JSON.parse(badPatch.content[0].text).patched).toBe(false);

    // Let step1 finish -> pauses at human gate -> simulate restart
    finishStep1();
    const pausedRes = JSON.parse((await flowPromise).content[0].text);
    expect(pausedRes.status).toBe("waiting_input");
    await h1.emit("session_shutdown", {}, ctx);

    // Fresh harness after restart: while temp-used is deleted, resume uses the SAME revocation policy and refuses cleanly!
    const seenStances: string[] = [];
    const h2 = makeHarness({
      cwd, globalDir, lockPath,
      runner: {
        async runRoleTurn(stepCtx) {
          seenStances.push(stepCtx.role.stance.trim());
          return makeHandoff(stepCtx, "Completed from frozen snapshot");
        },
      },
    });
    const blockedResume = await h2.tools.get("enhance_flow")!.execute("res-blocked", {
      action: "resume", flowId, nodeId: "ask", message: "同意", wait: true,
    }, null, null, ctx);
    expect(blockedResume.isError).toBe(true);
    expect(JSON.parse(blockedResume.content[0].text).error).toContain('Unknown role "temp-used"');

    // Restore temp-used on disk (even edited to v2!) -> resume succeeds using its frozen v1 snapshot!
    writeText(usedPath, mkRoleYaml("temp-used", "v2-edited-stance"));
    const resumed = JSON.parse((await h2.tools.get("enhance_flow")!.execute("res-ok", {
      action: "resume", flowId, nodeId: "ask", message: "同意", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(resumed.status).toBe("completed");
    expect(seenStances).toEqual(["v1-frozen-stance"]);
  });

  test("11. CI evaluator separates cross-sentence negation vs material-only answers and all 3 blind exports enforce leak-free output", () => {
    const c1Dir = makeTmpDir("eval-c1");
    PILOT_CASES[0]!.setup(c1Dir);

    const goodCrossSentence = scoreCaseOutput(
      PILOT_CASES[0]!,
      c1Dir,
      "已排除连接池问题。根因是 src/settlement/window.ts:10 在非 UTC 时区按本地时间解析导致早间交易被遗漏（见 ci/failing-build-418.log:1），请运行双时区复验（TZ=UTC 与 TZ=America/Los_Angeles）。",
    );
    expect(goodCrossSentence.passed).toBe(true);
    expect(goodCrossSentence.noContradictionOrNonAnswer).toBe(true);

    const badMaterialOnly = scoreCaseOutput(
      PILOT_CASES[0]!,
      c1Dir,
      "排查材料包括 src/settlement/window.ts:10 和 ci/failing-build-418.log:1。日志使用 UTC。",
    );
    expect(badMaterialOnly.passed).toBe(false);
    expect(badMaterialOnly.rootCauseOrAbstentionOk).toBe(false);
    expect(badMaterialOnly.actionableStepOk).toBe(false);

    // Blind-review export boundary enforcement across ALL 3 eval scripts
    const ciBundle = buildBlindReviewBundle([{
      trialId: "ci-111111", caseId: PILOT_CASES[0]!.id, arm: "coord-autonomous", model: "test",
      durationMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, failed: false,
      responseText: "通过 enhance_flow 在 coord-autonomous 模式下得到 [planner handoff] 结论。",
      score: goodCrossSentence,
    }]);
    expect(detectBlindReviewLeaks(ciBundle.blindItems[0]!)).toEqual([]);
    expect(ciBundle.blindItems[0]!.responseText).not.toContain("enhance_flow");
    const ciKey = ciBundle.answerKey[ciBundle.blindItems[0]!.candidateId]!;
    expect(ciKey.rawResponseText).toContain("enhance_flow");
    expect(ciKey.leaksRedacted.length).toBeGreaterThanOrEqual(3);

    const intentBundle = buildIntentBlindBundle([{
      trialId: "in-222222", caseId: INTENT_CASES[0]!.id, arm: "coord-autonomous", model: "test",
      durationMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, failed: false,
      responseText: "调用 enhance_flow 完成摆正。",
      score: {
        passed: true, engineAvailable: true, importReadyWithoutTweak: true, falseComplete: false,
        clarificationAppropriate: true, rubricChallengeOk: true, verificationScopeHonest: true, originalPreserved: true, notes: [],
      },
    }]);
    expect(detectIntentBlindLeaks(intentBundle.blindItems[0]!)).toEqual([]);
    expect(intentBundle.blindItems[0]!.responseText).not.toContain("enhance_flow");
    expect(intentBundle.answerKey[intentBundle.blindItems[0]!.candidateId]!.leaksRedacted).toContain("enhance_flow");

    const simBundle = buildSimBlindBundle([{
      trialId: "sm-333333", caseId: SIM_CASES[0]!.id, arm: "fixed-flow", model: "test",
      durationMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, failed: false,
      responseText: "通过 fixed-flow 和 enhance_handoff 完成扫描。",
      score: { passed: true, verifierOk: true, metadataAndUnitsOk: true, notes: [] },
    }]);
    expect(detectSimBlindLeaks(simBundle.blindItems[0]!)).toEqual([]);
    expect(simBundle.blindItems[0]!.responseText).not.toContain("enhance_handoff");
    expect(simBundle.answerKey[simBundle.blindItems[0]!.candidateId]!.leaksRedacted.length).toBeGreaterThanOrEqual(2);
  });
});
