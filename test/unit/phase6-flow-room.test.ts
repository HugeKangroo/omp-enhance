import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ompEnhance from "../../src/entry.ts";
import { createAndVerifyHandoff } from "../../src/handoff.ts";
import {
  parseFlowOverlayInput, renderChatBubbleLines, renderRoomCardLines, type FlowRoomSnapshot,
} from "../../src/flow-room.ts";
import type { RoleSessionRunner } from "../../src/orchestrator.ts";
import type { ObservedToolCall, RoomEntry } from "../../src/types.ts";

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
    // User bubble sits on the right (starts with spaces, ends with "◀ 你" / "│")
    expect(userLines[0]!.startsWith("   ")).toBe(true);
    expect(userLines[0]!.trimEnd().endsWith("[目标] ◀ 你")).toBe(true);
    expect(userLines[1]!.endsWith("│")).toBe(true);

    // Agent bubble sits on the left ("  ▶ [dev → @qa] ✓ ready")
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

  test("enforces flowRoutingMode: manual blocks auto-dispatch, ask confirms, auto dispatches directly", async () => {
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

    // 1. manual mode -> blocks foreground auto-dispatch without calling confirm
    const manualRes = JSON.parse((await flowTool.execute("t1", { roles: ["dev", "qa"], goal: " Refactor auth " }, null, null, ctx)).content[0].text);
    expect(manualRes.started).toBe(false);
    expect(manualRes.blockedByRoutingMode).toBe("manual");
    expect(confirmCalls).toBe(0);
    expect(runCount).toBe(0);

    // 2. ask mode (declined) -> calls confirm and returns declined without running
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "ask" } } }));
    confirmAnswer = false;
    const declinedRes = JSON.parse((await flowTool.execute("t2", { roles: ["dev", "qa"], goal: "Refactor auth" }, null, null, ctx)).content[0].text);
    expect(confirmCalls).toBe(1);
    expect(declinedRes).toMatchObject({ started: false, declined: true });
    expect(runCount).toBe(0);

    // 3. ask mode (accepted, wait: true) -> runs flow to completion
    confirmAnswer = true;
    const acceptedRes = JSON.parse((await flowTool.execute("t3", { roles: ["dev", "qa"], goal: "Refactor auth", wait: true }, null, null, ctx)).content[0].text);
    expect(confirmCalls).toBe(2);
    expect(acceptedRes.status).toBe("completed");
    expect(runCount).toBe(2);

    // 4. auto mode -> runs without prompting confirm
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "auto" } } }));
    const autoRes = JSON.parse((await flowTool.execute("t4", { roles: ["dev"], goal: "Quick fix", wait: true }, null, null, ctx)).content[0].text);
    expect(confirmCalls).toBe(2);
    expect(autoRes.status).toBe("completed");
    expect(runCount).toBe(3);
  });

  test("runs non-blocking background Flow, updates live widget, delivers mid-flight steer, and posts summary card", async () => {
    let releaseDev = null as (() => void) | null;
    const steeredMessages: string[] = [];

    const gatedRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        const stageId = stepCtx.stageId ?? stepCtx.role.id;
        stepCtx.observer?.bindControls?.({
          steer: async (m) => { steeredMessages.push(`${stepCtx.role.id}:${m}`); },
          abort: async () => { releaseDev?.(); },
        });
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
          stepCtx.observer?.bindControls?.(null);
          return { envelope: env, observedCalls: [call], assistantText: "JWT ready", usage: null };
        }
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
        stepCtx.observer?.bindControls?.(null);
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

    // Start non-blocking background flow!
    const started = JSON.parse((await flowTool.execute("bg1", {
      roles: ["dev", "qa"], goal: "重构 JWT 刷新逻辑",
    }, null, null, ctx)).content[0].text);
    expect(started).toMatchObject({
      started: true, background: true, status: "running", roleChain: ["dev", "qa"],
    });
    expect(statusBadges.at(-1)).toContain("flow:dev→qa");

    // Wait a tick for dev stage to reach its gate
    for (let i = 0; i < 20 && !releaseDev; i++) await Bun.sleep(5);
    expect(activeWidgetFactory).not.toBeNull();

    // Render live Form B aboveEditor widget while running
    const widgetComp = activeWidgetFactory({ requestRender() {} }, {});
    const widgetLines: string[] = widgetComp.render(76);
    for (const line of widgetLines) expect(Bun.stringWidth(line)).toBe(76);
    expect(widgetLines.join("\n")).toContain("◀ 你");
    expect(widgetLines.join("\n")).toContain("edit src/auth.ts");

    // Query status & send live steer mid-flight!
    const midStatus = JSON.parse((await flowTool.execute("st1", { action: "status" }, null, null, ctx)).content[0].text);
    expect(midStatus.status).toBe("running");

    const steerRes = JSON.parse((await flowTool.execute("sr1", {
      action: "steer", message: "别动旧 RefreshToken 表",
    }, null, null, ctx)).content[0].text);
    expect(steerRes.delivered).toBe(true);
    expect(steeredMessages).toEqual(["dev:别动旧 RefreshToken 表"]);

    // Let dev finish -> qa runs -> flow finishes asynchronously
    releaseDev!();
    for (let i = 0; i < 40 && sentMessages.length === 0; i++) await Bun.sleep(10);

    // Live widget cleared & permanent custom card posted!
    expect(activeWidgetFactory).toBeUndefined();
    expect(sentMessages.length).toBe(1);
    const cardMsg = sentMessages[0]!;
    expect(cardMsg.customType).toBe("omp-enhance-room");
    const snap = cardMsg.details as FlowRoomSnapshot;
    expect(snap.status).toBe("completed");
    // Chronological order: [目标] 你 -> [插话] 你 -> [dev] -> [qa]
    expect(snap.entries.map((e) => `${e.side}:${e.speaker}:${e.badge}`)).toEqual([
      "right:你:目标",
      "right:你:插话",
      "left:dev:✓ ready",
      "left:qa:✓ ready",
    ]);

    // Verify registered custom message renderer supports both collapsed & Ctrl+O expanded!
    const renderer = renderers.get("omp-enhance-room")!;
    const renderedExpanded: string[] = renderer(cardMsg, { expanded: true }, {}).render(78);
    expect(renderedExpanded.join("\n")).toContain("edit src/auth.ts");
    expect(renderedExpanded.join("\n")).toContain('bash "bun test"');
  });

  test("drives split-pane /flow overlay: ↑↓ inspector, Chinese/paste steer, [/] scroll, Ctrl+X cancel, and @role input", async () => {
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
        });
        await new Promise<void>((resolve) => { releaseStage = resolve; });
        return {
          envelope: null, observedCalls: [c1], assistantText: "", usage: null,
          ...(aborted ? { cancelledByUser: true } : {}),
        };
      },
    };

    const { cwd, handlers, commands } = setupHarness({ flowRoutingMode: "auto" }, slowRunner);

    // Verify @<roleId> <task> input rewrite vs @file pass-through!
    const inputFn = handlers.get("input")![0]!;
    expect(inputFn({ text: "@qa 跑一下鉴权模块的边界测试" }, { cwd })).toEqual({
      text: "/flow qa 跑一下鉴权模块的边界测试",
    });
    expect(inputFn({ text: "@src/auth.ts 解释一下这段代码" }, { cwd })).toBeUndefined();
    expect(inputFn({ text: "@README.md 总结" }, { cwd })).toBeUndefined();
    expect(inputFn({ text: "@supervisor 检查" }, { cwd })).toBeUndefined();
    expect(inputFn({ text: "@qa" }, { cwd })).toBeUndefined();

    // Verify Kitty CSI-u & paste parser directly
    expect(parseFlowOverlayInput("\x1b[120;5u")).toEqual({ kind: "cancel_flow" });
    expect(parseFlowOverlayInput("\x1b[27;1:1u")).toEqual({ kind: "escape" });
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

    // Start /flow dev,qa in background
    await commands.get("flow")!.handler("dev,qa 修复并发锁", ctx);
    for (let i = 0; i < 20 && !releaseStage; i++) await Bun.sleep(5);

    // Open bare /flow split-pane overlay while flow is running!
    const overlayPromise = commands.get("flow")!.handler("", ctx);
    await Bun.sleep(5);
    expect(capturedComp).not.toBeNull();
    expect(capturedComp.capturesInput()).toBe(true);

    // Render initial split-pane view (cursor on running dev bubble -> right pane shows read src/index.ts!)
    const initialFrame: string[] = capturedComp.render(92);
    for (const line of initialFrame) expect(Bun.stringWidth(line)).toBe(92);
    expect(initialFrame.join("\n")).toContain("1. ✓ read src/index.ts");

    // Press ↑ (up) to inspect user's initial bubble on the right pane, then ↓ back to dev
    capturedComp.handleInput("\x1b[A");
    expect(capturedComp.render(92).join("\n")).toContain("发言者: 你 (目标)");
    capturedComp.handleInput("\x1b[B");
    expect(capturedComp.render(92).join("\n")).toContain("Agent: dev");

    // Paste Chinese text + Backspace + type + Enter -> steers running dev role!
    capturedComp.handleInput("\x1b[200~加单飞锁X\x1b[201~");
    capturedComp.handleInput("\x1b[127;1:1u"); // Kitty Backspace removes 'X'
    expect(capturedComp.render(92).join("\n")).toContain("💬 你: 加单飞锁█");
    capturedComp.handleInput("\x1b[13;1:1u"); // Kitty Enter submits steer!
    await Bun.sleep(10);
    expect(steered).toEqual(["加单飞锁"]);
    expect(capturedComp.render(92).join("\n")).toContain("你插话: 加单飞锁");

    // Type draft then press Esc once -> clears draft without closing; press Ctrl+X -> cancels flow; press Esc -> closes!
    capturedComp.handleInput("temp");
    capturedComp.handleInput("\x1b[27;1:1u"); // clears "temp"
    capturedComp.handleInput("\x1b[120;5u");  // Kitty Ctrl+X cancels active flow!
    await Bun.sleep(15);
    expect(aborted).toBe(true);
    expect(capturedComp.render(92).join("\n")).toContain("⏹ 已取消");

    capturedComp.handleInput("\x1b[27;1:1u"); // closes overlay!
    await overlayPromise;
  });

  test("applies defaultRole on session_start, steers @role mid-flow, queues followUp when foreground streams, and keeps /role ANSI-safe", async () => {
    let releaseRun = null as (() => void) | null;
    const activeToolSets: string[][] = [];
    const sentCalls: Array<{ msg: any; opts: any }> = [];

    const cwd = makeTempDir("audit-ws");
    const globalDir = makeTempDir("audit-global");
    const lockPath = path.join(cwd, "omp-plugins.lock.json");
    // Configure defaultRole = "reviewer" (restricted read-only tools!)
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

    // 1) session_start immediately applies defaultRole="reviewer" tool restrictions (no write/edit)!
    await handlers.get("session_start")![0]!({}, { cwd, ui: { setStatus() {} } });
    expect(activeToolSets.length).toBe(1);
    expect(activeToolSets[0]).toContain("read");
    expect(activeToolSets[0]).not.toContain("write");
    expect(activeToolSets[0]).not.toContain("edit");

    // 2) While flow is running, @dev <msg> rewrites to /flow steer [@dev] <msg> instead of colliding!
    // Also simulate foreground agent streaming (isIdle() === false) so summary card queues as followUp!
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
              // Every ESC[1m or ESC[38;2...m must have its closing reset intact (never sliced mid-ANSI!)
              const opens = (line.match(/\x1b\[38;2;/g) ?? []).length;
              const closes = (line.match(/\x1b\[39m/g) ?? []).length;
              expect(opens).toBe(closes);
            }
            comp.handleInput("\x1b[27;1:1u");
          });
        },
      },
    };

    // Check /role ANSI safety & exact border width at narrow 64 cols
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

    // Once flow finishes, @qa <task> returns to launching a new 1-role flow!
    expect(inputFn({ text: "@qa 验证 LRU 淘汰" }, ctx)).toEqual({
      text: "/flow qa 验证 LRU 淘汰",
    });
  });
});
