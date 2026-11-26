import {
  captureProcessStartToken, isProcessAliveWithToken, LeaseLostError,
  type EnhanceStore, type PersistedFlowCheckpoint,
} from "../core/store.ts";
import type {
  FlowGraphSnapshot, FlowLeaseMode, FlowMachineState, FlowRoomStatus, FlowRunResult, FlowStageTrace,
  FlowUserSteer, HandoffEnvelope, ObservedToolCall, RoleSpec, RoomEntry, SupervisorDecision, UsageSummary,
} from "../core/types.ts";
import { buildFlowGraphSnapshot } from "./machine.ts";
import {
  applyStageEndToRoom, computeMaxIdSeq, drainPendingFlowSteers, isCheckpointResumable,
  parseDirectedSteer, snapshotFromCheckpoint, syncSteerRecord,
} from "./state-helpers.ts";

export { isCheckpointResumable, parseDirectedSteer, snapshotFromCheckpoint };
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
  drainPendingSteers?: (info?: { roleId?: string; stageId?: string; phase?: "pre_stage" | "mid_stage" }) => Promise<number>;
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
  graphSnapshot?: FlowGraphSnapshot | null;
}

export interface FlowRoomUiAdapter {
  mountWidget?: (room: FlowRoomManager, ctx?: any) => void;
  clearWidget?: (ctx?: any) => void;
  sendSummaryCard?: (snapshot: FlowRoomSnapshot, summary: string, ctx?: any) => void;
  requestRender?: () => void;
}

export class FlowRoomManager {
  private flowId: string | null = null;
  private mandateId = ""; private goal = ""; private roleChain: string[] = [];
  private status: FlowRoomStatus = "idle"; private currentIndex = 0; private repairRound = 0;
  private lastHandoffId: string | null = null; private maxRepairRounds = 2; private nextStageSeq = 0;
  private lastRejectionSig: string | null = null; private userSteers: FlowUserSteer[] = [];
  private graphSnapshot: FlowGraphSnapshot | null = null; private graphSpecJson: string | null = null;
  private machineStateJson: string | null = null; private leaseMode: FlowLeaseMode = "write_main";
  private reason: string | undefined; private startedAt: string | null = null; private endedAt: string | null = null;
  private activeStageId: string | null = null; private entries: RoomEntry[] = []; private stages: FlowStageTrace[] = [];
  private controlStack: Array<{ stageId: string; controls: ActiveStageControls }> = [];
  private flowAbortController: AbortController | null = null;
  private leaseToken: string | null = null; private stateVersion = 0;
  private steerPollTimer: ReturnType<typeof setInterval> | null = null; private drainingSteers = false;
  private cancelled = false; private disposed = false; private seq = 0; private cwd: string | undefined;
  private readonly selfStartToken = captureProcessStartToken(process.pid);
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ui?: FlowRoomUiAdapter, private readonly store?: EnhanceStore, cwd?: string) {
    this.cwd = cwd; this.hydrateFromStore();
  }

  setGraphState(state: FlowMachineState): void {
    this.graphSnapshot = buildFlowGraphSnapshot(state); this.graphSpecJson = JSON.stringify(state.spec);
    this.machineStateJson = JSON.stringify(state); this.repairRound = state.repairRound;
    this.lastHandoffId = state.lastHandoffId; this.lastRejectionSig = state.lastRejectionSig;
    this.nextStageSeq = Math.max(this.nextStageSeq, state.nextStageSeq); this.persist(); this.notify();
  }
  getPersistedMachineState(): FlowMachineState | null {
    if (!this.machineStateJson) return null;
    try { return JSON.parse(this.machineStateJson) as FlowMachineState; } catch { return null; }
  }
  isRunning(): boolean { return this.status === "running"; }
  getLastHandoffId(): string | null { return this.lastHandoffId; }
  getMandateId(): string { return this.mandateId; }
  getUserSteers(): readonly FlowUserSteer[] { return this.userSteers; }
  getAbortSignal(): AbortSignal | undefined { return this.flowAbortController?.signal; }
  getLeaseToken(): string | null { return this.leaseToken; }
  hasActiveLeaseOwnership(): boolean {
    if (this.status !== "running" || !this.flowId) return false;
    if (!this.store || this.store.isClosed()) return true;
    if (!this.leaseToken) return false;
    try {
      const live = this.store.getProjectFlowLease(this.flowId);
      return Boolean(live && live.flowId === this.flowId && live.leaseToken === this.leaseToken);
    } catch { return false; }
  }
  isResumable(): boolean {
    return Boolean(
      this.flowId && this.mandateId && this.roleChain.length > 0 &&
      (this.graphSnapshot !== null || this.currentIndex < this.roleChain.length) &&
      (this.status === "waiting_input" || this.status === "interrupted" || this.status === "failed" || this.status === "cancelled"),
    );
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private notify(): void { try { this.ui?.requestRender?.(); } catch {} for (const fn of this.listeners) { try { fn(); } catch {} } }
  private startSteerPoll(): void {
    this.stopSteerPoll();
    if (!this.store || this.store.isClosed() || this.status !== "running") return;
    this.steerPollTimer = setInterval(() => {
      if (this.status !== "running") { this.stopSteerPoll(); return; }
      void this.drainPendingSteersInternal({ phase: "mid_stage" });
    }, 150);
    this.steerPollTimer.unref?.();
  }
  private stopSteerPoll(): void { if (this.steerPollTimer !== null) { clearInterval(this.steerPollTimer); this.steerPollTimer = null; } }

  private persist(opts?: { allowUnfencedRecovery?: boolean }): void {
    if (this.disposed || !this.store || this.store.isClosed() || !this.flowId || !this.mandateId) return;
    if (!this.leaseToken && !opts?.allowUnfencedRecovery) return;
    try {
      const owned = this.status === "running";
      const snapJson = JSON.stringify({
        flowId: this.flowId, mandateId: this.mandateId, goal: this.goal, ...(this.cwd ? { cwd: this.cwd } : {}),
        roleChain: this.roleChain, status: this.status, currentIndex: this.currentIndex, repairRound: this.repairRound,
        ...(this.reason ? { reason: this.reason } : {}), startedAt: this.startedAt, endedAt: this.endedAt,
        activeStageId: this.activeStageId, entries: this.entries, stages: this.stages, userSteers: this.userSteers,
        ...(this.graphSnapshot ? { graphSnapshot: this.graphSnapshot } : {}),
      });
      const saved = this.store.saveFlowCheckpoint({
        flowId: this.flowId, mandateId: this.mandateId, goal: this.goal, ...(this.cwd ? { cwd: this.cwd } : {}),
        roleChain: this.roleChain, status: this.status, currentIndex: this.currentIndex, repairRound: this.repairRound,
        lastHandoffId: this.lastHandoffId, maxRepairRounds: this.maxRepairRounds, snapshotJson: snapJson,
        ownerPid: owned ? process.pid : null, ownerStartToken: owned ? this.selfStartToken : null,
        leaseToken: owned ? this.leaseToken : null, stateVersion: this.stateVersion,
        nextStageSeq: this.nextStageSeq, lastRejectionSig: this.lastRejectionSig, userSteers: this.userSteers,
        ...(this.graphSpecJson ? { graphSpecJson: this.graphSpecJson } : {}),
        ...(this.machineStateJson ? { machineStateJson: this.machineStateJson } : {}),
        leaseMode: this.leaseMode, updatedAt: new Date().toISOString(),
      }, this.leaseToken ? { expectedLeaseToken: this.leaseToken } : undefined);
      if (saved) {
        if (typeof saved.stateVersion === "number") this.stateVersion = saved.stateVersion;
        if (Array.isArray(saved.userSteers)) this.userSteers = saved.userSteers.map((u) => ({ ...u }));
      }
    } catch (err) {
      if (err instanceof LeaseLostError) { this.leaseToken = null; this.cancelled = true; this.stopSteerPoll(); this.flowAbortController?.abort(); }
    }
  }

  private applyCheckpointState(cp: PersistedFlowCheckpoint): void {
    const snap = snapshotFromCheckpoint(cp, this.cwd);
    this.flowId = cp.flowId; this.mandateId = cp.mandateId; this.goal = cp.goal; this.cwd = snap.cwd ?? this.cwd;
    this.roleChain = [...cp.roleChain]; this.currentIndex = cp.currentIndex; this.repairRound = cp.repairRound;
    this.lastHandoffId = cp.lastHandoffId; this.maxRepairRounds = cp.maxRepairRounds; this.stateVersion = cp.stateVersion ?? 0;
    this.startedAt = snap.startedAt; this.endedAt = snap.endedAt; this.reason = snap.reason;
    this.entries = snap.entries; this.stages = snap.stages; this.userSteers = snap.userSteers ?? [];
    this.graphSnapshot = snap.graphSnapshot ?? null; this.graphSpecJson = cp.graphSpecJson ?? null;
    this.machineStateJson = cp.machineStateJson ?? null; this.leaseMode = cp.leaseMode ?? "write_main";
    this.lastRejectionSig = cp.lastRejectionSig ?? null;
    this.seq = Math.max(this.entries.length, computeMaxIdSeq(this.entries, this.stages)) + 1;
    this.nextStageSeq = Math.max(cp.nextStageSeq ?? 0, this.stages.length, this.seq);
  }

  syncFromCheckpoint(cp: PersistedFlowCheckpoint, ctx?: any): void {
    if (this.status === "running" || this.flowId !== cp.flowId || cp.status === "running") return;
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
    this.persist({ allowUnfencedRecovery: true });
  }

  getSnapshot(): FlowRoomSnapshot {
    return {
      flowId: this.flowId, mandateId: this.mandateId, goal: this.goal, ...(this.cwd ? { cwd: this.cwd } : {}),
      roleChain: [...this.roleChain], status: this.status, currentIndex: this.currentIndex, repairRound: this.repairRound,
      ...(this.reason ? { reason: this.reason } : {}), startedAt: this.startedAt, endedAt: this.endedAt,
      activeStageId: this.activeStageId, entries: this.entries.map((e) => ({ ...e })),
      stages: this.stages.map((s) => ({ ...s, calls: s.calls.map((c) => ({ ...c, touchedPaths: [...c.touchedPaths] })), notes: [...s.notes] })),
      userSteers: this.userSteers.map((u) => ({ ...u })),
      ...(this.graphSnapshot ? { graphSnapshot: this.graphSnapshot } : {}),
    };
  }

  private insertBeforeRunning(entry: RoomEntry): void {
    const idx = this.activeStageId ? this.entries.findIndex((e) => e.id === `stage-${this.activeStageId}`) : -1;
    if (idx >= 0) this.entries.splice(idx, 0, entry); else this.entries.push(entry);
  }
  private syncSteerIntoMemory(s: FlowUserSteer, deliveredLive: boolean, stageId?: string | null): boolean {
    return syncSteerRecord(this.userSteers, (e) => this.insertBeforeRunning(e), this.entries, () => ++this.seq, s, deliveredLive, stageId);
  }
  private async drainPendingSteersInternal(info?: { roleId?: string; stageId?: string; phase?: "pre_stage" | "mid_stage" }): Promise<number> {
    if (this.drainingSteers || this.disposed || this.status !== "running" || !this.flowId || !this.store || this.store.isClosed() || !this.hasActiveLeaseOwnership()) return 0;
    this.drainingSteers = true;
    try {
      return await drainPendingFlowSteers({
        store: this.store, flowId: this.flowId, stages: this.stages, controlStack: this.controlStack, activeStageId: this.activeStageId,
        syncSteer: (s, live, sid) => this.syncSteerIntoMemory(s, live, sid),
        onChanged: (persisted) => { if (persisted) this.persist(); this.notify(); }, info,
      });
    } finally { this.drainingSteers = false; }
  }

  beginFlow(input: {
    flowId?: string; mandateId?: string; goal: string; roleChain: string[]; leaseMode?: FlowLeaseMode;
    maxRepairRounds?: number; lastHandoffId?: string | null; initiatorText?: string; ctx?: any;
  }): string {
    if (this.status === "running") throw new Error("已有正在运行的协作 Flow；可通过 steer 插话、/flow 查看或 cancel 取消。");
    const nextFlowId = input.flowId ?? `flow-${Date.now().toString(36)}-${this.seq + 1}`;
    this.leaseMode = input.leaseMode ?? "write_main";
    if (this.store && !this.store.isClosed()) {
      const acq = this.leaseMode === "write_main"
        ? this.store.acquireProjectFlowLease(nextFlowId, process.pid, this.selfStartToken)
        : this.store.acquireScopedFlowLease(nextFlowId, this.leaseMode, process.pid, this.selfStartToken);
      this.leaseToken = acq.leaseToken; this.stateVersion = acq.stateVersion;
    } else { this.leaseToken = null; this.stateVersion = 0; }
    this.disposed = false; this.seq += 1; this.flowId = nextFlowId; this.graphSnapshot = null; this.graphSpecJson = null; this.machineStateJson = null;
    this.mandateId = input.mandateId ?? ""; this.goal = input.goal; this.roleChain = [...input.roleChain];
    this.currentIndex = 0; this.repairRound = 0; this.lastHandoffId = input.lastHandoffId ?? null;
    this.maxRepairRounds = input.maxRepairRounds ?? 2; this.nextStageSeq = 0; this.lastRejectionSig = null;
    this.userSteers = []; this.status = "running"; this.reason = undefined;
    this.startedAt = new Date().toISOString(); this.endedAt = null; this.activeStageId = null;
    this.controlStack = []; this.flowAbortController = new AbortController(); this.cancelled = false; this.stages = [];
    this.entries = [{ id: `user-${this.seq}-init`, side: "right", speaker: "你", badge: "目标", tone: "success", text: input.initiatorText ?? input.goal, timestamp: this.startedAt }];
    this.persist(); this.startSteerPoll(); this.ui?.mountWidget?.(this, input.ctx); this.notify();
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
    if (this.store && !this.store.isClosed()) {
      const acq = this.store.acquireProjectFlowLease(leaseFlowId, process.pid, this.selfStartToken);
      cp = this.store.getFlowCheckpoint(leaseFlowId) ?? cp;
      if (cp) this.applyCheckpointState(cp);
      this.leaseToken = acq.leaseToken; this.stateVersion = acq.stateVersion;
    } else { this.leaseToken = null; this.stateVersion = 0; }

    this.disposed = false; this.status = "running"; this.cancelled = false;
    this.endedAt = null; this.reason = undefined; this.controlStack = [];
    this.flowAbortController = new AbortController(); this.activeStageId = null; this.seq += 1;
    const now = new Date().toISOString();
    for (const st of this.stages) if (st.status === "running") { st.status = "aborted"; st.endedAt = now; st.activeTool = null; }
    const roleId = this.roleChain[this.currentIndex]!;
    this.entries.push({ id: `user-${this.seq}-resume`, side: "right", speaker: "你", badge: "续跑", tone: "success", text: `从阶段 ${this.currentIndex + 1}/${this.roleChain.length} (${roleId}) 断点继续`, timestamp: now });
    this.persist(); this.startSteerPoll(); this.ui?.mountWidget?.(this, ctx); this.notify();
    return {
      flowId: this.flowId!, mandateId: this.mandateId, roleChain: [...this.roleChain],
      startIndex: this.currentIndex, repairRound: this.repairRound, lastHandoffId: this.lastHandoffId,
      maxRepairRounds: this.maxRepairRounds, initialStageSeq: this.nextStageSeq, lastRejectionSig: this.lastRejectionSig,
    };
  }

  async postUserSteer(message: string, ctx?: any): Promise<{
    steerId?: string; deliveryState: "delivered_to_stage" | "saved_pending_delivery";
    savedToCheckpoint: boolean; delivered: boolean; queuedForRole?: string; activeStageId: string | null;
  }> {
    const clean = message.trim();
    if (!clean) return { deliveryState: "saved_pending_delivery", savedToCheckpoint: false, delivered: false, activeStageId: this.activeStageId };
    const { text: steerText, targetRole } = parseDirectedSteer(clean), now = new Date().toISOString();
    const topControl = this.controlStack.at(-1) ?? null, currentStageId = topControl?.stageId ?? this.activeStageId;
    const activeStage = currentStageId ? this.stages.find((s) => s.stageId === currentStageId) : undefined;
    const ownsLive = this.hasActiveLeaseOwnership();
    const canDeliverNow = ownsLive && Boolean(topControl) && (!targetRole || activeStage?.roleId === targetRole);

    let steerId: string | undefined, savedToCheckpoint = false;
    if (this.store && !this.store.isClosed() && this.flowId) {
      const appended = this.store.appendFlowSteer(this.flowId, { text: steerText, targetRole: targetRole ?? null, createdAt: now });
      steerId = appended.steerId; savedToCheckpoint = true;
      this.syncSteerIntoMemory(appended, canDeliverNow, currentStageId);
    } else {
      this.seq += 1;
      const localSteer: FlowUserSteer = { steerId: `local-${this.seq}`, text: steerText, ...(targetRole ? { targetRole } : {}), createdAt: now };
      steerId = localSteer.steerId;
      this.syncSteerIntoMemory(localSteer, canDeliverNow, currentStageId);
    }

    let delivered = false;
    if (canDeliverNow && topControl && currentStageId) {
      const claimed = savedToCheckpoint && this.store && this.flowId && steerId
        ? this.store.markFlowSteersConsumed(this.flowId, [steerId], currentStageId) > 0 : true;
      if (claimed) {
        await topControl.controls.steer(steerText);
        if (activeStage) activeStage.notes.push(`你插话: ${steerText}`);
        const hit = steerId ? this.userSteers.find((u) => u.steerId === steerId) : undefined;
        if (hit) { hit.consumedAt = now; hit.consumedByStage = currentStageId; }
        delivered = true;
      }
    }
    if (ownsLive) { this.ui?.mountWidget?.(this, ctx); this.persist(); }
    this.notify();
    return {
      ...(steerId ? { steerId } : {}), deliveryState: delivered ? "delivered_to_stage" : "saved_pending_delivery",
      savedToCheckpoint, delivered, ...(targetRole && !delivered ? { queuedForRole: targetRole } : {}),
      activeStageId: canDeliverNow ? currentStageId : null,
    };
  }

  async cancelActiveFlow(ctx?: any): Promise<boolean> {
    if (this.status !== "running") return false;
    this.cancelled = true; this.stopSteerPoll(); this.flowAbortController?.abort(); this.seq += 1;
    this.insertBeforeRunning({ id: `user-${this.seq}-cancel`, side: "right", speaker: "你", badge: "中止", tone: "warning", text: "停止当前协作 Flow", timestamp: new Date().toISOString() });
    for (const item of [...this.controlStack].reverse()) { try { await item.controls.abort(); } catch {} }
    this.ui?.clearWidget?.(ctx); this.persist(); this.notify();
    return true;
  }

  createObserver(_ctx?: any): FlowObserver {
    return {
      isCancelled: () => this.cancelled,
      allocateStageId: ({ roleId, round, stepIndex }) => `step-${++this.nextStageSeq}-r${round}-${stepIndex}-${roleId}`,
      getUserSteers: () => this.userSteers,
      drainPendingSteers: (info) => this.drainPendingSteersInternal(info),
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
        if (existing && existing.status === "running") { existing.modelLabel = modelLabel; this.activeStageId = stageId; this.persist(); this.notify(); return; }
        const finalStageId = existing ? `${stageId}-${++this.nextStageSeq}` : stageId, now = new Date().toISOString();
        this.insertBeforeRunning({ id: `stage-${finalStageId}`, side: "left", speaker: role.id, target: toTarget, badge: round > 0 ? `● 返修#${round}` : "● 执行中", tone: "info", text: "正在分析上下文并准备执行...", timestamp: now, stageId: finalStageId });
        this.stages.push({ stageId: finalStageId, roleId: role.id, roleName: role.name, round, status: "running", modelLabel, startedAt: now, endedAt: null, activeTool: null, calls: [], assistantText: "", envelope: null, notes: [] });
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
        this.insertBeforeRunning({ id: `sup-${this.seq}`, side: "left", speaker: "supervisor", target: st?.roleId, badge: "↺ 督导", tone: "warning", text: note, timestamp: new Date().toISOString(), stageId });
        this.persist(); this.notify();
      },
      onStageEnd: (stageId, { status, outcome, reason, hostError }) => {
        this.activeStageId = applyStageEndToRoom({ stageId, status, outcome, reason, hostError, stages: this.stages, entries: this.entries, roleChain: this.roleChain });
        this.persist(); this.notify();
      },
    };
  }

  finishFlow(result: FlowRunResult, ctx?: any): FlowRoomSnapshot {
    if (this.disposed) return this.getSnapshot();
    this.stopSteerPoll(); this.endedAt = new Date().toISOString(); this.activeStageId = null; this.controlStack = [];
    this.flowAbortController = null; this.reason = result.reason;
    this.status = result.status === "completed" ? "completed" : result.status === "waiting_input" ? "waiting_input"
      : result.status === "cancelled" ? "cancelled" : result.status === "violation" ? "violation"
        : (result.status === "blocked" || result.status === "rejected_max_rounds" || result.status === "stagnated") ? "blocked" : "failed";
    if (result.status === "rejected_max_rounds" || result.status === "stagnated") {
      this.seq += 1;
      this.entries.push({ id: `sys-${this.seq}`, side: "left", speaker: "flow", target: "user", badge: result.status === "stagnated" ? "! 停滞升级" : "! 超轮次升级", tone: "warning", text: result.reason ?? "多轮修复未收敛，请介入决策。", timestamp: this.endedAt });
    }
    this.ui?.clearWidget?.(ctx); this.persist();
    const tok = this.leaseToken; this.leaseToken = null;
    if (tok) { try { this.store?.releaseProjectFlowLease(this.flowId ?? undefined, tok); } catch {} }
    const snap = this.getSnapshot();
    this.ui?.sendSummaryCard?.(snap, result.finalEnvelope?.summary ?? result.reason ?? snap.status, ctx);
    this.notify(); return snap;
  }
  failFlow(error: unknown, ctx?: any): FlowRoomSnapshot {
    if (this.disposed) return this.getSnapshot();
    this.stopSteerPoll(); const msg = error instanceof Error ? error.message : String(error);
    this.endedAt = new Date().toISOString(); this.activeStageId = null; this.controlStack = []; this.flowAbortController = null;
    this.status = "failed"; this.reason = msg; this.seq += 1;
    this.entries.push({ id: `err-${this.seq}`, side: "left", speaker: "flow", target: "user", badge: "✕ 错误", tone: "error", text: msg, timestamp: this.endedAt });
    this.ui?.clearWidget?.(ctx); this.persist();
    const tok = this.leaseToken; this.leaseToken = null;
    if (tok) { try { this.store?.releaseProjectFlowLease(this.flowId ?? undefined, tok); } catch {} }
    const snap = this.getSnapshot(); this.ui?.sendSummaryCard?.(snap, msg, ctx); this.notify(); return snap;
  }
  dispose(ctx?: any): void {
    this.disposed = true; this.cancelled = true; this.stopSteerPoll(); this.flowAbortController?.abort(); this.flowAbortController = null;
    const tok = this.leaseToken; this.leaseToken = null;
    if (this.status === "running" && tok) {
      try { this.store?.releaseFlowOwnership(this.flowId, process.pid, tok); } catch {}
      try { this.store?.releaseProjectFlowLease(this.flowId ?? undefined, tok); } catch {}
    }
    for (const item of [...this.controlStack].reverse()) void Promise.resolve(item.controls.abort()).catch(() => {});
    this.controlStack = []; this.ui?.clearWidget?.(ctx); this.listeners.clear();
  }
}
