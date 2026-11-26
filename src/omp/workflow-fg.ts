import { spawnSync } from "node:child_process";
import type { FlowMachineState, RoleWorkflowPhaseSpec } from "../core/graph-types.ts";
import { MUTATING_HOST_TOOLS } from "../core/policy.ts";
import type { HandoffEnvelope, RoleSpec } from "../core/types.ts";
import { createInitialFlowState, transitionFlow } from "../flow/machine.ts";
import { compileRoleWorkflow, type CompiledRoleWorkflow } from "../flow/workflow.ts";

const MUTATING_SET = new Set<string>(MUTATING_HOST_TOOLS);

interface ForegroundWorkflowEntry {
  roleId: string;
  roleSha: string;
  compiled: CompiledRoleWorkflow;
  state: FlowMachineState;
}

export interface ForegroundPhaseContext {
  effectiveRole: RoleSpec;
  phaseId: string;
  phaseIndex: number;
  totalPhases: number;
  badge: string;
  promptNote: string;
  lockedProtected: string[];
  waitingHumanPrompt?: string;
}

export class ForegroundWorkflowController {
  private readonly bySession = new Map<string, ForegroundWorkflowEntry>();

  reset(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  private ensureEntry(sessionId: string, cwd: string, role: RoleSpec, goal?: string): ForegroundWorkflowEntry | null {
    if (!role.workflow || role.workflow.phases.length === 0) {
      this.bySession.delete(sessionId);
      return null;
    }
    const existing = this.bySession.get(sessionId);
    if (existing && existing.roleId === role.id && existing.roleSha === role.contentSha256) return existing;

    const compiled = compileRoleWorkflow({ role, outerGoal: goal || role.description || role.id });
    const now = new Date().toISOString();
    const init = createInitialFlowState({
      flowId: `fg-${sessionId}`,
      mandateId: `fg-${sessionId}`,
      cwd,
      spec: compiled.spec,
      validation: compiled.validation,
      nowIso: now,
    });
    const started = transitionFlow(init, { type: "FLOW_START" }, now).state;
    const entry: ForegroundWorkflowEntry = { roleId: role.id, roleSha: role.contentSha256, compiled, state: started };
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
    const idx = Math.max(0, entry.state.nodeOrder.indexOf(activeId));
    const total = entry.state.nodeOrder.length;
    const phaseRole = spec.kind === "role" && spec.role ? (entry.compiled.phaseRoles.get(spec.role) ?? role) : role;
    const lockedProtected = entry.compiled.lockedProtectedByPhase[activeId] ?? [];

    const waitingHumanPrompt = spec.kind === "human" && rt.status === "waiting_input" ? spec.human?.prompt : undefined;
    const effectiveRole: RoleSpec = waitingHumanPrompt
      ? {
          ...role,
          permissions: {
            ...(role.permissions.tools ? { tools: role.permissions.tools.filter((t) => !MUTATING_SET.has(t)) } : {}),
            writable: [],
            protected: ["**"],
          },
          exit: { requireToolEvidence: false, criteria: [waitingHumanPrompt] },
        }
      : { ...phaseRole, id: role.id, name: role.name };
    const promptNote = waitingHumanPrompt
      ? `[Active Workflow Phase ${idx + 1}/${total}: ${activeId} (HUMAN GATE — AWAITING EXPLICIT USER CONFIRMATION)]\n` +
        `Question awaiting user decision: ${waitingHumanPrompt}\n` +
        `Stay in this gate (read-only) if the user is only asking a status or clarification question. Only after the user explicitly confirms or answers in chat, call enhance_handoff(verdict="ready", summary="<user's exact confirmation>") to unlock the next phase.`
      : `[Active Workflow Phase ${idx + 1}/${total}: ${activeId}${spec.title ? ` — ${spec.title}` : ""}]\n` +
        `${typeof spec.brief === "string" ? spec.brief : ""}\n` +
        (lockedProtected.length > 0 ? `Locked protected paths (DO NOT modify): ${lockedProtected.join(", ")}\n` : "") +
        `Call enhance_handoff(verdict="ready", summary=...) when this phase's exit criteria are met to unlock the next phase.`;

    return {
      effectiveRole,
      phaseId: activeId,
      phaseIndex: idx,
      totalPhases: total,
      badge: `${idx + 1}/${total} ${activeId}`,
      promptNote,
      lockedProtected,
      ...(waitingHumanPrompt ? { waitingHumanPrompt } : {}),
    };
  }

  onPhaseHandoff(input: {
    sessionId: string;
    cwd: string;
    role: RoleSpec;
    handoff: HandoffEnvelope;
  }): { advanced: boolean; completed?: boolean; nextPhaseId?: string; humanPrompt?: string; gateError?: string } {
    const entry = this.bySession.get(input.sessionId);
    if (!entry || entry.roleId !== input.role.id || input.handoff.verdict !== "ready") {
      return { advanced: false };
    }
    const now = new Date().toISOString();
    const waitingHumanId = entry.state.nodeOrder.find((id) => {
      const n = entry.state.spec.nodes.find((s) => s.id === id);
      return n?.kind === "human" && entry.state.nodes[id]!.status === "waiting_input";
    });
    if (waitingHumanId) {
      entry.state = transitionFlow(entry.state, { type: "FLOW_RESUME", targetNodeId: waitingHumanId, replyText: input.handoff.summary }, now).state;
    } else {
      const activeId = entry.state.nodeOrder.find((id) => entry.state.nodes[id]!.status === "running");
      if (!activeId) return { advanced: false };
      entry.state = transitionFlow(entry.state, { type: "NODE_SUCCEEDED", nodeId: activeId, handoff: input.handoff }, now).state;
    }

    // Auto-run immediate deterministic gate node if unlocked
    const gateId = entry.state.nodeOrder.find((id) => {
      const n = entry.state.spec.nodes.find((s) => s.id === id);
      return n?.kind === "gate" && entry.state.nodes[id]!.status === "running";
    });
    if (gateId) {
      const gateSpec = entry.state.spec.nodes.find((s) => s.id === gateId)!.gate!;
      const res = spawnSync("bash", ["-lc", gateSpec.command], {
        cwd: input.cwd,
        encoding: "utf8",
        timeout: Math.max(1_000, (gateSpec.timeoutSec ?? 120) * 1000),
        env: { ...process.env, OMP_ENHANCE_SUBPROCESS: "1" },
      });
      const exitCode = res.status ?? 1;
      const passed = exitCode === (gateSpec.expectExitCode ?? 0);
      const snippet = [res.stdout?.trim(), res.stderr?.trim()].filter(Boolean).join("\n").slice(-400) || "(no output)";
      entry.state = transitionFlow(entry.state, {
        type: "GATE_COMPLETED",
        nodeId: gateId,
        passed,
        evidence: { command: gateSpec.command, exitCode, outputSnippet: snippet, testedTreeFingerprint: "fg", toolCallId: `fg-${gateId}` },
        ...(!passed ? { feedback: `Phase gate "${gateSpec.command}" failed (exit ${exitCode}): ${snippet}` } : {}),
      }, new Date().toISOString()).state;
      if (!passed) return { advanced: false, gateError: `Phase gate "${gateSpec.command}" failed (exit ${exitCode}): ${snippet}` };
    }

    if (entry.state.status === "completed") {
      this.bySession.delete(input.sessionId);
      return { advanced: true, completed: true };
    }
    const nextId = entry.state.nodeOrder.find((id) => {
      const st = entry.state.nodes[id]!.status;
      return st === "running" || st === "waiting_input";
    });
    const nextNode = nextId ? entry.state.spec.nodes.find((s) => s.id === nextId) : undefined;
    const humanPrompt = nextNode?.kind === "human" ? nextNode.human?.prompt : undefined;
    return { advanced: true, ...(nextId ? { nextPhaseId: nextId } : {}), ...(humanPrompt ? { humanPrompt } : {}) };
  }

  getPhaseSpec(sessionId: string): RoleWorkflowPhaseSpec | null {
    const entry = this.bySession.get(sessionId);
    if (!entry) return null;
    const activeId = entry.state.nodeOrder.find((id) => entry.state.nodes[id]!.status === "running");
    return activeId ? (entry.compiled.spec.nodes.find((n) => n.id === activeId) as unknown as RoleWorkflowPhaseSpec) ?? null : null;
  }
}
