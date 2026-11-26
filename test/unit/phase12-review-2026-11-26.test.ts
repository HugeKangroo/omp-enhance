import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { computeSnapshotFingerprint, snapshotWorkspace } from "../../src/core/fs.ts";
import { checkToolCallAllowed, TurnTracker } from "../../src/core/policy.ts";
import { EnhanceStore } from "../../src/core/store.ts";
import type { HandoffEnvelope, RoleSpec } from "../../src/core/types.ts";
import ompEnhance from "../../src/entry.ts";
import { executeFlowGraph } from "../../src/flow/executor.ts";
import { compileFanOutJoin, compileLinearChain, validateFlowGraph } from "../../src/flow/graph.ts";
import { createAndVerifyHandoff } from "../../src/flow/handoff.ts";
import { createInitialFlowState, transitionFlow } from "../../src/flow/machine.ts";
import { isCheckpointResumable } from "../../src/flow/state.ts";
import { createGitWorktreeManager } from "../../src/flow/worktree.ts";
import { createOmpRoleSessionRunner } from "../../src/omp/session.ts";
import { FlowSessionPool } from "../../src/omp/session-pool.ts";
import { createManagedWorkspace } from "../../src/omp/workspace.ts";
import { discoverRoles, parseRoleYaml } from "../../src/roles/loader.ts";

const builtinRolesDir = path.resolve(import.meta.dir, "../../roles");
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `omp-enhance-p12-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeText(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function initGitRepo(files: Record<string, string>): { cwd: string; store: EnhanceStore } {
  const cwd = makeTmpDir("git");
  for (const [rel, content] of Object.entries(files)) writeText(path.join(cwd, rel), content);
  git(cwd, ["init"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "user.email", "test@local"]);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "init"]);
  return { cwd, store: new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite")) };
}

function makeRole(id: string, ro = false): RoleSpec {
  return {
    id, name: id.toUpperCase(), description: id, stance: "work", method: ["do"],
    permissions: { tools: ro ? ["read", "grep"] : ["read", "write", "edit", "bash"], ...(ro ? { writable: [], protected: ["**"] } : { protected: [".git/**"] }) },
    exit: { requireToolEvidence: false, criteria: [] },
    source: "builtin", filePath: `/tmp/${id}.yaml`, contentSha256: `sha-${id}`,
  };
}

function makeHarness(opts: { cwd: string; globalDir: string; lockPath: string; runnerFactory?: (pi: any, ctx: any) => any }) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(ev: any, ctx: any) => any>>();
  const sentMessages: any[] = [];
  const pi = {
    cwd: opts.cwd,
    on(ev: string, fn: (ev: any, ctx: any) => any) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
    registerTool(spec: any) { tools.set(spec.name, spec); },
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage(msg: any, delivery?: any) { sentMessages.push({ msg, delivery }); },
    getAllTools: () => [{ name: "read" }, { name: "grep" }, { name: "write" }, { name: "edit" }, { name: "bash" }],
    async setActiveTools() {},
    pi: { settings: {} },
  };
  ompEnhance(pi, {
    globalRolesDir: opts.globalDir, builtinRolesDir, pluginLockPath: opts.lockPath,
    ...(opts.runnerFactory ? { runnerFactory: opts.runnerFactory } : {}),
  });
  const emit = async (ev: string, payload: any, ctx: any) => {
    let last: any;
    for (const fn of handlers.get(ev) ?? []) last = await fn(payload, ctx);
    return last;
  };
  return { pi, tools, sentMessages, emit };
}

describe("Review 2026-11-26 Regression Suite (All 9 Findings)", () => {
  test("#9: merge failure under concurrent user staged edits leaves user file bytes, git diff --cached, and git status --porcelain identical and preserves preview branch", async () => {
    const { cwd, store } = initGitRepo({ "shared.txt": "line1\nline2\n" });
    const roles = new Map<string, RoleSpec>([["dev", makeRole("dev")]]);
    const spec = compileFanOutJoin({
      goal: "Update shared.txt",
      shards: [{ id: "w1", role: "dev", brief: "Edit line1", writableScope: ["shared.txt"], workspace: "worktree" }],
      merge: { landingMode: "apply", conflictPolicy: "ask_human" },
    });
    const validation = validateFlowGraph({ spec, roles, isGitRepo: true });
    expect(validation.ok).toBe(true);

    const flowId = "flow-p12-9";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["w1", "merge"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 1,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });

    let beforeBytes: Buffer | null = null;
    let beforeCached = "";
    let beforeStatus = "";
    const runner = {
      runRoleTurn: async (ctx: any) => {
        // Worker edits line 1 inside isolated worktree
        writeText(path.join(ctx.cwd, "shared.txt"), "worker-line1\nline2\n");
        // Meanwhile user edits the SAME line in main cwd and stages it!
        writeText(path.join(cwd, "shared.txt"), "user-staged-line1\nline2\n");
        git(cwd, ["add", "shared.txt"]);
        beforeBytes = readFileSync(path.join(cwd, "shared.txt"));
        beforeCached = git(cwd, ["diff", "--cached"]);
        beforeStatus = git(cwd, ["status", "--porcelain"]);
        const ho: HandoffEnvelope = {
          id: "ho-w1", mandateId: mandate.id, mandateRev: 1, parentHandoffId: null,
          fromRole: "dev", toTarget: "merge", verdict: "ready", summary: "Edited shared.txt",
          artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
        };
        store.saveHandoff(ho);
        return { envelope: ho, observedCalls: [], assistantText: ho.summary, usage: null };
      },
    };

    const wtMgr = createGitWorktreeManager();
    const res = await executeFlowGraph({ cwd, store, flowId, mandate, spec, validation, roles, runner, worktreeManager: wtMgr });
    expect(res.status).toBe("waiting_input");
    expect(res.reason).toContain("working-tree-drift");
    expect(res.mergedRef).toBe(`omp-enhance/${flowId}`);

    // Byte-for-byte identity of working file, staged diff, and porcelain status (no conflict markers, no UU!)
    expect(readFileSync(path.join(cwd, "shared.txt")).equals(beforeBytes!)).toBe(true);
    expect(readFileSync(path.join(cwd, "shared.txt"), "utf8")).not.toContain("<<<<<<<");
    expect(git(cwd, ["diff", "--cached"])).toBe(beforeCached);
    expect(git(cwd, ["status", "--porcelain"])).toBe(beforeStatus);
    expect(git(cwd, ["status", "--porcelain"])).not.toContain("UU");

    // Preview branch still contains the specialist's exact output
    expect(git(cwd, ["show", `${res.mergedRef}:shared.txt`])).toBe("worker-line1\nline2\n");
    await wtMgr.cleanupFlowWorktrees(cwd, flowId);
    store.close();
  });

  test("#8: parallel worktree writers without merge are rejected pre-flight; with merge (apply & branch_preview) both files remain retrievable after cleanup", async () => {
    const { cwd: cwdReject, store: storeReject } = initGitRepo({ "README.md": "init\n" });
    const roles = new Map<string, RoleSpec>([["dev", makeRole("dev")]]);

    // Counterexample: fan_out_join omitting merge on 2 parallel writable shards -> rejected pre-flight!
    const noMergeSpec = compileFanOutJoin({
      goal: "Write two files without merge",
      shards: [
        { id: "w1", role: "dev", brief: "Write a.txt" },
        { id: "w2", role: "dev", brief: "Write b.txt" },
      ],
    });
    const noMergeVal = validateFlowGraph({ spec: noMergeSpec, roles, isGitRepo: true });
    expect(noMergeVal.ok).toBe(false);
    expect(noMergeVal.issues.filter((i) => i.code === "missing_merge_delivery").map((i) => i.nodeId).sort()).toEqual(["w1", "w2"]);
    storeReject.close();

    // Acceptance: fan_out_join WITH branch_preview delivers both files on surviving preview branch after worktree cleanup!
    const { cwd, store } = initGitRepo({ "README.md": "init\n" });
    const previewSpec = compileFanOutJoin({
      goal: "Write two files to preview branch",
      shards: [
        { id: "w1", role: "dev", brief: "Write a.txt", writableScope: ["a.txt"], workspace: "worktree" },
        { id: "w2", role: "dev", brief: "Write b.txt", writableScope: ["b.txt"], workspace: "worktree" },
      ],
      merge: { landingMode: "branch_preview", conflictPolicy: "fail" },
    });
    const previewVal = validateFlowGraph({ spec: previewSpec, roles, isGitRepo: true });
    expect(previewVal.ok).toBe(true);

    const flowId = "flow-p12-8-preview";
    const mandate = store.upsertMandate({ goal: previewSpec.goal, flowId });
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: previewSpec.goal, cwd, roleChain: ["w1", "w2", "merge"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 1,
      snapshotJson: "{}", updatedAt: new Date().toISOString(),
    });
    const runner = {
      runRoleTurn: async (ctx: any) => {
        if (ctx.nodeId === "w1") writeText(path.join(ctx.cwd, "a.txt"), "ALPHA_CONTENT\n");
        if (ctx.nodeId === "w2") writeText(path.join(ctx.cwd, "b.txt"), "BETA_CONTENT\n");
        const ho: HandoffEnvelope = {
          id: `ho-${ctx.nodeId}`, mandateId: mandate.id, mandateRev: 1, parentHandoffId: null,
          fromRole: "dev", toTarget: "merge", verdict: "ready", summary: `wrote ${ctx.nodeId}`,
          artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
        };
        store.saveHandoff(ho);
        return { envelope: ho, observedCalls: [], assistantText: ho.summary, usage: null };
      },
    };
    const res = await executeFlowGraph({ cwd, store, flowId, mandate, spec: previewSpec, validation: previewVal, roles, runner, worktreeManager: createGitWorktreeManager() });
    expect(res.status).toBe("completed");
    expect(res.mergedRef).toBe(`omp-enhance/${flowId}`);
    // Ephemeral worktrees are cleaned up, yet BOTH files are retrievable from the delivered preview ref!
    const wtLines = git(cwd, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "));
    expect(wtLines.length).toBe(1);
    expect(git(cwd, ["show", `${res.mergedRef}:a.txt`])).toBe("ALPHA_CONTENT\n");
    expect(git(cwd, ["show", `${res.mergedRef}:b.txt`])).toBe("BETA_CONTENT\n");
    store.close();
  });

  test("#7: branch_preview gate evaluates the candidate commit in an isolated worktree (both main=PASS/cand=FAIL and main=FAIL/cand=PASS) and stamps testedCommitSha", async () => {
    const roles = new Map<string, RoleSpec>([["dev", makeRole("dev")]]);
    const runPreviewCase = async (mainContent: string, candidateContent: string, flowId: string) => {
      const { cwd, store } = initGitRepo({ "check.txt": `${mainContent}\n` });
      const spec = compileFanOutJoin({
        goal: `Preview gate ${mainContent}->${candidateContent}`,
        shards: [{ id: "w1", role: "dev", brief: "Edit check.txt", writableScope: ["check.txt"], workspace: "worktree" }],
        merge: { landingMode: "branch_preview", conflictPolicy: "fail" },
        gate: { id: "check-gate", command: "grep -qx PASS check.txt" },
        policies: { maxRepairRounds: 0 },
      });
      const validation = validateFlowGraph({ spec, roles, isGitRepo: true });
      expect(validation.ok).toBe(true);
      const mandate = store.upsertMandate({ goal: spec.goal, flowId });
      store.saveFlowCheckpoint({
        flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["w1", "merge", "check-gate"],
        status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null, maxRepairRounds: 0,
        snapshotJson: "{}", updatedAt: new Date().toISOString(),
      });
      const runner = {
        runRoleTurn: async (ctx: any) => {
          writeText(path.join(ctx.cwd, "check.txt"), `${candidateContent}\n`);
          const ho: HandoffEnvelope = {
            id: `ho-${flowId}`, mandateId: mandate.id, mandateRev: 1, parentHandoffId: null,
            fromRole: "dev", toTarget: "merge", verdict: "ready", summary: `set ${candidateContent}`,
            artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
          };
          store.saveHandoff(ho);
          return { envelope: ho, observedCalls: [], assistantText: ho.summary, usage: null };
        },
      };
      const res = await executeFlowGraph({ cwd, store, flowId, mandate, spec, validation, roles, runner, worktreeManager: createGitWorktreeManager() });
      const previewSha = git(cwd, ["rev-parse", `omp-enhance/${flowId}`]).trim();
      const mainAfter = readFileSync(path.join(cwd, "check.txt"), "utf8").trim();
      store.close();
      return { res, previewSha, mainAfter };
    };

    // Case 1: main=PASS, candidate=FAIL -> gate MUST fail on candidate SHA (NOT complete!)
    const failCase = await runPreviewCase("PASS", "FAIL", "flow-p12-7-fail");
    expect(failCase.res.status).not.toBe("completed");
    expect(failCase.res.finalState.nodes["check-gate"]?.lastGateEvidence?.exitCode).not.toBe(0);
    expect(failCase.res.finalState.nodes["check-gate"]?.lastGateEvidence?.testedCommitSha).toBe(failCase.previewSha);
    expect(failCase.mainAfter).toBe("PASS");

    // Case 2: main=FAIL, candidate=PASS -> gate MUST pass on candidate SHA (even though main is FAIL!)
    const passCase = await runPreviewCase("FAIL", "PASS", "flow-p12-7-pass");
    expect(passCase.res.status).toBe("completed");
    expect(passCase.res.finalState.nodes["check-gate"]?.lastGateEvidence?.exitCode).toBe(0);
    expect(passCase.res.finalState.nodes["check-gate"]?.lastGateEvidence?.testedCommitSha).toBe(passCase.previewSha);
    expect(passCase.mainAfter).toBe("FAIL");
  });

  test("#6: QA rejects piped failing tests (exit 0 from tee) and rejects stale prior-turn tests on warm reused sessions after workspace edits", async () => {
    const cwd = makeTmpDir("qa");
    const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    const roles = discoverRoles({ cwd, builtinRolesDir });
    const qaRole = roles.get("qa")!;
    const mandate = store.upsertMandate({ goal: "Verify tests cleanly" });

    // Counterexample 6a: real failing bun test piped through tee (overall exit 0, output has 0 pass / 1 fail)
    writeText(path.join(cwd, "nested.test.ts"), 'import { expect, test } from "bun:test";\ntest("boom", () => { expect(1).toBe(2); });\n');
    const pipedCmd = "bun test nested.test.ts 2>&1 | tee test.log";
    const pipedRun = spawnSync("bash", ["-lc", pipedCmd], { cwd, encoding: "utf8" });
    expect(pipedRun.status).toBe(0); // tee masked bun test's exit 1!
    const tracker = new TurnTracker();
    tracker.beginTurn(cwd, false);
    const pipedCall = tracker.recordToolExecutionEnd(cwd, {
      toolCallId: "tc-piped", toolName: "bash", args: { command: pipedCmd },
      output: `${pipedRun.stdout}\n${pipedRun.stderr}`, exitCode: pipedRun.status, isError: false, stageId: "stage-qa-1",
    });
    expect(() =>
      createAndVerifyHandoff({
        store, role: qaRole, cwd, mandate, stageId: "stage-qa-1", verdict: "ready",
        summary: "Claimed green from piped tee", observedCalls: [pipedCall],
      }),
    ).toThrow(/masked|unverifiable|pipefail/i);

    // Counterexample 6b: warm reused QA session — Turn 1 passes test & pauses; file changes; Turn 2 cannot reuse Turn 1 callId!
    writeText(path.join(cwd, "pass.test.ts"), 'import { expect, test } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n');
    writeText(path.join(cwd, "src", "app.ts"), "export const v = 1;\n");
    const pool = new FlowSessionPool();
    let turnNum = 0;
    let turn2StaleRejected = false;

    const pi = {
      getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "write" }],
      pi: {
        createAgentSession: async (opts: any) => {
          const handoffTool = opts.customTools.find((t: any) => t.name === "enhance_handoff");
          const guardHandlers = new Map<string, Array<(ev: any) => any>>();
          for (const ext of opts.preloadedPreparedExtensions ?? []) {
            ext.factory({ on(ev: string, fn: (ev: any) => any) { guardHandlers.set(ev, [...(guardHandlers.get(ev) ?? []), fn]); } });
          }
          const emitEnd = (ev: any) => { for (const fn of guardHandlers.get("tool_execution_end") ?? []) fn(ev); };
          const session = {
            messages: [] as any[],
            async setActiveTools() {},
            async prompt() {
              turnNum += 1;
              if (turnNum === 1) {
                const run1 = spawnSync("bash", ["-lc", "bun test pass.test.ts"], { cwd, encoding: "utf8" });
                session.messages.push(
                  { role: "assistant", content: [{ type: "toolCall", id: "qa-call-1", name: "bash", arguments: { command: "bun test pass.test.ts" } }] },
                  { role: "toolResult", toolCallId: "qa-call-1", toolName: "bash", output: run1.stdout, exitCode: run1.status, isError: false },
                );
                emitEnd({ toolCallId: "qa-call-1", toolName: "bash", args: { command: "bun test pass.test.ts" }, output: run1.stdout, exitCode: run1.status, isError: false });
                await handoffTool.execute("ho-turn1", { verdict: "needs_input", summary: "Need env clarification", questionsForUser: ["Run slow suite?"] });
                return;
              }
              // Turn 2: workspace changed between turns! Attempt ready WITHOUT re-running tests -> MUST fail!
              const staleAttempt = await handoffTool.execute("ho-turn2-stale", { verdict: "ready", summary: "Reusing turn 1 test" });
              turn2StaleRejected = Boolean(staleAttempt.isError);
              // Now actually re-run test on the new workspace tree
              const run2 = spawnSync("bash", ["-lc", "bun test pass.test.ts"], { cwd, encoding: "utf8" });
              session.messages.push(
                { role: "assistant", content: [{ type: "toolCall", id: "qa-call-2", name: "bash", arguments: { command: "bun test pass.test.ts" } }] },
                { role: "toolResult", toolCallId: "qa-call-2", toolName: "bash", output: run2.stdout, exitCode: run2.status, isError: false },
              );
              emitEnd({ toolCallId: "qa-call-2", toolName: "bash", args: { command: "bun test pass.test.ts" }, output: run2.stdout, exitCode: run2.status, isError: false });
              const freshAttempt = await handoffTool.execute("ho-turn2-fresh", { verdict: "ready", summary: "Verified on new tree" });
              expect(freshAttempt.isError).toBeUndefined();
            },
            getLastAssistantText: () => "ok",
            async dispose() {},
          };
          return { session };
        },
      },
    };

    const runner = createOmpRoleSessionRunner(pi, { cwd }, undefined, roles);
    const r1 = await runner.runRoleTurn({
      cwd, store, role: qaRole, mandate, epistemicItems: [], flowId: "flow-qa-warm", nodeId: "qa", stageId: "stage-qa-turn1",
      round: 0, toTarget: "user", conditioningPrompt: "QA", taskPrompt: "Run tests",
      upstreamHandoff: null, userSteers: [], sessionPool: pool, keepSessionWarm: true, reuseSession: false,
    });
    expect(r1.envelope?.verdict).toBe("needs_input");
    expect(r1.sessionWarm).toBe(true);

    // Mutate workspace while QA is paused!
    writeText(path.join(cwd, "src", "app.ts"), "export const v = 2;\n");
    const newTreeFp = computeSnapshotFingerprint(snapshotWorkspace(cwd));

    const r2 = await runner.runRoleTurn({
      cwd, store, role: qaRole, mandate, epistemicItems: [], flowId: "flow-qa-warm", nodeId: "qa", stageId: "stage-qa-turn2",
      round: 0, toTarget: "user", conditioningPrompt: "QA", taskPrompt: "Continue",
      upstreamHandoff: null, userSteers: [], sessionPool: pool, keepSessionWarm: false, reuseSession: true, replyText: "Just unit tests",
    });
    expect(turn2StaleRejected).toBe(true);
    expect(r2.envelope?.verdict).toBe("ready");
    expect(r2.envelope?.verificationEvidence?.length).toBe(1);
    expect(r2.envelope?.verificationEvidence?.[0]?.toolCallId).toBe("qa-call-2");
    expect(r2.envelope?.verificationEvidence?.[0]?.stageId).toBe("stage-qa-turn2");
    expect(r2.envelope?.verificationEvidence?.[0]?.testedTreeFingerprint).toBe(newTreeFp);
    await pool.disposeFlow("flow-qa-warm");
    store.close();
  });

  test("#2: real OMP 19.1.1 host schema validates linear, single-node DAG, preset workers/shards, live patch, and targeted resume, and rejects missing required fields", () => {
    const defaultOmp = path.join(homedir(), ".local", "bin", "omp");
    const ompBin = process.env.OMP_COMMAND ?? (existsSync(defaultOmp) ? defaultOmp : "");
    expect(Boolean(ompBin && existsSync(ompBin))).toBe(true);

    const probeDir = makeTmpDir("omp-schema");
    const entryPath = path.resolve(import.meta.dir, "../../src/entry.ts");
    const extPath = path.join(probeDir, "schema-probe-ext.ts");
    const outPath = path.join(probeDir, "report.json");
    writeText(extPath, `
import { writeFileSync } from "node:fs";
import ompEnhance from ${JSON.stringify(entryPath)};
export default function(pi: any) {
  const registered: Record<string, any> = {};
  const wrapped = Object.create(pi, {
    registerTool: { value: (spec: any) => { registered[spec.name] = spec; return pi.registerTool(spec); } },
  });
  ompEnhance(wrapped);
  pi.registerCommand("verify-flow-schema", {
    description: "Verify real OMP host schema validation for enhance_flow",
    async handler() {
      const schema = registered.enhance_flow.parameters;
      const check = (payload: unknown) => {
        const res = schema.run(payload);
        const isErr = Boolean(res && (res instanceof Error || typeof res.summary === "string"));
        return { ok: !isErr, error: isErr ? (res.summary ?? String(res)) : null };
      };
      writeFileSync(process.env.OUT!, JSON.stringify({
        linear: check({ action: "start", roles: ["dev", "qa"], goal: "Fix bug" }),
        singleNodeDag: check({ action: "start", goal: "Plan", nodes: [{ id: "p1", kind: "role", role: "planner", dependsOn: [] }] }),
        presetWorkers: check({
          action: "start", preset: "contract_parallel_verify", goal: "Parallel fix",
          contract: { brief: "Lock contract" },
          workers: [
            { id: "w1", role: "dev", brief: { owns: "src/a.ts", acceptance: ["tests pass"] }, writableScope: ["src/a.ts"] },
            { id: "w2", role: "dev", brief: "Fix b.ts", writableScope: ["src/b.ts"] },
          ],
          gateCommand: "bun test", landingMode: "branch_preview",
        }),
        presetShards: check({
          action: "start", preset: "fan_out_join", goal: "Fan out",
          shards: [{ id: "s1", role: "dev", brief: "Shard 1", workspace: "worktree" }],
          merge: { landingMode: "apply", conflictPolicy: "ask_human" },
          gate: { command: "bun test" },
        }),
        livePatch: check({
          action: "patch", flowId: "flow-b",
          patch: { skipNodeIds: ["n2"], addNodes: [{ id: "rev", kind: "role", role: "reviewer", dependsOn: ["n1"] }] },
        }),
        resumeTargeted: check({ action: "resume", flowId: "flow-1", nodeId: "approve_backend", message: "Approve backend only" }),
        badNodeMissingId: check({ action: "start", goal: "Bad", nodes: [{ kind: "role", role: "planner" }] }),
        badWorkerMissingBrief: check({ action: "start", preset: "contract_parallel_verify", goal: "Bad", workers: [{ role: "dev" }] }),
        badUnknownField: check({ action: "start", roles: ["dev"], unknownExtraField: 123 }),
      }, null, 2));
    },
  });
}
`);
    const run = spawnSync(ompBin, ["--cwd", probeDir, "--no-extensions", "--extension", extPath, "--no-session", "--print", "/verify-flow-schema"], {
      env: { ...process.env, OUT: outPath }, encoding: "utf8", timeout: 30_000,
    });
    expect(run.status).toBe(0);
    const report = JSON.parse(readFileSync(outPath, "utf8"));
    expect(report.linear.ok).toBe(true);
    expect(report.singleNodeDag.ok).toBe(true);
    expect(report.presetWorkers.ok).toBe(true);
    expect(report.presetShards.ok).toBe(true);
    expect(report.livePatch.ok).toBe(true);
    expect(report.resumeTargeted.ok).toBe(true);
    expect(report.badNodeMissingId.ok).toBe(false);
    expect(report.badNodeMissingId.error).toContain("id");
    expect(report.badWorkerMissingBrief.ok).toBe(false);
    expect(report.badWorkerMissingBrief.error).toContain("brief");
    expect(report.badUnknownField.ok).toBe(false);
  });

  test("#3: patch targeting historical Flow A fails cleanly without mutating running Flow B; same patch targeting Flow B adds the node only to B", async () => {
    const cwd = makeTmpDir("patch-iso");
    const globalDir = makeTmpDir("patch-global");
    const lockPath = path.join(makeTmpDir("patch-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));

    let releaseStep1!: () => void;
    const step1Started = new Promise<void>((resolve) => {
      const doneGate = new Promise<void>((res) => { releaseStep1 = res; });
      (globalThis as any).__p12PatchGate = { resolve, doneGate };
    });
    const ranNodes: string[] = [];

    const h = makeHarness({
      cwd, globalDir, lockPath,
      runnerFactory: () => ({
        runRoleTurn: async (ctx: any) => {
          ranNodes.push(`${ctx.flowId}:${ctx.nodeId}`);
          if (ctx.nodeId === "scan") {
            (globalThis as any).__p12PatchGate.resolve();
            await (globalThis as any).__p12PatchGate.doneGate;
          }
          const ho: HandoffEnvelope = {
            id: `ho-${ctx.flowId}-${ctx.nodeId}`, mandateId: ctx.mandate.id, mandateRev: 1, parentHandoffId: null,
            fromRole: ctx.role.id, toTarget: ctx.toTarget, verdict: "ready", summary: `done ${ctx.nodeId}`,
            artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
          };
          ctx.store.saveHandoff(ho);
          return { envelope: ho, observedCalls: [], assistantText: ho.summary, usage: null };
        },
      }),
    });
    const ctx = { cwd, hasUI: true, ui: { setWidget() {}, setStatus() {}, notify() {} } };

    // 1. Run historical Flow A to completion
    const resA = JSON.parse((await h.tools.get("enhance_flow")!.execute("start-a", {
      action: "start", goal: "Historical A", wait: true,
      nodes: [{ id: "plan-a", kind: "role", role: "planner", dependsOn: [] }],
    }, null, null, ctx)).content[0].text);
    expect(resA.status).toBe("completed");
    const flowAId = JSON.parse((await h.tools.get("enhance_flow")!.execute("st-a", { action: "status" }, null, null, ctx)).content[0].text).flowId;

    // 2. Start live running DAG Flow B in background
    const startB = JSON.parse((await h.tools.get("enhance_flow")!.execute("start-b", {
      action: "start", goal: "Running B",
      nodes: [{ id: "scan", kind: "role", role: "planner", dependsOn: [] }],
    }, null, null, ctx)).content[0].text);
    expect(startB.started).toBe(true);
    const flowBId = startB.flowId;
    await step1Started;

    // 3. Send patch targeting historical Flow A -> MUST fail and leave B untouched!
    const badPatchRes = await h.tools.get("enhance_flow")!.execute("patch-a", {
      action: "patch", flowId: flowAId,
      patch: { addNodes: [{ id: "added-rev", kind: "role", role: "reviewer", dependsOn: ["scan"] }] },
    }, null, null, ctx);
    expect(badPatchRes.isError).toBe(true);
    const badPatch = JSON.parse(badPatchRes.content[0].text);
    expect(badPatch.patched).toBe(false);
    expect(badPatch.flowId).toBe(flowAId);
    const statusBAfterBad = JSON.parse((await h.tools.get("enhance_flow")!.execute("st-b1", { action: "status", flowId: flowBId }, null, null, ctx)).content[0].text);
    expect(statusBAfterBad.graphSnapshot.nodes.map((n: any) => n.nodeId)).toEqual(["scan"]);

    // 4. Send the SAME patch targeting live Flow B -> succeeds and adds node ONLY to B!
    const goodPatchRes = await h.tools.get("enhance_flow")!.execute("patch-b", {
      action: "patch", flowId: flowBId,
      patch: { addNodes: [{ id: "added-rev", kind: "role", role: "reviewer", dependsOn: ["scan"] }] },
    }, null, null, ctx);
    expect(goodPatchRes.isError).toBeUndefined();
    const goodPatch = JSON.parse(goodPatchRes.content[0].text);
    expect(goodPatch.patched).toBe(true);
    expect(goodPatch.flowId).toBe(flowBId);

    releaseStep1();
    await new Promise((r) => setTimeout(r, 80));
    expect(ranNodes).toContain(`${flowBId}:added-rev`);
    expect(ranNodes.some((x) => x.startsWith(`${flowAId}:added-rev`))).toBe(false);
    await h.emit("session_shutdown", {}, ctx);
  });

  test("#1: parallel human nodes list all questions, require nodeId binding, preserve user verbatim reply, and foreground algo keeps align_metric paused on status questions", async () => {
    const cwd = makeTmpDir("waiting-iso");
    const globalDir = makeTmpDir("waiting-global");
    const lockPath = path.join(makeTmpDir("waiting-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));

    const dispatched: string[] = [];
    const h = makeHarness({
      cwd, globalDir, lockPath,
      runnerFactory: () => ({
        runRoleTurn: async (ctx: any) => {
          dispatched.push(ctx.nodeId);
          const ho: HandoffEnvelope = {
            id: `ho-${ctx.nodeId}`, mandateId: ctx.mandate.id, mandateRev: 1, parentHandoffId: null,
            fromRole: ctx.role.id, toTarget: "user", verdict: "ready", summary: `deployed ${ctx.nodeId}`,
            artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
          };
          ctx.store.saveHandoff(ho);
          return { envelope: ho, observedCalls: [], assistantText: ho.summary, usage: null };
        },
      }),
    });
    const ctx = { cwd, hasUI: false, ui: { setWidget() {}, setStatus() {}, notify() {} } };

    // Two parallel human approval gates: backend & billing
    const startRes = JSON.parse((await h.tools.get("enhance_flow")!.execute("start-dual", {
      action: "start", goal: "Approve backend and billing releases", wait: true,
      nodes: [
        { id: "approve_backend", kind: "human", dependsOn: [], human: { prompt: "是否批准发布 backend？" } },
        { id: "approve_billing", kind: "human", dependsOn: [], human: { prompt: "是否批准发布 billing？" } },
        { id: "deploy_backend", kind: "role", role: "planner", dependsOn: ["approve_backend"] },
        { id: "deploy_billing", kind: "role", role: "planner", dependsOn: ["approve_billing"] },
      ],
    }, null, null, ctx)).content[0].text);
    expect(startRes.status).toBe("waiting_input");
    expect(startRes.reason).toContain("approve_backend");
    expect(startRes.reason).toContain("approve_billing");

    const flowId = JSON.parse((await h.tools.get("enhance_flow")!.execute("st0", { action: "status" }, null, null, ctx)).content[0].text).flowId;

    // Resuming WITHOUT nodeId when 2 nodes are waiting MUST fail cleanly without approving either!
    const ambiguous = await h.tools.get("enhance_flow")!.execute("res-ambig", {
      action: "resume", flowId, message: "只同意 backend，billing 另等决定", wait: true,
    }, null, null, ctx);
    expect(ambiguous.isError).toBe(true);
    const ambigPayload = JSON.parse(ambiguous.content[0].text);
    expect(ambigPayload.requiresNodeId).toBe(true);
    expect(ambigPayload.waitingNodes.map((w: any) => w.nodeId)).toEqual(["approve_backend", "approve_billing"]);
    expect(dispatched).toEqual([]);

    // Resume ONLY approve_backend with exact user wording -> backend runs, billing stays waiting_input!
    const userReplyBackend = "只同意 backend，billing 另等决定";
    const resBackend = JSON.parse((await h.tools.get("enhance_flow")!.execute("res-be", {
      action: "resume", flowId, nodeId: "approve_backend", message: userReplyBackend, wait: true,
    }, null, null, ctx)).content[0].text);
    expect(resBackend.status).toBe("waiting_input");
    expect(dispatched).toEqual(["deploy_backend"]);

    const midStatus = JSON.parse((await h.tools.get("enhance_flow")!.execute("st-mid", { action: "status", flowId }, null, null, ctx)).content[0].text);
    const nodeMap = Object.fromEntries(midStatus.graphSnapshot.nodes.map((n: any) => [n.nodeId, n]));
    expect(nodeMap.approve_backend.status).toBe("succeeded");
    expect(nodeMap.approve_backend.summary).toBe(userReplyBackend); // Verbatim user wording, NOT "已确认放行"!
    expect(nodeMap.deploy_backend.status).toBe("succeeded");
    expect(nodeMap.approve_billing.status).toBe("waiting_input");
    expect(nodeMap.deploy_billing.status).toBe("pending");

    // Now approve billing separately -> billing runs and flow completes
    const resBilling = JSON.parse((await h.tools.get("enhance_flow")!.execute("res-bill", {
      action: "resume", flowId, nodeId: "approve_billing", message: "billing 现在批准", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(resBilling.status).toBe("completed");
    expect(dispatched).toEqual(["deploy_backend", "deploy_billing"]);
    await h.emit("session_shutdown", {}, ctx);

    // 1b: Foreground /role algo paused at align_metric MUST NOT advance when user asks "现在进度如何？"
    const fgCwd = makeTmpDir("fg-algo");
    const fgLock = path.join(makeTmpDir("fg-lock"), "omp-plugins.lock.json");
    writeText(fgLock, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "algo" } } }));
    const fgH = makeHarness({ cwd: fgCwd, globalDir, lockPath: fgLock });
    const fgCtx = { cwd: fgCwd, hasUI: false };
    await fgH.emit("session_start", {}, fgCtx);
    await fgH.emit("before_agent_start", { systemPrompt: [] }, fgCtx);
    writeText(path.join(fgCwd, "algo_work", "benchmark", "data_profile.json"), '{"rows":50}\n');
    await fgH.emit("tool_execution_end", { toolCallId: "fg-t1", toolName: "write", args: { path: "algo_work/benchmark/data_profile.json" }, isError: false }, fgCtx);
    const auditHo = await fgH.tools.get("enhance_handoff")!.execute("ho-audit", { verdict: "ready", summary: "Audit done" }, null, null, fgCtx);
    expect(auditHo.isError).toBeUndefined();
    await fgH.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, fgCtx);

    // User asks "现在进度如何？" on Turn 2 -> before_agent_start MUST keep phase at align_metric (NOT baseline!)
    const turn2Prompt = await fgH.emit("before_agent_start", { systemPrompt: [] }, fgCtx);
    const joinedPrompt = (turn2Prompt?.systemPrompt ?? []).join("\n");
    expect(joinedPrompt).toContain("align_metric");
    expect(joinedPrompt).toContain("HUMAN GATE");
    expect(joinedPrompt).not.toContain("Phase 3/5: baseline");
    // Write tool is physically blocked while waiting in align_metric!
    const writeBlocked = await fgH.emit("tool_call", { toolName: "write", input: { path: "algo_work/benchmark/eval.py", content: "x" } }, fgCtx);
    expect(writeBlocked?.block).toBe(true);
    await fgH.emit("session_shutdown", {}, fgCtx);
  });

  test("#4: roles:['confirm-first'] and single-node DAG execute identical workflow phases, pause, resume, and exit artifacts; dev->qa & legacy linear checkpoints remain compatible", async () => {
    const globalDir = makeTmpDir("wf-global");
    writeText(path.join(globalDir, "confirm-first.yaml"), `
id: confirm-first
name: Confirm First Worker
description: Must ask human before doing work
stance: Ask before writing.
method:
  - Ask then write
permissions:
  tools: ["read", "write"]
  writable: ["out/**"]
  protected: [".git/**"]
exit:
  require_tool_evidence: false
  criteria:
    - Produce out/result.txt
workflow:
  session: reuse
  phases:
    - id: confirm
      title: Human Approval
      kind: human
      prompt: "请确认是否开始写入 out/result.txt？"
    - id: work
      title: Produce Output
      exit_artifacts: ["out/result.txt"]
      brief: Write out/result.txt
`);
    const runPath = async (mode: "roles" | "dag") => {
      const cwd = makeTmpDir(`wf-${mode}`);
      const lockPath = path.join(makeTmpDir(`wf-lock-${mode}`), "omp-plugins.lock.json");
      writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));
      const workerCalls: string[] = [];
      const h = makeHarness({
        cwd, globalDir, lockPath,
        runnerFactory: () => ({
          runRoleTurn: async (ctx: any) => {
            workerCalls.push(`${ctx.role.id}:${ctx.nodeId}`);
            writeText(path.join(cwd, "out", "result.txt"), `ok:${mode}\n`);
            const ho = createAndVerifyHandoff({
              store: ctx.store, role: ctx.role, cwd, mandate: ctx.mandate, verdict: "ready",
              summary: `completed ${mode}`, artifactPaths: ["out/result.txt"],
            });
            return { envelope: ho, observedCalls: [], assistantText: ho.summary, usage: null };
          },
        }),
      });
      const ctx = { cwd, hasUI: false };
      const startParams = mode === "roles"
        ? { action: "start", roles: ["confirm-first"], goal: "Test unified workflow", wait: true }
        : { action: "start", goal: "Test unified workflow", wait: true, nodes: [{ id: "confirm-first", kind: "role", role: "confirm-first", dependsOn: [] }] };
      const paused = JSON.parse((await h.tools.get("enhance_flow")!.execute("s1", startParams, null, null, ctx)).content[0].text);
      const callsBeforeResume = [...workerCalls];
      const flowId = JSON.parse((await h.tools.get("enhance_flow")!.execute("st1", { action: "status" }, null, null, ctx)).content[0].text).flowId;
      const done = JSON.parse((await h.tools.get("enhance_flow")!.execute("r1", { action: "resume", flowId, message: "批准写入", wait: true }, null, null, ctx)).content[0].text);
      await h.emit("session_shutdown", {}, ctx);
      return { paused, callsBeforeResume, done, workerCalls };
    };

    const viaRoles = await runPath("roles");
    const viaDag = await runPath("dag");
    expect(viaRoles.paused.status).toBe("waiting_input");
    expect(viaDag.paused.status).toBe("waiting_input");
    expect(viaRoles.paused.reason).toContain("请确认是否开始写入 out/result.txt？");
    expect(viaDag.paused.reason).toContain("请确认是否开始写入 out/result.txt？");
    expect(viaRoles.callsBeforeResume).toEqual([]); // Neither path ran worker before human approval!
    expect(viaDag.callsBeforeResume).toEqual([]);
    expect(viaRoles.done.status).toBe("completed");
    expect(viaDag.done.status).toBe("completed");
    expect(viaRoles.workerCalls).toEqual(viaDag.workerCalls);
    expect(viaRoles.workerCalls).toEqual(["confirm-first__work:work"]);

    // Compatibility: workflow-less roles:["dev","qa"] and legacy linear checkpoint resume still work identically
    const compatCwd = makeTmpDir("wf-compat");
    const compatLock = path.join(makeTmpDir("wf-compat-lock"), "omp-plugins.lock.json");
    writeText(compatLock, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator", flowRoutingMode: "auto", supervisorEnabled: false } } }));
    const compatOrder: string[] = [];
    const compatH = makeHarness({
      cwd: compatCwd, globalDir, lockPath: compatLock,
      runnerFactory: () => ({
        runRoleTurn: async (ctx: any) => {
          compatOrder.push(ctx.role.id);
          const ho: HandoffEnvelope = {
            id: `ho-compat-${ctx.role.id}`, mandateId: ctx.mandate.id, mandateRev: 1, parentHandoffId: null,
            fromRole: ctx.role.id, toTarget: ctx.toTarget, verdict: "ready", summary: `${ctx.role.id} ok`,
            artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
          };
          ctx.store.saveHandoff(ho);
          return { envelope: ho, observedCalls: [], assistantText: ho.summary, usage: null };
        },
      }),
    });
    const compatRes = JSON.parse((await compatH.tools.get("enhance_flow")!.execute("c1", {
      action: "start", roles: ["dev", "qa"], goal: "Legacy linear dev->qa", wait: true,
    }, null, null, { cwd: compatCwd, hasUI: false })).content[0].text);
    expect(compatRes.status).toBe("completed");
    expect(compatOrder).toEqual(["dev", "qa"]);
    await compatH.emit("session_shutdown", {}, { cwd: compatCwd, hasUI: false });
  });

  test("#5: dead-owner crash recovery synchronizes persisted DAG machine_state_json to interrupted, preserves succeeded node handoff, and dispatches running node once to completion", async () => {
    const cwd = makeTmpDir("crash-dag");
    const globalDir = makeTmpDir("crash-global");
    const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    const roles = new Map<string, RoleSpec>([["planner", makeRole("planner", true)], ["reviewer", makeRole("reviewer", true)]]);
    const spec = compileLinearChain([roles.get("planner")!, roles.get("reviewer")!], "Crash recovery DAG");
    const val = validateFlowGraph({ spec, roles, isGitRepo: false });
    const flowId = "flow-p12-5-crash";
    const mandate = store.upsertMandate({ goal: spec.goal, flowId });

    // Construct a live mid-flight DAG state: planner=succeeded (with hoA), reviewer=running!
    const hoA: HandoffEnvelope = {
      id: "ho-planner-a", mandateId: mandate.id, mandateRev: 1, parentHandoffId: null,
      fromRole: "planner", toTarget: "reviewer", verdict: "ready", summary: "Preserved planner handoff",
      artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null, observedUsage: null, createdAt: "2026-11-26T10:00:00Z",
    };
    store.saveHandoff(hoA);
    let st = createInitialFlowState({ flowId, mandateId: mandate.id, cwd, spec, validation: val, nowIso: "2026-11-26T10:00:00Z" });
    st = transitionFlow(st, { type: "FLOW_START" }, "2026-11-26T10:00:00Z").state;
    st = transitionFlow(st, { type: "NODE_SUCCEEDED", nodeId: "planner", handoff: hoA, sessionWarm: false }, "2026-11-26T10:00:01Z").state;
    expect(st.status).toBe("running");
    expect(st.nodes["planner"]!.status).toBe("succeeded");
    expect(st.nodes["reviewer"]!.status).toBe("running");

    // Persist running DAG owned by a dead PID + dead lease!
    const deadPid = 999_999;
    store.acquireProjectFlowLease(flowId, deadPid, "ps:dead-token");
    store.saveFlowCheckpoint({
      flowId, mandateId: mandate.id, goal: spec.goal, cwd, roleChain: ["planner", "reviewer"],
      status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: hoA.id, maxRepairRounds: 2,
      snapshotJson: JSON.stringify({ flowId, mandateId: mandate.id, goal: spec.goal, roleChain: ["planner", "reviewer"], status: "running", entries: [], stages: [] }),
      ownerPid: deadPid, ownerStartToken: "ps:dead-token",
      graphSpecJson: JSON.stringify(spec), machineStateJson: JSON.stringify(st), leaseMode: "write_main",
      updatedAt: "2026-11-26T10:00:01Z",
    });
    store.close();

    // New process recreates workspace -> hydrates dead-owner running DAG into interrupted!
    const dispatched: Array<{ nodeId: string; upstreamSummary: string | null }> = [];
    const ws = createManagedWorkspace(
      { cwd, on() {}, sendMessage() {}, getAllTools: () => [{ name: "read" }] },
      cwd, true,
      {
        globalRolesDir: globalDir, builtinRolesDir,
        runnerFactory: () => ({
          runRoleTurn: async (ctx: any) => {
            dispatched.push({ nodeId: ctx.nodeId, upstreamSummary: ctx.upstreamHandoff?.summary ?? null });
            const hoB: HandoffEnvelope = {
              id: "ho-reviewer-b", mandateId: mandate.id, mandateRev: 1, parentHandoffId: ctx.upstreamHandoff?.id ?? null,
              fromRole: "reviewer", toTarget: "user", verdict: "ready", summary: "Reviewer finished after crash recovery",
              artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null, observedUsage: null, createdAt: new Date().toISOString(),
            };
            ctx.store.saveHandoff(hoB);
            return { envelope: hoB, observedCalls: [], assistantText: hoB.summary, usage: null };
          },
        }),
      },
    );

    expect(ws.room.getSnapshot().status).toBe("interrupted");
    expect(ws.room.isResumable()).toBe(true);
    const hydratedMachine = ws.room.getPersistedMachineState()!;
    expect(hydratedMachine.status).toBe("interrupted");
    expect(hydratedMachine.nodes["planner"]!.status).toBe("succeeded");
    expect(hydratedMachine.nodes["reviewer"]!.status).toBe("ready");
    expect(isCheckpointResumable(ws.store.getFlowCheckpoint(flowId))).toBe(true);

    // Resume in new process -> preserves planner handoff, dispatches reviewer EXACTLY ONCE, reaches completed!
    const resumed = await ws.resumeManagedFlow({ cwd, hasUI: false }, false, undefined, undefined, flowId);
    expect("status" in resumed && resumed.status).toBe("completed");
    expect(dispatched).toEqual([{ nodeId: "reviewer", upstreamSummary: "Preserved planner handoff" }]);
    ws.room.dispose();
    ws.store.close();
  });
});
