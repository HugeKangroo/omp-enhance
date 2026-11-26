import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { diffSnapshots, snapshotWorkspace } from "../core/fs.ts";
import { canRoleDispatch, isInternalRole } from "../core/policy.ts";
import { loadEnhanceSettings } from "../core/settings.ts";
import type { BackgroundJob, FlowRoomStatus, HandoffEnvelope, Mandate } from "../core/types.ts";
import { createAndVerifyHandoff } from "../flow/handoff.ts";
import type { RoleSessionRunner } from "../flow/orchestrator.ts";
import { isCheckpointResumable, snapshotFromCheckpoint, type FlowRoomSnapshot } from "../flow/state.ts";
import { reconcileJobs } from "../jobs/runner.ts";
import type { FlowMonitorTarget } from "../ui/flow-room.ts";
import { evaluateWorkspaceTrust, grantProjectTrust, resolveTrustedProjectsFilePath, revokeProjectTrust } from "./trust.ts";
import { createManagedWorkspace, type BackgroundFlowSettlement, type ManagedWorkspace } from "./workspace.ts";

export interface HubOptions {
  globalRolesDir?: string; builtinRolesDir?: string; pluginLockPath?: string;
  runnerFactory?: (pi: any, ctx: any) => RoleSessionRunner;
}

export interface HubFlowSummary {
  cwd: string; flowId: string | null; status: FlowRoomStatus; resumable: boolean;
  roleChain: string[]; currentIndex: number; repairRound: number; goal: string;
  reason?: string; questionsForUser?: string[];
  waitingNodes?: Array<{ nodeId: string; questions: string[] }>;
  mergedRef?: string | null;
}

export interface PendingWakeup {
  flowId: string; settlementKey: string; originWs: ManagedWorkspace; ctx: any; report: string;
}

export interface WorkspaceHub {
  readonly pendingWakeups: Map<string, PendingWakeup>;
  getWorkspace(ctxOrCwd: any, hostCtx?: any): ManagedWorkspace;
  resolveTargetWorkspace(originWs: ManagedWorkspace, rawCwd: string | undefined, ctx: any): ManagedWorkspace;
  grantProjectTrust(rawCwd: string | undefined, originWs: ManagedWorkspace, ctx: any): ManagedWorkspace;
  revokeProjectTrust(rawCwd: string | undefined, originWs: ManagedWorkspace, ctx: any): ManagedWorkspace;
  findWorkspaceByFlowId(flowId: string, ctx?: any): ManagedWorkspace | undefined;
  findWorkspaceByJobId(jobId: string): ManagedWorkspace | undefined;
  resolveFlowWorkspace(originWs: ManagedWorkspace, params: { flowId?: string; cwd?: string }, ctx: any, predicate?: (ws: ManagedWorkspace) => boolean): ManagedWorkspace;
  seedLocalChangesHandoff(ws: ManagedWorkspace, sid: string, mandate: Mandate, firstRoleId: string): HandoffEnvelope | null;
  markFlowSnapshotObserved(ws: ManagedWorkspace, flowId?: string): void;
  markAllSettledFlowsObserved(): void;
  setForegroundTurnActive(active: boolean): void;
  flushPendingWakeups(ctx?: any): void;
  isSelfResumeBlockedDuringWakeup(flowId: string, ctx?: any): boolean;
  listWorkspaces(): ManagedWorkspace[];
  getMonitorTargets(primaryWs?: ManagedWorkspace): FlowMonitorTarget[];
  getAllFlowSummaries(): HubFlowSummary[];
  getAllJobs(status?: BackgroundJob["status"]): BackgroundJob[];
  getAllRunningJobs(): BackgroundJob[];
  collectActiveWorkloads(): string[];
  syncGlobalUi(ctx: any, originWs?: ManagedWorkspace): void;
  disposeAll(): void;
}

const MAX_TRACKED_SUBPROJECTS = 24;

export function resolveHubProjectsFilePath(options: HubOptions = {}): string {
  const envHome = process.env.OMP_ENHANCE_HOME?.trim();
  if (envHome) return path.join(path.resolve(envHome), ".omp", "enhance", "hub-projects.json");
  if (options.globalRolesDir) {
    const defaultRoles = path.join(homedir(), ".omp", "enhance", "roles");
    const resolvedRoles = path.resolve(options.globalRolesDir);
    if (resolvedRoles !== path.resolve(defaultRoles)) return path.join(path.dirname(resolvedRoles), "hub-projects.json");
  }
  return path.join(homedir(), ".omp", "enhance", "hub-projects.json");
}

function readHubProjectsMap(filePath: string): Record<string, string[]> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((it): it is string => typeof it === "string" && it.trim().length > 0);
    }
    return out;
  } catch { return {}; }
}

function persistSecondaryProject(filePath: string, primaryCwd: string, targetCwd: string): void {
  if (primaryCwd === targetCwd) return;
  try {
    const map = readHubProjectsMap(filePath);
    const prev = (map[primaryCwd] ?? []).filter((p) => p !== targetCwd && p !== primaryCwd);
    map[primaryCwd] = [targetCwd, ...prev].slice(0, MAX_TRACKED_SUBPROJECTS);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
    writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, "utf8");
    renameSync(tmp, filePath);
  } catch {}
}

export function computeSettlementKey(snap: Pick<FlowRoomSnapshot, "flowId" | "status" | "stages">): string | null {
  if (!snap.flowId || snap.status === "idle" || snap.status === "running") return null;
  return `${snap.flowId}:${snap.status}:${snap.stages.length}`;
}

function collectWaitingNodes(snap: FlowRoomSnapshot): Array<{ nodeId: string; questions: string[] }> {
  const fromGraph = (snap.graphSnapshot?.nodes ?? [])
    .filter((n) => n.status === "waiting_input")
    .map((n) => ({ nodeId: n.nodeId, questions: n.questionsForUser?.length ? [...n.questionsForUser] : [n.summary ?? "需要用户确认"] }));
  if (fromGraph.length > 0) return fromGraph;
  const env = [...snap.stages].reverse().find((s) => s.envelope?.questionsForUser?.length)?.envelope;
  return env?.questionsForUser?.length ? [{ nodeId: env.fromRole, questions: [...env.questionsForUser] }] : [];
}

function toFlowSummary(cwd: string, snap: FlowRoomSnapshot, resumable: boolean): HubFlowSummary {
  const waitingNodes = snap.status === "waiting_input" ? collectWaitingNodes(snap) : [];
  const allQuestions = waitingNodes.flatMap((w) => w.questions.map((q) => (waitingNodes.length > 1 ? `[${w.nodeId}] ${q}` : q)));
  return {
    cwd, flowId: snap.flowId, status: snap.status, resumable,
    roleChain: snap.roleChain, currentIndex: snap.currentIndex ?? 0, repairRound: snap.repairRound ?? 0, goal: snap.goal,
    ...(snap.reason ? { reason: snap.reason } : {}),
    ...(allQuestions.length > 0 ? { questionsForUser: allQuestions } : {}),
    ...(waitingNodes.length > 0 ? { waitingNodes } : {}),
    ...(snap.graphSnapshot?.mergedRef ? { mergedRef: snap.graphSnapshot.mergedRef } : {}),
  };
}

function formatFlowEventReport(settlement: BackgroundFlowSettlement): string {
  const { targetWs, flowId, mandate, roleChain, result, error } = settlement;
  const snap = targetWs.room.getSnapshot();
  const status = error ? "failed" : (result?.status ?? "failed"), env = result?.finalEnvelope ?? null;
  const summary = error ? (error instanceof Error ? error.message : String(error)) : (env?.summary ?? result?.reason ?? status);
  const isRejectedAudit = status === "completed" && env?.verdict === "rejected";
  const lines = [
    `[Flow Event · ${status}${isRejectedAudit ? " (audit_rejected)" : ""}] flowId=${flowId} · cwd=${targetWs.cwd} · chain=${roleChain.join(" → ")}`,
    `Goal: ${mandate.goal}`, `Summary: ${summary}`,
  ];
  const mergedRef = result?.mergedRef ?? snap.graphSnapshot?.mergedRef;
  if (mergedRef) lines.push(`Delivery ref: ${mergedRef}`);
  if (isRejectedAudit && env?.feedbackForUpstream) lines.push(`Findings: ${env.feedbackForUpstream}`);
  else if (result?.reason && result.reason !== summary) lines.push(`Detail: ${result.reason}`);
  if (env?.artifacts.length) lines.push(`Artifacts: ${env.artifacts.map((a) => `${a.path} [${a.role}]`).join(", ")}`);
  if (env?.deletedFiles?.length) lines.push(`Deleted files: ${env.deletedFiles.join(", ")}`);
  if (env?.verifiedFacts.length) lines.push("Verified facts:", ...env.verifiedFacts.map((f) => `- ${f.claim} (evidence: ${f.evidenceRef})`));
  if (env?.openRisks.length) lines.push("Open risks:", ...env.openRisks.map((r) => `- ${r}`));
  const waitingNodes = status === "waiting_input" ? collectWaitingNodes(snap) : [];
  if (waitingNodes.length > 0) {
    lines.push(
      "Questions for user:",
      ...waitingNodes.flatMap((w) => w.questions.map((q) => `- [${w.nodeId}] ${q}`)),
      `Action required: Relay ALL questions above to the user in plain language and STOP to wait for their reply — do NOT guess or answer on the user's behalf. Resume each answered node individually with enhance_flow(action="resume", flowId="${flowId}", cwd="${targetWs.cwd}", nodeId="<nodeId>", message="<user's exact answer>").`,
    );
  }
  return lines.join("\n");
}

function assertExistingDir(targetCwd: string): void {
  let isDir = false;
  try { isDir = existsSync(targetCwd) && statSync(targetCwd).isDirectory(); } catch { isDir = false; }
  if (!isDir) throw new Error(`Target project directory does not exist: ${targetCwd}`);
}

function countBranchUserMessages(ctx: any): number | null {
  const fn = ctx?.sessionManager?.getBranch ?? ctx?.sessionManager?.getEntries;
  if (typeof fn !== "function") return null;
  try {
    const entries: any[] = fn.call(ctx.sessionManager) ?? [];
    let count = 0;
    for (const e of entries) if (e?.type === "message" && e?.message?.role === "user") count += 1;
    return count;
  } catch { return null; }
}

export function createWorkspaceHub(pi: any, options: HubOptions = {}): WorkspaceHub {
  const workspaces = new Map<string, ManagedWorkspace>(), hydratedRoots = new Set<string>();
  const lastReportedKeys = new Map<string, string>(), pendingWakeups = new Map<string, PendingWakeup>();
  const waitingWakeupUserCounts = new Map<string, number>();
  const hubProjectsPath = resolveHubProjectsFilePath(options), trustStorePath = resolveTrustedProjectsFilePath(options);
  let primaryCwd = path.resolve(pi?.cwd ?? process.cwd()), foregroundTurnActive = false;
  let wakeupTimer: ReturnType<typeof setTimeout> | null = null;

  const clearWakeupTimer = (): void => { if (wakeupTimer !== null) { clearTimeout(wakeupTimer); wakeupTimer = null; } };
  const evaluateTrustFor = (targetCwd: string, ctx?: any) => evaluateWorkspaceTrust({ targetCwd, originCwd: primaryCwd, ctx, trustStorePath });
  const reconcileAllStores = (): void => {
    for (const ws of workspaces.values()) if (!ws.store.isClosed()) { try { reconcileJobs(ws.store); } catch {} }
  };
  const getActiveTargets = (): readonly FlowMonitorTarget[] => [...workspaces.values()].map((w) => ({ cwd: w.cwd, room: w.room }));

  const scheduleFallbackFlush = (): void => {
    clearWakeupTimer();
    wakeupTimer = setTimeout(() => { wakeupTimer = null; hub.flushPendingWakeups(); }, foregroundTurnActive ? 30_000 : 30);
    wakeupTimer.unref?.();
  };

  const emitEventMessage = (content: string, originWs: ManagedWorkspace, ctx: any): void => {
    if (typeof pi?.sendMessage !== "function") return;
    const shouldWake = Boolean(ctx?.hasUI && canRoleDispatch(originWs.getActiveRole(ctx)));
    try {
      pi.sendMessage({ customType: "omp-enhance-flow-event", content, display: false, excludeFromContext: false }, { triggerTurn: shouldWake, deliverAs: "followUp" });
    } catch {}
  };

  const onBackgroundFlowSettled = (settlement: BackgroundFlowSettlement): void => {
    if (typeof pi?.sendMessage !== "function") return;
    const snap = settlement.targetWs.room.getSnapshot();
    const status = settlement.error ? "failed" : (settlement.result?.status ?? snap.status);
    const key = computeSettlementKey(snap) ?? `${settlement.flowId}:${status}:${snap.stages.length}`;
    if (lastReportedKeys.get(settlement.flowId) === key) return;
    const report = formatFlowEventReport(settlement);
    if (status === "waiting_input") {
      const uc = countBranchUserMessages(settlement.ctx);
      if (uc !== null) waitingWakeupUserCounts.set(settlement.flowId, uc);
    } else {
      waitingWakeupUserCounts.delete(settlement.flowId);
    }
    if (settlement.ctx?.isIdle?.() === false) {
      pendingWakeups.set(settlement.flowId, { flowId: settlement.flowId, settlementKey: key, originWs: settlement.originWs, ctx: settlement.ctx, report });
      scheduleFallbackFlush();
      return;
    }
    lastReportedKeys.set(settlement.flowId, key);
    pendingWakeups.delete(settlement.flowId);
    emitEventMessage(report, settlement.originWs, settlement.ctx);
  };

  const ensureWorkspace = (cwd: string, effectiveCtx: any): ManagedWorkspace => {
    const trustEval = evaluateTrustFor(cwd, effectiveCtx), existing = workspaces.get(cwd);
    if (existing) {
      if (existing.isTrusted !== trustEval.trusted) existing.refresh(effectiveCtx);
      else {
        existing.trustNotice = trustEval.trustNotice;
        existing.settings = loadEnhanceSettings({ cwd, pluginLockPath: options.pluginLockPath, isProjectTrusted: existing.isTrusted });
      }
      return existing;
    }
    const created = createManagedWorkspace(pi, cwd, trustEval, options, {
      syncGlobalUi: (c, ws) => hub.syncGlobalUi(c, ws), getActiveTargets, onBackgroundFlowSettled, evaluateTrust: evaluateTrustFor,
    });
    workspaces.set(cwd, created);
    return created;
  };

  const hydrateTrackedProjectsFor = (rootCwd: string, ctx: any, force = false): void => {
    if (!force && hydratedRoots.has(rootCwd)) return;
    hydratedRoots.add(rootCwd);
    for (const rawSub of readHubProjectsMap(hubProjectsPath)[rootCwd] ?? []) {
      const subCwd = path.resolve(rawSub);
      if (subCwd === rootCwd || workspaces.has(subCwd)) continue;
      try { if (existsSync(subCwd) && statSync(subCwd).isDirectory()) ensureWorkspace(subCwd, ctx); } catch {}
    }
  };

  const wsHasResumableFlow = (ws: ManagedWorkspace): boolean =>
    ws.room.isResumable() || (!ws.store.isClosed() && ws.store.listFlowCheckpoints(10).some((cp) => isCheckpointResumable(cp)));

  const hub: WorkspaceHub = {
    pendingWakeups,
    getWorkspace(ctxOrCwd: any, hostCtx?: any): ManagedWorkspace {
      const isDirectCwd = typeof ctxOrCwd === "string";
      const cwd = path.resolve(isDirectCwd ? ctxOrCwd : (ctxOrCwd?.cwd ?? hostCtx?.cwd ?? process.cwd()));
      const effectiveCtx = isDirectCwd ? hostCtx : ctxOrCwd;
      if (!isDirectCwd && workspaces.size === 0) primaryCwd = cwd;
      const ws = ensureWorkspace(cwd, effectiveCtx);
      if (!isDirectCwd) hydrateTrackedProjectsFor(cwd, effectiveCtx);
      return ws;
    },
    resolveTargetWorkspace(originWs: ManagedWorkspace, rawCwd: string | undefined, ctx: any): ManagedWorkspace {
      if (!rawCwd) return originWs;
      const targetCwd = path.resolve(originWs.cwd, rawCwd);
      assertExistingDir(targetCwd);
      const targetWs = hub.getWorkspace(targetCwd, ctx);
      if (targetCwd !== originWs.cwd) persistSecondaryProject(hubProjectsPath, originWs.cwd, targetCwd);
      return targetWs;
    },
    grantProjectTrust(rawCwd, originWs, ctx): ManagedWorkspace {
      const targetCwd = rawCwd ? path.resolve(originWs.cwd, rawCwd) : originWs.cwd;
      assertExistingDir(targetCwd);
      grantProjectTrust(trustStorePath, targetCwd);
      const ws = hub.resolveTargetWorkspace(originWs, targetCwd, ctx);
      ws.refresh(ctx); return ws;
    },
    revokeProjectTrust(rawCwd, originWs, ctx): ManagedWorkspace {
      const targetCwd = rawCwd ? path.resolve(originWs.cwd, rawCwd) : originWs.cwd;
      assertExistingDir(targetCwd);
      revokeProjectTrust(trustStorePath, targetCwd);
      const ws = hub.resolveTargetWorkspace(originWs, targetCwd, ctx);
      ws.refresh(ctx); return ws;
    },
    findWorkspaceByFlowId(flowId: string, ctx?: any): ManagedWorkspace | undefined {
      for (const ws of workspaces.values()) if (ws.room.getSnapshot().flowId === flowId) return ws;
      for (const ws of workspaces.values()) if (!ws.store.isClosed() && ws.store.getFlowCheckpoint(flowId)) return ws;
      hydrateTrackedProjectsFor(primaryCwd, ctx, true);
      for (const ws of workspaces.values()) if (!ws.store.isClosed() && ws.store.getFlowCheckpoint(flowId)) return ws;
      return undefined;
    },
    findWorkspaceByJobId(jobId: string): ManagedWorkspace | undefined {
      for (const ws of workspaces.values()) if (!ws.store.isClosed() && ws.store.getJob(jobId)) return ws;
      return undefined;
    },
    resolveFlowWorkspace(originWs, params, ctx, predicate): ManagedWorkspace {
      if (params.flowId) {
        const found = params.cwd ? hub.resolveTargetWorkspace(originWs, params.cwd, ctx) : hub.findWorkspaceByFlowId(params.flowId, ctx);
        if (!found) throw new Error(`Unknown flowId "${params.flowId}".`);
        if (found.room.getSnapshot().flowId !== params.flowId && (found.store.isClosed() || !found.store.getFlowCheckpoint(params.flowId))) {
          throw new Error(`Unknown flowId "${params.flowId}".`);
        }
        return found;
      }
      if (params.cwd) return hub.resolveTargetWorkspace(originWs, params.cwd, ctx);
      const effPredicate = predicate ?? wsHasResumableFlow;
      if (!predicate || effPredicate(originWs)) return originWs;
      const matches = [...workspaces.values()].filter(effPredicate);
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        const choices = matches.map((w) => `${w.room.getSnapshot().flowId ?? "flow"} (${w.cwd})`).join(", ");
        throw new Error(`Multiple project Flows match; specify flowId or cwd: ${choices}`);
      }
      return originWs;
    },
    seedLocalChangesHandoff(ws, sid, mandate, firstRoleId): HandoffEnvelope | null {
      const tracker = ws.trackers.get(sid);
      if (tracker.getObservedCalls().length === 0) return null;
      const before = tracker.getBaselineSnapshot(ws.cwd);
      if (!before) return null;
      const after = snapshotWorkspace(ws.cwd), diff = diffSnapshots(before, after);
      if (diff.added.length === 0 && diff.modified.length === 0 && diff.deleted.length === 0) return null;
      const seedRole = ws.roles.get("dev") ?? [...ws.roles.values()].find((r) => !isInternalRole(r));
      if (!seedRole) return null;
      try {
        return createAndVerifyHandoff({
          store: ws.store, role: { ...seedRole, permissions: {}, exit: { requireToolEvidence: false, criteria: [] } },
          cwd: ws.cwd, mandate, sessionId: sid, flowId: mandate.flowId ?? null, toTarget: firstRoleId,
          verdict: "ready", summary: "Workspace local changes snapshot",
          baselineSnapshot: before, afterSnapshot: after, observedCalls: tracker.getObservedCalls(),
        });
      } catch { return null; }
    },
    markFlowSnapshotObserved(ws: ManagedWorkspace, flowId?: string): void {
      const ownsLive = ws.room.hasActiveLeaseOwnership();
      const targetId = flowId ?? ws.room.getSnapshot().flowId;
      const cp = targetId && (!ownsLive || ws.room.getSnapshot().flowId !== targetId) && !ws.store.isClosed()
        ? ws.store.getFlowCheckpoint(targetId)
        : null;
      const snap = cp ? snapshotFromCheckpoint(cp, ws.cwd) : ws.room.getSnapshot();
      const key = computeSettlementKey(snap);
      if (!key || !snap.flowId) return;
      lastReportedKeys.set(snap.flowId, key);
      if (pendingWakeups.get(snap.flowId)?.settlementKey === key) {
        pendingWakeups.delete(snap.flowId);
        if (pendingWakeups.size === 0) clearWakeupTimer();
      }
    },
    markAllSettledFlowsObserved(): void { for (const ws of workspaces.values()) hub.markFlowSnapshotObserved(ws); },
    setForegroundTurnActive(active: boolean): void { foregroundTurnActive = active; },
    flushPendingWakeups(ctx?: any): void {
      clearWakeupTimer();
      if (pendingWakeups.size === 0) return;
      const items = [...pendingWakeups.values()].filter((it) => lastReportedKeys.get(it.flowId) !== it.settlementKey);
      pendingWakeups.clear();
      if (items.length === 0) return;
      for (const item of items) lastReportedKeys.set(item.flowId, item.settlementKey);
      emitEventMessage(items.map((it) => it.report).join("\n\n---\n\n"), items[0]!.originWs, ctx ?? items[0]!.ctx);
    },
    isSelfResumeBlockedDuringWakeup(flowId: string, ctx?: any): boolean {
      const recorded = waitingWakeupUserCounts.get(flowId);
      if (recorded === undefined) return false;
      const cur = countBranchUserMessages(ctx);
      if (cur === null || cur > recorded) { waitingWakeupUserCounts.delete(flowId); return false; }
      return true;
    },
    listWorkspaces: () => [...workspaces.values()],
    getMonitorTargets(primaryWs?: ManagedWorkspace): FlowMonitorTarget[] {
      if (primaryWs) hydrateTrackedProjectsFor(primaryWs.cwd, undefined);
      const ordered = primaryWs ? [primaryWs, ...[...workspaces.values()].filter((w) => w.cwd !== primaryWs.cwd)] : [...workspaces.values()];
      return ordered.map((w) => ({ cwd: w.cwd, room: w.room }));
    },
    getAllFlowSummaries(): HubFlowSummary[] {
      const out: HubFlowSummary[] = [], seen = new Set<string>();
      for (const ws of workspaces.values()) {
        let emittedForWs = 0;
        const roomSnap = ws.room.getSnapshot();
        if (ws.room.hasActiveLeaseOwnership() && roomSnap.flowId) {
          out.push(toFlowSummary(ws.cwd, roomSnap, ws.room.isResumable()));
          seen.add(roomSnap.flowId); emittedForWs += 1;
        }
        const cps = !ws.store.isClosed() ? ws.store.listFlowCheckpoints(20) : [];
        for (const cp of cps) {
          if (seen.has(cp.flowId)) continue;
          const actionable = cp.status === "running" || cp.status === "waiting_input" || cp.status === "interrupted";
          if (emittedForWs === 0 || actionable) {
            out.push(toFlowSummary(ws.cwd, snapshotFromCheckpoint(cp, ws.cwd), isCheckpointResumable(cp)));
            seen.add(cp.flowId); emittedForWs += 1;
          }
        }
        if (emittedForWs === 0) out.push(toFlowSummary(ws.cwd, roomSnap, ws.room.isResumable()));
      }
      return out;
    },
    getAllJobs(status?: BackgroundJob["status"]): BackgroundJob[] {
      reconcileAllStores();
      const jobs: BackgroundJob[] = [];
      for (const ws of workspaces.values()) if (!ws.store.isClosed()) jobs.push(...ws.store.listJobs(status));
      return jobs;
    },
    getAllRunningJobs: () => hub.getAllJobs("running"),
    collectActiveWorkloads(): string[] {
      reconcileAllStores();
      const lines: string[] = [];
      for (const s of hub.getAllFlowSummaries()) {
        if (!s.flowId || s.status === "idle" || s.status === "completed" || s.status === "cancelled") continue;
        const qHint = s.questionsForUser?.length ? ` questions=${JSON.stringify(s.questionsForUser)}` : "";
        lines.push(`[flow ${s.flowId}] cwd=${s.cwd} status=${s.status} chain=${s.roleChain.join("->")} stage=${s.currentIndex + 1}/${Math.max(1, s.roleChain.length)} goal=${JSON.stringify(s.goal)}${qHint}`);
      }
      for (const j of hub.getAllRunningJobs()) lines.push(`[job ${j.jobId}] cwd=${j.cwd} status=${j.status} pid=${j.pid} cmd=${JSON.stringify(j.command)}`);
      return lines;
    },
    syncGlobalUi(ctx: any, originWs?: ManagedWorkspace): void {
      reconcileAllStores();
      const fgWs = originWs ?? hub.getWorkspace(ctx), role = fgWs.getActiveRole(ctx), summaries = hub.getAllFlowSummaries();
      const runningFlows = summaries.filter((s) => s.status === "running"), waitingFlows = summaries.filter((s) => s.status === "waiting_input");
      const runningJobs = hub.getAllRunningJobs();
      if (!role && runningFlows.length === 0 && waitingFlows.length === 0 && runningJobs.length === 0) {
        try { ctx?.ui?.setStatus?.("omp-enhance", undefined); } catch {}
        try { ctx?.ui?.setWidget?.("omp-enhance-flow", undefined); } catch {}
        return;
      }
      if (!fgWs.settings.showStatusBar) { try { ctx?.ui?.setStatus?.("omp-enhance", undefined); } catch {} return; }
      const rolePart = role ? `enhance:${role.id}${role.model ? ` (${role.model})` : ""}` : "enhance:bg";
      const flowPart = runningFlows.length === 1 ? ` · flow:${runningFlows[0]!.roleChain.join("→")}` : runningFlows.length > 1 ? ` · flows:${runningFlows.length} running` : "";
      const waitPart = waitingFlows.length > 0 ? ` · waiting_input:${waitingFlows.length}` : "";
      const jobPart = runningJobs.length > 0 ? ` · jobs:${runningJobs.length}` : "";
      try { ctx?.ui?.setStatus?.("omp-enhance", `${rolePart}${flowPart}${waitPart}${jobPart}`); } catch {}
    },
    disposeAll(): void {
      clearWakeupTimer(); pendingWakeups.clear(); foregroundTurnActive = false;
      for (const ws of workspaces.values()) {
        try { ws.room.dispose(); } catch {} try { ws.store.close(); } catch {}
        ws.trackers.clear(); ws.baselines.clear();
      }
      workspaces.clear(); hydratedRoots.clear();
    },
  };
  return hub;
}
