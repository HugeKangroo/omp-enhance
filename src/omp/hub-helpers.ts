import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { canRoleDispatch, isInternalRole } from "../core/policy.ts";
import type { FlowMachineState, FlowRoomStatus, PersistedFlowCheckpoint } from "../core/types.ts";
import { appendBoardEntrySafe } from "../flow/board.ts";
import { buildFlowGraphSnapshot, transitionFlow } from "../flow/machine.ts";
import { isCheckpointResumable, snapshotFromCheckpoint, type FlowRoomSnapshot } from "../flow/state.ts";
import type { TrustedPeerRoleGroup } from "../roles/conditioning.ts";
import { discoverRolesWithDiagnostics } from "../roles/loader.ts";
import { readTrustStore, sameProjectPath, type TrustEvaluation } from "./trust.ts";
import type { BackgroundFlowSettlement, EmitMessageOptions, ManagedWorkspace } from "./workspace.ts";

const MAX_TRACKED_SUBPROJECTS = 24;
const NON_TERMINAL_FLOW_STATUSES = new Set(["running", "waiting_input", "interrupted", "failed"]);

export interface HubFlowSummary {
  cwd: string; flowId: string | null; status: FlowRoomStatus; resumable: boolean;
  roleChain: string[]; currentIndex: number; repairRound: number; goal: string;
  reason?: string; questionsForUser?: string[]; waitingNodes?: Array<{ nodeId: string; questions: string[] }>;
  mergedRef?: string | null; mergedCommitSha?: string | null; graphProgress?: { done: number; total: number };
  remoteOwnerPid?: number | null; updatedAt?: string;
}

export interface ResumableFlowCandidate {
  ws: ManagedWorkspace; cwd: string; flowId: string; status: string; goal: string;
  waitingNodes?: Array<{ nodeId: string; questions: string[] }>;
}

export interface NonTerminalFlowCandidate {
  ws: ManagedWorkspace; cwd: string; flowId: string; status: string; goal: string; roleChain: string[];
}

export function emitWorkspaceMessage(pi: any, ctx: any, text: string, options?: EmitMessageOptions): void {
  const outPath = process.env.OMP_ENHANCE_CMD_OUT;
  if (outPath) {
    const outPayload = options?.cmdOutText ?? text;
    try {
      mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      appendFileSync(outPath, outPayload.endsWith("\n") ? outPayload : `${outPayload}\n`, "utf8");
    } catch {}
  }
  try {
    const excludeFromContext = options?.excludeFromContext ?? true;
    const opts = { triggerTurn: false, ...(ctx?.isIdle?.() === false ? { deliverAs: "followUp" } : {}) };
    if (typeof pi?.sendMessage === "function") {
      pi.sendMessage({ customType: "omp-enhance", content: text, display: true, ...(excludeFromContext ? { excludeFromContext: true } : {}) }, opts);
    } else {
      ctx?.ui?.notify?.(text, "info");
    }
  } catch {}
}

export function resolveHubProjectsFilePath(options: { globalRolesDir?: string } = {}): string {
  const envHome = process.env.OMP_ENHANCE_HOME?.trim();
  if (envHome) return path.join(path.resolve(envHome), ".omp", "enhance", "hub-projects.json");
  if (options.globalRolesDir) {
    const defaultRoles = path.join(homedir(), ".omp", "enhance", "roles");
    const resolvedRoles = path.resolve(options.globalRolesDir);
    if (resolvedRoles !== path.resolve(defaultRoles)) return path.join(path.dirname(resolvedRoles), "hub-projects.json");
  }
  return path.join(homedir(), ".omp", "enhance", "hub-projects.json");
}

export function readHubProjectsMap(filePath: string): Record<string, string[]> {
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

export function persistSecondaryProject(filePath: string, primaryCwd: string, targetCwd: string): void {
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

export function collectWaitingNodes(snap: FlowRoomSnapshot): Array<{ nodeId: string; questions: string[] }> {
  const fromGraph = (snap.graphSnapshot?.nodes ?? [])
    .filter((n) => n.status === "waiting_input")
    .map((n) => ({ nodeId: n.nodeId, questions: n.questionsForUser?.length ? [...n.questionsForUser] : [n.summary ?? "需要用户确认"] }));
  if (fromGraph.length > 0) return fromGraph;
  const env = [...snap.stages].reverse().find((s) => s.envelope?.questionsForUser?.length)?.envelope;
  return env?.questionsForUser?.length ? [{ nodeId: env.fromRole, questions: [...env.questionsForUser] }] : [];
}

export function toFlowSummary(cwd: string, snap: FlowRoomSnapshot, resumable: boolean): HubFlowSummary {
  const waitingNodes = snap.status === "waiting_input" ? collectWaitingNodes(snap) : [];
  const allQuestions = waitingNodes.flatMap((w) => w.questions.map((q) => (waitingNodes.length > 1 ? `[${w.nodeId}] ${q}` : q)));
  const gNodes = snap.graphSnapshot?.nodes;
  const graphProgress = gNodes?.length ? { done: gNodes.filter((n) => n.status === "succeeded" || n.status === "skipped").length, total: gNodes.length } : undefined;
  return {
    cwd, flowId: snap.flowId, status: snap.status, resumable, roleChain: snap.roleChain,
    currentIndex: snap.currentIndex ?? 0, repairRound: snap.repairRound ?? 0, goal: snap.goal,
    ...(snap.reason ? { reason: snap.reason } : {}), ...(allQuestions.length > 0 ? { questionsForUser: allQuestions } : {}),
    ...(waitingNodes.length > 0 ? { waitingNodes } : {}), ...(snap.graphSnapshot?.mergedRef ? { mergedRef: snap.graphSnapshot.mergedRef } : {}),
    ...(snap.graphSnapshot?.mergedCommitSha ? { mergedCommitSha: snap.graphSnapshot.mergedCommitSha } : {}),
    ...(graphProgress ? { graphProgress } : {}), ...(snap.remoteOwnerPid ? { remoteOwnerPid: snap.remoteOwnerPid } : {}),
    ...(snap.updatedAt ? { updatedAt: snap.updatedAt } : {}),
  };
}

export function formatFlowEventReport(settlement: BackgroundFlowSettlement): string {
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
  const mergedSha = result?.mergedCommitSha ?? snap.graphSnapshot?.mergedCommitSha;
  if (mergedRef) lines.push(`Delivery ref: ${mergedRef}${mergedSha ? ` (${mergedSha})` : ""}`);
  if (isRejectedAudit && env?.feedbackForUpstream) lines.push(`Findings: ${env.feedbackForUpstream}`);
  else if (result?.reason && result.reason !== summary) lines.push(`Detail: ${result.reason}`);
  if (env?.artifacts.length) lines.push(`Artifacts: ${env.artifacts.map((a) => `${a.path} [${a.role}]`).join(", ")}`);
  if (env?.deletedFiles?.length) lines.push(`Deleted files: ${env.deletedFiles.join(", ")}`);
  if (env?.verifiedFacts.length) lines.push("Verified facts:", ...env.verifiedFacts.map((f) => `- ${f.claim} (evidence: ${f.evidenceRef})`));
  if (env?.verificationScope) {
    const s = env.verificationScope;
    const parts = [`checked=[${s.checked.join(", ")}]`];
    if (s.unchecked?.length) parts.push(`unchecked=[${s.unchecked.join(", ")}]`);
    if (s.environmentGaps?.length) parts.push(`environmentGaps=[${s.environmentGaps.join(", ")}]`);
    lines.push(`Verification scope: ${parts.join("; ")}`);
  }
  if (env?.reworkCategory) lines.push(`Rework category: ${env.reworkCategory}`);
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

export function collectResumableFlowCandidates(workspaces: readonly ManagedWorkspace[]): ResumableFlowCandidate[] {
  const out: ResumableFlowCandidate[] = [], seen = new Set<string>();
  const pushSnap = (ws: ManagedWorkspace, flowId: string, status: string, goal: string, snap: FlowRoomSnapshot): void => {
    const key = `${ws.cwd}::${flowId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const waitingNodes = collectWaitingNodes(snap);
    out.push({ ws, cwd: ws.cwd, flowId, status, goal, ...(waitingNodes.length > 0 ? { waitingNodes } : {}) });
  };
  for (const ws of workspaces) {
    const persistedIds = new Set<string>();
    const initialSnap = ws.room.getSnapshot();
    if (!ws.store.isClosed()) {
      for (const raw of ws.store.listFlowCheckpoints(50)) {
        persistedIds.add(raw.flowId);
        const cp = raw.status === "running" && (!ws.room.hasActiveLeaseOwnership() || initialSnap.flowId !== raw.flowId)
          ? (ws.store.reclaimDeadCheckpoint(raw.flowId) ?? raw) : raw;
        if (initialSnap.flowId === cp.flowId && cp.status !== "running" && initialSnap.status !== cp.status) {
          ws.room.syncFromCheckpoint(cp);
        }
        if (isCheckpointResumable(cp)) pushSnap(ws, cp.flowId, cp.status, cp.goal, snapshotFromCheckpoint(cp, ws.cwd));
      }
    }
    const snap = ws.room.getSnapshot();
    if (snap.flowId && !ws.store.isClosed()) {
      if (persistedIds.has(snap.flowId)) continue;
      const persisted = ws.store.getFlowCheckpoint(snap.flowId);
      if (persisted) {
        if (persisted.status !== "running" && snap.status !== persisted.status) ws.room.syncFromCheckpoint(persisted);
        if (isCheckpointResumable(persisted)) pushSnap(ws, persisted.flowId, persisted.status, persisted.goal, snapshotFromCheckpoint(persisted, ws.cwd));
        continue;
      }
    }
    if (ws.room.isResumable() && snap.flowId) pushSnap(ws, snap.flowId, snap.status, snap.goal, snap);
  }
  return out;
}

export function collectNonTerminalFlowCandidates(workspaces: readonly ManagedWorkspace[]): NonTerminalFlowCandidate[] {
  const out: NonTerminalFlowCandidate[] = [], seen = new Set<string>();
  const add = (ws: ManagedWorkspace, flowId: string, status: string, goal: string, roleChain: readonly string[]): void => {
    const key = `${ws.cwd}::${flowId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ws, cwd: ws.cwd, flowId, status, goal, roleChain: [...roleChain] });
  };
  for (const ws of workspaces) {
    const persistedIds = new Set<string>();
    const snap = ws.room.getSnapshot();
    if (!ws.store.isClosed()) {
      for (const c of ws.store.listFlowCheckpoints(50)) {
        persistedIds.add(c.flowId);
        if (snap.flowId === c.flowId && c.status !== "running" && snap.status !== c.status) ws.room.syncFromCheckpoint(c);
        if (NON_TERMINAL_FLOW_STATUSES.has(c.status)) add(ws, c.flowId, c.status, c.goal, c.roleChain);
      }
    }
    const freshSnap = ws.room.getSnapshot();
    if (ws.room.hasActiveLeaseOwnership() && freshSnap.flowId) {
      if (!ws.store.isClosed() && persistedIds.has(freshSnap.flowId)) continue;
      add(ws, freshSnap.flowId, freshSnap.status, freshSnap.goal, freshSnap.roleChain);
    }
  }
  return out;
}

export function collectTrustedPeerProjectRoles(input: {
  workspaces: ReadonlyMap<string, ManagedWorkspace>;
  originWs: ManagedWorkspace;
  trustStorePath: string;
  evaluateTrust: (targetCwd: string, ctx?: any) => TrustEvaluation;
  globalRolesDir: string;
  builtinRolesDir?: string;
  ctx?: any;
}): TrustedPeerRoleGroup[] {
  const candidatePaths: string[] = [];
  const addCandidate = (rawPath: string): void => {
    const resolved = path.resolve(rawPath);
    if (sameProjectPath(resolved, input.originWs.cwd)) return;
    if (!candidatePaths.some((p) => sameProjectPath(p, resolved))) candidatePaths.push(resolved);
  };
  for (const ws of input.workspaces.values()) addCandidate(ws.cwd);
  for (const trustedPath of readTrustStore(input.trustStorePath).trustedProjects) addCandidate(trustedPath);

  const groups: TrustedPeerRoleGroup[] = [];
  for (const peerCwd of candidatePaths.sort()) {
    let isDir = false;
    try { isDir = existsSync(peerCwd) && statSync(peerCwd).isDirectory(); } catch { isDir = false; }
    if (!isDir || !input.evaluateTrust(peerCwd, input.ctx).trusted) continue;
    const loaded = [...input.workspaces.values()].find((w) => sameProjectPath(w.cwd, peerCwd));
    const roleMap = loaded
      ? loaded.refresh(input.ctx)
      : discoverRolesWithDiagnostics({
          cwd: peerCwd, globalRolesDir: input.globalRolesDir, builtinRolesDir: input.builtinRolesDir, isProjectTrusted: true,
        }).roles;
    const projectSpecialists = [...roleMap.values()]
      .filter((r) => r.source === "project" && !isInternalRole(r) && !canRoleDispatch(r))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({ id: r.id, name: r.name, description: r.description }));
    if (projectSpecialists.length > 0) groups.push({ cwd: peerCwd, roles: projectSpecialists });
  }
  return groups;
}

export function persistHeldHumanDecision(input: {
  targetWs: ManagedWorkspace; cp: PersistedFlowCheckpoint | null; persistedMachine: FlowMachineState;
  flowId: string; nodeId: string; replyText: string; ctx?: any;
}): { state: FlowMachineState; reason?: string } {
  const now = new Date().toISOString();
  const out = transitionFlow(input.persistedMachine, { type: "FLOW_RESUME", targetNodeId: input.nodeId, replyText: input.replyText }, now);
  for (const cmd of out.commands) {
    if (cmd.type === "APPEND_BOARD") {
      const saved = appendBoardEntrySafe(input.targetWs.store, input.flowId, cmd.entry);
      if (saved?.seq) out.state.boardSeq = Math.max(out.state.boardSeq, saved.seq);
    }
  }
  if (!input.targetWs.store.isClosed() && input.cp) {
    const prevSnap = snapshotFromCheckpoint(input.cp, input.targetWs.cwd);
    const updatedSnap = {
      ...prevSnap, status: "waiting_input" as const,
      ...(out.state.reason ? { reason: out.state.reason } : {}),
      graphSnapshot: buildFlowGraphSnapshot(out.state),
    };
    const savedCp = input.targetWs.store.saveFlowCheckpoint({
      ...input.cp, status: "waiting_input", ownerPid: null, ownerStartToken: null, leaseToken: null,
      snapshotJson: JSON.stringify(updatedSnap), machineStateJson: JSON.stringify(out.state), updatedAt: now,
    });
    if (savedCp && input.targetWs.room.getSnapshot().flowId === input.flowId) {
      input.targetWs.room.syncFromCheckpoint(savedCp, input.ctx);
    }
  }
  return { state: out.state, ...(out.state.reason ? { reason: out.state.reason } : {}) };
}
