import {
  captureProcessStartToken, isProcessAliveWithToken,
  type EnhanceStore, type PersistedFlowCheckpoint,
} from "../core/store.ts";
import type {
  FlowRoomStatus, FlowRunResult, FlowStageTrace, FlowUserSteer, HandoffEnvelope,
  ObservedToolCall, RoleSpec, RoomEntry, SupervisorDecision, UsageSummary,
} from "../core/types.ts";

export type { FlowRoomStatus } from "../core/types.ts";

export interface ActiveStageControls {
  steer: (message: string) => Promise<void>;
  abort: () => Promise<void>;
}

export interface StageTurnSummaryLike {
  envelope: HandoffEnvelope | null; observedCalls: ObservedToolCall[];
  assistantText: string; usage: UsageSummary | null;
  abortedBySupervisor?: SupervisorDecision | null; cancelledByUser?: boolean; hostError?: string | null;
}

export interface FlowObserver {
  isCancelled?: () => boolean;
  allocateStageId?: (info: { roleId: string; round: number; stepIndex: number }) => string;
  getUserSteers?: () => readonly FlowUserSteer[];
  bindControls?: (controls: ActiveStageControls | null, stageId?: string) => void;
  onProgress?: (info: {
    currentIndex: number; repairRound: number; lastHandoffId: string | null;
    lastRejectionSig?: string | null; nextStageSeq?: number;
  }) => void;
  onStageStart?: (info: { stageId: string; role: RoleSpec; round: number; toTarget: string; modelLabel: string }) => void;
  onStageModelResolved?: (stageId: string, modelLabel: string) => void;
  onToolStart?: (stageId: string, summary: string) => void;
  onToolEnd?: (stageId: string, call: ObservedToolCall) => void;
  onSupervisorNote?: (stageId: string, note: string) => void;
  onStageEnd?: (stageId: string, info: {
    status: "ready" | "needs_input" | "rejected" | "blocked" | "violation" | "host_error" | "missing_handoff" | "aborted";
    outcome: StageTurnSummaryLike | null; reason?: string; hostError?: string | null;
  }) => void;
}

export interface FlowRoomSnapshot {
  flowId: string | null; mandateId?: string; goal: string; cwd?: string; roleChain: string[];
  status: FlowRoomStatus; reason?: string; currentIndex?: number; repairRound?: number;
  startedAt: string | null; endedAt: string | null; activeStageId: string | null;
  entries: RoomEntry[]; stages: FlowStageTrace[]; userSteers?: FlowUserSteer[];
}

export interface FlowRoomUiAdapter {
  mountWidget?: (room: FlowRoomManager, ctx?: any) => void;
  clearWidget?: (ctx?: any) => void;
  sendSummaryCard?: (snapshot: FlowRoomSnapshot, summary: string, ctx?: any) => void;
  requestRender?: () => void;
}

const MAX_ASSISTANT_TEXT_CHARS = 16_384;
const DIRECTED_STEER_RE = /^(?:\[@([a-zA-Z0-9][a-zA-Z0-9_-]*)\]|@([a-zA-Z0-9][a-zA-Z0-9_-]*))\s+([\s\S]+)$/;

export function parseDirectedSteer(rawMessage: string): { text: string; targetRole?: string } {
  const clean = rawMessage.trim(), m = DIRECTED_STEER_RE.exec(clean);
  const candidate = m ? (m[1] ?? m[2] ?? "").trim() : "";
  const targetRole = candidate && candidate !== "supervisor" ? candidate : undefined;
  return { text: targetRole && m?.[3] ? m[3].trim() : clean, ...(targetRole ? { targetRole } : {}) };
}

export function isCheckpointResumable(cp: PersistedFlowCheckpoint | null | undefined): boolean {
  return Boolean(
    cp?.flowId && cp.mandateId && cp.roleChain.length > 0 && cp.currentIndex < cp.roleChain.length &&
    (cp.status === "waiting_input" || cp.status === "interrupted" || cp.status === "failed" || cp.status === "cancelled"),
  );
}

export function snapshotFromCheckpoint(cp: PersistedFlowCheckpoint, fallbackCwd?: string): FlowRoomSnapshot {
  let snap: Partial<FlowRoomSnapshot> = {};
  try {
    const parsed: unknown = JSON.parse(cp.snapshotJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) snap = parsed as Partial<FlowRoomSnapshot>;
  } catch {}
  const resolvedCwd = cp.cwd ?? snap.cwd ?? fallbackCwd;
  const steers = Array.isArray(cp.userSteers) ? cp.userSteers.map((u) => ({ ...u })) : (Array.isArray(snap.userSteers) ? snap.userSteers.map((u) => ({ ...u })) : []);
  return {
    flowId: cp.flowId, mandateId: cp.mandateId, goal: cp.goal, ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
    roleChain: [...cp.roleChain], status: cp.status as FlowRoomStatus, currentIndex: cp.currentIndex, repairRound: cp.repairRound,
    ...(typeof snap.reason === "string" && snap.reason ? { reason: snap.reason } : {}),
    startedAt: typeof snap.startedAt === "string" ? snap.startedAt : null, endedAt: typeof snap.endedAt === "string" ? snap.endedAt : null,
    activeStageId: cp.status === "running" && typeof snap.activeStageId === "string" ? snap.activeStageId : null,
    entries: Array.isArray(snap.entries) ? snap.entries.map((e) => ({ ...e })) : [],
    stages: Array.isArray(snap.stages) ? snap.stages.map((s) => ({ ...s, calls: (s.calls ?? []).map((c) => ({ ...c, touchedPaths: [...(c.touchedPaths ?? [])] })), notes: [...(s.notes ?? [])] })) : [],
    userSteers: steers,
  };
}

function computeMaxIdSeq(entries: readonly RoomEntry[], stages: readonly FlowStageTrace[]): number {
  let max = 0;
  for (const e of entries) for (const m of e.id.matchAll(/(\d+)/g)) max = Math.max(max, Number(m[1]));
  for (const s of stages) for (const m of s.stageId.matchAll(/(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export class FlowRoomManager {
  private flowId: string | null = null;
  private mandateId = ""; private goal = ""; private roleChain: string[] = [];
  private status: FlowRoomStatus = "idle"; private currentIndex = 0; private repairRound = 0;
  private lastHandoffId: string | null = null; private maxRepairRounds = 2; private nextStageSeq = 0;
  private lastRejectionSig: string | null = null; private userSteers: FlowUserSteer[] = [];
  private reason: string | undefined; private startedAt: string | null = null; private endedAt: string | null = null;
  private activeStageId: string | null = null; private entries: RoomEntry[] = []; private stages: FlowStageTrace[] = [];
  private controlStack: Array<{ stageId: string; controls: ActiveStageControls }> = [];
  private flowAbortController: AbortController | null = null;
  private cancelled = false; private disposed = false; private seq = 0; private cwd: string | undefined;
  private readonly selfStartToken = captureProcessStartToken(process.pid);
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ui?: FlowRoomUiAdapter, private readonly store?: EnhanceStore, cwd?: string) {
    this.cwd = cwd; this.hydrateFromStore();
  }

  isRunning(): boolean { return this.status === "running"; }
  getLastHandoffId(): string | null { return this.lastHandoffId; }
  getMandateId(): string { return this.mandateId; }
  getUserSteers(): readonly FlowUserSteer[] { return this.userSteers; }
  getAbortSignal(): AbortSignal | undefined { return this.flowAbortController?.signal; }
  isResumable(): boolean {
    return Boolean(
      this.flowId && this.mandateId && this.roleChain.length > 0 && this.currentIndex < this.roleChain.length &&
      (this.status === "waiting_input" || this.status === "interrupted" || this.status === "failed" || this.status === "cancelled"),
    );
  }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private notify(): void {
    try { this.ui?.requestRender?.(); } catch {}
    for (const fn of this.listeners) { try { fn(); } catch {} }
  }

  private persist(): void {
    if (this.disposed || !this.store || this.store.isClosed() || !this.flowId || !this.mandateId) return;
    try {
      const owned = this.status === "running";
      const snapJson = JSON.stringify({
        flowId: this.flowId, mandateId: this.mandateId, goal: this.goal, ...(this.cwd ? { cwd: this.cwd } : {}),
        roleChain: this.roleChain, status: this.status, currentIndex: this.currentIndex, repairRound: this.repairRound,
        ...(this.reason ? { reason: this.reason } : {}), startedAt: this.startedAt, endedAt: this.endedAt,
        activeStageId: this.activeStageId, entries: this.entries, stages: this.stages, userSteers: this.userSteers,
      });
      this.store.saveFlowCheckpoint({
        flowId: this.flowId, mandateId: this.mandateId, goal: this.goal, ...(this.cwd ? { cwd: this.cwd } : {}),
        roleChain: this.roleChain, status: this.status, currentIndex: this.currentIndex, repairRound: this.repairRound,
        lastHandoffId: this.lastHandoffId, maxRepairRounds: this.maxRepairRounds, snapshotJson: snapJson,
        ownerPid: owned ? process.pid : null, ownerStartToken: owned ? this.selfStartToken : null,
        nextStageSeq: this.nextStageSeq, lastRejectionSig: this.lastRejectionSig,
        userSteers: this.userSteers, updatedAt: new Date().toISOString(),
      });
    } catch {}
  }

  private applyCheckpointState(cp: PersistedFlowCheckpoint): void {
    const snap = snapshotFromCheckpoint(cp, this.cwd);
    this.flowId = cp.flowId; this.mandateId = cp.mandateId; this.goal = cp.goal;
    this.cwd = snap.cwd ?? this.cwd; this.roleChain = [...cp.roleChain];
    this.currentIndex = cp.currentIndex; this.repairRound = cp.repairRound;
    this.lastHandoffId = cp.lastHandoffId; this.maxRepairRounds = cp.maxRepairRounds;
    this.startedAt = snap.startedAt; this.endedAt = snap.endedAt; this.reason = snap.reason;
    this.entries = snap.entries; this.stages = snap.stages; this.userSteers = snap.userSteers ?? [];
    this.lastRejectionSig = cp.lastRejectionSig ?? null;
    this.seq = Math.max(this.entries.length, computeMaxIdSeq(this.entries, this.stages)) + 1;
    this.nextStageSeq = Math.max(cp.nextStageSeq ?? 0, this.stages.length, this.seq);
  }

  syncFromCheckpoint(cp: PersistedFlowCheckpoint, ctx?: any): void {
    if (this.status === "running" || this.flowId !== cp.flowId) return;
    this.applyCheckpointState(cp);
    this.status = cp.status as FlowRoomStatus; this.activeStageId = null;
    if (this.status !== "waiting_input") this.ui?.clearWidget?.(ctx);
    this.notify();
  }

  private hydrateFromStore(): void {
    if (process.env.OMP_ENHANCE_SUBPROCESS === "1") return;
    let cp;
    try { cp = this.store?.getLatestFlowCheckpoint(); } catch { return; }
    if (!cp || (cp.status === "running" && cp.ownerPid != null && isProcessAliveWithToken(cp.ownerPid, cp.ownerStartToken))) return;
    this.applyCheckpointState(cp);
    if (cp.status !== "running") { this.status = cp.status as FlowRoomStatus; return; }
    this.status = "interrupted"; this.activeStageId = null; this.endedAt = new Date().toISOString();
    this.reason = "上次进程中断，可在总秘书 (/coord) 中断点续跑";
    for (const st of this.stages) if (st.status === "running") { st.status = "aborted"; st.endedAt = this.endedAt; st.activeTool = null; }
    for (const en of this.entries) if (en.badge?.startsWith("●")) {
      en.badge = "⏸ 中断"; en.tone = "warning"; en.text = "进程中断，可在总秘书 (/coord) 中从本阶段断点续跑";
    }
    this.persist();
  }

  getSnapshot(): FlowRoomSnapshot {
    return {
      flowId: this.flowId, mandateId: this.mandateId, goal: this.goal, ...(this.cwd ? { cwd: this.cwd } : {}),
      roleChain: [...this.roleChain], status: this.status, currentIndex: this.currentIndex, repairRound: this.repairRound,
      ...(this.reason ? { reason: this.reason } : {}), startedAt: this.startedAt, endedAt: this.endedAt,
      activeStageId: this.activeStageId, entries: this.entries.map((e) => ({ ...e })),
      stages: this.stages.map((s) => ({ ...s, calls: s.calls.map((c) => ({ ...c, touchedPaths: [...c.touchedPaths] })), notes: [...s.notes] })),
      userSteers: this.userSteers.map((u) => ({ ...u })),
    };
  }

  private insertBeforeRunning(entry: RoomEntry): void {
    const idx = this.activeStageId ? this.entries.findIndex((e) => e.id === `stage-${this.activeStageId}`) : -1;
    if (idx >= 0) this.entries.splice(idx, 0, entry); else this.entries.push(entry);
  }

  beginFlow(input: {
    flowId?: string; mandateId?: string; goal: string; roleChain: string[];
    maxRepairRounds?: number; lastHandoffId?: string | null; initiatorText?: string; ctx?: any;
  }): string {
    if (this.status === "running") throw new Error("已有正在运行的协作 Flow；可通过 steer 插话、/flow 查看或 cancel 取消。");
    const nextFlowId = input.flowId ?? `flow-${Date.now().toString(36)}-${this.seq + 1}`;
    if (this.store && !this.store.isClosed()) this.store.acquireProjectFlowLease(nextFlowId, process.pid, this.selfStartToken);
    this.disposed = false; this.seq += 1; this.flowId = nextFlowId;
    this.mandateId = input.mandateId ?? ""; this.goal = input.goal; this.roleChain = [...input.roleChain];
    this.currentIndex = 0; this.repairRound = 0; this.lastHandoffId = input.lastHandoffId ?? null;
    this.maxRepairRounds = input.maxRepairRounds ?? 2; this.nextStageSeq = 0; this.lastRejectionSig = null;
    this.userSteers = []; this.status = "running"; this.reason = undefined;
    this.startedAt = new Date().toISOString(); this.endedAt = null; this.activeStageId = null;
    this.controlStack = []; this.flowAbortController = new AbortController(); this.cancelled = false; this.stages = [];
    this.entries = [{
      id: `user-${this.seq}-init`, side: "right", speaker: "你", badge: "目标",
      tone: "success", text: input.initiatorText ?? input.goal, timestamp: this.startedAt,
    }];
    this.persist(); this.ui?.mountWidget?.(this, input.ctx); this.notify();
    return this.flowId;
  }

  resumeFlow(ctx?: any, targetFlowId?: string): {
    flowId: string; mandateId: string; roleChain: string[]; startIndex: number; repairRound: number;
    lastHandoffId: string | null; maxRepairRounds: number; initialStageSeq: number; lastRejectionSig: string | null;
  } {
    if (this.status === "running") throw new Error("已有正在运行的协作 Flow；可通过 steer 插话、/flow 查看或 cancel 取消。");
    const effectiveId = targetFlowId ?? this.flowId;
    let cp: PersistedFlowCheckpoint | null = null;
    if (this.store && !this.store.isClosed() && effectiveId) {
      cp = this.store.getFlowCheckpoint(effectiveId);
      if (cp && !isCheckpointResumable(cp)) throw new Error(`Flow "${effectiveId}" 当前状态为 ${cp.status}，无法断点续跑。`);
      if (!cp && targetFlowId && targetFlowId !== this.flowId) throw new Error(`Unknown flowId "${targetFlowId}".`);
    }
    if (!cp && !this.isResumable()) throw new Error("当前没有可断点续跑的中断/失败 Flow。");
    const leaseFlowId = cp?.flowId ?? effectiveId!;
    if (this.store && !this.store.isClosed()) this.store.acquireProjectFlowLease(leaseFlowId, process.pid, this.selfStartToken);
    if (cp) this.applyCheckpointState(cp);

    this.disposed = false; this.status = "running"; this.cancelled = false;
    this.endedAt = null; this.reason = undefined; this.controlStack = [];
    this.flowAbortController = new AbortController(); this.activeStageId = null; this.seq += 1;
    const now = new Date().toISOString();
    for (const st of this.stages) if (st.status === "running") { st.status = "aborted"; st.endedAt = now; st.activeTool = null; }
    const roleId = this.roleChain[this.currentIndex]!;
    this.entries.push({
      id: `user-${this.seq}-resume`, side: "right", speaker: "你", badge: "续跑", tone: "success",
      text: `从阶段 ${this.currentIndex + 1}/${this.roleChain.length} (${roleId}) 断点继续`, timestamp: now,
    });
    this.persist(); this.ui?.mountWidget?.(this, ctx); this.notify();
    return {
      flowId: this.flowId!, mandateId: this.mandateId, roleChain: [...this.roleChain],
      startIndex: this.currentIndex, repairRound: this.repairRound, lastHandoffId: this.lastHandoffId,
      maxRepairRounds: this.maxRepairRounds, initialStageSeq: this.nextStageSeq, lastRejectionSig: this.lastRejectionSig,
    };
  }

  async postUserSteer(message: string, ctx?: any): Promise<{ delivered: boolean; queuedForRole?: string; activeStageId: string | null }> {
    const clean = message.trim();
    if (!clean) return { delivered: false, activeStageId: this.activeStageId };
    const { text: steerText, targetRole } = parseDirectedSteer(clean), now = new Date().toISOString();
    this.userSteers.push({ text: steerText, ...(targetRole ? { targetRole } : {}), createdAt: now });

    const topControl = this.controlStack.at(-1) ?? null, currentStageId = topControl?.stageId ?? this.activeStageId;
    const activeStage = currentStageId ? this.stages.find((s) => s.stageId === currentStageId) : undefined;
    const canDeliverNow = this.status === "running" && Boolean(topControl) && (!targetRole || activeStage?.roleId === targetRole);

    this.seq += 1;
    this.insertBeforeRunning({
      id: `user-${this.seq}`, side: "right", speaker: "你", ...(targetRole ? { target: targetRole } : {}),
      badge: canDeliverNow ? "插话" : (targetRole ? `@${targetRole}` : "留言"),
      tone: "success", text: targetRole ? `[@${targetRole}] ${steerText}` : steerText, timestamp: now,
      ...(currentStageId && canDeliverNow ? { stageId: currentStageId } : {}),
    });
    if (canDeliverNow && activeStage) activeStage.notes.push(`你插话: ${steerText}`);

    let delivered = false;
    if (canDeliverNow && topControl) { await topControl.controls.steer(steerText); delivered = true; }
    if (this.status === "running") this.ui?.mountWidget?.(this, ctx);
    this.persist(); this.notify();
    return { delivered, ...(targetRole && !delivered ? { queuedForRole: targetRole } : {}), activeStageId: currentStageId };
  }

  async cancelActiveFlow(ctx?: any): Promise<boolean> {
    if (this.status !== "running") return false;
    this.cancelled = true; this.flowAbortController?.abort(); this.seq += 1;
    this.insertBeforeRunning({
      id: `user-${this.seq}-cancel`, side: "right", speaker: "你", badge: "中止",
      tone: "warning", text: "停止当前协作 Flow", timestamp: new Date().toISOString(),
    });
    for (const item of [...this.controlStack].reverse()) { try { await item.controls.abort(); } catch {} }
    this.ui?.clearWidget?.(ctx); this.persist(); this.notify();
    return true;
  }

  createObserver(_ctx?: any): FlowObserver {
    return {
      isCancelled: () => this.cancelled,
      allocateStageId: ({ roleId, round, stepIndex }) => `step-${++this.nextStageSeq}-r${round}-${stepIndex}-${roleId}`,
      getUserSteers: () => this.userSteers,
      bindControls: (controls, stageId) => {
        const key = stageId ?? this.activeStageId ?? "stage";
        if (controls) this.controlStack = [...this.controlStack.filter((i) => i.stageId !== key), { stageId: key, controls }];
        else if (stageId) this.controlStack = this.controlStack.filter((i) => i.stageId !== stageId);
        else this.controlStack.pop();
      },
      onProgress: ({ currentIndex, repairRound, lastHandoffId, lastRejectionSig, nextStageSeq }) => {
        this.currentIndex = currentIndex; this.repairRound = repairRound; this.lastHandoffId = lastHandoffId;
        if (lastRejectionSig !== undefined) this.lastRejectionSig = lastRejectionSig;
        if (typeof nextStageSeq === "number") this.nextStageSeq = Math.max(this.nextStageSeq, nextStageSeq);
        this.persist();
      },
      onStageStart: ({ stageId, role, round, toTarget, modelLabel }) => {
        const existing = this.stages.find((s) => s.stageId === stageId);
        if (existing && existing.status === "running") {
          existing.modelLabel = modelLabel; this.activeStageId = stageId; this.persist(); this.notify(); return;
        }
        const finalStageId = existing ? `${stageId}-${++this.nextStageSeq}` : stageId, now = new Date().toISOString();
        this.insertBeforeRunning({
          id: `stage-${finalStageId}`, side: "left", speaker: role.id, target: toTarget,
          badge: round > 0 ? `● 返修#${round}` : "● 执行中", tone: "info",
          text: "正在分析上下文并准备执行...", timestamp: now, stageId: finalStageId,
        });
        this.stages.push({
          stageId: finalStageId, roleId: role.id, roleName: role.name, round, status: "running", modelLabel,
          startedAt: now, endedAt: null, activeTool: null, calls: [], assistantText: "", envelope: null, notes: [],
        });
        this.activeStageId = finalStageId; this.persist(); this.notify();
      },
      onStageModelResolved: (stageId, modelLabel) => {
        const st = this.stages.find((s) => s.stageId === stageId && s.status === "running");
        if (st && st.modelLabel !== modelLabel) { st.modelLabel = modelLabel; this.persist(); this.notify(); }
      },
      onToolStart: (stageId, summary) => {
        const st = this.stages.find((s) => s.stageId === stageId); if (st) st.activeTool = summary;
        const en = this.entries.find((e) => e.id === `stage-${stageId}`); if (en) en.text = `⚙ ${summary}`;
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
        const st = this.stages.find((s) => s.stageId === stageId); if (st) st.notes.push(note);
        this.seq += 1;
        this.insertBeforeRunning({
          id: `sup-${this.seq}`, side: "left", speaker: "supervisor", target: st?.roleId,
          badge: "↺ 督导", tone: "warning", text: note, timestamp: new Date().toISOString(), stageId,
        });
        this.persist(); this.notify();
      },
      onStageEnd: (stageId, { status, outcome, reason, hostError }) => {
        const st = this.stages.find((s) => s.stageId === stageId), effHostErr = hostError ?? outcome?.hostError ?? null;
        if (st) {
          st.status = status; st.endedAt = new Date().toISOString(); st.activeTool = null;
          if (effHostErr) st.hostError = effHostErr;
          const raw = outcome?.assistantText ?? "";
          st.assistantText = raw.length > MAX_ASSISTANT_TEXT_CHARS ? `${raw.slice(0, MAX_ASSISTANT_TEXT_CHARS)}…` : raw;
          st.envelope = outcome?.envelope ?? null;
          for (const c of outcome?.observedCalls ?? []) if (!st.calls.some((p) => p.toolCallId === c.toolCallId)) st.calls.push(c);
        }
        const en = this.entries.find((e) => e.id === `stage-${stageId}`);
        if (en) {
          if (status === "ready") {
            en.badge = "✓ ready"; en.tone = "success"; en.text = outcome?.envelope?.summary ?? (outcome?.assistantText || "阶段完成");
          } else if (status === "needs_input") {
            en.badge = "? 待确认"; en.tone = "warning"; en.target = "user";
            const qs = outcome?.envelope?.questionsForUser;
            en.text = qs?.length ? `${outcome?.envelope?.summary ?? ""}\n• ${qs.join("\n• ")}`.trim() : (outcome?.envelope?.summary ?? reason ?? "需补充信息后继续");
          } else if (status === "rejected") {
            en.badge = "✕ rejected"; en.tone = "warning";
            en.target = outcome?.envelope?.toTarget && outcome.envelope.toTarget !== en.speaker
              ? outcome.envelope.toTarget : (this.roleChain[0] && this.roleChain[0] !== en.speaker ? this.roleChain[0] : "user");
            en.text = outcome?.envelope?.feedbackForUpstream ?? outcome?.envelope?.summary ?? reason ?? "验收未通过";
          } else if (status === "blocked") {
            en.badge = "! blocked"; en.tone = "warning"; en.target = "user";
            en.text = outcome?.envelope?.summary ?? reason ?? "阶段受阻，需你确认";
          } else {
            en.badge = status === "aborted" ? "⏹ aborted" : status === "host_error" ? "! 服务异常" : status === "missing_handoff" ? "! 未交接" : "✕ violation";
            en.tone = "error"; en.target = "user"; en.text = reason ?? outcome?.envelope?.summary ?? "执行中止";
          }
        }
        this.activeStageId = [...this.stages].reverse().find((s) => s.status === "running")?.stageId ?? null;
        this.persist(); this.notify();
      },
    };
  }

  finishFlow(result: FlowRunResult, ctx?: any): FlowRoomSnapshot {
    if (this.disposed) return this.getSnapshot();
    this.endedAt = new Date().toISOString(); this.activeStageId = null; this.controlStack = [];
    this.flowAbortController = null; this.reason = result.reason;
    this.status = result.status === "completed" ? "completed" : result.status === "waiting_input" ? "waiting_input"
      : result.status === "cancelled" ? "cancelled" : result.status === "violation" ? "violation"
        : (result.status === "blocked" || result.status === "rejected_max_rounds" || result.status === "stagnated") ? "blocked" : "failed";
    if (result.status === "rejected_max_rounds" || result.status === "stagnated") {
      this.seq += 1;
      this.entries.push({
        id: `sys-${this.seq}`, side: "left", speaker: "flow", target: "user",
        badge: result.status === "stagnated" ? "! 停滞升级" : "! 超轮次升级",
        tone: "warning", text: result.reason ?? "多轮修复未收敛，请介入决策。", timestamp: this.endedAt,
      });
    }
    this.ui?.clearWidget?.(ctx); this.persist();
    try { this.store?.releaseProjectFlowLease(this.flowId ?? undefined); } catch {}
    const snap = this.getSnapshot();
    this.ui?.sendSummaryCard?.(snap, result.finalEnvelope?.summary ?? result.reason ?? snap.status, ctx);
    this.notify(); return snap;
  }

  failFlow(error: unknown, ctx?: any): FlowRoomSnapshot {
    if (this.disposed) return this.getSnapshot();
    const msg = error instanceof Error ? error.message : String(error);
    this.endedAt = new Date().toISOString(); this.activeStageId = null; this.controlStack = []; this.flowAbortController = null;
    this.status = "failed"; this.reason = msg; this.seq += 1;
    this.entries.push({ id: `err-${this.seq}`, side: "left", speaker: "flow", target: "user", badge: "✕ 错误", tone: "error", text: msg, timestamp: this.endedAt });
    this.ui?.clearWidget?.(ctx); this.persist();
    try { this.store?.releaseProjectFlowLease(this.flowId ?? undefined); } catch {}
    const snap = this.getSnapshot();
    this.ui?.sendSummaryCard?.(snap, msg, ctx);
    this.notify(); return snap;
  }

  dispose(ctx?: any): void {
    this.disposed = true; this.cancelled = true; this.flowAbortController?.abort(); this.flowAbortController = null;
    if (this.status === "running") {
      try { this.store?.releaseFlowOwnership(this.flowId, process.pid); } catch {}
      try { this.store?.releaseProjectFlowLease(this.flowId ?? undefined); } catch {}
    }
    for (const item of [...this.controlStack].reverse()) void Promise.resolve(item.controls.abort()).catch(() => {});
    this.controlStack = []; this.ui?.clearWidget?.(ctx); this.listeners.clear();
  }
}
