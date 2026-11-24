import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EnhanceStore } from "../../src/core/store.ts";
import type { ObservedToolCall } from "../../src/core/types.ts";
import ompEnhance from "../../src/entry.ts";
import { createAndVerifyHandoff } from "../../src/flow/handoff.ts";
import type { RoleSessionRunner } from "../../src/flow/orchestrator.ts";
import { FlowRoomManager } from "../../src/flow/state.ts";
import { parseFlowOverlayInput } from "../../src/ui/flow-room.ts";

const builtinRolesDir = path.resolve(import.meta.dir, "..", "..", "roles");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `omp-enhance-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function writeText(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createHarness(input: {
  cwd: string;
  globalDir: string;
  lockPath: string;
  runner?: RoleSessionRunner;
  branchEntries?: any[];
}) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sentMessages: any[] = [];
  const branchEntries = input.branchEntries ?? [];

  const pi: any = {
    cwd: input.cwd,
    on(event: string, fn: (ev: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, cmd: any) { commands.set(name, cmd); },
    registerMessageRenderer() {},
    getAllTools: () => ["read", "grep", "find", "ls", "edit", "write", "bash", "task"].map((name) => ({ name })),
    setActiveTools: async () => {},
    sendMessage(msg: any) { sentMessages.push(msg); },
    appendEntry(customType: string, data: unknown) {
      branchEntries.push({ type: "custom", customType, data });
    },
  };

  ompEnhance(pi, {
    builtinRolesDir,
    globalRolesDir: input.globalDir,
    pluginLockPath: input.lockPath,
    ...(input.runner ? { runnerFactory: () => input.runner! } : {}),
  });

  const emit = async (name: string, event: any, ctx: any) => {
    let last: any;
    for (const fn of handlers.get(name) ?? []) last = await fn(event, ctx);
    return last;
  };

  return { pi, tools, commands, sentMessages, branchEntries, emit };
}

describe("Phase 7 State Persistence & Interruption/Retry Resilience", () => {
  test("preserves lazy SQLite invariant on clean workspace when hydrating FlowRoomManager", async () => {
    const cwd = makeTempDir("p7-lazy");
    const globalDir = makeTempDir("p7-lazy-global");
    const lockPath = path.join(makeTempDir("p7-lazy-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": {} } }));

    const h = createHarness({ cwd, globalDir, lockPath });
    const ctx = { cwd, hasUI: false };
    await h.emit("session_start", {}, ctx);
    await h.emit("before_agent_start", { systemPrompt: ["Base"] }, ctx);

    expect(existsSync(path.join(cwd, ".omp-enhance", "state.sqlite"))).toBe(false);
  });

  test("protects live ownerPid checkpoints from second-process clobbering and preserves checkpoint across session_shutdown microtasks", async () => {
    const cwd = makeTempDir("p7-flow-crash");
    const globalDir = makeTempDir("p7-flow-global");
    const lockPath = path.join(makeTempDir("p7-flow-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "auto" } } }));

    expect(parseFlowOverlayInput("\t")).toEqual({ kind: "next_project" });
    expect(parseFlowOverlayInput("q")).toEqual({ kind: "escape" });

    const instance1ExecutedRoles: string[] = [];
    let qaReachedMidStage = false;
    let releaseCrashHang = null as (() => void) | null;

    const crashingRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        instance1ExecutedRoles.push(stepCtx.role.id);
        const stageId = stepCtx.stageId ?? stepCtx.role.id;
        if (stepCtx.role.id === "dev") {
          writeText(path.join(stepCtx.cwd, "src", "feature.ts"), "export const answer = 42;\n");
          const call: ObservedToolCall = {
            toolCallId: "dev-w1", toolName: "write", isError: false,
            touchedPaths: ["src/feature.ts"], timestamp: new Date().toISOString(), summary: "write src/feature.ts",
          };
          stepCtx.observer?.onToolEnd?.(stageId, call);
          const env = createAndVerifyHandoff({
            store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
            parentHandoffId: stepCtx.upstreamHandoff?.id ?? null, toTarget: stepCtx.toTarget,
            verdict: "ready", summary: "Implemented src/feature.ts", artifactPaths: ["src/feature.ts"], observedCalls: [call],
          });
          return { envelope: env, observedCalls: [call], assistantText: "Dev done", usage: null };
        }
        const partialCall: ObservedToolCall = {
          toolCallId: "qa-partial-1", toolName: "bash", isError: false,
          touchedPaths: [], timestamp: new Date().toISOString(), summary: 'bash "bun test --bail"',
        };
        stepCtx.observer?.onToolEnd?.(stageId, partialCall);
        qaReachedMidStage = true;
        await new Promise<void>((resolve) => { releaseCrashHang = resolve; });
        return { envelope: null, observedCalls: [partialCall], assistantText: "", usage: null, cancelledByUser: true };
      },
    };

    const h1 = createHarness({ cwd, globalDir, lockPath, runner: crashingRunner });
    const ctx1 = { cwd, hasUI: true, ui: { setWidget() {}, setStatus() {}, notify() {} } };
    await h1.emit("session_start", {}, ctx1);

    const started = JSON.parse((await h1.tools.get("enhance_flow")!.execute("f1", {
      roles: ["dev", "qa", "reviewer"], goal: "Ship resilient feature",
    }, null, null, ctx1)).content[0].text);
    expect(started.status).toBe("running");

    for (let i = 0; i < 40 && !qaReachedMidStage; i++) await Bun.sleep(5);
    expect(qaReachedMidStage).toBe(true);
    expect(instance1ExecutedRoles).toEqual(["dev", "qa"]);

    // While h1's process (process.pid + matching token) owns the running Flow, a second FlowRoomManager MUST NOT clobber SQLite!
    const concurrentStore = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    try {
      const concurrentRoom = new FlowRoomManager(undefined, concurrentStore);
      expect(concurrentRoom.getSnapshot().status).toBe("idle");
      expect(concurrentStore.getLatestFlowCheckpoint()?.status).toBe("running");
    } finally {
      concurrentStore.close();
    }

    // Now h1 shuts down AND background runFlowTask unwinds completely BEFORE h2 boots!
    await h1.emit("session_shutdown", {}, ctx1);
    releaseCrashHang?.();
    await Bun.sleep(20);

    const instance2ExecutedRoles: string[] = [];
    let qaReceivedUpstreamFrom = null as string | null;
    let qaReceivedArtifacts: string[] = [];

    const resumedRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        instance2ExecutedRoles.push(stepCtx.role.id);
        const stageId = stepCtx.stageId ?? stepCtx.role.id;
        if (stepCtx.role.id === "qa") {
          qaReceivedUpstreamFrom = stepCtx.upstreamHandoff?.fromRole ?? null;
          qaReceivedArtifacts = stepCtx.upstreamHandoff?.artifacts.map((a) => a.path) ?? [];
        }
        const toolName = stepCtx.role.id === "qa" ? "bash" : "read";
        const call: ObservedToolCall = {
          toolCallId: `${stepCtx.role.id}-ok`, toolName, isError: false,
          touchedPaths: [], timestamp: new Date().toISOString(), summary: `${toolName} src/feature.ts`,
        };
        stepCtx.observer?.onToolEnd?.(stageId, call);
        const env = createAndVerifyHandoff({
          store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
          parentHandoffId: stepCtx.upstreamHandoff?.id ?? null, toTarget: stepCtx.toTarget,
          verdict: "ready", summary: `${stepCtx.role.id} verified feature.ts`, observedCalls: [call],
        });
        return { envelope: env, observedCalls: [call], assistantText: `${stepCtx.role.id} ok`, usage: null };
      },
    };

    const statusBadges2: Array<string | undefined> = [];
    const h2 = createHarness({ cwd, globalDir, lockPath, runner: resumedRunner });
    const ctx2 = { cwd, hasUI: false, ui: { setStatus(_k: string, b?: string) { statusBadges2.push(b); } } };
    await h2.emit("session_start", {}, ctx2);

    // Default role is null ("off") with zero running flows -> status bar is hidden (undefined)!
    expect(statusBadges2.at(-1)).toBeUndefined();

    const hydrated = JSON.parse((await h2.tools.get("enhance_flow")!.execute("st", {
      action: "status",
    }, null, null, ctx2)).content[0].text);
    expect(hydrated.status).toBe("interrupted");
    expect(hydrated.resumable).toBe(true);
    expect(hydrated.currentIndex).toBe(1);
    expect(hydrated.entries.some((e: any) => e.speaker === "dev" && e.badge === "✓ ready")).toBe(true);
    expect(hydrated.entries.some((e: any) => e.speaker === "qa" && e.badge === "⏸ 中断")).toBe(true);

    const resumeOut = JSON.parse((await h2.tools.get("enhance_flow")!.execute("res-1", {
      action: "resume", wait: true,
    }, null, null, ctx2)).content[0].text);
    expect(resumeOut.status).toBe("completed");
    expect(instance2ExecutedRoles).toEqual(["qa", "reviewer"]);
    expect(qaReceivedUpstreamFrom).toBe("dev");
    expect(qaReceivedArtifacts).toEqual(["src/feature.ts"]);

    await h2.emit("session_shutdown", {}, ctx2);
  });

  test("preserves Round 0 bubbles when resuming at idx=0 / repairRound>=1 and blocks resuming boundary violations", async () => {
    const cwd = makeTempDir("p7-r1-resume");
    const globalDir = makeTempDir("p7-r1-global");
    const lockPath = path.join(makeTempDir("p7-r1-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "auto" } } }));

    let devAttempts = 0;
    let releaseCrash = null as (() => void) | null;
    let reachedRound1Dev = false;

    const r1CrashRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        const call: ObservedToolCall = {
          toolCallId: `tc-${stepCtx.role.id}-${devAttempts}`, toolName: "bash", isError: false,
          touchedPaths: [], timestamp: new Date().toISOString(), summary: "bash test",
        };
        if (stepCtx.role.id === "dev") {
          devAttempts += 1;
          if (devAttempts === 1) {
            const env = createAndVerifyHandoff({
              store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
              toTarget: stepCtx.toTarget, verdict: "ready", summary: "ROUND0_DEV_SUMMARY", observedCalls: [call],
            });
            return { envelope: env, observedCalls: [call], assistantText: "r0", usage: null };
          }
          reachedRound1Dev = true;
          await new Promise<void>((resolve) => { releaseCrash = resolve; });
          return { envelope: null, observedCalls: [], assistantText: "", usage: null, cancelledByUser: true };
        }
        // Round 0 qa rejects!
        const env = createAndVerifyHandoff({
          store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
          toTarget: stepCtx.toTarget, verdict: "rejected", summary: "QA_R0_REJECT",
          feedbackForUpstream: "SAME_REJECTION_REASON", observedCalls: [call],
        });
        return { envelope: env, observedCalls: [call], assistantText: "reject", usage: null };
      },
    };

    const h1 = createHarness({ cwd, globalDir, lockPath, runner: r1CrashRunner });
    const ctx1 = { cwd, hasUI: true, ui: { setWidget() {}, setStatus() {}, notify() {} } };
    await h1.tools.get("enhance_flow")!.execute("f-r1", { roles: ["dev", "qa"], goal: "Test Round 1 resume" }, null, null, ctx1);
    for (let i = 0; i < 40 && !reachedRound1Dev; i++) await Bun.sleep(5);
    expect(reachedRound1Dev).toBe(true);

    await h1.emit("session_shutdown", {}, ctx1);
    releaseCrash?.();
    await Bun.sleep(15);

    // Resume in h2 where qa repeats the exact same rejection -> lastRejectionSig persisted across resume triggers stagnation!
    const h2Runner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        const call: ObservedToolCall = {
          toolCallId: `h2-${stepCtx.role.id}`, toolName: "bash", isError: false,
          touchedPaths: [], timestamp: new Date().toISOString(), summary: "bash test",
        };
        if (stepCtx.role.id === "dev") {
          const env = createAndVerifyHandoff({
            store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
            toTarget: stepCtx.toTarget, verdict: "ready", summary: "ROUND1_DEV_SUMMARY", observedCalls: [call],
          });
          return { envelope: env, observedCalls: [call], assistantText: "r1", usage: null };
        }
        const env = createAndVerifyHandoff({
          store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
          toTarget: stepCtx.toTarget, verdict: "rejected", summary: "QA_R1_REJECT",
          feedbackForUpstream: "same_rejection_reason", observedCalls: [call],
        });
        return { envelope: env, observedCalls: [call], assistantText: "reject again", usage: null };
      },
    };

    const h2 = createHarness({ cwd, globalDir, lockPath, runner: h2Runner });
    const ctx2 = { cwd, hasUI: false };
    const out = JSON.parse((await h2.tools.get("enhance_flow")!.execute("res-r1", {
      action: "resume", wait: true,
    }, null, null, ctx2)).content[0].text);
    expect(out.status).toBe("stagnated");

    const snap = JSON.parse((await h2.tools.get("enhance_flow")!.execute("st", { action: "status" }, null, null, ctx2)).content[0].text);
    // Round 0's `ROUND0_DEV_SUMMARY` was NOT clobbered in place by Round 1's `ROUND1_DEV_SUMMARY`!
    expect(snap.entries.some((e: any) => e.text === "ROUND0_DEV_SUMMARY" && e.badge === "✓ ready")).toBe(true);
    expect(snap.entries.some((e: any) => e.text === "ROUND1_DEV_SUMMARY" && e.badge === "✓ ready")).toBe(true);
    expect(snap.entries.some((e: any) => e.badge === "⏸ 中断")).toBe(true);
    await h2.emit("session_shutdown", {}, ctx2);

    // Boundary violation Flow sets status="violation" and is NOT resumable!
    const cwdViol = makeTempDir("p7-viol");
    writeText(path.join(cwdViol, "src", "protected.ts"), "export const clean = 1;\n");
    const violRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        writeText(path.join(stepCtx.cwd, "src", "protected.ts"), "export const dirty = 2;\n");
        return { envelope: null, observedCalls: [], assistantText: "", usage: null };
      },
    };
    const hv = createHarness({ cwd: cwdViol, globalDir, lockPath, runner: violRunner });
    await hv.tools.get("enhance_flow")!.execute("f-viol", {
      action: "start", roles: ["qa"], goal: "Verify protected", wait: true,
    }, null, null, { cwd: cwdViol, hasUI: false });
    const violStatus = JSON.parse((await hv.tools.get("enhance_flow")!.execute("st-v", { action: "status" }, null, null, { cwd: cwdViol, hasUI: false })).content[0].text);
    expect(violStatus.status).toBe("violation");
    expect(violStatus.resumable).toBe(false);
    await hv.emit("session_shutdown", {}, { cwd: cwdViol, hasUI: false });
  });

  test("persists active /role & waiting_input checkpoint across omp --continue and falls back to defaultRole when newest custom role was deleted", async () => {
    const cwd = makeTempDir("p7-role-persist");
    const globalDir = makeTempDir("p7-role-global");
    const lockPath = path.join(makeTempDir("p7-role-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator" } } }));

    const sharedSessionBranch: any[] = [];
    const waitInputRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        const env = createAndVerifyHandoff({
          store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
          toTarget: stepCtx.toTarget, verdict: "needs_input", summary: "Confirm deployment region",
          questionsForUser: ["Deploy to us-east-1 or ap-northeast-1?"],
        });
        return { envelope: env, observedCalls: [], assistantText: "ask", usage: null };
      },
    };

    const h1 = createHarness({ cwd, globalDir, lockPath, runner: waitInputRunner, branchEntries: sharedSessionBranch });
    const ctx1 = {
      cwd, hasUI: false,
      sessionManager: { getSessionId: () => "sess-1", getBranch: () => sharedSessionBranch },
    };
    await h1.emit("session_start", {}, ctx1);
    await h1.tools.get("enhance_flow")!.execute("fw-1", { roles: ["planner"], goal: "Plan deploy", wait: true }, null, null, ctx1);
    await h1.commands.get("role")!.handler("off", ctx1);
    await h1.commands.get("role")!.handler("create temp-role --project Temporary custom role", ctx1);
    await h1.commands.get("role")!.handler("temp-role --foreground", ctx1);
    await h1.emit("session_shutdown", {}, ctx1);

    // Delete `temp-role` on disk -> resuming `sess-1` stops at newest entry (`temp-role`, missing) and falls back to `coordinator`, NOT older `off`!
    rmSync(path.join(cwd, ".omp", "roles", "temp-role.yaml"), { force: true });

    const h2 = createHarness({ cwd, globalDir, lockPath, branchEntries: sharedSessionBranch });
    const ctx2 = {
      cwd, hasUI: false,
      sessionManager: { getSessionId: () => "sess-1", getBranch: () => sharedSessionBranch },
    };
    await h2.emit("session_start", {}, ctx2);
    h2.sentMessages.length = 0;
    await h2.commands.get("coord")!.handler("status", ctx2);
    expect(h2.sentMessages.at(-1)!.content).toContain("总秘书运行中 (coordinator)");
    const hydratedWait = JSON.parse((await h2.tools.get("enhance_flow")!.execute("st-w", { action: "status" }, null, null, ctx2)).content[0].text);
    expect(hydratedWait.status).toBe("waiting_input");
    expect(hydratedWait.resumable).toBe(true);
    await h2.emit("session_shutdown", {}, ctx2);
  });

  test("preserves TurnTracker baseline and tool evidence across F5 (app.retry) after failed/aborted turn", async () => {
    const cwd = makeTempDir("p7-f5-retry");
    const globalDir = makeTempDir("p7-f5-global");
    const lockPath = path.join(makeTempDir("p7-f5-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "algo" } } }));

    const h = createHarness({ cwd, globalDir, lockPath });
    const ctx = { cwd, hasUI: false };
    await h.emit("session_start", {}, ctx);

    await h.emit("before_agent_start", { systemPrompt: ["Base"] }, ctx);
    writeText(path.join(cwd, "src", "bugfix.ts"), "export const fixed = true;\n");
    writeText(path.join(cwd, "algo_work", "REPORT.md"), "# F5 Retry Report\n");
    writeText(path.join(cwd, "algo_work", "runs", "r1", "metrics.json"), '{"score":0.99}\n');
    await h.emit("tool_execution_end", {
      toolCallId: "tc-write-1", toolName: "write", args: { path: "src/bugfix.ts" }, isError: false,
    }, ctx);

    await h.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "502 Bad Gateway" }],
    }, ctx);

    await h.emit("before_agent_start", { systemPrompt: ["Base"] }, ctx);

    const handoffRes = await h.tools.get("enhance_handoff")!.execute("ho-1", {
      verdict: "ready", summary: "Completed bugfix after F5 retry",
    }, null, null, ctx);
    expect(handoffRes.isError).toBeUndefined();
    const parsed = JSON.parse(handoffRes.content[0].text);
    expect(parsed.handoff.fromRole).toBe("algo");
    expect(parsed.handoff.artifacts.map((a: any) => a.path)).toContain("src/bugfix.ts");

    await h.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    }, ctx);

    await h.emit("before_agent_start", { systemPrompt: ["Base"] }, ctx);
    const turn2Res = await h.tools.get("enhance_handoff")!.execute("ho-2", {
      verdict: "ready", summary: "Unverified claim on Turn 2",
    }, null, null, ctx);
    expect(turn2Res.isError).toBe(true);
    expect(turn2Res.content[0].text).toContain("requires");

    await h.emit("session_shutdown", {}, ctx);
  });

  test("handles session_switch / session_branch / session_tree without __default__ bleed, avoids redundant setActiveTools in before_agent_start, and preserves manual /model switches", async () => {
    const cwd = makeTempDir("p7-lifecycle");
    const globalDir = makeTempDir("p7-lifecycle-global");
    const lockPath = path.join(makeTempDir("p7-lifecycle-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "coordinator" } } }));

    let setActiveToolsCalls = 0;
    let activeTools: string[] = [];
    let currentModel: any = { provider: "deepseek", id: "deepseek-flash" };
    let thinkingLevel = "max";
    let activeBranch: any[] = [];
    let currentSessionId = "sess-a";

    const handlers = new Map<string, Array<(ev: any, ctx: any) => any>>();
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const sentMessages: any[] = [];

    const pi: any = {
      cwd,
      on(ev: string, fn: (e: any, c: any) => any) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
      registerTool(t: any) { tools.set(t.name, t); },
      registerCommand(n: string, c: any) { commands.set(n, c); },
      registerMessageRenderer() {},
      getAllTools: () => ["read", "grep", "edit", "write", "bash", "task"].map((name) => ({ name })),
      async setActiveTools(names: string[]) { setActiveToolsCalls += 1; activeTools = names; },
      async setModel(m: any) { currentModel = m; },
      setThinkingLevel(lvl: string) { thinkingLevel = lvl; },
      getThinkingLevel: () => thinkingLevel,
      sendMessage(msg: any) { sentMessages.push(msg); },
      appendEntry(customType: string, data: unknown) {
        activeBranch.push({ id: `e-${activeBranch.length + 1}`, type: "custom", customType, data });
      },
      pi: { settings: {} },
    };

    ompEnhance(pi, { builtinRolesDir, globalRolesDir: globalDir, pluginLockPath: lockPath });

    const emit = async (name: string, ev: any, c: any) => {
      let last: any;
      for (const fn of handlers.get(name) ?? []) last = await fn(ev, c);
      return last;
    };

    const makeCtx = (sid: string, branchGetter: () => any[]) => ({
      cwd,
      hasUI: true,
      get model() { return currentModel; },
      models: {
        resolve: (spec: string) => (spec === "@vision" ? { provider: "openrouter", id: "qwen-vl", input: ["text", "image"] } : undefined),
        list: () => [],
      },
      sessionManager: { getSessionId: () => sid, getBranch: branchGetter },
      ui: { setStatus() {}, setWidget() {}, notify() {} },
    });

    const ctxA = makeCtx("sess-a", () => activeBranch);
    await emit("session_start", {}, ctxA);
    const callsAfterStart = setActiveToolsCalls;
    expect(callsAfterStart).toBe(1);

    // 1) before_agent_start when session & branch have NOT changed makes ZERO redundant setActiveTools calls!
    await emit("before_agent_start", { systemPrompt: ["Base"] }, ctxA);
    expect(setActiveToolsCalls).toBe(callsAfterStart);

    // 2) Switch to vision (--foreground) in sess-a; verify brand-new sess-c sees NO "__default__" bleed even before session_switch!
    await commands.get("role")!.handler("vision --foreground", ctxA);
    expect(currentModel).toMatchObject({ provider: "openrouter", id: "qwen-vl" });
    expect(thinkingLevel).toBe("low");

    const ctxUnseen = makeCtx("sess-unseen", () => []);
    sentMessages.length = 0;
    await commands.get("coord")!.handler("status", ctxUnseen);
    expect(sentMessages.at(-1)!.content).toContain("总秘书运行中 (coordinator)");
    expect(sentMessages.at(-1)!.excludeFromContext).toBe(true);

    // 3) User manually switches /model & thinking while in vision -> switching back to coordinator preserves user's manual choice!
    currentModel = { provider: "openai-codex", id: "gpt-6.1-sol" };
    thinkingLevel = "max";
    await commands.get("coord")!.handler("", ctxA);
    expect(currentModel).toMatchObject({ provider: "openai-codex", id: "gpt-6.1-sol" });
    expect(thinkingLevel).toBe("max");

    // 4) /tree navigation within the SAME sessionId ("sess-a") switches branches immediately via session_tree!
    const ancestorBranch: any[] = [];
    const qaBranch = [{ id: "qa-1", type: "custom", customType: "omp-enhance-role", data: { roleId: "qa" } }];
    activeBranch = qaBranch;
    await emit("session_tree", {}, ctxA);
    sentMessages.length = 0;
    await commands.get("coord")!.handler("status", ctxA);
    expect(sentMessages.at(-1)!.content).toContain("前台覆写角色 (qa)");
    const callsAfterTree = setActiveToolsCalls;
    await emit("before_agent_start", { systemPrompt: ["Base"] }, ctxA);
    expect(setActiveToolsCalls).toBe(callsAfterTree);

    activeBranch = ancestorBranch;
    await emit("session_tree", {}, ctxA);
    sentMessages.length = 0;
    await commands.get("coord")!.handler("status", ctxA);
    expect(sentMessages.at(-1)!.content).toContain("总秘书运行中 (coordinator)");

    // 5) session_switch (/new) to sess-b resets role/model/thinking immediately while idle!
    await commands.get("role")!.handler("vision --foreground", ctxA);
    expect(currentModel).toMatchObject({ provider: "openrouter", id: "qwen-vl" });
    currentSessionId = "sess-b";
    const ctxB = makeCtx(currentSessionId, () => []);
    await emit("session_switch", {}, ctxB);
    expect(currentModel).toMatchObject({ provider: "openai-codex", id: "gpt-6.1-sol" });
    expect(thinkingLevel).toBe("max");
    expect(activeTools).toContain("enhance_job");

    await emit("session_shutdown", {}, ctxB);
  });

  test("persists secondary project paths in ~/.omp/enhance/hub-projects.json across restarts without writing inside primaryCwd", async () => {
    const primaryCwd = makeTempDir("p7-hub-primary");
    const subCwd = makeTempDir("p7-hub-sub");
    const fakeHome = makeTempDir("p7-hub-home");
    const globalDir = path.join(fakeHome, ".omp", "enhance", "roles");
    const lockPath = path.join(makeTempDir("p7-hub-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "auto" } } }));

    const prevHome = process.env.OMP_ENHANCE_HOME;
    process.env.OMP_ENHANCE_HOME = fakeHome;
    try {
      const subRunner: RoleSessionRunner = {
        async runRoleTurn(stepCtx) {
          const env = createAndVerifyHandoff({
            store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
            toTarget: stepCtx.toTarget, verdict: "needs_input", summary: "Subproject awaiting API key",
            questionsForUser: ["Which sandbox API key should subproject use?"],
          });
          return { envelope: env, observedCalls: [], assistantText: "wait", usage: null };
        },
      };

      const h1 = createHarness({ cwd: primaryCwd, globalDir, lockPath, runner: subRunner });
      const ctx1 = { cwd: primaryCwd, hasUI: false };
      await h1.emit("session_start", {}, ctx1);
      const startedSub = JSON.parse((await h1.tools.get("enhance_flow")!.execute("f-sub", {
        cwd: subCwd, roles: ["planner"], goal: "Audit subproject", wait: true,
      }, null, null, ctx1)).content[0].text);
      expect(startedSub.status).toBe("waiting_input");
      await h1.emit("session_shutdown", {}, ctx1);

      // Zero files written inside primaryCwd!
      expect(readdirSync(primaryCwd)).toEqual([]);
      const hubProjectsFile = path.join(fakeHome, ".omp", "enhance", "hub-projects.json");
      expect(existsSync(hubProjectsFile)).toBe(true);
      const persistedMap = JSON.parse(readFileSync(hubProjectsFile, "utf8")) as Record<string, string[]>;
      expect(persistedMap[primaryCwd]).toEqual([subCwd]);

      // Reopen omp in primaryCwd -> /flow status & enhance_flow(list) automatically remember subCwd!
      const h2 = createHarness({ cwd: primaryCwd, globalDir, lockPath });
      const ctx2 = { cwd: primaryCwd, hasUI: false };
      await h2.emit("session_start", {}, ctx2);
      const listOut = JSON.parse((await h2.tools.get("enhance_flow")!.execute("fl-2", {
        action: "list",
      }, null, null, ctx2)).content[0].text);
      expect(listOut.flows.find((f: any) => f.cwd === subCwd)).toMatchObject({
        status: "waiting_input",
        resumable: true,
        goal: "Audit subproject",
      });
      await h2.commands.get("flow")!.handler("status", ctx2);
      expect(h2.sentMessages.at(-1)!.content).toContain(subCwd);
      expect(h2.sentMessages.at(-1)!.content).toContain("Audit subproject");
      await h2.emit("session_shutdown", {}, ctx2);
    } finally {
      if (prevHome === undefined) delete process.env.OMP_ENHANCE_HOME;
      else process.env.OMP_ENHANCE_HOME = prevHome;
    }
  });

  test("enforces cross-instance SQLite project_leases mutual exclusion, dead-owner lease recovery, and parallel execution on distinct projects (P1-2)", async () => {
    const cwdSame = makeTempDir("p7-lease-same");
    const cwdOther = makeTempDir("p7-lease-other");
    const globalDir = makeTempDir("p7-lease-global");
    const lockPath = path.join(makeTempDir("p7-lease-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "auto" } } }));

    let releaseFirst: (() => void) | null = null;
    let firstEntered = false;

    const gatedRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        const call: ObservedToolCall = {
          toolCallId: `lc-${path.basename(stepCtx.cwd)}`, toolName: "read", isError: false,
          touchedPaths: [], timestamp: new Date().toISOString(),
        };
        if (stepCtx.cwd === cwdSame && !firstEntered) {
          firstEntered = true;
          await new Promise<void>((r) => { releaseFirst = r; });
        }
        const env = createAndVerifyHandoff({
          store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
          toTarget: stepCtx.toTarget, verdict: "ready", summary: `Completed ${path.basename(stepCtx.cwd)}`, observedCalls: [call],
        });
        return { envelope: env, observedCalls: [call], assistantText: "ok", usage: null };
      },
    };

    const h1 = createHarness({ cwd: cwdSame, globalDir, lockPath, runner: gatedRunner });
    const h2 = createHarness({ cwd: cwdSame, globalDir, lockPath, runner: gatedRunner });
    const ctx1 = { cwd: cwdSame, hasUI: true, ui: { setWidget() {}, setStatus() {}, notify() {} } };
    const ctx2 = { cwd: cwdSame, hasUI: true, ui: { setWidget() {}, setStatus() {}, notify() {} } };

    // 1) h1 acquires lease on cwdSame -> h2 attempting start on cwdSame gets busy=true & 0 duplicate running rows!
    const s1 = JSON.parse((await h1.tools.get("enhance_flow")!.execute("l1", {
      roles: ["reviewer"], goal: "Owner 1 Flow",
    }, null, null, ctx1)).content[0].text);
    expect(s1.started).toBe(true);
    for (let i = 0; i < 20 && !firstEntered; i++) await Bun.sleep(5);

    const conflictRaw = await h2.tools.get("enhance_flow")!.execute("l2", {
      roles: ["reviewer"], goal: "Conflicting Owner 2 Flow",
    }, null, null, ctx2);
    expect(conflictRaw.isError).toBe(true);
    const conflictPayload = JSON.parse(conflictRaw.content[0].text);
    expect(conflictPayload).toMatchObject({ started: false, busy: true, cwd: cwdSame, activeFlowId: s1.flowId });

    // Meanwhile h2 CAN dispatch in parallel to a distinct project directory cwdOther!
    const parallelOther = JSON.parse((await h2.tools.get("enhance_flow")!.execute("l-other", {
      cwd: cwdOther, roles: ["reviewer"], goal: "Parallel Project Flow", wait: true,
    }, null, null, ctx2)).content[0].text);
    expect(parallelOther.status).toBe("completed");

    releaseFirst!();
    for (let i = 0; i < 30; i++) {
      const st = JSON.parse((await h1.tools.get("enhance_flow")!.execute("ls", { action: "status", flowId: s1.flowId }, null, null, ctx1)).content[0].text);
      if (st.status === "completed") break;
      await Bun.sleep(10);
    }

    // 2) Simulate dead owner PID holding a stale lease -> next start marks stale flow 'interrupted' and acquires lease once!
    const inspectStore = new EnhanceStore(path.join(cwdSame, ".omp-enhance", "state.sqlite"));
    try {
      expect(inspectStore.getProjectFlowLease()).toBeNull();
      const deadMandate = inspectStore.upsertMandate({ goal: "Dead owner flow", flowId: "flow-dead-owner" });
      inspectStore.saveFlowCheckpoint({
        flowId: "flow-dead-owner", mandateId: deadMandate.id, goal: deadMandate.goal, cwd: cwdSame,
        roleChain: ["reviewer"], status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null,
        maxRepairRounds: 2, snapshotJson: "{}", ownerPid: 999_999_991, ownerStartToken: "dead-token",
        updatedAt: new Date().toISOString(),
      });
      inspectStore.acquireProjectFlowLease("flow-dead-owner", 999_999_991, "dead-token");
    } finally {
      inspectStore.close();
    }

    const recoveredRun = JSON.parse((await h2.tools.get("enhance_flow")!.execute("l-rec", {
      roles: ["reviewer"], goal: "Recovered after dead PID", wait: true,
    }, null, null, ctx2)).content[0].text);
    expect(recoveredRun.status).toBe("completed");

    const verifyStore = new EnhanceStore(path.join(cwdSame, ".omp-enhance", "state.sqlite"));
    try {
      expect(verifyStore.getFlowCheckpoint("flow-dead-owner")?.status).toBe("interrupted");
      expect(verifyStore.getProjectFlowLease()).toBeNull();
    } finally {
      verifyStore.close();
    }

    await h1.emit("session_shutdown", {}, ctx1);
    await h2.emit("session_shutdown", {}, ctx2);
  });

  test("gates foreign target project .omp/* overrides behind target-scoped trust (/coord trust & /coord untrust) across restarts (P1-6)", async () => {
    const cwdA = makeTempDir("p7-trust-origin-a");
    const cwdB = makeTempDir("p7-trust-target-b");
    const cwdC = makeTempDir("p7-trust-target-c");
    const fakeHome = makeTempDir("p7-trust-home");
    const globalDir = path.join(fakeHome, ".omp", "enhance", "roles");
    const lockPath = path.join(makeTempDir("p7-trust-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "auto", flowMaxRepairRounds: 2 } } }));

    // Foreign projects B and C contain project-local .omp/roles/reviewer.yaml AND .omp/plugin-overrides.json
    for (const [dir, marker] of [[cwdB, "PROJECT_B_CUSTOM_REVIEWER"], [cwdC, "PROJECT_C_CUSTOM_REVIEWER"]] as const) {
      writeText(
        path.join(dir, ".omp", "roles", "reviewer.yaml"),
        [
          "id: reviewer",
          `name: ${marker}`,
          `description: ${marker}`,
          "stance: |",
          `  ${marker}_STANCE`,
          "method:",
          "  - Read files",
          "permissions:",
          "  tools: [read]",
          "  writable: []",
          '  protected: ["**"]',
          "exit:",
          "  require_tool_evidence: true",
        ].join("\n") + "\n",
      );
      writeText(
        path.join(dir, ".omp", "plugin-overrides.json"),
        JSON.stringify({ settings: { "omp-enhance": { flowMaxRepairRounds: 7 } } }),
      );
    }

    const prevHome = process.env.OMP_ENHANCE_HOME;
    process.env.OMP_ENHANCE_HOME = fakeHome;
    try {
      const seenRolePrompts: Array<{ cwd: string; prompt: string; source: string }> = [];
      const inspectRunner: RoleSessionRunner = {
        async runRoleTurn(stepCtx) {
          seenRolePrompts.push({ cwd: stepCtx.cwd, prompt: stepCtx.conditioningPrompt, source: stepCtx.role.source });
          const call: ObservedToolCall = { toolCallId: "tr-1", toolName: "read", isError: false, touchedPaths: [], timestamp: new Date().toISOString() };
          const env = createAndVerifyHandoff({
            store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
            toTarget: stepCtx.toTarget, verdict: "ready", summary: "ok", observedCalls: [call],
          });
          return { envelope: env, observedCalls: [call], assistantText: "ok", usage: null };
        },
      };

      // Host ctx has 0-arg `isProjectTrusted: () => true` (origin A is trusted, foreign B & C have NO host decision!)
      const h1 = createHarness({ cwd: cwdA, globalDir, lockPath, runner: inspectRunner });
      const ctxA = { cwd: cwdA, hasUI: false, isProjectTrusted: () => true };

      // 1) Before `/coord trust`, dispatching to cwdB MUST NOT inherit A's trust: B's .omp/roles & plugin-overrides are skipped!
      const untrustedResB = JSON.parse((await h1.tools.get("enhance_flow")!.execute("tb-1", {
        cwd: cwdB, roles: ["reviewer"], goal: "Audit untrusted B", wait: true,
      }, null, null, ctxA)).content[0].text);
      expect(untrustedResB.status).toBe("completed");
      expect(untrustedResB.trustNotice).toContain(".omp/roles/*.yaml");
      expect(seenRolePrompts[0]?.source).toBe("builtin");
      expect(seenRolePrompts[0]?.prompt).not.toContain("PROJECT_B_CUSTOM_REVIEWER_STANCE");
      const checkUntrustedStore = new EnhanceStore(path.join(cwdB, ".omp-enhance", "state.sqlite"));
      try { expect(checkUntrustedStore.getLatestFlowCheckpoint()?.maxRepairRounds).toBe(2); } finally { checkUntrustedStore.close(); }

      // 2) Explicitly trust cwdB via `/coord trust <cwdB>` -> ONLY cwdB overrides take effect; cwdC stays untrusted!
      await h1.commands.get("coord")!.handler(`trust ${cwdB}`, ctxA);
      expect(h1.sentMessages.at(-1)!.content).toContain(cwdB);
      expect(existsSync(path.join(fakeHome, ".omp", "enhance", "trusted-projects.json"))).toBe(true);

      const trustedResB = JSON.parse((await h1.tools.get("enhance_flow")!.execute("tb-2", {
        cwd: cwdB, roles: ["reviewer"], goal: "Audit trusted B", wait: true,
      }, null, null, ctxA)).content[0].text);
      expect(trustedResB.trustNotice).toBeUndefined();
      expect(seenRolePrompts[1]?.source).toBe("project");
      expect(seenRolePrompts[1]?.prompt).toContain("PROJECT_B_CUSTOM_REVIEWER_STANCE");
      const checkBStore = new EnhanceStore(path.join(cwdB, ".omp-enhance", "state.sqlite"));
      try { expect(checkBStore.getLatestFlowCheckpoint()?.maxRepairRounds).toBe(7); } finally { checkBStore.close(); }

      await h1.tools.get("enhance_flow")!.execute("tc-1", {
        cwd: cwdC, roles: ["reviewer"], goal: "Audit still-untrusted C", wait: true,
      }, null, null, ctxA);
      expect(seenRolePrompts[2]?.source).toBe("builtin");
      expect(seenRolePrompts[2]?.prompt).not.toContain("PROJECT_C_CUSTOM_REVIEWER_STANCE");
      await h1.emit("session_shutdown", {}, ctxA);

      // 3) Restart in h2 -> cwdB trust persists across restart; `/coord untrust <cwdB>` revokes it cleanly!
      const h2 = createHarness({ cwd: cwdA, globalDir, lockPath, runner: inspectRunner });
      await h2.tools.get("enhance_flow")!.execute("tb-3", {
        cwd: cwdB, roles: ["reviewer"], goal: "Audit B after restart", wait: true,
      }, null, null, ctxA);
      expect(seenRolePrompts[3]?.source).toBe("project");

      await h2.commands.get("coord")!.handler(`untrust ${cwdB}`, ctxA);
      await h2.tools.get("enhance_flow")!.execute("tb-4", {
        cwd: cwdB, roles: ["reviewer"], goal: "Audit B after untrust", wait: true,
      }, null, null, ctxA);
      expect(seenRolePrompts[4]?.source).toBe("builtin");
      expect(seenRolePrompts[4]?.prompt).not.toContain("PROJECT_B_CUSTOM_REVIEWER_STANCE");
      await h2.emit("session_shutdown", {}, ctxA);
    } finally {
      if (prevHome === undefined) delete process.env.OMP_ENHANCE_HOME;
      else process.env.OMP_ENHANCE_HOME = prevHome;
    }
  });

  test("pre-validates roleChain before entering running or acquiring lease on resume, preserving retryable checkpoint when a custom role was deleted (P2-3)", async () => {
    const cwd = makeTempDir("p7-resume-missing-role");
    const globalDir = makeTempDir("p7-resume-missing-global");
    const lockPath = path.join(makeTempDir("p7-resume-missing-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "auto" } } }));

    let stepCalls = 0;
    const customRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        stepCalls += 1;
        const call: ObservedToolCall = { toolCallId: `cr-${stepCalls}`, toolName: "read", isError: false, touchedPaths: [], timestamp: new Date().toISOString() };
        if (stepCtx.role.id === "ephemeral-spec" && stepCalls === 1) {
          const env = createAndVerifyHandoff({
            store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
            toTarget: stepCtx.toTarget, verdict: "needs_input", summary: "Confirm schema version",
            questionsForUser: ["Use schema v2?"], observedCalls: [call],
          });
          return { envelope: env, observedCalls: [call], assistantText: "wait", usage: null };
        }
        const env = createAndVerifyHandoff({
          store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
          parentHandoffId: stepCtx.upstreamHandoff?.id ?? null, toTarget: stepCtx.toTarget,
          verdict: "ready", summary: `${stepCtx.role.id} done`, observedCalls: [call],
        });
        return { envelope: env, observedCalls: [call], assistantText: "done", usage: null };
      },
    };

    const h = createHarness({ cwd, globalDir, lockPath, runner: customRunner });
    const ctx = { cwd, hasUI: false };
    await h.commands.get("role")!.handler("create ephemeral-spec --readonly Ephemeral specialist", ctx);
    const customYamlPath = path.join(globalDir, "ephemeral-spec.yaml");
    const savedYaml = readFileSync(customYamlPath, "utf8");

    const paused = JSON.parse((await h.tools.get("enhance_flow")!.execute("f-eph", {
      roles: ["ephemeral-spec", "reviewer"], goal: "Validate schema v2", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(paused.status).toBe("waiting_input");

    // Remove the custom role YAML and attempt resume -> diagnostic error, checkpoint stays waiting_input, lease stays null!
    rmSync(customYamlPath, { force: true });
    const failedResume = await h.tools.get("enhance_flow")!.execute("res-missing", {
      action: "resume", wait: true,
    }, null, null, ctx);
    expect(failedResume.isError).toBe(true);
    expect(JSON.parse(failedResume.content[0].text).error).toContain('Unknown role "ephemeral-spec"');

    const statusMid = JSON.parse((await h.tools.get("enhance_flow")!.execute("st-mid", { action: "status" }, null, null, ctx)).content[0].text);
    expect(statusMid.status).toBe("waiting_input");
    expect(statusMid.resumable).toBe(true);
    const checkStore = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    try {
      expect(checkStore.getLatestFlowCheckpoint()?.status).toBe("waiting_input");
      expect(checkStore.getProjectFlowLease()).toBeNull();
    } finally {
      checkStore.close();
    }

    // Restore the custom role YAML -> resume immediately succeeds from the preserved checkpoint!
    writeText(customYamlPath, savedYaml);
    const okResume = JSON.parse((await h.tools.get("enhance_flow")!.execute("res-restored", {
      action: "resume", message: "Yes, use schema v2", wait: true,
    }, null, null, ctx)).content[0].text);
    expect(okResume.status).toBe("completed");
    await h.emit("session_shutdown", {}, ctx);
  });
});
