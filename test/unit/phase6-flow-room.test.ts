import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EnhanceStore } from "../../src/core/store.ts";
import type { ObservedToolCall, RoomEntry } from "../../src/core/types.ts";
import ompEnhance from "../../src/entry.ts";
import { createAndVerifyHandoff } from "../../src/flow/handoff.ts";
import type { RoleSessionRunner } from "../../src/flow/orchestrator.ts";
import {
  parseFlowOverlayInput, renderChatBubbleLines, renderRoomCardLines, type FlowRoomSnapshot,
} from "../../src/ui/flow-room.ts";

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

describe("Left-Right Group Chat rendering & CJK alignment", () => {
  test("aligns Agent/Supervisor bubbles left and User ('你') bubbles right with exact display width", () => {
    const width = 56;
    const userEntry: RoomEntry = {
      id: "u1", side: "right", speaker: "你", badge: "目标", tone: "success",
      text: "帮我重构并验证 JWT 刷新逻辑", timestamp: new Date().toISOString(),
    };
    const agentEntry: RoomEntry = {
      id: "a1", side: "left", speaker: "dev", target: "qa", badge: "✓ ready", tone: "success",
      text: "已完成 src/auth.ts 令牌刷新与过期校验", timestamp: new Date().toISOString(),
    };

    const userLines = renderChatBubbleLines(userEntry, width);
    const agentLines = renderChatBubbleLines(agentEntry, width);

    for (const line of [...userLines, ...agentLines]) {
      expect(Bun.stringWidth(line)).toBe(width);
    }
    expect(userLines[0]!.startsWith("   ")).toBe(true);
    expect(userLines[0]!.trimEnd().endsWith("[目标] ◀ 你")).toBe(true);
    expect(userLines[1]!.endsWith("│")).toBe(true);
    expect(agentLines[0]!.startsWith("  ▶ [dev → @qa] ✓ ready")).toBe(true);
    expect(agentLines[1]!.startsWith("  │ 已完成 src/auth.ts")).toBe(true);
  });

  test("renders permanent room summary card in collapsed and Ctrl+O expanded modes", () => {
    const snap: FlowRoomSnapshot = {
      flowId: "flow-1",
      goal: "验证 JWT",
      roleChain: ["dev", "qa"],
      status: "completed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      activeStageId: null,
      entries: [
        { id: "u1", side: "right", speaker: "你", badge: "目标", text: "验证 JWT", timestamp: new Date().toISOString() },
        { id: "s1", side: "left", speaker: "dev", target: "qa", badge: "✓ ready", text: "改好了", timestamp: new Date().toISOString(), stageId: "st-1" },
      ],
      stages: [{
        stageId: "st-1", roleId: "dev", roleName: "Developer", round: 0, status: "ready",
        modelLabel: "anthropic/claude-sonnet", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        activeTool: null,
        calls: [
          { toolCallId: "c1", toolName: "read", isError: false, touchedPaths: [], timestamp: new Date().toISOString(), summary: "read src/auth.ts" },
          { toolCallId: "c2", toolName: "edit", isError: false, touchedPaths: ["src/auth.ts"], timestamp: new Date().toISOString(), summary: "edit src/auth.ts" },
        ],
        assistantText: "已完成修改", envelope: null, notes: [],
      }],
    };

    const collapsed = renderRoomCardLines(snap, 72, false);
    const expanded = renderRoomCardLines(snap, 72, true);
    for (const line of [...collapsed, ...expanded]) {
      expect(Bun.stringWidth(line)).toBe(72);
    }
    expect(collapsed.join("\n")).not.toContain("1. ✓ read src/auth.ts");
    expect(expanded.join("\n")).toContain("🔎 Agent 动作轨迹");
    expect(expanded.join("\n")).toContain("1. ✓ read src/auth.ts");
    expect(expanded.join("\n")).toContain("2. ✓ edit src/auth.ts");
  });
});

describe("Dual-Flow routing modes, live widget, mid-flight steer, and @role input", () => {
  function setupHarness(initialSettings: Record<string, unknown>, runner: RoleSessionRunner) {
    const cwd = makeTempDir("room-ws");
    const globalDir = makeTempDir("room-global");
    const lockPath = path.join(cwd, "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": initialSettings } }));

    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const renderers = new Map<string, any>();
    const sentMessages: any[] = [];

    const pi = {
      cwd,
      on(ev: string, fn: (...args: any[]) => any) {
        const list = handlers.get(ev) ?? [];
        list.push(fn);
        handlers.set(ev, list);
      },
      registerTool(spec: any) { tools.set(spec.name, spec); },
      registerCommand(name: string, spec: any) { commands.set(name, spec); },
      registerMessageRenderer(type: string, fn: any) { renderers.set(type, fn); },
      sendMessage(msg: any) { sentMessages.push(msg); },
      getAllTools: () => [{ name: "read" }, { name: "edit" }, { name: "bash" }],
      async setActiveTools() {},
      pi: { settings: {} },
    };

    ompEnhance(pi, {
      globalRolesDir: globalDir,
      builtinRolesDir,
      pluginLockPath: lockPath,
      runnerFactory: () => runner,
    });

    return { cwd, lockPath, handlers, tools, commands, renderers, sentMessages };
  }

  test("enforces flowRoutingMode (including headless manual mode) without premature SQLite Mandate writes", async () => {
    let runCount = 0;
    const fastRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        runCount += 1;
        const call: ObservedToolCall = {
          toolCallId: `c-${runCount}`, toolName: "read", isError: false,
          touchedPaths: [], timestamp: new Date().toISOString(), summary: "read README.md",
        };
        const envelope = createAndVerifyHandoff({
          store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
          parentHandoffId: stepCtx.upstreamHandoff?.id ?? null, toTarget: stepCtx.toTarget,
          verdict: "ready", summary: `${stepCtx.role.id} done`, observedCalls: [call],
        });
        return { envelope, observedCalls: [call], assistantText: "ok", usage: null };
      },
    };

    const { cwd, lockPath, tools } = setupHarness({ flowRoutingMode: "manual" }, fastRunner);
    const flowTool = tools.get("enhance_flow")!;
    let confirmCalls = 0;
    let confirmAnswer = false;
    const ctx = {
      cwd, hasUI: true,
      ui: {
        async confirm() { confirmCalls += 1; return confirmAnswer; },
        setWidget() {},
        setStatus() {},
        notify() {},
      },
    };

    // 1. manual mode -> blocks in both UI and headless (hasUI: false) without creating state.sqlite!
    const manualRes = JSON.parse((await flowTool.execute("t1", { roles: ["dev", "qa"], goal: " Refactor auth " }, null, null, ctx)).content[0].text);
    expect(manualRes).toMatchObject({ started: false, blockedByRoutingMode: "manual" });
    const headlessManual = JSON.parse((await flowTool.execute("t1b", { roles: ["dev", "qa"], goal: "Headless auth" }, null, null, { cwd, hasUI: false })).content[0].text);
    expect(headlessManual).toMatchObject({ started: false, blockedByRoutingMode: "manual" });
    expect(existsSync(path.join(cwd, ".omp-enhance", "state.sqlite"))).toBe(false);
    expect(confirmCalls).toBe(0);
    expect(runCount).toBe(0);

    // 2. ask mode (declined) -> calls confirm and returns declined without creating/archiving Mandate in SQLite!
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "ask" } } }));
    confirmAnswer = false;
    const declinedRes = JSON.parse((await flowTool.execute("t2", { roles: ["dev", "qa"], goal: "Refactor auth" }, null, null, ctx)).content[0].text);
    expect(confirmCalls).toBe(1);
    expect(declinedRes).toMatchObject({ started: false, declined: true });
    expect(existsSync(path.join(cwd, ".omp-enhance", "state.sqlite"))).toBe(false);
    expect(runCount).toBe(0);

    // 3. ask mode (accepted, wait: true) -> runs flow to completion & marks flow mandate completed
    confirmAnswer = true;
    const acceptedRes = JSON.parse((await flowTool.execute("t3", { roles: ["dev", "qa"], goal: "Refactor auth", wait: true }, null, null, ctx)).content[0].text);
    expect(confirmCalls).toBe(2);
    expect(acceptedRes.status).toBe("completed");
    expect(runCount).toBe(2);
    const verifyStore = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    try {
      expect(verifyStore.getActiveMandate()).toBeNull();
    } finally {
      verifyStore.close();
    }

    // 4. auto mode -> runs without prompting confirm
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "auto" } } }));
    const autoRes = JSON.parse((await flowTool.execute("t4", { roles: ["dev"], goal: "Quick fix", wait: true }, null, null, ctx)).content[0].text);
    expect(confirmCalls).toBe(2);
    expect(autoRes.status).toBe("completed");
    expect(runCount).toBe(3);
  });

  test("delivers live steer, propagates steers & directed @role steers downstream, and posts summary card", async () => {
    let releaseDev = null as (() => void) | null;
    const steeredMessages: string[] = [];
    let qaConditioningPrompt = "";

    const gatedRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        const stageId = stepCtx.stageId ?? stepCtx.role.id;
        stepCtx.observer?.bindControls?.({
          steer: async (m) => { steeredMessages.push(`${stepCtx.role.id}:${m}`); },
          abort: async () => { releaseDev?.(); },
        }, stageId);
        if (stepCtx.role.id === "dev") {
          writeText(path.join(stepCtx.cwd, "src", "auth.ts"), "export const jwt = true;\n");
          stepCtx.observer?.onToolStart?.(stageId, "edit src/auth.ts");
          await new Promise<void>((resolve) => { releaseDev = resolve; });
          const call: ObservedToolCall = {
            toolCallId: "dev-1", toolName: "edit", isError: false,
            touchedPaths: ["src/auth.ts"], timestamp: new Date().toISOString(), summary: "edit src/auth.ts",
          };
          stepCtx.observer?.onToolEnd?.(stageId, call);
          const env = createAndVerifyHandoff({
            store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
            parentHandoffId: stepCtx.upstreamHandoff?.id ?? null, toTarget: stepCtx.toTarget,
            verdict: "ready", summary: "保留旧表并完成 JWT 刷新", artifactPaths: ["src/auth.ts"], observedCalls: [call],
          });
          stepCtx.observer?.bindControls?.(null, stageId);
          return { envelope: env, observedCalls: [call], assistantText: "JWT ready", usage: null };
        }
        qaConditioningPrompt = stepCtx.conditioningPrompt;
        const qaCall: ObservedToolCall = {
          toolCallId: "qa-1", toolName: "bash", isError: false,
          touchedPaths: [], timestamp: new Date().toISOString(), summary: 'bash "bun test"',
        };
        stepCtx.observer?.onToolEnd?.(stageId, qaCall);
        const env = createAndVerifyHandoff({
          store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
          parentHandoffId: stepCtx.upstreamHandoff?.id ?? null, toTarget: stepCtx.toTarget,
          verdict: "ready", summary: "14 个并发测试全部通过", observedCalls: [qaCall],
        });
        stepCtx.observer?.bindControls?.(null, stageId);
        return { envelope: env, observedCalls: [qaCall], assistantText: "QA passed", usage: null };
      },
    };

    const { cwd, tools, renderers, sentMessages } = setupHarness({ flowRoutingMode: "auto" }, gatedRunner);
    const flowTool = tools.get("enhance_flow")!;
    let activeWidgetFactory = null as any;
    const statusBadges: Array<string | undefined> = [];

    const ctx = {
      cwd, hasUI: true,
      ui: {
        setWidget(_key: string, factory: any) { activeWidgetFactory = factory; },
        setStatus(_key: string, badge?: string) { statusBadges.push(badge); },
        notify() {},
      },
    };

    const started = JSON.parse((await flowTool.execute("bg1", {
      roles: ["dev", "qa"], goal: "重构 JWT 刷新逻辑",
    }, null, null, ctx)).content[0].text);
    expect(started).toMatchObject({
      started: true, background: true, status: "running", roleChain: ["dev", "qa"],
    });
    expect(statusBadges.at(-1)).toContain("flow:dev→qa");

    for (let i = 0; i < 20 && !releaseDev; i++) await Bun.sleep(5);
    expect(activeWidgetFactory).not.toBeNull();

    const widgetComp = activeWidgetFactory({ requestRender() {} }, {});
    const widgetLines: string[] = widgetComp.render(76);
    for (const line of widgetLines) expect(Bun.stringWidth(line)).toBe(76);
    expect(widgetLines.join("\n")).toContain("◀ 你");
    expect(widgetLines.join("\n")).toContain("edit src/auth.ts");

    // 1) General steer goes immediately to dev AND propagates downstream to qa!
    const steerRes = JSON.parse((await flowTool.execute("sr1", {
      action: "steer", message: "别动旧 RefreshToken 表",
    }, null, null, ctx)).content[0].text);
    expect(steerRes.delivered).toBe(true);
    expect(steeredMessages).toEqual(["dev:别动旧 RefreshToken 表"]);

    // 2) Directed `[@qa]` steer while dev runs queues for qa WITHOUT distracting dev!
    const directedRes = JSON.parse((await flowTool.execute("sr2", {
      action: "steer", message: "[@qa] 重点压测过期边界",
    }, null, null, ctx)).content[0].text);
    expect(directedRes.delivered).toBe(false);
    expect(directedRes.queuedForRole).toBe("qa");
    expect(steeredMessages).toEqual(["dev:别动旧 RefreshToken 表"]);

    releaseDev!();
    for (let i = 0; i < 40 && sentMessages.length === 0; i++) await Bun.sleep(10);

    // Downstream qa received BOTH the general steer AND its queued [@qa] steer in conditioning!
    expect(qaConditioningPrompt).toContain("## User Interjections");
    expect(qaConditioningPrompt).toContain("别动旧 RefreshToken 表");
    expect(qaConditioningPrompt).toContain("[@qa] 重点压测过期边界");

    expect(activeWidgetFactory).toBeUndefined();
    expect(sentMessages.length).toBe(1);
    const cardMsg = sentMessages[0]!;
    expect(cardMsg.customType).toBe("omp-enhance-room");
    const snap = cardMsg.details as FlowRoomSnapshot;
    expect(snap.status).toBe("completed");
    expect(snap.entries.map((e) => `${e.side}:${e.speaker}:${e.badge}`)).toEqual([
      "right:你:目标",
      "right:你:插话",
      "right:你:@qa",
      "left:dev:✓ ready",
      "left:qa:✓ ready",
    ]);

    const renderer = renderers.get("omp-enhance-room")!;
    const renderedExpanded: string[] = renderer(cardMsg, { expanded: true }, {}).render(78);
    expect(renderedExpanded.join("\n")).toContain("edit src/auth.ts");
    expect(renderedExpanded.join("\n")).toContain('bash "bun test"');
  });

  test("drives split-pane /flow overlay: ↑↓ inspector, [@role] bracket typing, Alt+[/] scroll, Ctrl+X cancel, and multiline @role input", async () => {
    let releaseStage = null as (() => void) | null;
    let aborted = false;
    const steered: string[] = [];

    const slowRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        const stageId = stepCtx.stageId ?? stepCtx.role.id;
        const c1: ObservedToolCall = {
          toolCallId: "t1", toolName: "read", isError: false,
          touchedPaths: [], timestamp: new Date().toISOString(), summary: "read src/index.ts",
        };
        stepCtx.observer?.onToolEnd?.(stageId, c1);
        stepCtx.observer?.bindControls?.({
          steer: async (m) => { steered.push(m); },
          abort: async () => { aborted = true; releaseStage?.(); },
        }, stageId);
        await new Promise<void>((resolve) => { releaseStage = resolve; });
        return {
          envelope: null, observedCalls: [c1], assistantText: "", usage: null,
          ...(aborted ? { cancelledByUser: true } : {}),
        };
      },
    };

    const { cwd, handlers, commands } = setupHarness({ flowRoutingMode: "auto" }, slowRunner);

    // Verify multiline @<roleId> <task> preservation vs @file pass-through!
    const inputFn = handlers.get("input")![0]!;
    expect(inputFn({ text: "@qa 跑一下鉴权测试\n- 空串\n- 过期" }, { cwd })).toEqual({
      text: "/flow qa 跑一下鉴权测试\n- 空串\n- 过期",
    });
    expect(inputFn({ text: "@src/auth.ts 解释一下这段代码" }, { cwd })).toBeUndefined();
    expect(inputFn({ text: "@supervisor 检查" }, { cwd })).toBeUndefined();

    // Verify Kitty CSI-u, literal `[` / `]` typing when draft is empty, and Alt+[/] / PgUp scrolling!
    expect(parseFlowOverlayInput("\x1b[120;5u")).toEqual({ kind: "cancel_flow" });
    expect(parseFlowOverlayInput("\x1b[27::27;1:1u")).toEqual({ kind: "escape" });
    expect(parseFlowOverlayInput("[", undefined, false)).toEqual({ kind: "text", text: "[" });
    expect(parseFlowOverlayInput("]", undefined, false)).toEqual({ kind: "text", text: "]" });
    expect(parseFlowOverlayInput("\x1b[", undefined, false)).toEqual({ kind: "scroll_up" });
    expect(parseFlowOverlayInput("\x1b]", undefined, false)).toEqual({ kind: "scroll_down" });
    expect(parseFlowOverlayInput("\x1b[5~", undefined, false)).toEqual({ kind: "scroll_up" });
    expect(parseFlowOverlayInput("\x1b[200~请加单飞锁\x1b[201~")).toEqual({ kind: "text", text: "请加单飞锁" });

    let capturedComp = null as any;
    const ctx = {
      cwd, hasUI: true,
      ui: {
        setWidget() {},
        setStatus() {},
        notify() {},
        async custom(factory: any) {
          await new Promise<void>((resolve) => {
            capturedComp = factory({ requestRender() {} }, {}, null, () => resolve());
          });
        },
      },
    };

    await commands.get("flow")!.handler("dev,qa 修复并发锁", ctx);
    for (let i = 0; i < 20 && !releaseStage; i++) await Bun.sleep(5);

    const overlayPromise = commands.get("flow")!.handler("", ctx);
    await Bun.sleep(5);
    expect(capturedComp).not.toBeNull();
    expect(capturedComp.capturesInput()).toBe(true);

    const initialFrame: string[] = capturedComp.render(92);
    for (const line of initialFrame) expect(Bun.stringWidth(line)).toBe(92);
    expect(initialFrame.join("\n")).toContain("1. ✓ read src/index.ts");

    capturedComp.handleInput("\x1b[A");
    expect(capturedComp.render(92).join("\n")).toContain("发言者: 你 (目标)");
    capturedComp.handleInput("\x1b[B");
    expect(capturedComp.render(92).join("\n")).toContain("Agent: dev");

    // Typing `[@dev]` at empty draft works without swallowing `[`!
    capturedComp.handleInput("[");
    capturedComp.handleInput("@dev] ");
    capturedComp.handleInput("\x1b[200~加单飞锁X\x1b[201~");
    capturedComp.handleInput("\x1b[127;1:1u");
    expect(capturedComp.render(92).join("\n")).toContain("💬 你: [@dev] 加单飞锁█");
    capturedComp.handleInput("\x1b[13;1:1u");
    await Bun.sleep(10);
    expect(steered).toEqual(["加单飞锁"]);
    expect(capturedComp.render(92).join("\n")).toContain("你插话: 加单飞锁");

    capturedComp.handleInput("temp");
    capturedComp.handleInput("\x1b[27;1:1u");
    capturedComp.handleInput("\x1b[120;5u");
    await Bun.sleep(15);
    expect(aborted).toBe(true);
    expect(capturedComp.render(92).join("\n")).toContain("⏹ 已取消");

    capturedComp.handleInput("\x1b[27;1:1u");
    await overlayPromise;
  });

  test("applies defaultRole on session_start, steers @role mid-flow, queues followUp when foreground streams, and keeps /role ANSI-safe", async () => {
    let releaseRun = null as (() => void) | null;
    const activeToolSets: string[][] = [];
    const sentCalls: Array<{ msg: any; opts: any }> = [];

    const cwd = makeTempDir("audit-ws");
    const globalDir = makeTempDir("audit-global");
    const lockPath = path.join(cwd, "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "reviewer", flowRoutingMode: "auto" } } }));

    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const commands = new Map<string, any>();
    const pi = {
      cwd,
      on(ev: string, fn: (...args: any[]) => any) {
        const list = handlers.get(ev) ?? []; list.push(fn); handlers.set(ev, list);
      },
      registerTool() {},
      registerCommand(name: string, spec: any) { commands.set(name, spec); },
      registerMessageRenderer() {},
      sendMessage(msg: any, opts: any) { sentCalls.push({ msg, opts }); },
      getAllTools: () => [{ name: "read" }, { name: "grep" }, { name: "write" }, { name: "edit" }, { name: "bash" }],
      async setActiveTools(names: string[]) { activeToolSets.push(names); },
      pi: { settings: {} },
    };

    const runner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        await new Promise<void>((resolve) => { releaseRun = resolve; });
        const call: ObservedToolCall = {
          toolCallId: "r1", toolName: "read", isError: false,
          touchedPaths: [], timestamp: new Date().toISOString(), summary: "read README.md",
        };
        const env = createAndVerifyHandoff({
          store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
          parentHandoffId: null, toTarget: "user", verdict: "ready", summary: "ok", observedCalls: [call],
        });
        return { envelope: env, observedCalls: [call], assistantText: "ok", usage: null };
      },
    };

    ompEnhance(pi, { globalRolesDir: globalDir, builtinRolesDir, pluginLockPath: lockPath, runnerFactory: () => runner });

    await handlers.get("session_start")![0]!({}, { cwd, ui: { setStatus() {} } });
    expect(activeToolSets.length).toBe(1);
    expect(activeToolSets[0]).toContain("read");
    expect(activeToolSets[0]).not.toContain("write");
    expect(activeToolSets[0]).not.toContain("enhance_job");

    const ctx = {
      cwd, hasUI: true,
      isIdle: () => false,
      ui: {
        setWidget() {}, setStatus() {}, notify() {},
        async custom(factory: any) {
          const ansiTheme = {
            fg: (_c: string, s: string) => `\x1b[38;2;80;160;255m${s}\x1b[39m`,
            bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
          };
          await new Promise<void>((resolve) => {
            const comp = factory({ requestRender() {} }, ansiTheme, null, () => resolve());
            const lines: string[] = comp.render(64);
            for (const line of lines) {
              expect(Bun.stringWidth(line)).toBe(64);
              const opens = (line.match(/\x1b\[38;2;/g) ?? []).length;
              const closes = (line.match(/\x1b\[39m/g) ?? []).length;
              expect(opens).toBe(closes);
            }
            comp.handleInput("\x1b[27;1:1u");
          });
        },
      },
    };

    await commands.get("role")!.handler("", ctx);
    await commands.get("flow")!.handler("dev 实现缓存层", ctx);
    for (let i = 0; i < 20 && !releaseRun; i++) await Bun.sleep(5);

    const inputFn = handlers.get("input")![0]!;
    expect(inputFn({ text: "@dev 记得加 LRU 上限" }, ctx)).toEqual({
      text: "/flow steer [@dev] 记得加 LRU 上限",
    });

    releaseRun!();
    for (let i = 0; i < 30 && sentCalls.length === 0; i++) await Bun.sleep(10);
    expect(sentCalls[0]?.msg.customType).toBe("omp-enhance-room");
    expect(sentCalls[0]?.opts).toEqual({ triggerTurn: false, deliverAs: "followUp" });

    expect(inputFn({ text: "@qa 验证 LRU 淘汰" }, ctx)).toEqual({
      text: "/flow qa 验证 LRU 淘汰",
    });
  });

  test("supports algo mid-turn visual consultation to vision (@vision) with stacked controls & verifiedFacts", async () => {
    const cwd = makeTempDir("algo-vis-ws");
    const globalDir = makeTempDir("algo-vis-global");
    const lockPath = path.join(cwd, "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "auto", supervisorEnabled: false } } }));

    const tools = new Map<string, any>();
    const sentMessages: any[] = [];
    const createdModels: unknown[] = [];

    const pi = {
      cwd,
      on() {},
      registerTool(spec: any) { tools.set(spec.name, spec); },
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage(msg: any) { sentMessages.push(msg); },
      getAllTools: () => [{ name: "read" }, { name: "glob" }, { name: "write" }, { name: "bash" }],
      async setActiveTools() {},
      pi: {
        settings: {},
        async createAgentSession(opts: any) {
          createdModels.push(opts.model);
          const handoffTool = opts.customTools[0];
          const guardHandlers = new Map<string, Array<(ev: any) => any>>();
          const factories = opts.restrictToolNames
            ? (opts.preloadedPreparedExtensions ?? []).map((e: any) => e.factory)
            : (opts.extensions ?? []);
          for (const ext of factories) {
            ext({ on(ev: string, fn: (ev: any) => any) { guardHandlers.set(ev, [...(guardHandlers.get(ev) ?? []), fn]); } });
          }
          const emitEnd = (toolCallId: string, toolName: string, args: unknown) => {
            for (const fn of guardHandlers.get("tool_execution_end") ?? []) fn({ toolCallId, toolName, args, isError: false });
          };
          const isVision = String(opts.customSystemPrompt).includes("Active Role: vision");
          return {
            session: {
              messages: [{ role: "assistant", usage: { input: 30, output: 15, cost: { total: 0.0005 } } }],
              async prompt() {
                if (isVision) {
                  emitEnd("vis-read-1", "read", { path: "artifacts/vis/badcases.png" });
                  await handoffTool.execute("vh-1", {
                    verdict: "ready",
                    summary: "样本 #3/#7 真值框偏移，其余 10 例集中在高频突变区滞后",
                    verifiedFacts: [{ claim: "样本 #3/#7 真值偏移", evidenceRef: "vis-read-1" }],
                  });
                  return;
                }
                writeText(path.join(cwd, "artifacts", "vis", "badcases.png"), "PNG_BYTES");
                emitEnd("algo-plot-1", "bash", { command: "python plot_badcases.py" });
                const consultRes = await handoffTool.execute("ah-consult", {
                  verdict: "ready",
                  toTarget: "vision",
                  delegateNow: true,
                  artifactPaths: ["artifacts/vis/badcases.png"],
                  summary: "请核查 artifacts/vis/badcases.png 中的 Top-12 误差样本规律",
                });
                const parsedConsult = JSON.parse(consultRes.content[0].text);
                expect(parsedConsult.delegated.ok).toBe(true);
                expect(parsedConsult.delegated.envelope.summary).toContain("样本 #3/#7 真值框偏移");

                emitEnd("algo-opt-2", "bash", { command: "python eval_v1.py" });
                await handoffTool.execute("ah-final", {
                  verdict: "ready",
                  summary: "依据视觉诊断修正边缘滞后与剔除脏标后，MAE 较基线降低 32%",
                  artifactPaths: ["artifacts/vis/badcases.png"],
                });
              },
              getLastAssistantText: () => "done",
              getLastAssistantMessage: () => ({ role: "assistant", stopReason: "stop", usage: { input: 30, output: 15, cost: { total: 0.0005 } } }),
              async dispose() {},
            },
          };
        },
      },
    };

    ompEnhance(pi, { globalRolesDir: globalDir, builtinRolesDir, pluginLockPath: lockPath });

    const ctx = {
      cwd,
      hasUI: true,
      model: { provider: "deepseek", id: "deepseek-r1" },
      models: {
        resolve: (spec: string) => (spec === "@vision" ? { provider: "openrouter", id: "qwen/qwen3.8-flash" } : undefined),
        list: () => [],
      },
      ui: { setWidget() {}, setStatus() {}, notify() {} },
    };

    const res = JSON.parse((await tools.get("enhance_flow")!.execute("f1", {
      roles: ["algo"], goal: "优化传感器真值回归算法", wait: true,
    }, null, null, ctx)).content[0].text);

    expect(res.status).toBe("completed");
    expect(res.finalEnvelope.observedUsage).toEqual({ inputTokens: 30, outputTokens: 15, costUsd: 0.0005 });
    expect(createdModels).toEqual([
      { provider: "deepseek", id: "deepseek-r1" },
      { provider: "openrouter", id: "qwen/qwen3.8-flash" },
    ]);
    const snap = sentMessages[0]!.details as FlowRoomSnapshot;
    expect(snap.entries.map((e) => `${e.side}:${e.speaker}:${e.badge}`)).toEqual([
      "right:你:目标",
      "left:vision:✓ ready",
      "left:algo:✓ ready",
    ]);
  });

  test("injects adaptive RuntimeVision hints (suppressing vision self-delegation) and algo_work/ 4-gate rules", async () => {
    const cwd = makeTempDir("algo-spec-ws");
    const globalDir = makeTempDir("algo-spec-global");
    const lockPath = path.join(cwd, "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "algo", flowRoutingMode: "auto", supervisorEnabled: false } } }));

    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
    const childSystemPrompts: string[] = [];

    const pi = {
      cwd,
      on(ev: string, fn: (...args: any[]) => any) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
      registerTool(spec: any) { tools.set(spec.name, spec); },
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      getAllTools: () => [{ name: "read" }, { name: "bash" }],
      async setActiveTools() {},
      pi: {
        settings: {},
        async createAgentSession(opts: any) {
          childSystemPrompts.push(String(opts.customSystemPrompt));
          const handoffTool = opts.customTools[0];
          const guardHandlers = new Map<string, Array<(ev: any) => any>>();
          const factories = opts.restrictToolNames
            ? (opts.preloadedPreparedExtensions ?? []).map((e: any) => e.factory)
            : (opts.extensions ?? []);
          for (const ext of factories) {
            ext({ on(ev: string, fn: (ev: any) => any) { guardHandlers.set(ev, [...(guardHandlers.get(ev) ?? []), fn]); } });
          }
          return {
            session: {
              messages: [],
              async prompt() {
                for (const fn of guardHandlers.get("tool_execution_end") ?? []) {
                  fn({ toolCallId: "c1", toolName: "read", args: { path: "README.md" }, isError: false });
                }
                await handoffTool.execute("h1", { verdict: "blocked", summary: "no vision model" });
              },
              getLastAssistantText: () => "ok",
              getLastAssistantMessage: () => null,
              async dispose() {},
            },
          };
        },
      },
    };

    ompEnhance(pi, { globalRolesDir: globalDir, builtinRolesDir, pluginLockPath: lockPath });

    const beforeStart = handlers.get("before_agent_start")![0]!;
    const multiPrompt = ((await beforeStart({ systemPrompt: [] }, {
      cwd, model: { provider: "deepseek", id: "deepseek-flash", input: ["text", "image"] }, ui: { setStatus() {} },
    })) as { systemPrompt: string[] }).systemPrompt.join("\n");
    expect(multiPrompt).toContain("RuntimeVision: native-multimodal");
    expect(multiPrompt).toContain("algo_work/REPORT.md");

    const textOnlyPrompt = ((await beforeStart({ systemPrompt: [] }, {
      cwd, model: { provider: "deepseek", id: "deepseek-reasoner", input: ["text"] }, ui: { setStatus() {} },
    })) as { systemPrompt: string[] }).systemPrompt.join("\n");
    expect(textOnlyPrompt).toContain("RuntimeVision: text-only");
    expect(textOnlyPrompt).toContain('toTarget="vision", delegateNow=true');

    // Vision role itself on a text-only fallback does NOT instruct self-delegation to "vision"!
    await tools.get("enhance_flow")!.execute("f-vis-text", { roles: ["vision"], goal: "Inspect plot", wait: true }, null, null, {
      cwd, hasUI: false, model: { provider: "deepseek", id: "deepseek-reasoner", input: ["text"] }, models: { resolve: () => undefined, list: () => [] },
    });
    expect(childSystemPrompts[0]).toContain("do NOT self-delegate");
  });
});
