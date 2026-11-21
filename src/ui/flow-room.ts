import type { FlowRoomSnapshot, FlowRoomStatus, FlowRoomUiAdapter } from "../flow/state.ts";
import { FlowRoomManager } from "../flow/state.ts";
import type { ObservedToolCall, RoomEntry } from "../core/types.ts";
import {
  decodeKittyCsiU, padLeftCell, padRightCell, parseFlowOverlayInput as baseParseFlowOverlayInput,
  truncateDisplay, wrapPlainText, type OverlayInputEvent,
} from "./kit.ts";

export {
  FlowRoomManager, padLeftCell, padRightCell, truncateDisplay, wrapPlainText,
  type FlowRoomSnapshot, type FlowRoomStatus, type FlowRoomUiAdapter, type OverlayInputEvent,
};

export interface FlowRoomOverlayDeps {
  ctx: any; room: FlowRoomManager; onFollowUp?: (text: string) => Promise<void>; onResume?: () => Promise<void>;
}

const toneColor = (t: RoomEntry["tone"]): string =>
  t === "success" ? "success" : t === "warning" ? "warning" : t === "error" ? "error" : "accent";
const statusBadge = (s: FlowRoomStatus): { text: string; color: string } =>
  s === "running" ? { text: "● 运行中", color: "accent" }
    : s === "interrupted" ? { text: "⏸ 中断可续跑", color: "warning" }
      : s === "completed" ? { text: "✓ 已完成", color: "success" }
        : s === "blocked" ? { text: "! 需你介入", color: "warning" }
          : s === "cancelled" ? { text: "⏹ 已取消", color: "muted" }
            : s === "violation" ? { text: "✕ 越界拦截", color: "error" }
              : s === "failed" ? { text: "✕ 异常中止", color: "error" } : { text: "○ 空闲", color: "muted" };

export function renderChatBubbleLines(
  entry: RoomEntry, width: number, options?: { selected?: boolean; maxBodyLines?: number; theme?: any },
): string[] {
  const w = Math.max(20, width), sel = options?.selected === true, maxBody = options?.maxBodyLines ?? 3;
  const fg = (c: string, s: string): string => (typeof options?.theme?.fg === "function" ? options.theme.fg(c, s) : s);
  if (entry.side === "right") {
    const head = `${sel ? "◂ " : ""}${entry.badge ? `[${entry.badge}] ` : ""}◀ ${entry.speaker || "你"}`;
    const body = wrapPlainText(entry.text, Math.max(10, Math.floor(w * 0.76) - 2), maxBody);
    return [
      fg(sel ? "accent" : "success", padRightCell(head, w)),
      ...body.map((l) => sel ? fg("accent", `${padRightCell(l, w - 2)} │`) : `${padRightCell(l, w - 2)} ${fg("border", "│")}`),
    ];
  }
  const target = entry.target ? ` → @${entry.target === "user" ? "你" : entry.target}` : "";
  const head = `${sel ? "▸ " : "  "}▶ [${entry.speaker}${target}]${entry.badge ? ` ${entry.badge}` : ""}`;
  const body = wrapPlainText(entry.text, Math.max(10, Math.floor(w * 0.84) - 4), maxBody);
  return [
    fg(sel ? "accent" : toneColor(entry.tone), padLeftCell(head, w)),
    ...body.map((l) => { const row = padLeftCell(`  │ ${l}`, w); return sel ? fg("accent", row) : row; }),
  ];
}

export function renderLiveWidgetLines(snapshot: FlowRoomSnapshot, width: number, theme?: any): string[] {
  const inner = Math.max(28, width - 4);
  const fg = (c: string, s: string): string => (typeof theme?.fg === "function" ? theme.fg(c, s) : s);
  const head = `⇄ 协作群聊 · ${snapshot.roleChain.join(" → ")} [${statusBadge(snapshot.status).text}] (/flow 详情与插话)`;
  const lines = [fg("border", `╭─ ${padLeftCell(head, inner - 2)} ─╮`)];
  for (const entry of snapshot.entries.slice(-3)) {
    for (const row of renderChatBubbleLines(entry, inner, { maxBodyLines: 1, theme })) lines.push(`${fg("border", "│")} ${row} ${fg("border", "│")}`);
  }
  const active = snapshot.stages.find((s) => s.stageId === snapshot.activeStageId);
  const foot = active
    ? `⚙ ${active.roleId} (${active.modelLabel}) · 工具 ${active.calls.length} 次${active.activeTool ? ` → ${active.activeTool}` : ""}`
    : `目标: ${snapshot.goal}`;
  lines.push(fg("border", `╰─ ${padLeftCell(foot, inner - 2)} ─╯`));
  return lines;
}

export function renderRoomCardLines(snapshot: FlowRoomSnapshot, width: number, expanded: boolean, theme?: any): string[] {
  const inner = Math.max(28, width - 4);
  const fg = (c: string, s: string): string => (typeof theme?.fg === "function" ? theme.fg(c, s) : s);
  const totalCalls = snapshot.stages.reduce((acc, s) => acc + s.calls.length, 0);
  const title = `⇄ 群聊纪要 · ${snapshot.roleChain.join(" → ")} [${statusBadge(snapshot.status).text}] · 工具 ${totalCalls} 次`;
  const lines = [fg("border", `╭─ ${padLeftCell(title, inner - 2)} ─╮`)];
  for (const entry of snapshot.entries) {
    for (const row of renderChatBubbleLines(entry, inner, { maxBodyLines: expanded ? 5 : 2, theme })) lines.push(`${fg("border", "│")} ${row} ${fg("border", "│")}`);
  }
  if (expanded && snapshot.stages.length > 0) {
    lines.push(fg("border", `├─ ${padLeftCell("🔎 Agent 动作轨迹 (Ctrl+O 收起)", inner - 2)} ─┤`));
    for (const st of snapshot.stages) {
      lines.push(`${fg("border", "│")} ${fg("accent", padLeftCell(`• ${st.roleId} (${st.modelLabel}) [${st.status}] · 工具 ${st.calls.length} 次`, inner))} ${fg("border", "│")}`);
      st.calls.forEach((c: ObservedToolCall, i: number) => {
        lines.push(`${fg("border", "│")} ${padLeftCell(`  ${i + 1}. ${c.isError ? "✕" : "✓"} ${c.summary ?? c.toolName}`, inner)} ${fg("border", "│")}`);
      });
      if (st.envelope && st.envelope.artifacts.length > 0) {
        const arts = st.envelope.artifacts.map((a) => `${a.path}#${a.sha256.slice(0, 8)}`).join(", ");
        lines.push(`${fg("border", "│")} ${fg("muted", padLeftCell(`  📦 ${arts}`, inner))} ${fg("border", "│")}`);
      }
      if (st.envelope?.deletedFiles?.length) {
        lines.push(`${fg("border", "│")} ${fg("warning", padLeftCell(`  🗑 ${st.envelope.deletedFiles.join(", ")}`, inner))} ${fg("border", "│")}`);
      }
    }
  }
  const hint = expanded ? "Ctrl+O 收起工具轨迹 · /flow 打开双栏检查器" : "Ctrl+O 展开每个 Agent 工具轨迹 · /flow 打开双栏检查器";
  lines.push(fg("border", `╰─ ${padLeftCell(hint, inner - 2)} ─╯`));
  return lines;
}

export function createFlowRoomUiAdapter(pi: any): FlowRoomUiAdapter {
  let widgetTui: any = null;
  return {
    mountWidget(room, ctx) {
      if (!ctx?.hasUI || typeof ctx?.ui?.setWidget !== "function") return;
      try {
        ctx.ui.setWidget("omp-enhance-flow", (tui: any, theme: any) => {
          widgetTui = tui;
          return { invalidate() {}, render: (width: number): string[] => renderLiveWidgetLines(room.getSnapshot(), width, theme) };
        }, { placement: "aboveEditor" });
      } catch {}
    },
    clearWidget(ctx) { widgetTui = null; try { ctx?.ui?.setWidget?.("omp-enhance-flow", undefined); } catch {} },
    sendSummaryCard(snap, summary, ctx) {
      if (!ctx?.hasUI || typeof pi?.sendMessage !== "function") return;
      try {
        const opts = { triggerTurn: false, ...(ctx?.isIdle?.() === false ? { deliverAs: "followUp" } : {}) };
        pi.sendMessage({
          customType: "omp-enhance-room", display: true, details: snap,
          content: `[Flow ${snap.roleChain.join(" → ")} · ${snap.status}] ${summary}`,
        }, opts);
      } catch {}
    },
    requestRender() { try { widgetTui?.requestRender?.(); } catch {} },
  };
}

export function registerRoomMessageRenderer(pi: any): void {
  if (typeof pi?.registerMessageRenderer !== "function") return;
  pi.registerMessageRenderer("omp-enhance-room", (message: any, opts: any, theme: any) => ({
    invalidate() {},
    render: (width: number): string[] => {
      const snap = message?.details as FlowRoomSnapshot | undefined;
      return snap && Array.isArray(snap.entries)
        ? renderRoomCardLines(snap, width, Boolean(opts?.expanded), theme) : [String(message?.content ?? "")];
    },
  }));
}

export function parseFlowOverlayInput(data: string, kb?: any, _hasDraft = false): OverlayInputEvent | null {
  if (!data) return null;
  if (data === "\x1b[" || kb?.matches?.(data, "tui.select.pageUp")) return { kind: "scroll_up" };
  if (data === "\x1b]" || kb?.matches?.(data, "tui.select.pageDown")) return { kind: "scroll_down" };
  const kitty = decodeKittyCsiU(data);
  if (kitty) {
    const base = kitty.baseCodepoint ?? kitty.codepoint;
    if (kitty.codepoint === 57365 || ((kitty.modifiers & 2) !== 0 && base === 91)) return { kind: "scroll_up" };
    if (kitty.codepoint === 57366 || ((kitty.modifiers & 2) !== 0 && base === 93)) return { kind: "scroll_down" };
  }
  return baseParseFlowOverlayInput(data, kb, true);
}

function buildInspectorLines(snap: FlowRoomSnapshot, selected: RoomEntry | undefined, rightW: number): string[] {
  const stage = selected?.stageId ? snap.stages.find((s) => s.stageId === selected.stageId) : undefined;
  if (!stage) {
    const lines = [
      `Flow: ${snap.flowId ?? "(未启动)"}`, `状态: ${statusBadge(snap.status).text}`,
      `角色链: ${snap.roleChain.length > 0 ? snap.roleChain.join(" → ") : "(无)"}`, "─".repeat(Math.min(28, rightW)),
      selected ? `发言者: ${selected.speaker} (${selected.badge ?? "消息"})` : "提示: 输入 /flow dev,qa <目标> 或直接下方输入",
    ];
    if (selected?.text) lines.push(...wrapPlainText(selected.text, rightW - 2, 8));
    if (snap.stages.length > 0) {
      lines.push("", `阶段概览 (${snap.stages.length}):`);
      snap.stages.forEach((s, i) => lines.push(` ${i + 1}. ${s.roleId} [${s.status}] · 工具 ${s.calls.length} 次`));
    }
    return lines;
  }
  const elapsedSec = Math.max(0, Math.round(((stage.endedAt ? Date.parse(stage.endedAt) : Date.now()) - Date.parse(stage.startedAt)) / 1000));
  const out: string[] = [
    `Agent: ${stage.roleId} (${stage.roleName}) · R${stage.round}`,
    `模型: ${stage.modelLabel}  状态: ${stage.status}  耗时: ${elapsedSec}s`,
    ...(stage.activeTool ? [`当前动作: ⚙ ${stage.activeTool}`] : []),
    "─".repeat(Math.min(28, rightW)), `动作时间线 (${stage.calls.length}):`,
  ];
  if (stage.calls.length === 0) out.push("  (尚无工具调用)");
  stage.calls.forEach((c, i) => out.push(`  ${i + 1}. ${c.isError ? "✕" : "✓"} ${c.summary ?? c.toolName}`));
  if (stage.envelope && stage.envelope.artifacts.length > 0) {
    out.push("", `产物快照 (${stage.envelope.artifacts.length}):`);
    for (const a of stage.envelope.artifacts) out.push(`  📦 ${a.path} (${a.sha256.slice(0, 8)})`);
  }
  if (stage.envelope?.deletedFiles?.length) {
    out.push("", `已删除文件 (${stage.envelope.deletedFiles.length}):`);
    for (const d of stage.envelope.deletedFiles) out.push(`  🗑 ${d}`);
  }
  if (stage.notes.length > 0) {
    out.push("", "插话与督导:");
    for (const n of stage.notes) out.push(...wrapPlainText(`  • ${n}`, rightW - 2, 2));
  }
  const conclusion = stage.envelope?.feedbackForUpstream ?? stage.envelope?.summary ?? stage.assistantText;
  if (conclusion) out.push("", "交付结论:", ...wrapPlainText(conclusion, rightW - 2, 8));
  return out;
}

export async function openFlowRoomOverlay(deps: FlowRoomOverlayDeps): Promise<void> {
  const ui = deps.ctx?.ui;
  if (typeof ui?.custom !== "function") return;
  await ui.custom((tui: any, theme: any, kb: any, done: (res: undefined) => void) => {
    const fg = (c: string, s: string): string => (typeof theme?.fg === "function" ? theme.fg(c, s) : s);
    let focused = true, cursor = Math.max(0, deps.room.getSnapshot().entries.length - 1);
    let followTail = true, rightScroll = 0, draft = "", statusNote = "";
    const unsub = deps.room.subscribe(() => {
      if (followTail) cursor = Math.max(0, deps.room.getSnapshot().entries.length - 1);
      tui?.requestRender?.();
    });
    const timer = setInterval(() => { if (deps.room.isRunning()) tui?.requestRender?.(); }, 400);
    const cleanup = () => { clearInterval(timer); unsub(); };

    return {
      get focused() { return focused; }, set focused(v: boolean) { focused = v; },
      capturesInput() { return true; }, invalidate() {}, dispose() { cleanup(); },
      handleInput(data: string) {
        const ev = parseFlowOverlayInput(data, kb, draft.length > 0);
        if (!ev) return;
        const snap = deps.room.getSnapshot();
        if (ev.kind === "escape") {
          if (draft.length > 0) { draft = ""; statusNote = ""; tui?.requestRender?.(); return; }
          cleanup(); done(undefined); return;
        }
        if (ev.kind === "up" || ev.kind === "down") {
          const last = Math.max(0, snap.entries.length - 1);
          cursor = ev.kind === "up" ? Math.max(0, cursor - 1) : Math.min(last, cursor + 1);
          followTail = cursor >= last; rightScroll = 0; tui?.requestRender?.(); return;
        }
        if (ev.kind === "scroll_up") { rightScroll = Math.max(0, rightScroll - 3); tui?.requestRender?.(); return; }
        if (ev.kind === "scroll_down") { rightScroll += 3; tui?.requestRender?.(); return; }
        if (ev.kind === "backspace") { draft = Array.from(draft).slice(0, -1).join(""); tui?.requestRender?.(); return; }
        if (ev.kind === "text") { draft += ev.text; tui?.requestRender?.(); return; }
        const onErr = (err: unknown) => { statusNote = `✕ ${err instanceof Error ? err.message : String(err)}`; tui?.requestRender?.(); };
        if (ev.kind === "cancel_flow") {
          void deps.room.cancelActiveFlow(deps.ctx).then((ok) => {
            statusNote = ok ? "⏹ 已发送中止指令" : "当前无运行中的 Flow"; tui?.requestRender?.();
          }, onErr);
          return;
        }
        if (ev.kind === "resume_flow") {
          if (deps.onResume && deps.room.isResumable()) {
            followTail = true; statusNote = "▶ 正在从断点续跑 Flow";
            void deps.onResume().then(() => tui?.requestRender?.(), onErr);
          } else statusNote = "当前无待续跑的中断 Flow";
          tui?.requestRender?.();
          return;
        }
        if (ev.kind === "enter") {
          const msg = draft.trim();
          if (!msg) return;
          draft = ""; followTail = true;
          if (deps.room.isRunning()) {
            void deps.room.postUserSteer(msg, deps.ctx).then((r) => {
              statusNote = r.delivered ? "✓ 已实时插话至当前 Agent" : r.queuedForRole ? `✓ 已为 @${r.queuedForRole} 排队定向留言` : "✓ 已记录留言";
              tui?.requestRender?.();
            }, onErr);
          } else if (deps.onFollowUp) {
            statusNote = "▶ 已发起新一轮协作"; void deps.onFollowUp(msg).then(() => tui?.requestRender?.(), onErr);
          } else void deps.room.postUserSteer(msg, deps.ctx).then(() => tui?.requestRender?.(), onErr);
          tui?.requestRender?.();
        }
      },
      render(width: number): string[] {
        const snap = deps.room.getSnapshot();
        if (cursor >= snap.entries.length) cursor = Math.max(0, snap.entries.length - 1);
        const inner = Math.max(46, width - 4), bodyRows = 14;
        const leftW = Math.max(22, Math.floor(inner * 0.5)), rightW = Math.max(20, inner - leftW - 3);
        const title = `⇄ Flow 协作群聊与动作检查器 · ${snap.roleChain.join(" → ") || "待命"} [${statusBadge(snap.status).text}]`;
        const out = [fg("border", `╭─ ${padLeftCell(title, inner - 2)} ─╮`)];
        const flatLeft: string[] = [];
        let selectedEnd = 0;
        snap.entries.forEach((e, idx) => {
          for (const l of renderChatBubbleLines(e, leftW, { selected: idx === cursor, maxBodyLines: 3, theme })) flatLeft.push(l);
          if (idx === cursor) selectedEnd = flatLeft.length;
        });
        const leftStart = Math.max(0, Math.min(flatLeft.length - bodyRows, selectedEnd - bodyRows + 2));
        const visibleLeft = flatLeft.length > 0 ? flatLeft.slice(leftStart, leftStart + bodyRows)
          : [fg("muted", padLeftCell("  (暂无群聊记录，可在下方直接输入发起协作)", leftW))];
        const inspectorAll = buildInspectorLines(snap, snap.entries[cursor], rightW);
        rightScroll = Math.min(rightScroll, Math.max(0, inspectorAll.length - bodyRows));
        const visibleRight = inspectorAll.slice(rightScroll, rightScroll + bodyRows);
        for (let r = 0; r < bodyRows; r++) {
          out.push(`${fg("border", "│")} ${visibleLeft[r] ?? " ".repeat(leftW)} ${fg("border", "│")} ${padLeftCell(visibleRight[r] ?? "", rightW)} ${fg("border", "│")}`);
        }
        out.push(fg("border", `├─${"─".repeat(inner)}─┤`));
        const hint = snap.status === "running" ? "实时插话 (Enter 发送给当前 Agent，支持 @role 定向)" : "发起跟进 (Enter 启动协作，支持 @role)";
        const inputLine = draft ? `💬 你: ${draft}█` : `💬 ${hint}...`;
        out.push(`${fg("border", "│")} ${draft ? fg("accent", padLeftCell(inputLine, inner)) : fg("muted", padLeftCell(inputLine, inner))} ${fg("border", "│")}`);
        const resumeHint = deps.room.isResumable() ? "Ctrl+R 断点续跑 · " : "";
        const foot = `${statusNote ? `${statusNote} · ` : ""}${resumeHint}↑↓ 选消息 · PgUp/PgDn(Alt+[/]) 滚详情 · 输入+Enter 插话 · Ctrl+X 中止 · Esc 关闭`;
        out.push(fg("border", `╰─ ${padLeftCell(foot, inner - 2)} ─╯`));
        return out;
      },
    };
  }, { overlay: true });
}
