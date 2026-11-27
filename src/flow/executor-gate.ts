import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { snapshotWorkspace } from "../core/fs.ts";
import type {
  FlowCommand,
  FlowGraphPatch,
  FlowGraphSpec,
  FlowMachineState,
  FlowNodeSpec,
  GateNodeConfig,
  GraphValidationIssue,
} from "../core/graph-types.ts";
import type { EnhanceStore } from "../core/store.ts";
import type { HandoffEnvelope, Mandate, RoleSpec, VerificationEvidenceRecord } from "../core/types.ts";
import { validateGraphPatch } from "./graph.ts";
import { isFlowTerminal, transitionFlow } from "./machine.ts";

export interface WorktreeManagerLike {
  isGitRepo(cwd: string): boolean;
  prepareNodeWorktree(input: { cwd: string; flowId: string; nodeId: string; baseCommitSha?: string }): Promise<{ worktreePath: string; baseRef: string }>;
  commitNodeWorktree(input: { worktreePath: string; flowId: string; nodeId: string; summary: string }): Promise<string | null>;
  commitAndUpdatePreviewRef?(input: {
    cwd: string; worktreePath: string; flowId: string; nodeId: string; targetRef: string; expectedParentSha?: string; summary: string;
  }): Promise<{ commitRef: string; commitSha: string } | null>;
  mergeWorktrees(input: {
    cwd: string; flowId: string; nodeId: string; sourceRefs: Record<string, string>; landingMode: "apply" | "branch_preview"; baseCommitSha?: string;
  }): Promise<{ ok: boolean; mergedRef?: string | null; mergedCommitSha?: string | null; summary: string; conflicts?: string[] }>;
  withCommitWorktree?<T>(
    input: { cwd: string; flowId: string; nodeId: string; commitRef: string },
    fn: (ctx: { worktreePath: string; commitSha: string }) => Promise<T>,
  ): Promise<T>;
  cleanupFlowWorktrees(cwd: string, flowId: string): Promise<void>;
}

export interface LivePatchResult {
  patched: boolean;
  waves?: string[][];
  invalidGraph?: boolean;
  issues?: GraphValidationIssue[];
  error?: string;
}

export type LivePatchHandler = (
  patch: FlowGraphPatch,
  patchRoles?: ReadonlyMap<string, RoleSpec>,
) => Promise<LivePatchResult>;

export function resolveUpstreamHandoff(
  state: FlowMachineState,
  node: FlowNodeSpec,
  initialHandoff: HandoffEnvelope | null,
): HandoffEnvelope | null {
  for (let i = node.dependsOn.length - 1; i >= 0; i--) {
    const dep = state.nodes[node.dependsOn[i]!];
    if (dep?.lastHandoff) return dep.lastHandoff;
  }
  return initialHandoff;
}

export function snapshotReferencedRoles(
  spec: FlowGraphSpec,
  roles: ReadonlyMap<string, RoleSpec>,
  existing?: Record<string, RoleSpec>,
): Record<string, RoleSpec> {
  const out: Record<string, RoleSpec> = existing ? { ...existing } : {};
  for (const n of spec.nodes) {
    if (n.kind === "role" && n.role && !out[n.role]) {
      const r = roles.get(n.role);
      if (r) out[n.role] = structuredClone(r);
    }
  }
  return out;
}

export function applyLivePatchOnState(input: {
  state: FlowMachineState;
  flowId: string;
  cwd: string;
  patch: FlowGraphPatch;
  baseRoles: ReadonlyMap<string, RoleSpec>;
  patchRoles?: ReadonlyMap<string, RoleSpec>;
  isGitRepo: boolean;
  isRoleReadOnly: (roleId: string) => boolean;
  nowIso: string;
}): { result: LivePatchResult; nextState?: FlowMachineState; commands?: FlowCommand[] } {
  if (isFlowTerminal(input.state.status)) {
    return { result: { patched: false, error: `Flow "${input.flowId}" is already ${input.state.status} and cannot be patched.` } };
  }
  // Preserve already-frozen role snapshots while exposing newly installed roles from patchRoles.
  const mergedRoles = new Map<string, RoleSpec>(input.baseRoles);
  if (input.patchRoles) {
    for (const [id, r] of input.patchRoles) mergedRoles.set(id, r);
  }
  for (const [id, r] of Object.entries(input.state.roleSnapshots ?? {})) {
    mergedRoles.set(id, r);
  }
  const nodeStatuses = Object.fromEntries(
    Object.entries(input.state.nodes).map(([k, v]) => [k, v.status]),
  );
  const validated = validateGraphPatch({
    currentSpec: input.state.spec,
    nodeStatuses,
    patch: input.patch,
    roles: mergedRoles,
    isGitRepo: input.isGitRepo,
  });
  if (!validated.ok) {
    return {
      result: {
        patched: false,
        invalidGraph: true,
        issues: validated.issues,
        error: validated.issues.map((i) => i.message).join(" | "),
      },
    };
  }
  const nextSnapshots = validated.normalizedSpec
    ? snapshotReferencedRoles(validated.normalizedSpec, mergedRoles, input.state.roleSnapshots)
    : input.state.roleSnapshots;
  const patchedInput: FlowMachineState = { ...input.state, ...(nextSnapshots ? { roleSnapshots: nextSnapshots } : {}) };
  const out = transitionFlow(
    patchedInput,
    { type: "GRAPH_PATCH", patch: input.patch, validated },
    input.nowIso,
    { isRoleReadOnly: input.isRoleReadOnly },
  );
  return { result: { patched: true, waves: validated.waves }, nextState: out.state, commands: out.commands };
}

function treeFingerprint(cwd: string): string {
  const snap = snapshotWorkspace(cwd);
  const h = createHash("sha256");
  for (const [rel, entry] of [...snap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    h.update(`${rel}\0${entry.sha256}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

export async function runDeterministicGate(input: {
  cwd: string; flowId: string; mandate: Mandate; store: EnhanceStore; nodeId: string; stageId: string;
  config: GateNodeConfig; testedCommitSha?: string; signal?: AbortSignal;
}): Promise<{ passed: boolean; evidence: VerificationEvidenceRecord; handoff: HandoffEnvelope; feedback?: string }> {
  const effCwd = input.config.cwd ? path.resolve(input.cwd, input.config.cwd) : input.cwd;
  const timeoutMs = Math.max(1_000, (input.config.timeoutSec ?? 180) * 1000);
  const expectExit = input.config.expectExitCode ?? 0;
  const proc = Bun.spawn(["bash", "-lc", input.config.command], {
    cwd: effCwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, OMP_ENHANCE_SUBPROCESS: "1" },
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
    if (!existsSync(mp)) {
      metricsOk = false;
      metricsNote = `Missing metrics file ${input.config.parseJsonMetricsPath}`;
    } else {
      try {
        JSON.parse(readFileSync(mp, "utf8"));
        metricsNote = `Parsed metrics ${input.config.parseJsonMetricsPath}`;
      } catch {
        metricsOk = false;
        metricsNote = `Invalid JSON in ${input.config.parseJsonMetricsPath}`;
      }
    }
  }
  const passed = !timedOut && exitCode === expectExit && metricsOk;
  const evidence: VerificationEvidenceRecord = {
    command: input.config.command, exitCode: timedOut ? -1 : exitCode,
    outputSnippet: metricsNote ? `${metricsNote} | ${snippet}` : snippet,
    testedTreeFingerprint: fp, toolCallId: `gate-${input.stageId}`, stageId: input.stageId,
    ...(input.testedCommitSha ? { testedCommitSha: input.testedCommitSha } : {}),
  };
  const shaNote = input.testedCommitSha ? `, commit ${input.testedCommitSha.slice(0, 12)}` : "";
  const feedback = passed
    ? undefined
    : timedOut
      ? `Gate "${input.config.command}" timed out after ${Math.round(timeoutMs / 1000)}s.`
      : `Gate "${input.config.command}" failed (exit ${exitCode}${shaNote}): ${evidence.outputSnippet}`;
  const handoff: HandoffEnvelope = {
    id: `ho-gate-${randomUUID()}`, mandateId: input.mandate.id, mandateRev: input.mandate.rev,
    parentHandoffId: null, fromRole: input.nodeId, toTarget: passed ? "user" : (input.config.repairTargetNodeId ?? "user"),
    verdict: passed ? "ready" : "rejected",
    summary: passed ? `Gate passed: ${input.config.command} (exit ${exitCode}, tree ${fp}${shaNote})` : feedback!,
    artifacts: [],
    verifiedFacts: [{ claim: `Executed gate "${input.config.command}" with exit=${exitCode}${shaNote}`, evidenceRef: `gate-${input.stageId}` }],
    verificationEvidence: [evidence], openRisks: [], feedbackForUpstream: passed ? null : feedback!,
    observedUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, createdAt: new Date().toISOString(),
  };
  if (!input.store.isClosed()) input.store.saveHandoff(handoff);
  return { passed, evidence, handoff, ...(feedback ? { feedback } : {}) };
}
