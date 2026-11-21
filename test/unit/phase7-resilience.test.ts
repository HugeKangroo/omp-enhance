import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    expect(parseFlowOverlayInput("\x12")).toEqual({ kind: "resume_flow" });

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
        const call: ObservedToolCall = {
          toolCallId: `${stepCtx.role.id}-ok`, toolName: "read", isError: false,
          touchedPaths: [], timestamp: new Date().toISOString(), summary: "read src/feature.ts",
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

    expect(statusBadges2.at(-1)).toContain("flow:paused");

    const hydrated = JSON.parse((await h2.tools.get("enhance_flow")!.execute("st", {
      action: "status",
    }, null, null, ctx2)).content[0].text);
    expect(hydrated.status).toBe("interrupted");
    expect(hydrated.resumable).toBe(true);
    expect(hydrated.currentIndex).toBe(1);
    expect(hydrated.entries.some((e: any) => e.speaker === "dev" && e.badge === "✓ ready")).toBe(true);
    expect(hydrated.entries.some((e: any) => e.speaker === "qa" && e.badge === "⏸ 中断")).toBe(true);

    h2.sentMessages.length = 0;
    await h2.commands.get("flow")!.handler("continue", ctx2);
    const resumeOut = JSON.parse(h2.sentMessages.at(-1)!.content);
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
    await h2.commands.get("flow")!.handler("continue", ctx2);
    const out = JSON.parse(h2.sentMessages.at(-1)!.content);
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
    await hv.commands.get("flow")!.handler("qa Verify protected", { cwd: cwdViol, hasUI: false });
    const violStatus = JSON.parse((await hv.tools.get("enhance_flow")!.execute("st-v", { action: "status" }, null, null, { cwd: cwdViol, hasUI: false })).content[0].text);
    expect(violStatus.status).toBe("violation");
    expect(violStatus.resumable).toBe(false);
    await hv.emit("session_shutdown", {}, { cwd: cwdViol, hasUI: false });
  });

  test("persists active /role across omp --continue and falls back to defaultRole when newest custom role was deleted", async () => {
    const cwd = makeTempDir("p7-role-persist");
    const globalDir = makeTempDir("p7-role-global");
    const lockPath = path.join(makeTempDir("p7-role-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "general" } } }));

    const sharedSessionBranch: any[] = [];

    const h1 = createHarness({ cwd, globalDir, lockPath, branchEntries: sharedSessionBranch });
    const ctx1 = {
      cwd, hasUI: false,
      sessionManager: { getSessionId: () => "sess-1", getBranch: () => sharedSessionBranch },
    };
    await h1.emit("session_start", {}, ctx1);
    await h1.commands.get("role")!.handler("off", ctx1);
    await h1.commands.get("role")!.handler("create temp-role --project Temporary custom role", ctx1);
    await h1.commands.get("role")!.handler("temp-role", ctx1);
    await h1.emit("session_shutdown", {}, ctx1);

    // Delete `temp-role` on disk -> resuming `sess-1` stops at newest entry (`temp-role`, missing) and falls back to `general`, NOT older `off`!
    rmSync(path.join(cwd, ".omp", "roles", "temp-role.yaml"), { force: true });

    const h2 = createHarness({ cwd, globalDir, lockPath, branchEntries: sharedSessionBranch });
    const ctx2 = {
      cwd, hasUI: false,
      sessionManager: { getSessionId: () => "sess-1", getBranch: () => sharedSessionBranch },
    };
    await h2.emit("session_start", {}, ctx2);
    h2.sentMessages.length = 0;
    await h2.commands.get("enhance-status")!.handler("", ctx2);
    expect(JSON.parse(h2.sentMessages.at(-1)!.content).activeRoleId).toBe("general");
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
});
