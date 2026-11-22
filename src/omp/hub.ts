import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { diffSnapshots, snapshotWorkspace } from "../core/fs.ts";
import { canRoleDispatch, isInternalRole } from "../core/policy.ts";
import { loadEnhanceSettings } from "../core/settings.ts";
import type { BackgroundJob, FlowRoomStatus, HandoffEnvelope, Mandate } from "../core/types.ts";
import { createAndVerifyHandoff } from "../flow/handoff.ts";
import type { RoleSessionRunner } from "../flow/orchestrator.ts";
import type { FlowRoomSnapshot } from "../flow/state.ts";
import { reconcileJobs } from "../jobs/runner.ts";
import type { FlowMonitorTarget } from "../ui/flow-room.ts";
import {
  createManagedWorkspace, isProjectTrusted,
  type BackgroundFlowSettlement, type ManagedWorkspace,
} from "./workspace.ts";

export interface HubOptions {
  globalRolesDir?: string;
  builtinRolesDir?: string;
  pluginLockPath?: string;
  runnerFactory?: (pi: any, ctx: any) => RoleSessionRunner;
}

export interface HubFlowSummary {
  cwd: string;
  flowId: string | null;
  status: FlowRoomStatus;
  resumable: boolean;
  roleChain: string[];
  currentIndex: number;
  repairRound: number;
  goal: string;
  reason?: string;
  questionsForUser?: string[];
}

export interface PendingWakeup {
  flowId: string;
  settlementKey: string;
  originWs: ManagedWorkspace;
  ctx: any;
  report: string;
}

export interface WorkspaceHub {
  readonly pendingWakeups: Map<string, PendingWakeup>;
  getWorkspace(ctxOrCwd: any, hostCtx?: any): ManagedWorkspace;
  resolveTargetWorkspace(originWs: ManagedWorkspace, rawCwd: string | undefined, ctx: any): ManagedWorkspace;
  findWorkspaceByFlowId(flowId: string): ManagedWorkspace | undefined;
  findWorkspaceByJobId(jobId: string): ManagedWorkspace | undefined;
  resolveFlowWorkspace(
    originWs: ManagedWorkspace,
    params: { flowId?: string; cwd?: string },
    ctx: any,
    predicate?: (ws: ManagedWorkspace) => boolean,
  ): ManagedWorkspace;
  seedLocalChangesHandoff(ws: ManagedWorkspace, sid: string, mandate: Mandate, firstRoleId: string): HandoffEnvelope | null;
  markFlowSnapshotObserved(ws: ManagedWorkspace): void;
  markAllSettledFlowsObserved(): void;
  setForegroundTurnActive(active: boolean): void;
  flushPendingWakeups(ctx?: any): void;
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
    if (resolvedRoles !== path.resolve(defaultRoles)) {
      return path.join(path.dirname(resolvedRoles), "hub-projects.json");
    }
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
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
    writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, "utf8");
    renameSync(tmp, filePath);
  } catch {}
}

export function computeSettlementKey(snap: Pick<FlowRoomSnapshot, "flowId" | "status" | "stages">): string | null {
  if (!snap.flowId || snap.status === "idle" || snap.status === "running") return null;
  return `${snap.flowId}:${snap.status}:${snap.stages.length}`;
}

function formatFlowEventReport(settlement: BackgroundFlowSettlement): string {
  const { targetWs, flowId, mandate, roleChain, result, error } = settlement;
  const status = error ? "failed" : (result?.status ?? "failed");
  const env = result?.finalEnvelope ?? null;
  const summary = error ? (error instanceof Error ? error.message : String(error)) : (env?.summary ?? result?.reason ?? status);
  const isRejectedAudit = status === "completed" && env?.verdict === "rejected";
  const lines = [
    `[Flow Event · ${status}${isRejectedAudit ? " (audit_rejected)" : ""}] flowId=${flowId} · cwd=${targetWs.cwd} · chain=${roleChain.join(" → ")}`,
    `Goal: ${mandate.goal}`,
    `Summary: ${summary}`,
  ];
  if (isRejectedAudit && env?.feedbackForUpstream) lines.push(`Findings: ${env.feedbackForUpstream}`);
  else if (result?.reason && result.reason !== summary) lines.push(`Detail: ${result.reason}`);
  if (env?.artifacts.length) lines.push(`Artifacts: ${env.artifacts.map((a) => `${a.path} [${a.role}]`).join(", ")}`);
  if (env?.deletedFiles?.length) lines.push(`Deleted files: ${env.deletedFiles.join(", ")}`);
  if (env?.verifiedFacts.length) lines.push("Verified facts:", ...env.verifiedFacts.map((f) => `- ${f.claim} (evidence: ${f.evidenceRef})`));
  if (env?.openRisks.length) lines.push("Open risks:", ...env.openRisks.map((r) => `- ${r}`));
  if (env?.questionsForUser?.length) {
    lines.push(
      "Questions for user:",
      ...env.questionsForUser.map((q) => `- ${q}`),
      `Action required: Relay these questions to the user in plain language. Once answered, resume with enhance_flow(action="resume", flowId="${flowId}", cwd="${targetWs.cwd}", message="<user's answer>").`,
    );
  }
  return lines.join("\n");
}

export function createWorkspaceHub(pi: any, options: HubOptions = {}): WorkspaceHub {
  const workspaces = new Map<string, ManagedWorkspace>();
  const hydratedRoots = new Set<string>();
  const lastReportedKeys = new Map<string, string>();
  const pendingWakeups = new Map<string, PendingWakeup>();
  const hubProjectsPath = resolveHubProjectsFilePath(options);
  let foregroundTurnActive = false;
  let wakeupTimer: ReturnType<typeof setTimeout> | null = null;

  const clearWakeupTimer = (): void => {
    if (wakeupTimer !== null) { clearTimeout(wakeupTimer); wakeupTimer = null; }
  };

  const reconcileAllStores = (): void => {
    for (const ws of workspaces.values()) {
      if (!ws.store.isClosed()) { try { reconcileJobs(ws.store); } catch {} }
    }
  };

  const getActiveTargets = (): readonly FlowMonitorTarget[] =>
    [...workspaces.values()].map((w) => ({ cwd: w.cwd, room: w.room }));

  const scheduleFallbackFlush = (): void => {
    clearWakeupTimer();
    const delayMs = foregroundTurnActive ? 30_000 : 30;
    wakeupTimer = setTimeout(() => {
      wakeupTimer = null;
      hub.flushPendingWakeups();
    }, delayMs);
    wakeupTimer.unref?.();
  };

  const emitEventMessage = (content: string, originWs: ManagedWorkspace, ctx: any): void => {
    if (typeof pi?.sendMessage !== "function") return;
    const shouldWake = Boolean(ctx?.hasUI && canRoleDispatch(originWs.getActiveRole(ctx)));
    try {
      pi.sendMessage(
        { customType: "omp-enhance-flow-event", content, display: false, excludeFromContext: false },
        { triggerTurn: shouldWake, deliverAs: "followUp" },
      );
    } catch {}
  };

  const onBackgroundFlowSettled = (settlement: BackgroundFlowSettlement): void => {
    if (typeof pi?.sendMessage !== "function") return;
    const snap = settlement.targetWs.room.getSnapshot();
    const status = settlement.error ? "failed" : (settlement.result?.status ?? snap.status);
    const key = computeSettlementKey(snap) ?? `${settlement.flowId}:${status}:${snap.stages.length}`;
    if (lastReportedKeys.get(settlement.flowId) === key) return;

    const report = formatFlowEventReport(settlement);
    const isBusy = settlement.ctx?.isIdle?.() === false;
    if (isBusy) {
      pendingWakeups.set(settlement.flowId, {
        flowId: settlement.flowId, settlementKey: key, originWs: settlement.originWs, ctx: settlement.ctx, report,
      });
      scheduleFallbackFlush();
      return;
    }

    lastReportedKeys.set(settlement.flowId, key);
    pendingWakeups.delete(settlement.flowId);
    emitEventMessage(report, settlement.originWs, settlement.ctx);
  };

  const ensureWorkspace = (cwd: string, effectiveCtx: any): ManagedWorkspace => {
    const trusted = isProjectTrusted(effectiveCtx);
    const existing = workspaces.get(cwd);
    if (existing) {
      existing.settings = loadEnhanceSettings({ cwd, pluginLockPath: options.pluginLockPath, isProjectTrusted: trusted });
      return existing;
    }
    const created = createManagedWorkspace(pi, cwd, trusted, options, {
      syncGlobalUi: (c, ws) => hub.syncGlobalUi(c, ws),
      getActiveTargets,
      onBackgroundFlowSettled,
    });
    workspaces.set(cwd, created);
    return created;
  };

  const hydrateTrackedProjectsFor = (primaryCwd: string, ctx: any): void => {
    if (hydratedRoots.has(primaryCwd)) return;
    hydratedRoots.add(primaryCwd);
    const persisted = readHubProjectsMap(hubProjectsPath)[primaryCwd];
    if (!persisted || persisted.length === 0) return;
    for (const rawSub of persisted) {
      const subCwd = path.resolve(rawSub);
      if (subCwd === primaryCwd || workspaces.has(subCwd)) continue;
      try {
        if (existsSync(subCwd) && statSync(subCwd).isDirectory()) ensureWorkspace(subCwd, ctx);
      } catch {}
    }
  };

  const hub: WorkspaceHub = {
    pendingWakeups,

    getWorkspace(ctxOrCwd: any, hostCtx?: any): ManagedWorkspace {
      const isDirectCwd = typeof ctxOrCwd === "string";
      const rawCwd = isDirectCwd ? ctxOrCwd : (ctxOrCwd?.cwd ?? hostCtx?.cwd ?? process.cwd());
      const cwd = path.resolve(rawCwd);
      const effectiveCtx = isDirectCwd ? hostCtx : ctxOrCwd;
      const ws = ensureWorkspace(cwd, effectiveCtx);
      if (!isDirectCwd) hydrateTrackedProjectsFor(cwd, effectiveCtx);
      return ws;
    },

    resolveTargetWorkspace(originWs: ManagedWorkspace, rawCwd: string | undefined, ctx: any): ManagedWorkspace {
      if (!rawCwd) return originWs;
      const targetCwd = path.resolve(originWs.cwd, rawCwd);
      let isDir = false;
      try { isDir = existsSync(targetCwd) && statSync(targetCwd).isDirectory(); } catch { isDir = false; }
      if (!isDir) throw new Error(`Target project directory does not exist: ${targetCwd}`);
      const targetWs = hub.getWorkspace(targetCwd, ctx);
      if (targetCwd !== originWs.cwd) persistSecondaryProject(hubProjectsPath, originWs.cwd, targetCwd);
      return targetWs;
    },

    findWorkspaceByFlowId(flowId: string): ManagedWorkspace | undefined {
      for (const ws of workspaces.values()) { if (ws.room.getSnapshot().flowId === flowId) return ws; }
      for (const ws of workspaces.values()) { if (!ws.store.isClosed() && ws.store.getFlowCheckpoint(flowId)) return ws; }
      return undefined;
    },

    findWorkspaceByJobId(jobId: string): ManagedWorkspace | undefined {
      for (const ws of workspaces.values()) { if (!ws.store.isClosed() && ws.store.getJob(jobId)) return ws; }
      return undefined;
    },

    resolveFlowWorkspace(originWs, params, ctx, predicate): ManagedWorkspace {
      if (params.flowId) {
        const found = hub.findWorkspaceByFlowId(params.flowId);
        if (!found) throw new Error(`Unknown flowId "${params.flowId}".`);
        return found;
      }
      if (params.cwd) return hub.resolveTargetWorkspace(originWs, params.cwd, ctx);
      if (!predicate || predicate(originWs)) return originWs;
      const matches = [...workspaces.values()].filter(predicate);
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
      const after = snapshotWorkspace(ws.cwd);
      const diff = diffSnapshots(before, after);
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

    markFlowSnapshotObserved(ws: ManagedWorkspace): void {
      const snap = ws.room.getSnapshot();
      const key = computeSettlementKey(snap);
      if (!key || !snap.flowId) return;
      lastReportedKeys.set(snap.flowId, key);
      if (pendingWakeups.get(snap.flowId)?.settlementKey === key) {
        pendingWakeups.delete(snap.flowId);
        if (pendingWakeups.size === 0) clearWakeupTimer();
      }
    },

    markAllSettledFlowsObserved(): void {
      for (const ws of workspaces.values()) hub.markFlowSnapshotObserved(ws);
    },

    setForegroundTurnActive(active: boolean): void {
      foregroundTurnActive = active;
    },

    flushPendingWakeups(ctx?: any): void {
      clearWakeupTimer();
      if (pendingWakeups.size === 0) return;
      const items = [...pendingWakeups.values()].filter((it) => lastReportedKeys.get(it.flowId) !== it.settlementKey);
      pendingWakeups.clear();
      if (items.length === 0) return;
      for (const item of items) lastReportedKeys.set(item.flowId, item.settlementKey);
      const mergedReport = items.map((it) => it.report).join("\n\n---\n\n");
      const first = items[0]!;
      emitEventMessage(mergedReport, first.originWs, ctx ?? first.ctx);
    },

    listWorkspaces: () => [...workspaces.values()],

    getMonitorTargets(primaryWs?: ManagedWorkspace): FlowMonitorTarget[] {
      if (primaryWs) hydrateTrackedProjectsFor(primaryWs.cwd, undefined);
      const ordered = primaryWs ? [primaryWs, ...[...workspaces.values()].filter((w) => w.cwd !== primaryWs.cwd)] : [...workspaces.values()];
      return ordered.map((w) => ({ cwd: w.cwd, room: w.room }));
    },

    getAllFlowSummaries(): HubFlowSummary[] {
      return [...workspaces.values()].map((ws) => {
        const snap = ws.room.getSnapshot();
        const latestStageEnv = [...snap.stages].reverse().find((s) => s.envelope)?.envelope;
        return {
          cwd: ws.cwd, flowId: snap.flowId, status: snap.status, resumable: ws.room.isResumable(),
          roleChain: snap.roleChain, currentIndex: snap.currentIndex ?? 0, repairRound: snap.repairRound ?? 0, goal: snap.goal,
          ...(snap.reason ? { reason: snap.reason } : {}),
          ...(latestStageEnv?.questionsForUser?.length ? { questionsForUser: [...latestStageEnv.questionsForUser] } : {}),
        };
      });
    },

    getAllJobs(status?: BackgroundJob["status"]): BackgroundJob[] {
      reconcileAllStores();
      const jobs: BackgroundJob[] = [];
      for (const ws of workspaces.values()) {
        if (!ws.store.isClosed()) jobs.push(...ws.store.listJobs(status));
      }
      return jobs;
    },

    getAllRunningJobs: () => hub.getAllJobs("running"),

    collectActiveWorkloads(): string[] {
      reconcileAllStores();
      const lines: string[] = [];
      for (const summary of hub.getAllFlowSummaries()) {
        if (!summary.flowId || summary.status === "idle" || summary.status === "completed" || summary.status === "cancelled") continue;
        const qHint = summary.questionsForUser?.length ? ` questions=${JSON.stringify(summary.questionsForUser)}` : "";
        lines.push(
          `[flow ${summary.flowId}] cwd=${summary.cwd} status=${summary.status} chain=${summary.roleChain.join("->")} stage=${summary.currentIndex + 1}/${Math.max(1, summary.roleChain.length)} goal=${JSON.stringify(summary.goal)}${qHint}`,
        );
      }
      for (const job of hub.getAllRunningJobs()) {
        lines.push(`[job ${job.jobId}] cwd=${job.cwd} status=${job.status} pid=${job.pid} cmd=${JSON.stringify(job.command)}`);
      }
      return lines;
    },

    syncGlobalUi(ctx: any, originWs?: ManagedWorkspace): void {
      reconcileAllStores();
      const fgWs = originWs ?? hub.getWorkspace(ctx);
      const role = fgWs.getActiveRole(ctx);
      const summaries = hub.getAllFlowSummaries();
      const runningFlows = summaries.filter((s) => s.status === "running");
      const waitingFlows = summaries.filter((s) => s.status === "waiting_input");
      const runningJobs = hub.getAllRunningJobs();

      if (!role && runningFlows.length === 0 && waitingFlows.length === 0 && runningJobs.length === 0) {
        try { ctx?.ui?.setStatus?.("omp-enhance", undefined); } catch {}
        try { ctx?.ui?.setWidget?.("omp-enhance-flow", undefined); } catch {}
        return;
      }
      if (!fgWs.settings.showStatusBar) {
        try { ctx?.ui?.setStatus?.("omp-enhance", undefined); } catch {}
        return;
      }
      const rolePart = role ? `enhance:${role.id}${role.model ? ` (${role.model})` : ""}` : "enhance:bg";
      const flowPart = runningFlows.length === 1
        ? ` · flow:${runningFlows[0]!.roleChain.join("→")}`
        : runningFlows.length > 1
          ? ` · flows:${runningFlows.length} running`
          : "";
      const waitPart = waitingFlows.length > 0 ? ` · waiting_input:${waitingFlows.length}` : "";
      const jobPart = runningJobs.length > 0 ? ` · jobs:${runningJobs.length}` : "";
      try { ctx?.ui?.setStatus?.("omp-enhance", `${rolePart}${flowPart}${waitPart}${jobPart}`); } catch {}
    },

    disposeAll(): void {
      clearWakeupTimer();
      pendingWakeups.clear();
      foregroundTurnActive = false;
      for (const ws of workspaces.values()) {
        try { ws.room.dispose(); } catch {}
        try { ws.store.close(); } catch {}
        ws.trackers.clear();
        ws.baselines.clear();
      }
      workspaces.clear();
      hydratedRoots.clear();
    },
  };

  return hub;
}
