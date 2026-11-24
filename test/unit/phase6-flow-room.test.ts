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
  flowStatusIcon, openFlowRoomOverlay, parseFlowOverlayInput, renderChatBubbleLines,
  renderMultiProjectWidgetLines, renderRoomCardLines, FlowRoomManager, type FlowRoomSnapshot,
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
    expect(expanded.join("\n")).toContain("🔎 专员动作轨迹");
    expect(expanded.join("\n")).toContain("1. ✓ read src/auth.ts");
    expect(expanded.join("\n")).toContain("2. ✓ edit src/auth.ts");

    // High-3: read-only audit flow (status=completed + finalEnvelope.verdict=rejected) renders "✓ 审查完成（发现阻断项）" & "[inspected]"!
    const auditSnap: FlowRoomSnapshot = {
      ...snap,
      roleChain: ["reviewer"],
      stages: [{
        ...snap.stages[0]!,
        roleId: "reviewer",
        status: "rejected",
        envelope: {
          id: "h-audit", mandateId: "m-1", mandateRev: 1, parentHandoffId: null,
          fromRole: "reviewer", toTarget: "user", verdict: "rejected",
          summary: "Found null dereference", feedbackForUpstream: "Line 12 dereferences null",
          artifacts: [{ path: "src/auth.ts", sha256: "1234567890abcdef", byteSize: 42, role: "inspected" }],
          verifiedFacts: [], openRisks: [], observedUsage: null, createdAt: new Date().toISOString(),
        },
      }],
    };
    const auditExpanded = renderRoomCardLines(auditSnap, 84, true).join("\n");
    expect(auditExpanded).toContain("✓ 审查完成（发现阻断项）");
    expect(auditExpanded).toContain("src/auth.ts#12345678 [inspected]");
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
        const toolName = stepCtx.role.id === "qa" ? "bash" : "read";
        const call: ObservedToolCall = {
          toolCallId: `c-${runCount}`, toolName, isError: false,
          touchedPaths: [], timestamp: new Date().toISOString(), summary: `${toolName} check`,
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
    expect(widgetLines.join("\n")).toContain("后台专员动态 (1 个项目活跃");
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
    for (let i = 0; i < 40 && !sentMessages.some((m) => m.customType === "omp-enhance-flow-event"); i++) await Bun.sleep(10);

    // Downstream qa received BOTH the general steer AND its queued [@qa] steer in conditioning!
    expect(qaConditioningPrompt).toContain("## User Interjections");
    expect(qaConditioningPrompt).toContain("别动旧 RefreshToken 表");
    expect(qaConditioningPrompt).toContain("[@qa] 重点压测过期边界");

    expect(activeWidgetFactory).toBeUndefined();
    const cardMsg = sentMessages.find((m) => m.customType === "omp-enhance-room")!;
    expect(cardMsg).toBeDefined();
    expect(cardMsg.excludeFromContext).toBe(true);
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

  test("runs concurrent multi-project Flows (cwdA & cwdB), drives read-only /flow monitor switcher, pauses on needs_input, wakes coordinator with triggerTurn: true, and resumes with user answer", async () => {
    const cwdA = makeTempDir("hub-proj-a");
    const cwdB = makeTempDir("hub-proj-b");
    const globalDir = makeTempDir("hub-global");
    const lockPath = path.join(cwdA, "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "auto" } } }));

    let releaseA = null as (() => void) | null;
    let abortedA = false;
    let bTurnCount = 0;
    let bResumedPrompt = "";

    const hubRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        const stageId = stepCtx.stageId ?? stepCtx.role.id;
        const call: ObservedToolCall = {
          toolCallId: `tc-${path.basename(stepCtx.cwd)}-${bTurnCount}`, toolName: "read", isError: false,
          touchedPaths: [], timestamp: new Date().toISOString(), summary: "read src/index.ts",
        };
        stepCtx.observer?.onToolEnd?.(stageId, call);
        if (stepCtx.cwd === cwdA) {
          stepCtx.observer?.bindControls?.({
            steer: async () => {},
            abort: async () => { abortedA = true; releaseA?.(); },
          }, stageId);
          await new Promise<void>((resolve) => { releaseA = resolve; });
          if (abortedA) return { envelope: null, observedCalls: [call], assistantText: "", usage: null, cancelledByUser: true };
          const env = createAndVerifyHandoff({
            store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
            toTarget: stepCtx.toTarget, verdict: "ready", summary: "Project A finished", observedCalls: [call],
          });
          return { envelope: env, observedCalls: [call], assistantText: "A ok", usage: null };
        }

        bTurnCount += 1;
        if (bTurnCount === 1) {
          const env = createAndVerifyHandoff({
            store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
            toTarget: stepCtx.toTarget, verdict: "needs_input", summary: "Project B needs DB choice",
            questionsForUser: ["Use SQLite or Postgres for Project B?"], observedCalls: [call],
          });
          return { envelope: env, observedCalls: [call], assistantText: "need input", usage: null };
        }
        bResumedPrompt = stepCtx.conditioningPrompt;
        const env = createAndVerifyHandoff({
          store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
          parentHandoffId: stepCtx.upstreamHandoff?.id ?? null, toTarget: stepCtx.toTarget,
          verdict: "ready", summary: "Project B shipped with SQLite", observedCalls: [call],
        });
        return { envelope: env, observedCalls: [call], assistantText: "B done", usage: null };
      },
    };

    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const sentCalls: Array<{ msg: any; opts: any }> = [];

    const pi = {
      cwd: cwdA,
      on(ev: string, fn: (...args: any[]) => any) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
      registerTool(spec: any) { tools.set(spec.name, spec); },
      registerCommand(name: string, spec: any) { commands.set(name, spec); },
      registerMessageRenderer() {},
      sendMessage(msg: any, opts: any) { sentCalls.push({ msg, opts }); },
      getAllTools: () => [{ name: "read" }, { name: "grep" }, { name: "write" }, { name: "bash" }],
      async setActiveTools() {},
      pi: { settings: {} },
    };

    ompEnhance(pi, { globalRolesDir: globalDir, builtinRolesDir, pluginLockPath: lockPath, runnerFactory: () => hubRunner });

    // Verify read-only monitor key bindings (Tab, [, ], ←, →, PgUp/PgDn, Ctrl+X, Esc/q, no text events!)
    expect(parseFlowOverlayInput("\t")).toEqual({ kind: "next_project" });
    expect(parseFlowOverlayInput("]")).toEqual({ kind: "next_project" });
    expect(parseFlowOverlayInput("[")).toEqual({ kind: "prev_project" });
    expect(parseFlowOverlayInput("\x1b[C")).toEqual({ kind: "next_project" });
    expect(parseFlowOverlayInput("\x1b[D")).toEqual({ kind: "prev_project" });
    expect(parseFlowOverlayInput("\x1b[")).toEqual({ kind: "scroll_up" });
    expect(parseFlowOverlayInput("\x1b]")).toEqual({ kind: "scroll_down" });
    expect(parseFlowOverlayInput("\x1b[5~")).toEqual({ kind: "scroll_up" });
    expect(parseFlowOverlayInput("\x1b[120;5u")).toEqual({ kind: "cancel_flow" });
    expect(parseFlowOverlayInput("q")).toEqual({ kind: "escape" });

    let capturedComp: any = null;
    let liveWidgetFactory: any = null;
    const ctx = {
      cwd: cwdA,
      hasUI: true,
      ui: {
        setWidget(_k: string, factory: any) { liveWidgetFactory = factory; },
        setStatus() {},
        notify() {},
        async custom(factory: any) {
          await new Promise<void>((resolve) => {
            capturedComp = factory({ requestRender() {} }, {}, null, () => resolve());
          });
        },
      },
    };

    // Activate /coord first so coordinator auto-wakeup (triggerTurn: true) is active!
    await commands.get("coord")!.handler("", ctx);
    sentCalls.length = 0;

    const flowTool = tools.get("enhance_flow")!;
    // 1) Start Flow A in cwdA (stays running) AND Flow B in cwdB concurrently!
    const startA = JSON.parse((await flowTool.execute("fa", { roles: ["dev"], goal: "Build Service A" }, null, null, ctx)).content[0].text);
    expect(startA).toMatchObject({ started: true, cwd: cwdA, status: "running" });
    for (let i = 0; i < 20 && !releaseA; i++) await Bun.sleep(5);

    // Per-project single-writer guard blocks a second Flow on cwdA while cwdA is running...
    const dupA = await flowTool.execute("fa-dup", { roles: ["dev"], goal: "Conflict A" }, null, null, ctx);
    expect(dupA.isError).toBe(true);

    // ...but allows Flow B in cwdB to run concurrently!
    const startB = JSON.parse((await flowTool.execute("fb", { cwd: cwdB, roles: ["planner"], goal: "Plan Service B" }, null, null, ctx)).content[0].text);
    expect(startB).toMatchObject({ started: true, cwd: cwdB, status: "running" });

    // Wait for Flow B to settle into waiting_input and fire silent coordinator auto-wakeup (display: false)!
    for (let i = 0; i < 40 && !sentCalls.some((c) => c.msg.customType === "omp-enhance-flow-event"); i++) await Bun.sleep(10);
    const wakeEvent = sentCalls.find((c) => c.msg.customType === "omp-enhance-flow-event")!;
    expect(wakeEvent.msg.display).toBe(false);
    expect(wakeEvent.msg.excludeFromContext).toBe(false);
    expect(wakeEvent.msg.content).toContain("waiting_input");
    expect(wakeEvent.msg.content).toContain("Use SQLite or Postgres for Project B?");
    expect(wakeEvent.opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });

    // Medium-3: Multi-project aboveEditor widget renders BOTH running cwdA (●) and waiting_input cwdB (?) simultaneously!
    expect(liveWidgetFactory).not.toBeNull();
    const multiWidgetLines: string[] = liveWidgetFactory({ requestRender() {} }, {}).render(92);
    for (const line of multiWidgetLines) expect(Bun.stringWidth(line)).toBe(92);
    const multiWidgetText = multiWidgetLines.join("\n");
    expect(multiWidgetText).toContain("2 个项目活跃");
    expect(multiWidgetText).toContain(`● [${path.basename(cwdA)}]`);
    expect(multiWidgetText).toContain(`? [${path.basename(cwdB)}]`);

    // Verify enhance_flow(action="list") reports both cwdA (running) and cwdB (waiting_input, resumable: true)
    const listed = JSON.parse((await flowTool.execute("fl", { action: "list" }, null, null, ctx)).content[0].text);
    expect(listed.flows).toHaveLength(2);
    expect(listed.flows.find((f: any) => f.cwd === cwdA)?.status).toBe("running");
    expect(listed.flows.find((f: any) => f.cwd === cwdB)).toMatchObject({ status: "waiting_input", resumable: true });

    // Verify coordinator conditioning includes Multi-Project Active Workloads!
    const startHookOut = await handlers.get("before_agent_start")![0]!({ systemPrompt: [] }, ctx);
    await handlers.get("agent_end")![0]!({ messages: [] }, ctx);
    const coordSys = (startHookOut as { systemPrompt: string[] }).systemPrompt.join("\n");
    expect(coordSys).toContain("## Multi-Project Active Workloads");
    expect(coordSys).toContain(startA.flowId);
    expect(coordSys).toContain(startB.flowId);

    // 2) Open read-only /flow monitor: switch between Project A and Project B with Tab, inspect traces, cancel Project A with Ctrl+X, close with q!
    const overlayPromise = commands.get("flow")!.handler("", ctx);
    await Bun.sleep(5);
    expect(capturedComp).not.toBeNull();
    const frameA: string[] = capturedComp.render(96);
    for (const line of frameA) expect(Bun.stringWidth(line)).toBe(96);
    expect(frameA.join("\n")).toContain("只读监控窗");
    expect(frameA.join("\n")).not.toContain("💬");
    expect(frameA.join("\n")).toContain(path.basename(cwdA));

    capturedComp.handleInput("\t");
    const frameB = capturedComp.render(104).join("\n");
    expect(frameB).toContain("? 待你确认");
    expect(frameB).toContain("待用户确认问题 (1):");
    expect(frameB).toContain("Use SQLite or Postgres for Project B?");

    // Switch back to Project A with `[` and emergency-stop it with Ctrl+X!
    capturedComp.handleInput("[");
    capturedComp.handleInput("\x1b[120;5u");
    await Bun.sleep(15);
    expect(abortedA).toBe(true);
    expect(capturedComp.render(96).join("\n")).toContain("⏹ 已取消");
    capturedComp.handleInput("q");
    await overlayPromise;

    // 3) Resume Flow B by flowId with user's answer in `message` -> wakes coordinator silently (display: false) on completion!
    sentCalls.length = 0;
    const resumedB = JSON.parse((await flowTool.execute("fb-res", {
      action: "resume", flowId: startB.flowId, message: "Use SQLite with WAL mode",
    }, null, null, ctx)).content[0].text);
    expect(resumedB).toMatchObject({ resumed: true, flowId: startB.flowId, cwd: cwdB });

    for (let i = 0; i < 40 && !sentCalls.some((c) => c.msg.customType === "omp-enhance-flow-event"); i++) await Bun.sleep(10);
    expect(bResumedPrompt).toContain("## User Interjections");
    expect(bResumedPrompt).toContain("Use SQLite with WAL mode");
    const completedWake = sentCalls.find((c) => c.msg.customType === "omp-enhance-flow-event")!;
    expect(completedWake.msg.display).toBe(false);
    expect(completedWake.msg.excludeFromContext).toBe(false);
    expect(completedWake.msg.content).toContain("[Flow Event · completed]");
    expect(completedWake.msg.content).toContain("Project B shipped with SQLite");
    expect(completedWake.opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });

    // 4) Medium-4: coordinator blocks enhance_job(start), while /coord off allows enhance_job(start, cwd=cwdB)!
    const blockedJob = await tools.get("enhance_job")!.execute("jb-block", {
      action: "start", cwd: cwdB, command: "echo no-direct-shell",
    }, null, null, ctx);
    expect(blockedJob.isError).toBe(true);
    await commands.get("coord")!.handler("off", ctx);
    const jobRes = JSON.parse((await tools.get("enhance_job")!.execute("jb-b", {
      action: "start", cwd: cwdB, command: "echo multi-project-ok",
    }, null, null, ctx)).content[0].text);
    expect(jobRes.job.cwd).toBe(cwdB);
    await handlers.get("session_shutdown")?.[0]?.({}, ctx);
  });

  test("deduplicates mid-turn pendingWakeups when enhance_flow(status) already observed settlement, merges remaining wakeups on agent_end, and selects active /flow tab + error icons", async () => {
    const cwdHub = makeTempDir("dedup-hub");
    const cwdOne = makeTempDir("dedup-one");
    const cwdTwo = makeTempDir("dedup-two");
    const cwdThree = makeTempDir("dedup-three");
    const globalDir = makeTempDir("dedup-global");
    const lockPath = path.join(cwdHub, "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { flowRoutingMode: "auto" } } }));

    // Verify status icons mapping (Medium-3)
    expect(flowStatusIcon("running")).toBe("●");
    expect(flowStatusIcon("waiting_input")).toBe("?");
    expect(flowStatusIcon("completed")).toBe("✓");
    expect(flowStatusIcon("interrupted")).toBe("⏸");
    expect(flowStatusIcon("cancelled")).toBe("⏸");
    for (const errSt of ["blocked", "rejected_max_rounds", "stagnated", "violation", "aborted_by_supervisor", "failed"]) {
      expect(flowStatusIcon(errSt)).toBe("!");
    }
    expect(flowStatusIcon("idle")).toBe("○");

    // Verify openFlowRoomOverlay defaults initial projectIdx to first active/non-idle project and renders `!` on failed/blocked!
    const idleRoom = new FlowRoomManager(undefined, undefined, cwdHub);
    const failedRoom = new FlowRoomManager(undefined, undefined, cwdOne);
    failedRoom.beginFlow({ goal: "Broken deploy", roleChain: ["dev"] });
    failedRoom.failFlow(new Error("boom"));
    let overlayFrame = "";
    await openFlowRoomOverlay({
      ctx: {
        cwd: cwdHub, hasUI: true,
        ui: {
          async custom(factory: any) {
            await new Promise<void>((resolve) => {
              const comp = factory({ requestRender() {} }, {}, null, () => resolve());
              overlayFrame = comp.render(92).join("\n");
              comp.handleInput("q");
            });
          },
        },
      },
      targets: [
        { cwd: cwdHub, room: idleRoom },
        { cwd: cwdOne, room: failedRoom },
      ],
    });
    // Selected tab defaults to index 1 (failedRoom, non-idle) with `!` error icon instead of idle index 0!
    expect(overlayFrame).toContain(`▸[2/2 ! ${path.basename(cwdOne)}]`);
    expect(overlayFrame).toContain("Broken deploy");

    // Verify renderMultiProjectWidgetLines caps at 4 active projects cleanly
    const fiveRooms = [0, 1, 2, 3, 4].map((i) => {
      const r = new FlowRoomManager(undefined, undefined, `/tmp/proj-${i}`);
      r.beginFlow({ goal: `Goal ${i}`, roleChain: ["dev"] });
      return { cwd: `/tmp/proj-${i}`, room: r };
    });
    const cappedWidget = renderMultiProjectWidgetLines(fiveRooms, 80);
    expect(cappedWidget).toHaveLength(6); // top border + 4 project lines + footer
    expect(cappedWidget.at(-1)).toContain("(+1 个项目)");

    // High-2: Mid-turn pendingWakeups deduplication + single merged agent_end flush!
    const fastRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        const call: ObservedToolCall = { toolCallId: `c-${path.basename(stepCtx.cwd)}`, toolName: "read", isError: false, touchedPaths: [], timestamp: new Date().toISOString() };
        const env = createAndVerifyHandoff({
          store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
          toTarget: stepCtx.toTarget, verdict: "ready", summary: `Done ${path.basename(stepCtx.cwd)}`, observedCalls: [call],
        });
        return { envelope: env, observedCalls: [call], assistantText: "ok", usage: null };
      },
    };

    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const sentEvents: Array<{ msg: any; opts: any }> = [];
    const pi = {
      cwd: cwdHub,
      on(ev: string, fn: (...args: any[]) => any) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
      registerTool(spec: any) { tools.set(spec.name, spec); },
      registerCommand(name: string, spec: any) { commands.set(name, spec); },
      registerMessageRenderer() {},
      sendMessage(msg: any, opts: any) { if (msg.customType === "omp-enhance-flow-event") sentEvents.push({ msg, opts }); },
      getAllTools: () => [{ name: "read" }],
      async setActiveTools() {},
      pi: { settings: {} },
    };
    ompEnhance(pi, { globalRolesDir: globalDir, builtinRolesDir, pluginLockPath: lockPath, runnerFactory: () => fastRunner });

    let streaming = false;
    const ctx = { cwd: cwdHub, hasUI: true, isIdle: () => !streaming, ui: { setWidget() {}, setStatus() {}, notify() {} } };
    await commands.get("coord")!.handler("", ctx);

    // Open a foreground coordinator turn (streaming = true)
    streaming = true;
    await handlers.get("before_agent_start")![0]!({ systemPrompt: [] }, ctx);

    const flowTool = tools.get("enhance_flow")!;
    const s1 = JSON.parse((await flowTool.execute("d1", { cwd: cwdOne, roles: ["reviewer"], goal: "Audit 1" }, null, null, ctx)).content[0].text);
    const s2 = JSON.parse((await flowTool.execute("d2", { cwd: cwdTwo, roles: ["reviewer"], goal: "Audit 2" }, null, null, ctx)).content[0].text);
    const s3 = JSON.parse((await flowTool.execute("d3", { cwd: cwdThree, roles: ["reviewer"], goal: "Audit 3" }, null, null, ctx)).content[0].text);

    // Wait for all 3 background flows to finish while coordinator is STILL mid-turn -> held in pendingWakeups, 0 sentEvents!
    await Bun.sleep(40);
    expect(sentEvents).toHaveLength(0);

    // Coordinator calls enhance_flow(status, flowId=s1.flowId) mid-turn -> s1 is ALREADY seen and consumed!
    const status1 = JSON.parse((await flowTool.execute("st-1", { action: "status", flowId: s1.flowId }, null, null, ctx)).content[0].text);
    expect(status1.status).toBe("completed");

    // Turn ends (agent_end) -> s2 and s3 flush together in ONE single merged omp-enhance-flow-event (and s1 is NOT duplicated)!
    streaming = false;
    await handlers.get("agent_end")![0]!({ messages: [] }, ctx);
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]!.msg.display).toBe(false);
    expect(sentEvents[0]!.msg.excludeFromContext).toBe(false);
    expect(sentEvents[0]!.opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(sentEvents[0]!.msg.content).not.toContain(s1.flowId);
    expect(sentEvents[0]!.msg.content).toContain(s2.flowId);
    expect(sentEvents[0]!.msg.content).toContain(s3.flowId);

    await handlers.get("session_shutdown")?.[0]?.({}, ctx);
  });

  test("applies configured defaultRole on session_start, queues followUp when foreground streams, and keeps /role ANSI-safe", async () => {
    let releaseRun = null as (() => void) | null;
    const activeToolSets: string[][] = [];
    const sentCalls: Array<{ msg: any; opts: any }> = [];

    const cwd = makeTempDir("audit-ws");
    const globalDir = makeTempDir("audit-global");
    const lockPath = path.join(cwd, "omp-plugins.lock.json");
    writeText(lockPath, JSON.stringify({ settings: { "omp-enhance": { defaultRole: "reviewer", flowRoutingMode: "auto" } } }));

    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const pi = {
      cwd,
      on(ev: string, fn: (...args: any[]) => any) {
        const list = handlers.get(ev) ?? []; list.push(fn); handlers.set(ev, list);
      },
      registerTool(spec: any) { tools.set(spec.name, spec); },
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
    // Start read-only reviewer Flow while activeRole is reviewer (non-dispatch -> triggerTurn: false on event!)
    await tools.get("enhance_flow")!.execute("f-rev", { roles: ["reviewer"], goal: "审查缓存层" }, null, null, ctx);
    for (let i = 0; i < 20 && !releaseRun; i++) await Bun.sleep(5);

    releaseRun!();
    for (let i = 0; i < 30 && sentCalls.length < 2; i++) await Bun.sleep(10);
    expect(sentCalls[0]?.msg.customType).toBe("omp-enhance-room");
    expect(sentCalls[0]?.opts).toEqual({ triggerTurn: false, deliverAs: "followUp" });
    expect(sentCalls[1]?.msg.customType).toBe("omp-enhance-flow-event");
    expect(sentCalls[1]?.opts).toEqual({ triggerTurn: false, deliverAs: "followUp" });
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

                writeText(path.join(cwd, "algo_work", "REPORT.md"), "# Algo Report\nMAE reduced by 32%\n");
                writeText(path.join(cwd, "algo_work", "runs", "r1", "metrics.json"), '{"mae":0.068}\n');
                emitEnd("algo-opt-2", "bash", { command: "python eval_v1.py" });
                await handoffTool.execute("ah-final", {
                  verdict: "ready",
                  summary: "依据视觉诊断修正边缘滞后与剔除脏标后，MAE 较基线降低 32%",
                  artifactPaths: ["artifacts/vis/badcases.png", "algo_work/REPORT.md", "algo_work/runs/r1/metrics.json"],
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

  test("isolates status/steer/resume/cancel by flowId when Flow A is waiting_input and Flow B is running in the same project (P1-1)", async () => {
    let releaseB: (() => void) | null = null;
    let bAborted = false;
    const bLiveSteers: string[] = [];
    let aResumedPrompts: string[] = [];
    let aTurnCount = 0;

    const p1Runner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        const stageId = stepCtx.stageId ?? stepCtx.role.id;
        const call: ObservedToolCall = {
          toolCallId: `tc-${stepCtx.flowId}-${stepCtx.role.id}-${aTurnCount}`,
          toolName: "read", isError: false, touchedPaths: [], timestamp: new Date().toISOString(),
        };
        stepCtx.observer?.onToolEnd?.(stageId, call);

        if (stepCtx.mandate.goal.startsWith("FLOW_B_ACTIVE")) {
          stepCtx.observer?.bindControls?.({
            steer: async (m) => { bLiveSteers.push(m); },
            abort: async () => { bAborted = true; releaseB?.(); },
          }, stageId);
          writeText(path.join(stepCtx.cwd, "b-work.txt"), "B_CLEAN\n");
          await new Promise<void>((r) => { releaseB = r; });
          if (bAborted) return { envelope: null, observedCalls: [call], assistantText: "", usage: null, cancelledByUser: true };
          const env = createAndVerifyHandoff({
            store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
            toTarget: stepCtx.toTarget, verdict: "ready", summary: "Flow B finished cleanly",
            artifactPaths: ["b-work.txt"], observedCalls: [call],
          });
          return { envelope: env, observedCalls: [call], assistantText: "B done", usage: null };
        }

        aTurnCount += 1;
        if (stepCtx.mandate.goal.startsWith("PAUSE_CANCEL") || aTurnCount === 1) {
          const env = createAndVerifyHandoff({
            store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
            toTarget: stepCtx.toTarget, verdict: "needs_input", summary: `Waiting on ${stepCtx.mandate.goal}`,
            questionsForUser: ["Confirm A strategy?"], observedCalls: [call],
          });
          return { envelope: env, observedCalls: [call], assistantText: "pause", usage: null };
        }
        aResumedPrompts.push(stepCtx.conditioningPrompt);
        writeText(path.join(stepCtx.cwd, "a-work.txt"), "A_RESUMED\n");
        const env = createAndVerifyHandoff({
          store: stepCtx.store, role: stepCtx.role, cwd: stepCtx.cwd, mandate: stepCtx.mandate,
          parentHandoffId: stepCtx.upstreamHandoff?.id ?? null, toTarget: stepCtx.toTarget,
          verdict: "ready", summary: "Flow A completed after B", artifactPaths: ["a-work.txt"], observedCalls: [call],
        });
        return { envelope: env, observedCalls: [call], assistantText: "A done", usage: null };
      },
    };

    const { cwd, tools, commands } = setupHarness({ flowRoutingMode: "auto" }, p1Runner);
    const flowTool = tools.get("enhance_flow")!;
    const ctx = { cwd, hasUI: true, ui: { setWidget() {}, setStatus() {}, notify() {} } };

    // 1. Create paused Flow A (to be resumed later), paused A2 (to test /flow cancel), and paused A3 (to test enhance_flow cancel)
    const startA = JSON.parse((await flowTool.execute("sa", { roles: ["dev"], goal: "FLOW_A_MAIN", wait: true }, null, null, ctx)).content[0].text);
    expect(startA.status).toBe("waiting_input");
    const flowAId = (JSON.parse((await flowTool.execute("sta0", { action: "status" }, null, null, ctx)).content[0].text)).flowId as string;

    const a2Pause = JSON.parse((await flowTool.execute("sa2", { roles: ["planner"], goal: "PAUSE_CANCEL_CMD", wait: true }, null, null, ctx)).content[0].text);
    expect(a2Pause.status).toBe("waiting_input");
    const flowA2Id = (JSON.parse((await flowTool.execute("sta2", { action: "status" }, null, null, ctx)).content[0].text)).flowId as string;

    const a3Pause = JSON.parse((await flowTool.execute("sa3", { roles: ["planner"], goal: "PAUSE_CANCEL_TOOL", wait: true }, null, null, ctx)).content[0].text);
    expect(a3Pause.status).toBe("waiting_input");
    const flowA3Id = (JSON.parse((await flowTool.execute("sta3", { action: "status" }, null, null, ctx)).content[0].text)).flowId as string;

    // 2. Start Flow B in the SAME cwd -> B is now running in room!
    const startB = JSON.parse((await flowTool.execute("sb", { roles: ["dev"], goal: "FLOW_B_ACTIVE" }, null, null, ctx)).content[0].text);
    expect(startB).toMatchObject({ started: true, status: "running" });
    const flowBId = startB.flowId as string;
    for (let i = 0; i < 20 && !releaseB; i++) await Bun.sleep(5);

    // 3. Query status(flowId=A) while B runs -> MUST return Flow A, NOT Flow B!
    const statusA = JSON.parse((await flowTool.execute("q-a", { action: "status", flowId: flowAId }, null, null, ctx)).content[0].text);
    expect(statusA.flowId).toBe(flowAId);
    expect(statusA.goal).toBe("FLOW_A_MAIN");
    expect(statusA.status).toBe("waiting_input");
    expect(statusA.resumable).toBe(true);

    // 4. Steer A and attempt resume(A, message) while B holds the project execution lease -> B is 100% untouched!
    const steerA = JSON.parse((await flowTool.execute("st-a", {
      action: "steer", flowId: flowAId, message: "A_STEER_ONE",
    }, null, null, ctx)).content[0].text);
    expect(steerA).toMatchObject({ ok: true, flowId: flowAId, delivered: false, savedToCheckpoint: true, status: "waiting_input" });

    const busyResumeA = JSON.parse((await flowTool.execute("res-a-busy", {
      action: "resume", flowId: flowAId, message: "A_STEER_TWO",
    }, null, null, ctx)).content[0].text);
    expect(busyResumeA).toMatchObject({
      started: false, resumed: false, busy: true, flowId: flowAId, activeFlowId: flowBId, savedReply: true, status: "waiting_input",
    });

    // 5. Cancel A2 via `/flow cancel <flowA2Id>` AND cancel A3 via `enhance_flow(action="cancel", flowId=flowA3Id)` -> B stays running!
    await commands.get("flow")!.handler(`cancel ${flowA2Id}`, ctx);
    const cancelA3 = JSON.parse((await flowTool.execute("can-a3", { action: "cancel", flowId: flowA3Id }, null, null, ctx)).content[0].text);
    expect(cancelA3).toMatchObject({ cancelled: true, flowId: flowA3Id, status: "cancelled" });

    const statusA2After = JSON.parse((await flowTool.execute("q-a2", { action: "status", flowId: flowA2Id }, null, null, ctx)).content[0].text);
    expect(statusA2After.status).toBe("cancelled");
    expect(bAborted).toBe(false);
    expect(bLiveSteers).toEqual([]);
    const statusBMid = JSON.parse((await flowTool.execute("q-b", { action: "status", flowId: flowBId }, null, null, ctx)).content[0].text);
    expect(statusBMid.status).toBe("running");
    expect(statusBMid.userSteers).toEqual([]);

    // 6. Finish Flow B -> then resume Flow A from its original waiting_input checkpoint with both saved replies!
    releaseB!();
    for (let i = 0; i < 30; i++) {
      const sb = JSON.parse((await flowTool.execute("qb2", { action: "status", flowId: flowBId }, null, null, ctx)).content[0].text);
      if (sb.status === "completed") break;
      await Bun.sleep(10);
    }
    const finalB = JSON.parse((await flowTool.execute("qb3", { action: "status", flowId: flowBId }, null, null, ctx)).content[0].text);
    expect(finalB.status).toBe("completed");
    expect(finalB.userSteers).toEqual([]);

    const resumedA = JSON.parse((await flowTool.execute("res-a-ok", {
      action: "resume", flowId: flowAId, wait: true,
    }, null, null, ctx)).content[0].text);
    expect(resumedA.status).toBe("completed");
    expect(aResumedPrompts[0]).toContain("A_STEER_ONE");
    expect(aResumedPrompts[0]).toContain("A_STEER_TWO");
    expect(existsSync(path.join(cwd, "a-work.txt"))).toBe(true);
    expect(existsSync(path.join(cwd, "b-work.txt"))).toBe(true);
  });
});
