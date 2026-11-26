import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { snapshotWorkspace } from "../core/fs.ts";
import type {
  FlowCommand, FlowEvent, FlowGraphSpec, FlowMachineState, FlowNodeSpec,
  GateNodeConfig, GraphValidationResult, NativeTaskNodeConfig,
} from "../core/graph-types.ts";
import { isRoleReadOnly } from "../core/policy.ts";
import { narrowRolePermissions } from "../core/scope.ts";
import type { EnhanceStore } from "../core/store.ts";
import type {
  FlowRunResult, FlowStepResult, FlowUserSteer, HandoffEnvelope, Mandate, RoleSpec, VerificationEvidenceRecord,
} from "../core/types.ts";
import { appendBoardEntrySafe, formatNodeBrief, renderBoardContextForNode } from "./board.ts";
import { createInitialFlowState, isFlowTerminal, transitionFlow } from "./machine.ts";
import {
  executeRoleStep, type RoleSessionPoolLike, type RoleSessionRunner, type RoleSupervisorConfig,
} from "./orchestrator.ts";
import type { FlowObserver } from "./state.ts";

export interface WorktreeManagerLike {
  isGitRepo(cwd: string): boolean;
  prepareNodeWorktree(input: { cwd: string; flowId: string; nodeId: string }): Promise<{ worktreePath: string; baseRef: string }>;
  commitNodeWorktree(input: { worktreePath: string; flowId: string; nodeId: string; summary: string }): Promise<string | null>;
  mergeWorktrees(input: {
    cwd: string; flowId: string; nodeId: string; sourceRefs: Record<string, string>;
    landingMode: "apply" | "branch_preview";
  }): Promise<{ ok: boolean; mergedRef?: string | null; summary: string; conflicts?: string[] }>;
  cleanupFlowWorktrees(cwd: string, flowId: string): Promise<void>;
}

export interface NativeTaskRunnerLike {
  runNativeTasks(input: {
    cwd: string; agent: string; tasks: ReadonlyArray<{ id: string; prompt: string }>; signal?: AbortSignal;
  }): Promise<{ summary: string; verifiedFacts?: Array<{ claim: string; evidenceRef: string }> }>;
}

export interface ExecuteFlowGraphInput {
  cwd: string;
  store: EnhanceStore;
  flowId: string;
  mandate: Mandate;
  spec: FlowGraphSpec;
  validation: GraphValidationResult;
  roles: ReadonlyMap<string, RoleSpec>;
  runner: RoleSessionRunner;
  initialState?: FlowMachineState | null;
  resumeReplyText?: string;
  resumeTargetNodeId?: string;
  initialHandoff?: HandoffEnvelope | null;
  userSteers?: readonly FlowUserSteer[];
  observer?: FlowObserver;
  supervisor?: RoleSupervisorConfig;
  signal?: AbortSignal;
  sessionPool?: RoleSessionPoolLike;
  worktreeManager?: WorktreeManagerLike;
  nativeTaskRunner?: NativeTaskRunnerLike;
  onStateChange?: (state: FlowMachineState) => void;
  registerLivePatchHandler?: (handler: ((patch: import("../core/graph-types.ts").FlowGraphPatch, validated: GraphValidationResult) => boolean) | null) => void;
}

const nowIso = (): string => new Date().toISOString();

function treeFingerprint(cwd: string): string {
  const snap = snapshotWorkspace(cwd);
  const h = createHash("sha256");
  for (const [rel, entry] of [...snap.entries()].sort(([a], [b]) => a.localeCompare(b))) h.update(`${rel}\0${entry.sha256}\n`);
  return h.digest("hex").slice(0, 16);
}

async function runDeterministicGate(input: {
  cwd: string; flowId: string; mandate: Mandate; store: EnhanceStore; nodeId: string; stageId: string;
  config: GateNodeConfig; signal?: AbortSignal;
}): Promise<{ passed: boolean; evidence: VerificationEvidenceRecord; handoff: HandoffEnvelope; feedback?: string }> {
  const effCwd = input.config.cwd ? path.resolve(input.cwd, input.config.cwd) : input.cwd;
  const timeoutMs = Math.max(1_000, (input.config.timeoutSec ?? 180) * 1000);
  const expectExit = input.config.expectExitCode ?? 0;

  const proc = Bun.spawn(["bash", "-lc", input.config.command], {
    cwd: effCwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OMP_ENHANCE_SUBPROCESS: "1" },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill("SIGTERM"); } catch {} }, timeoutMs);
  const onAbort = () => { try { proc.kill("SIGTERM"); } catch {} };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  });

  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
  const snippet = combined.length > 600 ? `…${combined.slice(-599)}` : (combined || "(no output)");
  const fp = treeFingerprint(effCwd);
  let metricsNote = "";
  let metricsOk = true;
  if (input.config.parseJsonMetricsPath) {
    const mp = path.resolve(effCwd, input.config.parseJsonMetricsPath);
    if (!existsSync(mp)) { metricsOk = false; metricsNote = `Missing metrics file ${input.config.parseJsonMetricsPath}`; }
    else {
      try { JSON.parse(readFileSync(mp, "utf8")); metricsNote = `Parsed metrics ${input.config.parseJsonMetricsPath}`; }
      catch { metricsOk = false; metricsNote = `Invalid JSON in ${input.config.parseJsonMetricsPath}`; }
    }
  }
  const passed = !timedOut && exitCode === expectExit && metricsOk;
  const evidence: VerificationEvidenceRecord = {
    command: input.config.command,
    exitCode: timedOut ? -1 : exitCode,
    outputSnippet: metricsNote ? `${metricsNote} | ${snippet}` : snippet,
    testedTreeFingerprint: fp,
    toolCallId: `gate-${input.stageId}`,
  };
  const feedback = passed ? undefined : (timedOut ? `Gate "${input.config.command}" timed out after ${Math.round(timeoutMs / 1000)}s.` : `Gate "${input.config.command}" failed (exit ${exitCode}): ${evidence.outputSnippet}`);
  const handoff: HandoffEnvelope = {
    id: `ho-gate-${randomUUID()}`,
    mandateId: input.mandate.id,
    mandateRev: input.mandate.rev,
    parentHandoffId: null,
    fromRole: input.nodeId,
    toTarget: passed ? "user" : (input.config.repairTargetNodeId ?? "user"),
    verdict: passed ? "ready" : "rejected",
    summary: passed ? `Gate passed: ${input.config.command} (exit ${exitCode}, tree ${fp})` : feedback!,
    artifacts: [],
    verifiedFacts: [{ claim: `Executed gate "${input.config.command}" with exit=${exitCode}`, evidenceRef: `gate-${input.stageId}` }],
    verificationEvidence: [evidence],
    openRisks: [],
    feedbackForUpstream: passed ? null : feedback!,
    observedUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    createdAt: nowIso(),
  };
  if (!input.store.isClosed()) input.store.saveHandoff(handoff);
  return { passed, evidence, handoff, ...(feedback ? { feedback } : {}) };
}

function resolveUpstreamHandoff(state: FlowMachineState, node: FlowNodeSpec, initialHandoff: HandoffEnvelope | null): HandoffEnvelope | null {
  for (let i = node.dependsOn.length - 1; i >= 0; i--) {
    const dep = state.nodes[node.dependsOn[i]!];
    if (dep?.lastHandoff) return dep.lastHandoff;
  }
  return initialHandoff;
}

export async function executeFlowGraph(
  input: ExecuteFlowGraphInput,
): Promise<FlowRunResult & { finalState: FlowMachineState }> {
  const isRo = (roleId: string): boolean => isRoleReadOnly(input.roles.get(roleId));
  let state: FlowMachineState = input.initialState
    ? { ...input.initialState }
    : createInitialFlowState({
        flowId: input.flowId, mandateId: input.mandate.id, cwd: input.cwd,
        spec: input.spec, validation: input.validation, initialHandoffId: input.initialHandoff?.id ?? null, nowIso: nowIso(),
      });

  const queue: FlowEvent[] = [];
  const inFlight = new Map<string, Promise<void>>();
  const nodeAborts = new Map<string, AbortController>();
  const steps: FlowStepResult[] = [];
  let wakeResolve: (() => void) | null = null;

  const pushEvent = (ev: FlowEvent): void => {
    queue.push(ev);
    if (wakeResolve) { const r = wakeResolve; wakeResolve = null; r(); }
  };

  const onExternalAbort = () => pushEvent({ type: "FLOW_CANCEL", reason: "Cancelled by user." });
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const launchAsync = (nodeId: string, fn: (nodeSignal: AbortSignal) => Promise<void>): void => {
    const ac = new AbortController();
    nodeAborts.set(nodeId, ac);
    const effSignal = input.signal ? AbortSignal.any([input.signal, ac.signal]) : ac.signal;
    const p: Promise<void> = fn(effSignal).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      pushEvent({ type: "NODE_HOST_ERROR", nodeId, error: msg, retryable: false });
    }).finally(() => {
      if (inFlight.get(nodeId) === p) inFlight.delete(nodeId);
      if (nodeAborts.get(nodeId) === ac) nodeAborts.delete(nodeId);
      if (wakeResolve) { const r = wakeResolve; wakeResolve = null; r(); }
    });
    inFlight.set(nodeId, p);
  };

  const executeRoleDispatch = async (
    cmd: Extract<FlowCommand, { type: "DISPATCH_ROLE_NODE" }>,
    nodeSignal: AbortSignal,
  ): Promise<void> => {
    const spec = state.spec.nodes.find((n) => n.id === cmd.nodeId)!;
    const baseRole = input.roles.get(spec.role!)!;
    const narrowed = narrowRolePermissions(baseRole, spec.writableScope);
    if (!narrowed.ok) {
      pushEvent({ type: "NODE_VIOLATION", nodeId: cmd.nodeId, violations: spec.writableScope ?? [], reason: narrowed.reason });
      return;
    }
    const effRole = narrowed.role;
    const effCwd = cmd.worktreePath ?? input.cwd;
    const upstreamHandoff = resolveUpstreamHandoff(state, spec, input.initialHandoff ?? null);
    const boardContext = renderBoardContextForNode({ store: input.store, flowId: input.flowId, nodeSpec: spec });
    const nodeBrief = spec.brief ? formatNodeBrief(spec.brief, input.mandate.goal) : undefined;
    const toTarget = state.spec.nodes.find((n) => n.dependsOn.includes(spec.id))?.id ?? "user";
    const keepWarm = Boolean(state.spec.policies.enableSessionReuse && spec.sessionMode !== "fresh");

    const res = await executeRoleStep({
      cwd: effCwd, store: input.store, role: effRole, mandate: input.mandate,
      upstreamHandoff, userSteers: input.userSteers, toTarget,
      repairTargetRoleId: spec.repairTargetNodeId ?? "user",
      flowId: input.flowId, nodeId: cmd.nodeId, runner: input.runner,
      stageId: cmd.stageId, round: cmd.repairRound,
      observer: input.observer, supervisor: input.supervisor, signal: nodeSignal,
      reuseSession: cmd.reuseSession, keepSessionWarm: keepWarm,
      ...(cmd.forkFromNodeId ? { forkFromNodeId: cmd.forkFromNodeId } : {}),
      ...(cmd.modelOverride ? { modelOverride: cmd.modelOverride } : {}),
      ...(cmd.repairFeedback ? { repairFeedback: cmd.repairFeedback } : {}),
      ...(cmd.replyText ? { replyText: cmd.replyText } : {}),
      ...(nodeBrief ? { nodeBrief } : {}),
      ...(boardContext ? { boardContext } : {}),
      ...(spec.stallTimeoutSec ? { stallTimeoutMs: spec.stallTimeoutSec * 1000 } : {}),
      ...(input.sessionPool ? { sessionPool: input.sessionPool } : {}),
    });
    if (!res.ok) {
      if (res.status === "cancelled") { pushEvent({ type: "FLOW_CANCEL", reason: res.reason }); return; }
      if (res.status === "violation") { pushEvent({ type: "NODE_VIOLATION", nodeId: cmd.nodeId, violations: res.violations, reason: res.reason }); return; }
      if (res.status === "aborted_by_supervisor") { pushEvent({ type: "NODE_ABORTED_BY_SUPERVISOR", nodeId: cmd.nodeId, reason: res.reason }); return; }
      if (res.status === "stalled") { pushEvent({ type: "NODE_STALLED", nodeId: cmd.nodeId, idleSec: res.idleSec, currentModel: res.modelLabel }); return; }
      pushEvent({
        type: "NODE_HOST_ERROR", nodeId: cmd.nodeId, error: res.reason,
        retryable: res.status === "host_error" ? Boolean(res.retryable) : false,
        ...(res.status === "host_error" && res.modelLabel ? { currentModel: res.modelLabel } : {}),
      });
      return;
    }
    const env = res.envelope;
    steps.push({ stepIndex: state.nodeOrder.indexOf(cmd.nodeId), roleId: effRole.id, round: cmd.repairRound, envelope: env });
    if (env.verdict === "needs_input") {
      pushEvent({ type: "NODE_NEEDS_INPUT", nodeId: cmd.nodeId, handoff: env, questions: env.questionsForUser ?? [env.summary], sessionWarm: res.sessionWarm });
      return;
    }
    if (env.verdict === "blocked") { pushEvent({ type: "NODE_BLOCKED", nodeId: cmd.nodeId, handoff: env, reason: env.summary }); return; }
    if (env.verdict === "rejected") {
      pushEvent({
        type: "NODE_REJECTED", nodeId: cmd.nodeId, handoff: env,
        ...(env.toTarget && state.nodes[env.toTarget] ? { targetNodeId: env.toTarget } : {}),
        feedback: env.feedbackForUpstream ?? env.summary,
      });
      return;
    }
    let commitRef: string | null = null;
    if (cmd.worktreePath && input.worktreeManager) {
      commitRef = await input.worktreeManager.commitNodeWorktree({
        worktreePath: cmd.worktreePath, flowId: input.flowId, nodeId: cmd.nodeId, summary: env.summary,
      });
    }
    pushEvent({ type: "NODE_SUCCEEDED", nodeId: cmd.nodeId, handoff: env, sessionWarm: res.sessionWarm, commitRef });
  };

  const runRoleDispatch = (cmd: Extract<FlowCommand, { type: "DISPATCH_ROLE_NODE" }>): void => {
    launchAsync(cmd.nodeId, (nodeSignal) => executeRoleDispatch(cmd, nodeSignal));
  };

  const executeCommands = async (commands: readonly FlowCommand[]): Promise<void> => {
    for (const cmd of commands) {
      switch (cmd.type) {
        case "APPEND_BOARD": {
          const saved = appendBoardEntrySafe(input.store, input.flowId, cmd.entry);
          if (saved?.seq) state.boardSeq = Math.max(state.boardSeq, saved.seq);
          break;
        }
        case "PERSIST_STATE":
          input.onStateChange?.(state);
          break;
        case "PREPARE_WORKTREE":
          launchAsync(cmd.nodeId, async () => {
            if (!input.worktreeManager) throw new Error(`Worktree manager unavailable for node "${cmd.nodeId}".`);
            const wt = await input.worktreeManager.prepareNodeWorktree({ cwd: input.cwd, flowId: input.flowId, nodeId: cmd.nodeId });
            pushEvent({ type: "NODE_WORKTREE_READY", nodeId: cmd.nodeId, worktreePath: wt.worktreePath });
          });
          break;
        case "DISPATCH_ROLE_NODE":
          runRoleDispatch(cmd);
          break;
        case "SWITCH_MODEL_AND_RESUME":
          launchAsync(cmd.nodeId, async (nodeSignal) => {
            let switched = false;
            if (input.sessionPool?.switchModelInPlace) {
              const sw = await input.sessionPool.switchModelInPlace(input.flowId, cmd.nodeId, cmd.nextModel);
              switched = sw.switched;
            }
            const rt = state.nodes[cmd.nodeId]!;
            await executeRoleDispatch({
              type: "DISPATCH_ROLE_NODE", nodeId: cmd.nodeId, stageId: cmd.stageId, attempt: cmd.attempt,
              repairRound: rt.repairRound, reuseSession: switched,
              ...(rt.worktreePath ? { worktreePath: rt.worktreePath } : {}),
              modelOverride: cmd.nextModel,
              repairFeedback: `Previous attempt interrupted (${cmd.reason}); switched model to ${cmd.nextModel}. Continue and call enhance_handoff when done.`,
            }, nodeSignal);
          });
          break;
        case "RUN_GATE_NODE":
          launchAsync(cmd.nodeId, async (nodeSignal) => {
            const g = await runDeterministicGate({
              cwd: cmd.worktreePath ?? input.cwd, flowId: input.flowId, mandate: input.mandate, store: input.store,
              nodeId: cmd.nodeId, stageId: cmd.stageId, config: cmd.config, signal: nodeSignal,
            });
            steps.push({ stepIndex: state.nodeOrder.indexOf(cmd.nodeId), roleId: cmd.nodeId, round: state.nodes[cmd.nodeId]!.repairRound, envelope: g.handoff });
            pushEvent({ type: "GATE_COMPLETED", nodeId: cmd.nodeId, passed: g.passed, evidence: g.evidence, handoff: g.handoff, ...(g.feedback ? { feedback: g.feedback } : {}) });
          });
          break;
        case "RUN_MERGE_NODE":
          launchAsync(cmd.nodeId, async () => {
            if (!input.worktreeManager) throw new Error(`Worktree manager unavailable for merge node "${cmd.nodeId}".`);
            const m = await input.worktreeManager.mergeWorktrees({
              cwd: input.cwd, flowId: input.flowId, nodeId: cmd.nodeId,
              sourceRefs: cmd.sourceRefs, landingMode: cmd.config.landingMode ?? "apply",
            });
            const handoff: HandoffEnvelope = {
              id: `ho-merge-${randomUUID()}`, mandateId: input.mandate.id, mandateRev: input.mandate.rev,
              parentHandoffId: null, fromRole: cmd.nodeId, toTarget: "user", verdict: m.ok ? "ready" : "needs_input",
              summary: m.summary, artifacts: [], verifiedFacts: [], openRisks: m.conflicts ?? [],
              ...(m.conflicts?.length ? { questionsForUser: [`Resolve merge conflicts in: ${m.conflicts.join(", ")}`] } : {}),
              feedbackForUpstream: null, observedUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, createdAt: nowIso(),
            };
            if (!input.store.isClosed()) input.store.saveHandoff(handoff);
            pushEvent({ type: "MERGE_COMPLETED", nodeId: cmd.nodeId, ok: m.ok, mergedRef: m.mergedRef, summary: m.summary, conflicts: m.conflicts, handoff });
          });
          break;
        case "RUN_NATIVE_TASK_NODE":
          launchAsync(cmd.nodeId, async (nodeSignal) => {
            if (!input.nativeTaskRunner) throw new Error(`Native task runner unavailable for node "${cmd.nodeId}".`);
            const nt = await input.nativeTaskRunner.runNativeTasks({ cwd: input.cwd, agent: cmd.config.agent, tasks: cmd.config.tasks, signal: nodeSignal });
            const handoff: HandoffEnvelope = {
              id: `ho-task-${randomUUID()}`, mandateId: input.mandate.id, mandateRev: input.mandate.rev,
              parentHandoffId: null, fromRole: cmd.nodeId, toTarget: "user", verdict: "ready",
              summary: nt.summary, artifacts: [], verifiedFacts: nt.verifiedFacts ?? [], openRisks: [],
              feedbackForUpstream: null, observedUsage: null, createdAt: nowIso(),
            };
            if (!input.store.isClosed()) input.store.saveHandoff(handoff);
            pushEvent({ type: "NODE_SUCCEEDED", nodeId: cmd.nodeId, handoff, sessionWarm: false });
          });
          break;
        case "ABORT_NODE":
          nodeAborts.get(cmd.nodeId)?.abort();
          break;
        case "DISPOSE_SESSION":
          await input.sessionPool?.disposeNode(input.flowId, cmd.nodeId);
          break;
        case "CLEANUP_WORKTREES":
          await input.worktreeManager?.cleanupFlowWorktrees(input.cwd, cmd.flowId);
          break;
        case "RUN_HUMAN_NODE":
        case "DELIVER_STEER":
        case "WAKE_COORDINATOR":
          break;
      }
    }
  };

  try {
    input.registerLivePatchHandler?.((patch, validated) => {
      if (isFlowTerminal(state.status)) return false;
      pushEvent({ type: "GRAPH_PATCH", patch, validated });
      return true;
    });
    pushEvent(
      state.status === "draft"
        ? { type: "FLOW_START" }
        : { type: "FLOW_RESUME", ...(input.resumeReplyText ? { replyText: input.resumeReplyText } : {}), ...(input.resumeTargetNodeId ? { targetNodeId: input.resumeTargetNodeId } : {}) },
    );

    while (true) {
      while (queue.length > 0) {
        const ev = queue.shift()!;
        const out = transitionFlow(state, ev, nowIso(), { isRoleReadOnly: isRo });
        state = out.state;
        await executeCommands(out.commands);
      }
      if (isFlowTerminal(state.status) || state.status === "waiting_input") break;
      if (inFlight.size === 0) break;
      await new Promise<void>((resolve) => { wakeResolve = resolve; });
    }
  } finally {
    input.registerLivePatchHandler?.(null);
    input.signal?.removeEventListener("abort", onExternalAbort);
    for (const ac of nodeAborts.values()) ac.abort();
    if (inFlight.size > 0) await Promise.allSettled([...inFlight.values()]);
    if (isFlowTerminal(state.status)) await input.sessionPool?.disposeFlow(input.flowId);
  }

  if (state.status === "completed") input.store.completeMandate(input.mandate.id);
  const finalEnvelope = (state.lastHandoffId ? input.store.getHandoff(state.lastHandoffId) : null)
    ?? [...state.nodeOrder].reverse().map((id) => state.nodes[id]?.lastHandoff).find(Boolean)
    ?? input.initialHandoff
    ?? null;
  const resultStatus: FlowRunResult["status"] =
    state.status === "completed" || state.status === "waiting_input" || state.status === "rejected_max_rounds" ||
    state.status === "stagnated" || state.status === "blocked" || state.status === "violation" ||
    state.status === "aborted_by_supervisor" || state.status === "cancelled"
      ? state.status
      : "failed";
  return { status: resultStatus, cwd: input.cwd, steps, finalEnvelope, ...(state.reason ? { reason: state.reason } : {}), finalState: state };
}
