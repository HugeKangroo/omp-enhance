import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ompEnhance from "../../src/entry.ts";
import { createAndVerifyHandoff } from "../../src/handoff.ts";
import { parseFlowOverlayInput } from "../../src/flow-room.ts";
import type { RoleSessionRunner } from "../../src/orchestrator.ts";
import type { ObservedToolCall } from "../../src/types.ts";

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

  test("persists mid-Flow checkpoints across hard process crash and resumes from unfinished stage without re-running completed stages", async () => {
    const cwd = makeTempDir("p7-flow-crash");
    const globalDir = makeTempDir("p7-flow-global");
    const lockPath = path.join(makeTempDir("p7-flow-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "auto" } } }));

    expect(parseFlowOverlayInput("\x12")).toEqual({ kind: "resume_flow" });

    const instance1ExecutedRoles: string[] = [];
    let qaReachedMidStage = false;
    let releaseCrashHang = null as (() => void) | null;

    // Instance 1: dev succeeds, qa runs 1 tool call and then hangs as if the process died mid-turn
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
        // qa starts, logs 1 tool call to SQLite checkpoint, then process dies before qa finishes!
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

    // Kick off 3-stage flow in background: dev -> qa -> reviewer
    const started = JSON.parse((await h1.tools.get("enhance_flow")!.execute("f1", {
      roles: ["dev", "qa", "reviewer"], goal: "Ship resilient feature",
    }, null, null, ctx1)).content[0].text);
    expect(started.status).toBe("running");

    for (let i = 0; i < 40 && !qaReachedMidStage; i++) await Bun.sleep(5);
    expect(qaReachedMidStage).toBe(true);
    expect(instance1ExecutedRoles).toEqual(["dev", "qa"]);

    // Simulate abrupt process exit: close DB without letting executeRoleFlow call finishFlow!
    await h1.emit("session_shutdown", {}, ctx1);
    releaseCrashHang?.();

    // Instance 2: fresh process boots on same cwd (simulating `omp --continue`)
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

    // Status bar immediately warns that an interrupted Flow can be resumed
    expect(statusBadges2.at(-1)).toContain("flow:paused");

    // Inspect hydrated room state before resuming
    const hydrated = JSON.parse((await h2.tools.get("enhance_flow")!.execute("st", {
      action: "status",
    }, null, null, ctx2)).content[0].text);
    expect(hydrated.status).toBe("interrupted");
    expect(hydrated.resumable).toBe(true);
    expect(hydrated.currentIndex).toBe(1);
    expect(hydrated.entries.some((e: any) => e.speaker === "dev" && e.badge === "✓ ready")).toBe(true);
    expect(hydrated.entries.some((e: any) => e.speaker === "qa" && e.badge === "⏸ 中断")).toBe(true);
    expect(hydrated.stages.find((s: any) => s.roleId === "qa")?.calls).toHaveLength(1);

    // Resume via `/flow continue`!
    h2.sentMessages.length = 0;
    await h2.commands.get("flow")!.handler("continue", ctx2);
    const resumeOut = JSON.parse(h2.sentMessages.at(-1)!.content);
    expect(resumeOut.status).toBe("completed");

    // CRITICAL: `dev` was NOT re-executed; execution resumed cleanly at `qa` (idx=1) -> `reviewer` (idx=2)!
    expect(instance2ExecutedRoles).toEqual(["qa", "reviewer"]);
    expect(qaReceivedUpstreamFrom).toBe("dev");
    expect(qaReceivedArtifacts).toEqual(["src/feature.ts"]);

    // Final room snapshot retains both historical `⏸ 中断` bubble, `你 [续跑]` bubble, and completed `qa` + `reviewer` bubbles
    const afterResume = JSON.parse((await h2.tools.get("enhance_flow")!.execute("st2", {
      action: "status",
    }, null, null, ctx2)).content[0].text);
    expect(afterResume.status).toBe("completed");
    expect(afterResume.resumable).toBe(false);
    expect(afterResume.entries.some((e: any) => e.badge === "⏸ 中断")).toBe(true);
    expect(afterResume.entries.some((e: any) => e.speaker === "你" && e.badge === "续跑")).toBe(true);
    expect(afterResume.entries.some((e: any) => e.speaker === "reviewer" && e.badge === "✓ ready")).toBe(true);

    await h2.emit("session_shutdown", {}, ctx2);
  });

  test("persists active /role across omp --continue and /resume via session custom entries", async () => {
    const cwd = makeTempDir("p7-role-persist");
    const globalDir = makeTempDir("p7-role-global");
    const lockPath = path.join(makeTempDir("p7-role-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "general" } } }));

    const sharedSessionBranch: any[] = [];

    // Session 1: User switches from general -> algo
    const h1 = createHarness({ cwd, globalDir, lockPath, branchEntries: sharedSessionBranch });
    const ctx1 = {
      cwd, hasUI: false,
      sessionManager: { getSessionId: () => "sess-1", getBranch: () => sharedSessionBranch },
    };
    await h1.emit("session_start", {}, ctx1);
    await h1.commands.get("role")!.handler("algo", ctx1);
    expect(sharedSessionBranch).toContainEqual({
      type: "custom", customType: "omp-enhance-role", data: { roleId: "algo" },
    });
    await h1.emit("session_shutdown", {}, ctx1);

    // Session 1 resumed via `omp --continue` in a brand-new process
    const h2 = createHarness({ cwd, globalDir, lockPath, branchEntries: sharedSessionBranch });
    const ctx2 = {
      cwd, hasUI: false,
      model: { provider: "openai", id: "gpt-4.1", input: ["text", "image"] },
      sessionManager: { getSessionId: () => "sess-1", getBranch: () => sharedSessionBranch },
    };
    await h2.emit("session_start", {}, ctx2);

    h2.sentMessages.length = 0;
    await h2.commands.get("enhance-status")!.handler("", ctx2);
    expect(JSON.parse(h2.sentMessages.at(-1)!.content).activeRoleId).toBe("algo");

    const promptRes = await h2.emit("before_agent_start", { systemPrompt: ["Base"] }, ctx2);
    expect(promptRes.systemPrompt[1]).toContain("## Active Role: algo");

    // User switches to `/role off` -> persisted and respected on next restart
    await h2.commands.get("role")!.handler("off", ctx2);
    await h2.emit("session_shutdown", {}, ctx2);

    const h3 = createHarness({ cwd, globalDir, lockPath, branchEntries: sharedSessionBranch });
    const ctx3 = {
      cwd, hasUI: false,
      sessionManager: { getSessionId: () => "sess-1", getBranch: () => sharedSessionBranch },
    };
    await h3.emit("session_start", {}, ctx3);
    h3.sentMessages.length = 0;
    await h3.commands.get("enhance-status")!.handler("", ctx3);
    expect(JSON.parse(h3.sentMessages.at(-1)!.content).activeRoleId).toBeNull();

    // Switching to another clean session via `/resume` falls back to defaultRole ("general")
    const ctxOtherSession = {
      cwd, hasUI: false,
      sessionManager: { getSessionId: () => "sess-fresh-2", getBranch: () => [] },
    };
    await h3.emit("session_start", {}, ctxOtherSession);
    h3.sentMessages.length = 0;
    await h3.commands.get("enhance-status")!.handler("", ctxOtherSession);
    expect(JSON.parse(h3.sentMessages.at(-1)!.content).activeRoleId).toBe("general");
    await h3.emit("session_shutdown", {}, ctxOtherSession);
  });

  test("preserves TurnTracker baseline and tool evidence across F5 (app.retry) after failed/aborted turn", async () => {
    const cwd = makeTempDir("p7-f5-retry");
    const globalDir = makeTempDir("p7-f5-global");
    const lockPath = path.join(makeTempDir("p7-f5-lock"), "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "algo" } } }));

    const h = createHarness({ cwd, globalDir, lockPath });
    const ctx = { cwd, hasUI: false };
    await h.emit("session_start", {}, ctx);

    // Turn 1 starts: workspace is clean, Agent writes `src/bugfix.ts`, then network fails mid-turn
    await h.emit("before_agent_start", { systemPrompt: ["Base"] }, ctx);
    writeText(path.join(cwd, "src", "bugfix.ts"), "export const fixed = true;\n");
    await h.emit("tool_execution_end", {
      toolCallId: "tc-write-1", toolName: "write", args: { path: "src/bugfix.ts" }, isError: false,
    }, ctx);

    // Assistant turn terminates with stopReason === "error"
    await h.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "502 Bad Gateway" }],
    }, ctx);

    // User presses F5 (`app.retry`) -> `before_agent_start` fires again on the workspace where `src/bugfix.ts` already exists!
    await h.emit("before_agent_start", { systemPrompt: ["Base"] }, ctx);

    // Retried turn immediately calls `enhance_handoff` (`algo` requires tool evidence!) without repeating the write
    const handoffRes = await h.tools.get("enhance_handoff")!.execute("ho-1", {
      verdict: "ready", summary: "Completed bugfix after F5 retry",
    }, null, null, ctx);
    expect(handoffRes.isError).toBeUndefined();
    const parsed = JSON.parse(handoffRes.content[0].text);
    expect(parsed.handoff.fromRole).toBe("algo");
    expect(parsed.handoff.artifacts.map((a: any) => a.path)).toContain("src/bugfix.ts");

    // Turn finishes cleanly with stopReason === "stop"
    await h.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    }, ctx);

    // Next fresh turn resets TurnTracker cleanly (`algo` calling enhance_handoff with zero tools in Turn 2 is now rejected)
    await h.emit("before_agent_start", { systemPrompt: ["Base"] }, ctx);
    const turn2Res = await h.tools.get("enhance_handoff")!.execute("ho-2", {
      verdict: "ready", summary: "Unverified claim on Turn 2",
    }, null, null, ctx);
    expect(turn2Res.isError).toBe(true);
    expect(turn2Res.content[0].text).toContain("requires");

    await h.emit("session_shutdown", {}, ctx);
  });
});
