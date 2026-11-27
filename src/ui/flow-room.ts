import path from "node:path";
import type { FlowRoomSnapshot, FlowRoomStatus, FlowRoomUiAdapter } from "../flow/state.ts";
import { FlowRoomManager } from "../flow/state.ts";
import type { ObservedToolCall, RoomEntry } from "../core/types.ts";
import {
  renderConcurrentWidgetSummary, renderGraphNodeInspectorSection, renderWaveOverviewBar,
} from "./flow-graph-view.ts";
import {
  decodeKittyCsiU, padLeftCell, padRightCell, parseOverlayKey,
  truncateDisplay, wrapPlainText,
} from "./kit.ts";

export {
  FlowRoomManager, padLeftCell, padRightCell, truncateDisplay, wrapPlainText,
  type FlowRoomSnapshot, type FlowRoomStatus, type FlowRoomUiAdapter,
};

export type MonitorInputEvent =
  | { kind: "escape" } | { kind: "next_project" } | { kind: "prev_project" }
  | { kind: "up" } | { kind: "down" } | { kind: "scroll_up" } | { kind: "scroll_down" } | { kind: "cancel_flow" };

export interface FlowMonitorTarget { cwd: string; room: FlowRoomManager; getSnapshot?: () => FlowRoomSnapshot; }

export interface FlowRoomOverlayDeps {
  ctx: any; room?: FlowRoomManager; targets?: readonly FlowMonitorTarget[]; getTargets?: () => readonly FlowMonitorTarget[];
}

const targetSnap = (t?: FlowMonitorTarget): FlowRoomSnapshot =>
  t ? (t.getSnapshot ? t.getSnapshot() : t.room.getSnapshot())
    : { flowId: null, goal: "", roleChain: [], status: "idle", startedAt: null, endedAt: null, activeStageId: null, entries: [], stages: [] };

const toneColor = (t: RoomEntry["tone"]): string =>
  t === "success" ? "success" : t === "warning" ? "warning" : t === "error" ? "error" : "accent";

export function flowStatusIcon(status: string): string {
  if (status === "running") return "●";
  if (status === "waiting_input") return "?";
  if (status === "completed") return "✓";
  if (status === "interrupted" || status === "cancelled") return "⏸";
  if (
    status === "blocked" || status === "rejected_max_rounds" || status === "stagnated" ||
    status === "violation" || status === "aborted_by_supervisor" || status === "failed"
  ) {
    return "!";
  }
  return "○";
}

function snapshotStatusBadge(snap: Pick<FlowRoomSnapshot, "status" | "stages">): { text: string; color: string } {
  const s = snap.status;
  if (s === "completed" && snap.stages.at(-1)?.envelope?.verdict === "rejected") {
    return { text: "✓ 审查完成（发现阻断项）", color: "warning" };
  }
  return s === "running" ? { text: "● 运行中", color: "accent" }
    : s === "waiting_input" ? { text: "? 待你确认", color: "warning" }
      : s === "interrupted" ? { text: "⏸ 中断可续跑", color: "warning" }
        : s === "completed" ? { text: "✓ 已完成", color: "success" }
          : s === "blocked" ? { text: "! 需你介入", color: "warning" }
            : s === "cancelled" ? { text: "⏹ 已取消", color: "muted" }
              : s === "violation" ? { text: "✕ 越界拦截", color: "error" }
                : s === "failed" ? { text: "✕ 异常中止", color: "error" } : { text: "○ 空闲", color: "muted" };
}

const shortProjectLabel = (cwd?: string): string => (cwd ? path.basename(cwd) || cwd : "workspace");

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

export function renderMultiProjectWidgetLines(
  targets: readonly FlowMonitorTarget[], width: number, theme?: any,
): string[] {
  const active = targets.filter((t) => {
    const st = t.room.getSnapshot().status;
    return st === "running" || st === "waiting_input";
  });
  if (active.length === 0) return [];
  const inner = Math.max(28, width - 4);
  const fg = (c: string, s: string): string => (typeof theme?.fg === "function" ? theme.fg(c, s) : s);
  const head = `⇄ 后台专员动态 (${active.length} 个项目活跃 · /flow 打开监控窗)`;
  const lines = [fg("border", `╭─ ${padLeftCell(head, inner - 2)} ─╮`)];
  for (const item of active.slice(0, 4)) {
    const snap = item.room.getSnapshot();
    const icon = flowStatusIcon(snap.status);
    const curStage = snap.stages.find((s) => s.stageId === snap.activeStageId) ?? snap.stages.at(-1);
    const graphSummary = snap.graphSnapshot ? renderConcurrentWidgetSummary(snap.graphSnapshot) : null;
    const detail = snap.status === "waiting_input"
      ? (graphSummary ?? `待确认: ${curStage?.envelope?.questionsForUser?.[0] ?? snap.reason ?? snap.goal}`)
      : graphSummary ?? (curStage
        ? `${curStage.roleId} (${curStage.modelLabel})${curStage.activeTool ? ` → ${curStage.activeTool}` : ` · 工具 ${curStage.calls.length} 次`}`
        : snap.goal);
    const row = `${icon} [${shortProjectLabel(item.cwd)}] ${snap.roleChain.join("→")} · ${detail}`;
    const colored = fg(snap.status === "waiting_input" ? "warning" : "accent", padLeftCell(row, inner));
    lines.push(`${fg("border", "│")} ${colored} ${fg("border", "│")}`);
  }
  const more = active.length > 4 ? ` (+${active.length - 4} 个项目) · ` : "";
  const foot = `${more}目标: ${active[0]!.room.getSnapshot().goal}`;
  lines.push(fg("border", `╰─ ${padLeftCell(foot, inner - 2)} ─╯`));
  return lines;
}

export function renderRoomCardLines(snapshot: FlowRoomSnapshot, width: number, expanded: boolean, theme?: any): string[] {
  const inner = Math.max(28, width - 4);
  const fg = (c: string, s: string): string => (typeof theme?.fg === "function" ? theme.fg(c, s) : s);
  const totalCalls = snapshot.stages.reduce((acc, s) => acc + s.calls.length, 0);
  const proj = snapshot.cwd ? `[${shortProjectLabel(snapshot.cwd)}] ` : "";
  const title = `⇄ 协作纪要 · ${proj}${snapshot.roleChain.join(" → ")} [${snapshotStatusBadge(snapshot).text}] · 工具 ${totalCalls} 次`;
  const lines = [fg("border", `╭─ ${padLeftCell(title, inner - 2)} ─╮`)];
  if (snapshot.graphSnapshot && snapshot.graphSnapshot.waves.length > 0) {
    lines.push(`${fg("border", "│")} ${padLeftCell(renderWaveOverviewBar(snapshot.graphSnapshot, inner, theme), inner)} ${fg("border", "│")}`);
  }
  if (snapshot.graphSnapshot?.mergedRef) {
    const sha = snapshot.graphSnapshot.mergedCommitSha ? ` (${snapshot.graphSnapshot.mergedCommitSha.slice(0, 12)})` : "";
    lines.push(`${fg("border", "│")} ${fg("success", padLeftCell(`📦 交付引用: ${snapshot.graphSnapshot.mergedRef}${sha}`, inner))} ${fg("border", "│")}`);
  }
  for (const entry of snapshot.entries) {
    for (const row of renderChatBubbleLines(entry, inner, { maxBodyLines: expanded ? 5 : 2, theme })) lines.push(`${fg("border", "│")} ${row} ${fg("border", "│")}`);
  }
  if (expanded && snapshot.stages.length > 0) {
    lines.push(fg("border", `├─ ${padLeftCell("🔎 专员动作轨迹 (Ctrl+O 收起)", inner - 2)} ─┤`));
    for (const st of snapshot.stages) {
      lines.push(`${fg("border", "│")} ${fg("accent", padLeftCell(`• ${st.roleId} (${st.modelLabel}) [${st.status}] · 工具 ${st.calls.length} 次`, inner))} ${fg("border", "│")}`);
      st.calls.forEach((c: ObservedToolCall, i: number) => {
        lines.push(`${fg("border", "│")} ${padLeftCell(`  ${i + 1}. ${c.isError ? "✕" : "✓"} ${c.summary ?? c.toolName}`, inner)} ${fg("border", "│")}`);
      });
      if (st.envelope && st.envelope.artifacts.length > 0) {
        const arts = st.envelope.artifacts.map((a) => `${a.path}#${a.sha256.slice(0, 8)} [${a.role}]`).join(", ");
        lines.push(`${fg("border", "│")} ${fg("muted", padLeftCell(`  📦 ${arts}`, inner))} ${fg("border", "│")}`);
      }
      if (st.envelope?.deletedFiles?.length) {
        lines.push(`${fg("border", "│")} ${fg("warning", padLeftCell(`  🗑 ${st.envelope.deletedFiles.join(", ")}`, inner))} ${fg("border", "│")}`);
      }
      if (st.envelope?.questionsForUser?.length) {
        lines.push(`${fg("border", "│")} ${fg("warning", padLeftCell(`  ❓ ${st.envelope.questionsForUser.join(" | ")}`, inner))} ${fg("border", "│")}`);
      }
    }
  }
  const hint = expanded ? "Ctrl+O 收起工具轨迹 · /flow 打开只读监控窗" : "Ctrl+O 展开每个专员工具轨迹 · /flow 打开只读监控窗";
  lines.push(fg("border", `╰─ ${padLeftCell(hint, inner - 2)} ─╯`));
  return lines;
}

export function createFlowRoomUiAdapter(
  pi: any, getActiveTargets?: () => readonly FlowMonitorTarget[],
): FlowRoomUiAdapter {
  let widgetTui: any = null;
  const syncWidget = (fallbackRoom: FlowRoomManager | null, ctx?: any) => {
    if (!ctx?.hasUI || typeof ctx?.ui?.setWidget !== "function") return;
    const targets = getActiveTargets
      ? getActiveTargets().filter((t) => {
          const st = t.room.getSnapshot().status;
          return st === "running" || st === "waiting_input";
        })
      : (fallbackRoom && (fallbackRoom.isRunning() || fallbackRoom.getSnapshot().status === "waiting_input")
          ? [{ cwd: fallbackRoom.getSnapshot().cwd ?? ctx?.cwd ?? process.cwd(), room: fallbackRoom }]
          : []);
    if (targets.length === 0) {
      widgetTui = null;
      try { ctx.ui.setWidget("omp-enhance-flow", undefined); } catch {}
      return;
    }
    try {
      ctx.ui.setWidget("omp-enhance-flow", (tui: any, theme: any) => {
        widgetTui = tui;
        return {
          invalidate() {},
          render: (width: number): string[] => {
            const liveTargets = getActiveTargets ? getActiveTargets() : targets;
            return renderMultiProjectWidgetLines(liveTargets, width, theme);
          },
        };
      }, { placement: "aboveEditor" });
    } catch {}
  };
  return {
    mountWidget(room, ctx) { syncWidget(room, ctx); },
    clearWidget(ctx) { syncWidget(null, ctx); },
    sendSummaryCard(snap, summary, ctx) {
      if (!ctx?.hasUI || typeof pi?.sendMessage !== "function") return;
      try {
        const opts = { triggerTurn: false, ...(ctx?.isIdle?.() === false ? { deliverAs: "followUp" } : {}) };
        pi.sendMessage({
          customType: "omp-enhance-room", display: true, excludeFromContext: true, details: snap,
          content: `[Flow ${snap.roleChain.join(" → ")} · ${snapshotStatusBadge(snap).text}] ${summary}`,
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

export function parseFlowOverlayInput(data: string, kb?: any): MonitorInputEvent | null {
  if (!data || data.startsWith("\x1b[<") || /^\x1b\[[0-9;:]*:3[u~A-Z]$/.test(data)) return null;
  if (data === "\x18") return { kind: "cancel_flow" };
  if (data === "\x1b[Z") return { kind: "prev_project" };
  if (data === "\x1b[" || data === "\x1b[5~" || kb?.matches?.(data, "tui.select.pageUp")) return { kind: "scroll_up" };
  if (data === "\x1b]" || data === "\x1b[6~" || kb?.matches?.(data, "tui.select.pageDown")) return { kind: "scroll_down" };

  const kitty = decodeKittyCsiU(data);
  if (kitty) {
    const cp = kitty.codepoint, base = kitty.baseCodepoint ?? cp, mod = kitty.modifiers;
    if ((mod & 4) !== 0 && (base === 120 || base === 88)) return { kind: "cancel_flow" };
    if (cp === 57365 || ((mod & 2) !== 0 && base === 91)) return { kind: "scroll_up" };
    if (cp === 57366 || ((mod & 2) !== 0 && base === 93)) return { kind: "scroll_down" };
    if (cp === 9 && (mod & 1) !== 0) return { kind: "prev_project" };
  }

  const key = parseOverlayKey(data, kb);
  if (key === "escape" || key === "q" || key === "Q") return { kind: "escape" };
  if (key === "tab" || key === "right" || key === "]") return { kind: "next_project" };
  if (key === "left" || key === "[") return { kind: "prev_project" };
  if (key === "up") return { kind: "up" };
  if (key === "down") return { kind: "down" };
  return null;
}

function buildInspectorLines(snap: FlowRoomSnapshot, selected: RoomEntry | undefined, rightW: number, cwd?: string): string[] {
  const stage = selected?.stageId ? snap.stages.find((s) => s.stageId === selected.stageId) : undefined;
  if (!stage) {
    const lines = [
      ...(cwd ? [`目录: ${cwd}`] : []),
      `Flow: ${snap.flowId ?? "(空闲)"}`,
      `状态: ${snapshotStatusBadge(snap).text}${snap.remoteOwnerPid ? ` (在另一窗口运行 pid=${snap.remoteOwnerPid})` : ""}`,
      ...(snap.updatedAt ? [`更新时间: ${snap.updatedAt}`] : []),
      `专员链: ${snap.roleChain.length > 0 ? snap.roleChain.join(" → ") : "(无)"}`, "─".repeat(Math.min(28, rightW)),
      selected ? `发言者: ${selected.speaker} (${selected.badge ?? "消息"})` : "说明: 只读监控窗；任务派发与补充回答请在 /coord 聊天框进行",
    ];
    if (selected?.text) lines.push(...wrapPlainText(selected.text, rightW - 2, 8));
    if (snap.graphSnapshot && snap.graphSnapshot.nodes.length > 0) {
      lines.push("", ...renderGraphNodeInspectorSection(snap.graphSnapshot, rightW));
    } else if (snap.stages.length > 0) {
      lines.push("", `阶段概览 (${snap.stages.length}):`);
      snap.stages.forEach((s, i) => lines.push(` ${i + 1}. ${s.roleId} [${s.status}] · 工具 ${s.calls.length} 次`));
    }
    return lines;
  }
  const elapsedSec = Math.max(0, Math.round(((stage.endedAt ? Date.parse(stage.endedAt) : Date.now()) - Date.parse(stage.startedAt)) / 1000));
  const out: string[] = [
    `专员: ${stage.roleId} (${stage.roleName}) · R${stage.round}`,
    `模型: ${stage.modelLabel}  状态: ${stage.status}  耗时: ${elapsedSec}s`,
    ...(stage.activeTool ? [`当前动作: ⚙ ${stage.activeTool}`] : []),
    ...(stage.hostError ? wrapPlainText(`异常原因: ${stage.hostError}`, rightW - 2, 3) : []),
    "─".repeat(Math.min(28, rightW)), `动作时间线 (${stage.calls.length}):`,
  ];
  if (stage.calls.length === 0) out.push("  (尚无工具调用)");
  stage.calls.forEach((c, i) => out.push(`  ${i + 1}. ${c.isError ? "✕" : "✓"} ${c.summary ?? c.toolName}`));
  if (stage.envelope?.questionsForUser?.length) {
    out.push("", `待用户确认问题 (${stage.envelope.questionsForUser.length}):`);
    for (const q of stage.envelope.questionsForUser) out.push(...wrapPlainText(`  ❓ ${q}`, rightW - 2, 3));
  }
  if (stage.envelope && stage.envelope.artifacts.length > 0) {
    out.push("", `产物快照 (${stage.envelope.artifacts.length}):`);
    for (const a of stage.envelope.artifacts) out.push(`  📦 ${a.path} [${a.role}] (${a.sha256.slice(0, 8)})`);
  }
  if (stage.envelope?.deletedFiles?.length) {
    out.push("", `已删除文件 (${stage.envelope.deletedFiles.length}):`);
    for (const d of stage.envelope.deletedFiles) out.push(`  🗑 ${d}`);
  }
  if (stage.notes.length > 0) {
    out.push("", "留言与督导:");
    for (const n of stage.notes) out.push(...wrapPlainText(`  • ${n}`, rightW - 2, 2));
  }
  const conclusion = stage.envelope?.feedbackForUpstream ?? stage.envelope?.summary ?? stage.assistantText;
  if (conclusion) out.push("", "交付结论:", ...wrapPlainText(conclusion, rightW - 2, 8));
  if (snap.graphSnapshot && snap.graphSnapshot.nodes.length > 0) {
    out.push("", ...renderGraphNodeInspectorSection(snap.graphSnapshot, rightW));
  }
  return out;
}

function pickInitialProjectIdx(targets: readonly FlowMonitorTarget[]): number {
  const activeIdx = targets.findIndex((t) => { const st = targetSnap(t).status; return st === "running" || st === "waiting_input"; });
  if (activeIdx >= 0) return activeIdx;
  const nonIdleIdx = targets.findIndex((t) => { const snap = targetSnap(t); return snap.status !== "idle" || snap.stages.length > 0 || snap.entries.length > 0; });
  return nonIdleIdx >= 0 ? nonIdleIdx : 0;
}

export async function openFlowRoomOverlay(deps: FlowRoomOverlayDeps): Promise<void> {
  const ui = deps.ctx?.ui;
  if (typeof ui?.custom !== "function") return;
  const resolveTargets = (): readonly FlowMonitorTarget[] => {
    const dynamic = deps.getTargets?.() ?? deps.targets;
    if (dynamic && dynamic.length > 0) return dynamic;
    return deps.room ? [{ cwd: deps.room.getSnapshot().cwd ?? deps.ctx?.cwd ?? process.cwd(), room: deps.room }] : [];
  };

  await ui.custom((tui: any, theme: any, kb: any, done: (res: undefined) => void) => {
    const fg = (c: string, s: string): string => (typeof theme?.fg === "function" ? theme.fg(c, s) : s);
    const initialTargets = resolveTargets();
    let focused = true, projectIdx = pickInitialProjectIdx(initialTargets), followTail = true, rightScroll = 0, statusNote = "";
    let cursor = Math.max(0, (targetSnap(initialTargets[projectIdx]).entries.length || 1) - 1);
    const unsubs = new Map<FlowRoomManager, () => void>();
    const syncSubs = () => {
      for (const t of resolveTargets()) {
        if (unsubs.has(t.room)) continue;
        unsubs.set(t.room, t.room.subscribe(() => {
          const cur = resolveTargets()[projectIdx];
          if (followTail && cur?.room === t.room) cursor = Math.max(0, targetSnap(cur).entries.length - 1);
          tui?.requestRender?.();
        }));
      }
    };
    syncSubs();
    const timer = setInterval(() => {
      syncSubs();
      if (resolveTargets().some((t) => targetSnap(t).status === "running")) tui?.requestRender?.();
    }, 400);
    const cleanup = () => { clearInterval(timer); for (const u of unsubs.values()) u(); unsubs.clear(); };

    return {
      get focused() { return focused; }, set focused(v: boolean) { focused = v; },
      capturesInput() { return true; }, invalidate() {}, dispose() { cleanup(); },
      handleInput(data: string) {
        const ev = parseFlowOverlayInput(data, kb);
        if (!ev) return;
        const targets = resolveTargets();
        if (ev.kind === "escape") { cleanup(); done(undefined); return; }
        if ((ev.kind === "next_project" || ev.kind === "prev_project") && targets.length > 0) {
          projectIdx = ev.kind === "next_project" ? (projectIdx + 1) % targets.length : (projectIdx - 1 + targets.length) % targets.length;
          const snap = targetSnap(targets[projectIdx]);
          cursor = Math.max(0, snap.entries.length - 1); followTail = true; rightScroll = 0; statusNote = "";
          tui?.requestRender?.(); return;
        }
        const activeTarget = targets[Math.min(projectIdx, Math.max(0, targets.length - 1))];
        if (!activeTarget) return;
        const snap = targetSnap(activeTarget);
        if (ev.kind === "up" || ev.kind === "down") {
          const last = Math.max(0, snap.entries.length - 1);
          cursor = ev.kind === "up" ? Math.max(0, cursor - 1) : Math.min(last, cursor + 1);
          followTail = cursor >= last; rightScroll = 0; tui?.requestRender?.(); return;
        }
        if (ev.kind === "scroll_up") { rightScroll = Math.max(0, rightScroll - 3); tui?.requestRender?.(); return; }
        if (ev.kind === "scroll_down") { rightScroll += 3; tui?.requestRender?.(); return; }
        if (ev.kind === "cancel_flow") {
          void activeTarget.room.cancelActiveFlow(deps.ctx).then(
            (ok) => { statusNote = ok ? "⏹ 已发送中止指令" : "当前项目无运行中的 Flow"; tui?.requestRender?.(); },
            (err) => { statusNote = `✕ ${err instanceof Error ? err.message : String(err)}`; tui?.requestRender?.(); },
          );
        }
      },
      render(width: number): string[] {
        const targets = resolveTargets();
        projectIdx = Math.min(projectIdx, Math.max(0, targets.length - 1));
        const activeTarget = targets[projectIdx], snap = targetSnap(activeTarget);
        if (cursor >= snap.entries.length) cursor = Math.max(0, snap.entries.length - 1);
        const inner = Math.max(46, width - 4), bodyRows = 14;
        const leftW = Math.max(22, Math.floor(inner * 0.5)), rightW = Math.max(20, inner - leftW - 3);
        const remoteTag = snap.remoteOwnerPid ? ` · 另一窗口(pid=${snap.remoteOwnerPid})` : "";
        const title = `⇄ Flow 跨项目只读监控窗 · ${snap.roleChain.join(" → ") || "待命"} [${snapshotStatusBadge(snap).text}${remoteTag}]`;
        const out = [fg("border", `╭─ ${padLeftCell(title, inner - 2)} ─╮`)];
        const tabs = targets.map((t, i) => {
          const icon = flowStatusIcon(targetSnap(t).status);
          const label = `[${i + 1}/${targets.length} ${icon} ${shortProjectLabel(t.cwd)}]`;
          return i === projectIdx ? fg("accent", `▸${label}`) : fg("muted", ` ${label}`);
        }).join(" ");
        const projBar = targets.length > 0 ? `${tabs}  ${fg("muted", activeTarget?.cwd ?? "")}` : fg("muted", "(暂无受管项目)");
        out.push(`${fg("border", "│")} ${padLeftCell(projBar, inner)} ${fg("border", "│")}`);
        if (snap.graphSnapshot && snap.graphSnapshot.waves.length > 0) {
          out.push(`${fg("border", "│")} ${padLeftCell(renderWaveOverviewBar(snap.graphSnapshot, inner, theme), inner)} ${fg("border", "│")}`);
        }
        out.push(fg("border", `├─${"─".repeat(inner)}─┤`));

        const flatLeft: string[] = [];
        let selectedEnd = 0;
        snap.entries.forEach((e, idx) => {
          for (const l of renderChatBubbleLines(e, leftW, { selected: idx === cursor, maxBodyLines: 3, theme })) flatLeft.push(l);
          if (idx === cursor) selectedEnd = flatLeft.length;
        });
        const leftStart = Math.max(0, Math.min(flatLeft.length - bodyRows, selectedEnd - bodyRows + 2));
        const visibleLeft = flatLeft.length > 0 ? flatLeft.slice(leftStart, leftStart + bodyRows)
          : [fg("muted", padLeftCell("  (暂无后台专员记录；敲 /coord 用自然语言派单)", leftW))];
        const inspectorAll = buildInspectorLines(snap, snap.entries[cursor], rightW, activeTarget?.cwd);
        rightScroll = Math.min(rightScroll, Math.max(0, inspectorAll.length - bodyRows));
        const visibleRight = inspectorAll.slice(rightScroll, rightScroll + bodyRows);
        for (let r = 0; r < bodyRows; r++) {
          out.push(`${fg("border", "│")} ${visibleLeft[r] ?? " ".repeat(leftW)} ${fg("border", "│")} ${padLeftCell(visibleRight[r] ?? "", rightW)} ${fg("border", "│")}`);
        }
        const foot = `${statusNote ? `${statusNote} · ` : ""}Tab/[ ]/←→ 切项目 · ↑↓ 选阶段 · PgUp/PgDn 滚详情 · Ctrl+X 中止 · Esc/q 关闭`;
        out.push(fg("border", `╰─ ${padLeftCell(foot, inner - 2)} ─╯`));
        return out;
      },
    };
  }, { overlay: true });
}
