import { spawnSync } from "node:child_process";
import type { FlowMachineState, RoleWorkflowPhaseSpec } from "../core/graph-types.ts";
import { MUTATING_HOST_TOOLS } from "../core/policy.ts";
import type { HandoffEnvelope, RoleSpec } from "../core/types.ts";
import { validateFlowGraph } from "../flow/graph.ts";
import {
  evaluateHumanReply,
  inferHumanNodeMode,
  isStatusOrProgressQuery,
} from "../flow/human-policy.ts";
import { createInitialFlowState, transitionFlow } from "../flow/machine.ts";
import { compileRoleWorkflow, type CompiledRoleWorkflow } from "../flow/workflow.ts";

export { isStatusOrProgressQuery };

const MUTATING_SET = new Set<string>(MUTATING_HOST_TOOLS);

interface ForegroundWorkflowEntry {
  roleId: string; roleSha: string; compiled: CompiledRoleWorkflow; state: FlowMachineState;
  latestUserTurnKey: string | null; latestUserText: string | null;
  pausedAtUserTurnKey: string | null; lastConsumedUserTurnKey: string | null;
}

export interface ForegroundPhaseContext {
  effectiveRole: RoleSpec; phaseId: string; phaseIndex: number; totalPhases: number;
  badge: string; promptNote: string; lockedProtected: string[]; waitingHumanPrompt?: string;
}

export class ForegroundWorkflowController {
  private readonly bySession = new Map<string, ForegroundWorkflowEntry>();
  private readonly pendingTurnBySession = new Map<string, { turnKey: string; userText: string }>();

  reset(sessionId: string): void { this.bySession.delete(sessionId); this.pendingTurnBySession.delete(sessionId); }

  observeUserTurn(sessionId: string, turn: { turnKey: string; userText: string }): void {
    this.pendingTurnBySession.set(sessionId, turn);
    const entry = this.bySession.get(sessionId);
    if (entry) { entry.latestUserTurnKey = turn.turnKey; entry.latestUserText = turn.userText; }
  }

  private ensureEntry(sessionId: string, cwd: string, role: RoleSpec, goal?: string): ForegroundWorkflowEntry | null {
    if (!role.workflow || role.workflow.phases.length === 0) { this.bySession.delete(sessionId); return null; }
    const existing = this.bySession.get(sessionId);
    if (existing && existing.roleId === role.id && existing.roleSha === role.contentSha256) return existing;
    const compiled = compileRoleWorkflow({ role, outerGoal: goal || role.description || role.id });
    const validation = validateFlowGraph({ spec: compiled.spec, roles: new Map([[role.id, role]]), isGitRepo: false });
    const now = new Date().toISOString();
    const init = createInitialFlowState({ flowId: `fg-${sessionId}`, mandateId: `fg-${sessionId}`, cwd, spec: compiled.spec, validation, nowIso: now });
    const started = transitionFlow(init, { type: "FLOW_START" }, now).state;
    const pending = this.pendingTurnBySession.get(sessionId);
    const hasInitialHuman = started.nodeOrder.some((id) => started.nodes[id]!.status === "waiting_input");
    const entry: ForegroundWorkflowEntry = {
      roleId: role.id, roleSha: role.contentSha256, compiled, state: started,
      latestUserTurnKey: pending?.turnKey ?? null, latestUserText: pending?.userText ?? null,
      pausedAtUserTurnKey: hasInitialHuman ? (pending?.turnKey ?? "__init__") : null, lastConsumedUserTurnKey: null,
    };
    this.bySession.set(sessionId, entry);
    return entry;
  }

  getActivePhaseContext(sessionId: string, cwd: string, role: RoleSpec, goal?: string, _advanceHumanOnNewTurn = false): ForegroundPhaseContext | null {
    const entry = this.ensureEntry(sessionId, cwd, role, goal);
    if (!entry) return null;
    const activeId = entry.state.nodeOrder.find((id) => {
      const st = entry.state.nodes[id]!.status;
      return st === "running" || st === "waiting_input" || st === "ready";
    }) ?? entry.state.nodeOrder.at(-1)!;
    const spec = entry.state.spec.nodes.find((n) => n.id === activeId)!;
    const rt = entry.state.nodes[activeId]!;
    const idx = Math.max(0, entry.state.nodeOrder.indexOf(activeId)), total = entry.state.nodeOrder.length;
    const phaseRole = entry.compiled.phaseRoles.get(activeId) ?? role;
    const lockedProtected = entry.compiled.lockedProtectedByPhase[activeId] ?? [];
    const shortPhaseId = activeId.startsWith(`${role.id}__`) ? activeId.slice(role.id.length + 2) : activeId;
    const waitingHumanPrompt = spec.kind === "human" && rt.status === "waiting_input" ? spec.human?.prompt : undefined;
    const effectiveRole: RoleSpec = waitingHumanPrompt
      ? {
          ...role,
          permissions: { ...(role.permissions.tools ? { tools: role.permissions.tools.filter((t) => !MUTATING_SET.has(t)) } : {}), writable: [], protected: ["**"] },
          exit: { requireToolEvidence: false, criteria: [waitingHumanPrompt] },
        }
      : { ...phaseRole, id: role.id, name: role.name };
    const humanCfg = spec.kind === "human" ? spec.human : undefined;
    const humanMode = humanCfg ? inferHumanNodeMode(humanCfg) : "approval";
    const optionsHint = humanCfg?.options?.length ? humanCfg.options.join(" / ") : "同意 / 暂缓";
    const promptNote = waitingHumanPrompt
      ? humanMode === "input"
        ? `[Active Workflow Phase ${idx + 1}/${total}: ${shortPhaseId} (HUMAN GATE · INPUT — AWAITING USER SPECIFICATION)]\nQuestion awaiting user input: ${waitingHumanPrompt}\nStay read-only on questions, status checks, or deferrals; once the user supplies concrete parameters/preferences in a new message, call enhance_handoff(verdict="ready", summary=...) to unlock the next phase.`
        : `[Active Workflow Phase ${idx + 1}/${total}: ${shortPhaseId} (HUMAN GATE — AWAITING EXPLICIT USER CONFIRMATION)]\nQuestion awaiting user decision: ${waitingHumanPrompt}\nOffer clear options (${optionsHint})${humanCfg?.allowFreeText === false ? " (must select one of the declared options)" : " alongside natural-language reply"}. Stay read-only on questions, status checks, or deferrals; only after explicit user confirmation in a new message, call enhance_handoff(verdict="ready", summary=...) to unlock the next phase.`
      : `[Active Workflow Phase ${idx + 1}/${total}: ${shortPhaseId}${spec.title ? ` — ${spec.title}` : ""}]\n${typeof spec.brief === "string" ? spec.brief : ""}\n${lockedProtected.length > 0 ? `Locked protected paths (DO NOT modify): ${lockedProtected.join(", ")}\n` : ""}Call enhance_handoff(verdict="ready", summary=...) when this phase's exit criteria are met to unlock the next phase.`;
    return {
      effectiveRole, phaseId: shortPhaseId, phaseIndex: idx, totalPhases: total,
      badge: `${idx + 1}/${total} ${shortPhaseId}`, promptNote, lockedProtected,
      ...(waitingHumanPrompt ? { waitingHumanPrompt } : {}),
    };
  }

  onPhaseHandoff(input: {
    sessionId: string; cwd: string; role: RoleSpec; handoff: HandoffEnvelope; userReplyText?: string; userTurnKey?: string;
  }): { advanced: boolean; completed?: boolean; nextPhaseId?: string; humanPrompt?: string; userReply?: string; gateError?: string } {
    const entry = this.bySession.get(input.sessionId);
    if (!entry || entry.roleId !== input.role.id || input.handoff.verdict !== "ready") return { advanced: false };
    const now = new Date().toISOString();
    const waitingHumanId = entry.state.nodeOrder.find((id) => entry.state.spec.nodes.find((s) => s.id === id)?.kind === "human" && entry.state.nodes[id]!.status === "waiting_input");
    let recordedReply: string | undefined;
    if (waitingHumanId) {
      const effTurnKey = input.userTurnKey ?? entry.latestUserTurnKey;
      const effUserText = (input.userReplyText ?? entry.latestUserText ?? "").trim();
      if (!effTurnKey || effTurnKey === entry.pausedAtUserTurnKey || effTurnKey === entry.lastConsumedUserTurnKey) {
        return { advanced: false, gateError: "Human gate requires a new explicit user reply before advancing (same-turn or duplicate approvals are blocked)." };
      }
      const humanCfg = entry.state.spec.nodes.find((s) => s.id === waitingHumanId)?.human ?? { prompt: "" };
      const evalRes = evaluateHumanReply(humanCfg, effUserText);
      if (evalRes.decision !== "proceed") {
        return {
          advanced: false,
          gateError: evalRes.reason ?? "User's latest message did not satisfy this human gate; phase remains paused.",
        };
      }
      entry.lastConsumedUserTurnKey = effTurnKey;
      recordedReply = effUserText;
      entry.state = transitionFlow(entry.state, { type: "FLOW_RESUME", targetNodeId: waitingHumanId, replyText: effUserText }, now).state;
    } else {
      const activeId = entry.state.nodeOrder.find((id) => entry.state.nodes[id]!.status === "running");
      if (!activeId) return { advanced: false };
      entry.state = transitionFlow(entry.state, { type: "NODE_SUCCEEDED", nodeId: activeId, handoff: input.handoff }, now).state;
    }

    const gateId = entry.state.nodeOrder.find((id) => entry.state.spec.nodes.find((s) => s.id === id)?.kind === "gate" && entry.state.nodes[id]!.status === "running");
    if (gateId) {
      const gateSpec = entry.state.spec.nodes.find((s) => s.id === gateId)!.gate!;
      const res = spawnSync("bash", ["-lc", gateSpec.command], { cwd: input.cwd, encoding: "utf8", timeout: Math.max(1_000, (gateSpec.timeoutSec ?? 120) * 1000), env: { ...process.env, OMP_ENHANCE_SUBPROCESS: "1" } });
      const exitCode = res.status ?? 1, passed = exitCode === (gateSpec.expectExitCode ?? 0);
      const snippet = [res.stdout?.trim(), res.stderr?.trim()].filter(Boolean).join("\n").slice(-400) || "(no output)";
      entry.state = transitionFlow(entry.state, {
        type: "GATE_COMPLETED", nodeId: gateId, passed,
        evidence: { command: gateSpec.command, exitCode, outputSnippet: snippet, testedTreeFingerprint: "fg", toolCallId: `fg-${gateId}` },
        ...(!passed ? { feedback: `Phase gate "${gateSpec.command}" failed (exit ${exitCode}): ${snippet}` } : {}),
      }, new Date().toISOString()).state;
      if (!passed) return { advanced: false, gateError: `Phase gate "${gateSpec.command}" failed (exit ${exitCode}): ${snippet}` };
    }

    if (entry.state.status === "completed") {
      this.bySession.delete(input.sessionId);
      return { advanced: true, completed: true, ...(recordedReply ? { userReply: recordedReply } : {}) };
    }
    const nextId = entry.state.nodeOrder.find((id) => { const st = entry.state.nodes[id]!.status; return st === "running" || st === "waiting_input"; });
    const nextNode = nextId ? entry.state.spec.nodes.find((s) => s.id === nextId) : undefined;
    const humanPrompt = nextNode?.kind === "human" ? nextNode.human?.prompt : undefined;
    if (humanPrompt) entry.pausedAtUserTurnKey = entry.latestUserTurnKey ?? "__paused__";
    const shortNext = nextId && nextId.startsWith(`${input.role.id}__`) ? nextId.slice(input.role.id.length + 2) : nextId;
    return { advanced: true, ...(shortNext ? { nextPhaseId: shortNext } : {}), ...(humanPrompt ? { humanPrompt } : {}), ...(recordedReply ? { userReply: recordedReply } : {}) };
  }
}
