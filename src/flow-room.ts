import type { FlowRunResult, FlowStageTrace, ObservedToolCall, RoomEntry } from "./types.ts";
import type { EnhanceStore } from "./store.ts";
import type { ActiveStageControls, FlowObserver } from "./orchestrator.ts";

export type FlowRoomStatus = "idle" | "running" | "interrupted" | "completed" | "blocked" | "failed" | "cancelled";
export interface FlowRoomSnapshot {
  flowId: string | null; goal: string; roleChain: string[]; status: FlowRoomStatus; reason?: string;
  currentIndex?: number; startedAt: string | null; endedAt: string | null; activeStageId: string | null;
  entries: RoomEntry[]; stages: FlowStageTrace[];
}
export interface FlowRoomOverlayDeps {
  ctx: any; room: FlowRoomManager; onFollowUp?: (text: string) => Promise<void>; onResume?: () => Promise<void>;
}

export function truncateDisplay(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (Bun.stringWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";
  let out = "";
  for (const ch of Array.from(text)) {
    if (Bun.stringWidth(`${out}${ch}…`) > maxWidth) break;
    out += ch;
  }
  return `${out}…`;
}
export const padLeftCell = (text: string, width: number): string => {
  if (width <= 0) return "";
  const c = truncateDisplay(text, width);
  return c + " ".repeat(Math.max(0, width - Bun.stringWidth(c)));
};
export const padRightCell = (text: string, width: number): string => {
  if (width <= 0) return "";
  const c = truncateDisplay(text, width);
  return " ".repeat(Math.max(0, width - Bun.stringWidth(c))) + c;
};
export function wrapPlainText(text: string, maxWidth: number, maxLines = 4): string[] {
  const limit = Math.max(8, maxWidth), out: string[] = [];
  for (const raw of (text || "").replace(/\r\n/g, "\n").split("\n")) {
    const t = raw.trimEnd();
    if (!t) { if (out.length > 0 && out.length < maxLines) out.push(""); continue; }
    let cur = "";
    for (const ch of Array.from(t)) {
      if (Bun.stringWidth(cur + ch) > limit && cur.length > 0) {
        out.push(cur);
        if (out.length >= maxLines) return [...out.slice(0, maxLines - 1), truncateDisplay(`${out[maxLines - 1]}…`, limit)];
        cur = ch;
      } else cur += ch;
    }
    if (cur) {
      out.push(cur);
      if (out.length > maxLines) return [...out.slice(0, maxLines - 1), truncateDisplay(`${out[maxLines - 1]}…`, limit)];
    }
  }
  return out.length > 0 ? out.slice(0, maxLines) : [""];
}

const toneColor = (t: RoomEntry["tone"]): string =>
  t === "success" ? "success" : t === "warning" ? "warning" : t === "error" ? "error" : "accent";
const statusBadge = (s: FlowRoomStatus): { text: string; color: string } =>
  s === "running" ? { text: "● 运行中", color: "accent" }
    : s === "interrupted" ? { text: "⏸ 中断可续跑", color: "warning" }
      : s === "completed" ? { text: "✓ 已完成", color: "success" }
        : s === "blocked" ? { text: "! 需你介入", color: "warning" }
          : s === "cancelled" ? { text: "⏹ 已取消", color: "muted" }
            : s === "failed" ? { text: "✕ 异常中止", color: "error" } : { text: "○ 空闲", color: "muted" };

/** Render a single chat bubble: Agent/Supervisor on the left, User ("你") on the right. */
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

export class FlowRoomManager {
  private flowId: string | null = null; private mandateId = "";
  private goal = ""; private roleChain: string[] = []; private status: FlowRoomStatus = "idle";
  private currentIndex = 0; private repairRound = 0; private lastHandoffId: string | null = null; private maxRepairRounds = 2;
  private reason: string | undefined; private startedAt: string | null = null; private endedAt: string | null = null;
  private activeStageId: string | null = null; private entries: RoomEntry[] = []; private stages: FlowStageTrace[] = [];
  private controls: ActiveStageControls | null = null; private cancelled = false; private seq = 0;
  private widgetTui: any = null; private listeners = new Set<() => void>();

  constructor(private readonly pi: any, private readonly store?: EnhanceStore) { this.hydrateFromStore(); }
  isRunning(): boolean { return this.status === "running"; }
  isResumable(): boolean {
    return Boolean(this.flowId && this.mandateId && this.roleChain.length > 0 &&
      this.currentIndex < this.roleChain.length && (this.status === "interrupted" || this.status === "failed" || this.status === "cancelled"));
  }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private notify(): void {
    try { this.widgetTui?.requestRender?.(); } catch {}
    for (const fn of this.listeners) { try { fn(); } catch {} }
  }
  private persist(): void {
    if (!this.store || !this.flowId || !this.mandateId) return;
    try {
      this.store.saveFlowCheckpoint({
        flowId: this.flowId, mandateId: this.mandateId, goal: this.goal, roleChain: this.roleChain,
        status: this.status, currentIndex: this.currentIndex, repairRound: this.repairRound,
        lastHandoffId: this.lastHandoffId, maxRepairRounds: this.maxRepairRounds,
        snapshotJson: JSON.stringify(this.getSnapshot()), updatedAt: new Date().toISOString(),
      });
    } catch {}
  }
  private hydrateFromStore(): void {
    const cp = this.store?.getLatestFlowCheckpoint();
    if (!cp) return;
    try {
      const snap = JSON.parse(cp.snapshotJson) as FlowRoomSnapshot;
      this.flowId = cp.flowId; this.mandateId = cp.mandateId; this.goal = cp.goal; this.roleChain = [...cp.roleChain];
      this.currentIndex = cp.currentIndex; this.repairRound = cp.repairRound;
      this.lastHandoffId = cp.lastHandoffId; this.maxRepairRounds = cp.maxRepairRounds;
      this.startedAt = snap.startedAt; this.endedAt = snap.endedAt; this.reason = snap.reason;
      this.entries = Array.isArray(snap.entries) ? snap.entries : [];
      this.stages = Array.isArray(snap.stages) ? snap.stages : [];
      this.seq = this.entries.length + 1;
      if (cp.status === "running") {
        this.status = "interrupted"; this.activeStageId = null; this.endedAt = new Date().toISOString();
        this.reason = "上次进程中断，输入 /flow continue 断点续跑";
        for (const st of this.stages) {
          if (st.status === "running") { st.status = "aborted"; st.endedAt = this.endedAt; st.activeTool = null; }
        }
        for (const en of this.entries) {
          if (en.badge?.startsWith("●")) { en.badge = "⏸ 中断"; en.tone = "warning"; en.text = "进程中断，输入 /flow continue (或 Ctrl+R) 从本阶段续跑"; }
        }
        this.persist();
      } else this.status = cp.status as FlowRoomStatus;
    } catch {}
  }

  getSnapshot(): FlowRoomSnapshot {
    return {
      flowId: this.flowId, goal: this.goal, roleChain: [...this.roleChain], status: this.status,
      currentIndex: this.currentIndex, ...(this.reason ? { reason: this.reason } : {}),
      startedAt: this.startedAt, endedAt: this.endedAt,
      activeStageId: this.activeStageId, entries: this.entries.map((e) => ({ ...e })),
      stages: this.stages.map((s) => ({
        ...s, calls: s.calls.map((c) => ({ ...c, touchedPaths: [...c.touchedPaths] })), notes: [...s.notes],
      })),
    };
  }

  private insertBeforeRunning(entry: RoomEntry): void {
    const idx = this.activeStageId ? this.entries.findIndex((e) => e.id === `stage-${this.activeStageId}`) : -1;
    if (idx >= 0) this.entries.splice(idx, 0, entry); else this.entries.push(entry);
  }

  beginFlow(input: {
    mandateId?: string; goal: string; roleChain: string[]; maxRepairRounds?: number;
    lastHandoffId?: string | null; initiatorText?: string; ctx?: any;
  }): string {
    if (this.status === "running") throw new Error("已有正在运行的协作 Flow；可通过 steer 插话、/flow 查看或 cancel 取消。");
    this.seq += 1; this.flowId = `flow-${Date.now().toString(36)}-${this.seq}`;
    this.mandateId = input.mandateId ?? ""; this.goal = input.goal; this.roleChain = [...input.roleChain];
    this.currentIndex = 0; this.repairRound = 0; this.lastHandoffId = input.lastHandoffId ?? null;
    this.maxRepairRounds = input.maxRepairRounds ?? 2; this.status = "running";
    this.reason = undefined; this.startedAt = new Date().toISOString(); this.endedAt = null;
    this.activeStageId = null; this.controls = null; this.cancelled = false; this.stages = [];
    this.entries = [{
      id: `user-${this.seq}-init`, side: "right", speaker: "你", badge: "目标",
      tone: "success", text: input.initiatorText ?? input.goal, timestamp: this.startedAt,
    }];
    this.persist(); this.mountWidget(input.ctx); this.notify();
    return this.flowId;
  }

  resumeFlow(ctx?: any): {
    flowId: string; mandateId: string; roleChain: string[]; startIndex: number;
    repairRound: number; lastHandoffId: string | null; maxRepairRounds: number;
  } {
    if (!this.isResumable()) throw new Error("当前没有可断点续跑的中断/失败 Flow。");
    this.status = "running"; this.cancelled = false; this.endedAt = null; this.reason = undefined; this.seq += 1;
    const roleId = this.roleChain[this.currentIndex]!, retryId = `${this.currentIndex}:${roleId}:r${this.repairRound}`;
    const prev = this.stages.find((s) => s.stageId === retryId);
    if (prev) {
      const archived = `${retryId}-prev${this.seq}`; prev.stageId = archived;
      for (const e of this.entries) { if (e.id === `stage-${retryId}`) e.id = `stage-${archived}`; if (e.stageId === retryId) e.stageId = archived; }
    }
    this.entries.push({
      id: `user-${this.seq}-resume`, side: "right", speaker: "你", badge: "续跑", tone: "success",
      text: `从阶段 ${this.currentIndex + 1}/${this.roleChain.length} (${roleId}) 断点继续`, timestamp: new Date().toISOString(),
    });
    this.persist(); this.mountWidget(ctx); this.notify();
    return {
      flowId: this.flowId!, mandateId: this.mandateId, roleChain: [...this.roleChain],
      startIndex: this.currentIndex, repairRound: this.repairRound,
      lastHandoffId: this.lastHandoffId, maxRepairRounds: this.maxRepairRounds,
    };
  }

  async postUserSteer(message: string, ctx?: any): Promise<{ delivered: boolean; activeStageId: string | null }> {
    const clean = message.trim();
    if (!clean) return { delivered: false, activeStageId: this.activeStageId };
    this.seq += 1;
    this.insertBeforeRunning({
      id: `user-${this.seq}`, side: "right", speaker: "你", badge: this.status === "running" ? "插话" : "留言",
      tone: "success", text: clean, timestamp: new Date().toISOString(),
      ...(this.activeStageId ? { stageId: this.activeStageId } : {}),
    });
    const active = this.stages.find((s) => s.stageId === this.activeStageId);
    if (active) active.notes.push(`你插话: ${clean}`);
    let delivered = false;
    if (this.status === "running" && this.controls) { await this.controls.steer(clean); delivered = true; }
    if (this.status === "running") this.mountWidget(ctx);
    this.persist(); this.notify();
    return { delivered, activeStageId: this.activeStageId };
  }

  async cancelActiveFlow(ctx?: any): Promise<boolean> {
    if (this.status !== "running") return false;
    this.cancelled = true; this.seq += 1;
    this.insertBeforeRunning({
      id: `user-${this.seq}-cancel`, side: "right", speaker: "你", badge: "中止",
      tone: "warning", text: "停止当前协作 Flow", timestamp: new Date().toISOString(),
    });
    if (this.controls) await this.controls.abort();
    this.clearWidget(ctx); this.persist(); this.notify();
    return true;
  }

  createObserver(_ctx?: any): FlowObserver {
    return {
      isCancelled: () => this.cancelled,
      bindControls: (controls) => { this.controls = controls; },
      onProgress: ({ currentIndex, repairRound, lastHandoffId }) => {
        this.currentIndex = currentIndex; this.repairRound = repairRound; this.lastHandoffId = lastHandoffId;
        this.persist();
      },
      onStageStart: ({ stageId, role, round, toTarget, modelLabel }) => {
        const existing = this.stages.find((s) => s.stageId === stageId);
        if (existing) { existing.modelLabel = modelLabel; this.activeStageId = stageId; this.persist(); this.notify(); return; }
        const entry: RoomEntry = {
          id: `stage-${stageId}`, side: "left", speaker: role.id, target: toTarget,
          badge: round > 0 ? `● 返修#${round}` : "● 执行中", tone: "info",
          text: "正在分析上下文并准备执行...", timestamp: new Date().toISOString(), stageId,
        };
        this.insertBeforeRunning(entry);
        this.stages.push({
          stageId, roleId: role.id, roleName: role.name, round, status: "running", modelLabel,
          startedAt: new Date().toISOString(), endedAt: null, activeTool: null, calls: [],
          assistantText: "", envelope: null, notes: [],
        });
        this.activeStageId = stageId;
        this.persist(); this.notify();
      },
      onToolStart: (stageId, summary) => {
        const st = this.stages.find((s) => s.stageId === stageId);
        if (st) st.activeTool = summary;
        const en = this.entries.find((e) => e.id === `stage-${stageId}`);
        if (en) en.text = `⚙ ${summary}`;
        this.notify();
      },
      onToolEnd: (stageId, call) => {
        const st = this.stages.find((s) => s.stageId === stageId);
        if (st) {
          st.activeTool = null;
          if (!st.calls.some((c) => c.toolCallId === call.toolCallId)) st.calls.push(call);
          const en = this.entries.find((e) => e.id === `stage-${stageId}`);
          if (en) en.text = `${call.isError ? "✕" : "✓"} 已执行 ${st.calls.length} 步 · ${call.summary ?? call.toolName}`;
        }
        this.persist(); this.notify();
      },
      onSupervisorNote: (stageId, note) => {
        const st = this.stages.find((s) => s.stageId === stageId);
        if (st) st.notes.push(note);
        this.seq += 1;
        this.insertBeforeRunning({
          id: `sup-${this.seq}`, side: "left", speaker: "supervisor", target: st?.roleId,
          badge: "↺ 督导", tone: "warning", text: note, timestamp: new Date().toISOString(), stageId,
        });
        this.persist(); this.notify();
      },
      onStageEnd: (stageId, { status, outcome, reason }) => {
        const st = this.stages.find((s) => s.stageId === stageId);
        if (st) {
          st.status = status; st.endedAt = new Date().toISOString(); st.activeTool = null;
          st.assistantText = outcome?.assistantText ?? ""; st.envelope = outcome?.envelope ?? null;
          for (const c of outcome?.observedCalls ?? []) {
            if (!st.calls.some((prev) => prev.toolCallId === c.toolCallId)) st.calls.push(c);
          }
        }
        const en = this.entries.find((e) => e.id === `stage-${stageId}`);
        if (en) {
          if (status === "ready") {
            en.badge = "✓ ready"; en.tone = "success";
            en.text = outcome?.envelope?.summary ?? (outcome?.assistantText || "阶段完成");
          } else if (status === "rejected") {
            en.badge = "✕ rejected"; en.tone = "warning";
            en.target = this.roleChain[0] && this.roleChain[0] !== en.speaker ? this.roleChain[0] : "user";
            en.text = outcome?.envelope?.feedbackForUpstream ?? outcome?.envelope?.summary ?? reason ?? "验收未通过";
          } else if (status === "blocked") {
            en.badge = "! blocked"; en.tone = "warning"; en.target = "user";
            en.text = outcome?.envelope?.summary ?? reason ?? "阶段受阻，需你确认";
          } else {
            en.badge = status === "aborted" ? "⏹ aborted" : "✕ violation"; en.tone = "error";
            en.target = "user"; en.text = reason ?? outcome?.envelope?.summary ?? "执行中止";
          }
        }
        this.activeStageId = [...this.stages].reverse().find((s) => s.status === "running")?.stageId ?? null;
        this.persist(); this.notify();
      },
    };
  }

  private sendCard(snap: FlowRoomSnapshot, summary: string, ctx?: any): void {
    if (!ctx?.hasUI || typeof this.pi?.sendMessage !== "function") return;
    try {
      const opts = { triggerTurn: false, ...(ctx?.isIdle?.() === false ? { deliverAs: "followUp" } : {}) };
      this.pi.sendMessage({
        customType: "omp-enhance-room", display: true, details: snap,
        content: `[Flow ${snap.roleChain.join(" → ")} · ${snap.status}] ${summary}`,
      }, opts);
    } catch {}
  }

  finishFlow(result: FlowRunResult, ctx?: any): FlowRoomSnapshot {
    this.endedAt = new Date().toISOString(); this.activeStageId = null; this.controls = null; this.reason = result.reason;
    this.status = result.status === "completed" ? "completed"
      : result.status === "cancelled" ? "cancelled"
        : (result.status === "blocked" || result.status === "rejected_max_rounds" || result.status === "stagnated") ? "blocked" : "failed";
    if (result.status === "rejected_max_rounds" || result.status === "stagnated") {
      this.seq += 1;
      this.entries.push({
        id: `sys-${this.seq}`, side: "left", speaker: "flow", target: "user",
        badge: result.status === "stagnated" ? "! 停滞升级" : "! 超轮次升级",
        tone: "warning", text: result.reason ?? "多轮修复未收敛，请介入决策。", timestamp: this.endedAt,
      });
    }
    this.clearWidget(ctx); this.persist();
    const snap = this.getSnapshot();
    this.sendCard(snap, result.finalEnvelope?.summary ?? result.reason ?? snap.status, ctx);
    this.notify();
    return snap;
  }

  failFlow(error: unknown, ctx?: any): FlowRoomSnapshot {
    const msg = error instanceof Error ? error.message : String(error);
    this.endedAt = new Date().toISOString(); this.activeStageId = null; this.controls = null;
    this.status = "failed"; this.reason = msg; this.seq += 1;
    this.entries.push({ id: `err-${this.seq}`, side: "left", speaker: "flow", target: "user", badge: "✕ 错误", tone: "error", text: msg, timestamp: this.endedAt });
    this.clearWidget(ctx); this.persist();
    const snap = this.getSnapshot();
    this.sendCard(snap, msg, ctx);
    this.notify();
    return snap;
  }

  mountWidget(ctx?: any): void {
    if (!ctx?.hasUI || typeof ctx?.ui?.setWidget !== "function") return;
    try {
      ctx.ui.setWidget("omp-enhance-flow", (tui: any, theme: any) => {
        this.widgetTui = tui;
        return { invalidate() {}, render: (width: number): string[] => this.renderLiveWidget(width, theme) };
      }, { placement: "aboveEditor" });
    } catch {}
  }
  clearWidget(ctx?: any): void { this.widgetTui = null; try { ctx?.ui?.setWidget?.("omp-enhance-flow", undefined); } catch {} }
  dispose(ctx?: any): void { this.cancelled = true; this.clearWidget(ctx); this.listeners.clear(); }

  renderLiveWidget(width: number, theme?: any): string[] {
    const inner = Math.max(28, width - 4);
    const fg = (c: string, s: string): string => (typeof theme?.fg === "function" ? theme.fg(c, s) : s);
    const head = `⇄ 协作群聊 · ${this.roleChain.join(" → ")} [${statusBadge(this.status).text}] (/flow 详情与插话)`;
    const lines = [fg("border", `╭─ ${padLeftCell(head, inner - 2)} ─╮`)];
    for (const entry of this.entries.slice(-3)) {
      for (const row of renderChatBubbleLines(entry, inner, { maxBodyLines: 1, theme })) lines.push(`${fg("border", "│")} ${row} ${fg("border", "│")}`);
    }
    const active = this.stages.find((s) => s.stageId === this.activeStageId);
    const foot = active ? `⚙ ${active.roleId} (${active.modelLabel}) · 工具 ${active.calls.length} 次${active.activeTool ? ` → ${active.activeTool}` : ""}` : `目标: ${this.goal}`;
    lines.push(fg("border", `╰─ ${padLeftCell(foot, inner - 2)} ─╯`));
    return lines;
  }
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
    }
  }
  const hint = expanded ? "Ctrl+O 收起工具轨迹 · /flow 打开双栏检查器" : "Ctrl+O 展开每个 Agent 工具轨迹 · /flow 打开双栏检查器";
  lines.push(fg("border", `╰─ ${padLeftCell(hint, inner - 2)} ─╯`));
  return lines;
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

type OverlayInputEvent =
  | { kind: "escape" } | { kind: "enter" } | { kind: "backspace" }
  | { kind: "up" } | { kind: "down" } | { kind: "scroll_up" } | { kind: "scroll_down" }
  | { kind: "cancel_flow" } | { kind: "resume_flow" } | { kind: "text"; text: string };

export function parseFlowOverlayInput(data: string, kb?: any, hasDraft = false): OverlayInputEvent | null {
  if (!data || data.startsWith("\x1b[<") || /^\x1b\[[0-9;:]*:3[u~A-Z]$/.test(data)) return null;
  if (data.includes("\x1b[200~") || data.includes("\x1b[201~")) {
    const pasted = data.replace(/\x1b\[20[01]~/g, "").replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
    return pasted ? { kind: "text", text: pasted } : null;
  }
  if (data === "\x18") return { kind: "cancel_flow" };
  if (data === "\x12") return { kind: "resume_flow" };
  const kitty = /^\x1b\[(\d+)(?::(\d+))?(?:;(\d+)(?::(\d+))?)?u$/.exec(data);
  if (kitty) {
    if (kitty[4] === "3") return null;
    const cp = Number(kitty[1]), shifted = kitty[2] ? Number(kitty[2]) : undefined, mod = kitty[3] ? Number(kitty[3]) - 1 : 0;
    if ((mod & 4) !== 0 && (cp === 120 || cp === 88)) return { kind: "cancel_flow" };
    if ((mod & 4) !== 0 && (cp === 114 || cp === 82)) return { kind: "resume_flow" };
    if (cp === 27 || ((mod & 4) !== 0 && cp === 99)) return { kind: "escape" };
    if (cp === 13 || cp === 10) return { kind: "enter" };
    if (cp === 127 || cp === 8) return { kind: "backspace" };
    if ((mod & ~1) === 0) {
      if (cp === 32) return { kind: "text", text: " " };
      if (!hasDraft && cp === 91) return { kind: "scroll_up" };
      if (!hasDraft && cp === 93) return { kind: "scroll_down" };
      if (cp >= 33) {
        const ch = String.fromCodePoint((mod & 1) !== 0 && shifted ? shifted : cp);
        return { kind: "text", text: (mod & 1) !== 0 && !shifted ? ch.toUpperCase() : ch };
      }
    }
    return null;
  }
  if (data === "\x1b" || data === "\x1b\x1b" || data === "\x03") return { kind: "escape" };
  if (data === "\r" || data === "\n") return { kind: "enter" };
  if (data === "\x7f" || data === "\b" || data === "\x1b[3~") return { kind: "backspace" };
  if (/^\x1b\[(?:1;\d+(?::[12])?)?A$/.test(data) || data === "\x1bOA") return { kind: "up" };
  if (/^\x1b\[(?:1;\d+(?::[12])?)?B$/.test(data) || data === "\x1bOB") return { kind: "down" };
  if (data === "\x1b[5~") return { kind: "scroll_up" };
  if (data === "\x1b[6~") return { kind: "scroll_down" };
  if (data.startsWith("\x1b")) {
    if (kb?.matches?.(data, "tui.select.cancel") || kb?.matches?.(data, "app.interrupt")) return { kind: "escape" };
    if (kb?.matches?.(data, "tui.select.up") || kb?.matches?.(data, "tui.editor.cursorUp")) return { kind: "up" };
    if (kb?.matches?.(data, "tui.select.down") || kb?.matches?.(data, "tui.editor.cursorDown")) return { kind: "down" };
    return null;
  }
  if (!hasDraft && data === "[") return { kind: "scroll_up" };
  if (!hasDraft && data === "]") return { kind: "scroll_down" };
  const cleaned = data.replace(/[\x00-\x1f\x7f]/g, "");
  return cleaned ? { kind: "text", text: cleaned } : null;
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
              statusNote = r.delivered ? "✓ 已实时插话至当前 Agent" : "✓ 已记录留言"; tui?.requestRender?.();
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
        const hint = snap.status === "running" ? "实时插话 (Enter 发送给当前 Agent)" : "发起跟进 (Enter 启动协作，支持 @role)";
        const inputLine = draft ? `💬 你: ${draft}█` : `💬 ${hint}...`;
        out.push(`${fg("border", "│")} ${draft ? fg("accent", padLeftCell(inputLine, inner)) : fg("muted", padLeftCell(inputLine, inner))} ${fg("border", "│")}`);
        const resumeHint = deps.room.isResumable() ? "Ctrl+R 断点续跑 · " : "";
        const foot = `${statusNote ? `${statusNote} · ` : ""}${resumeHint}↑↓ 选消息 · [/] 滚详情 · 输入+Enter 插话 · Ctrl+X 中止 · Esc 关闭`;
        out.push(fg("border", `╰─ ${padLeftCell(foot, inner - 2)} ─╯`));
        return out;
      },
    };
  }, { overlay: true });
}
