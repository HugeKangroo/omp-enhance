import type { HandoffEnvelope, RoleSpec, VerificationEvidenceRecord } from "./types.ts";

export type NodeKind = "role" | "gate" | "merge" | "human";
export type WorkspaceMode = "inherit" | "worktree";
export type SessionReuseMode = "fresh" | "reuse";
export type JoinStrategy = "all" | "any";
export type FlowLeaseMode = "read" | "write_main" | "write_worktree";
export type FlowPreset = "linear" | "fan_out_join" | "contract_parallel_verify" | "experiment_loop" | "custom";
export type SessionResidency = "none" | "warm" | "hibernated" | "disposed";

export type NodeStatus =
  | "pending" | "ready" | "running" | "waiting_input" | "retrying" | "invalidated"
  | "succeeded" | "blocked" | "violation" | "failed" | "skipped" | "cancelled";

export type FlowMachineStatus =
  | "draft" | "running" | "waiting_input" | "interrupted" | "completed"
  | "blocked" | "stagnated" | "rejected_max_rounds" | "violation"
  | "aborted_by_supervisor" | "failed" | "cancelled";

export interface NodeBrief {
  owns: string; nonGoals?: string[]; acceptance: string[]; contextRefs?: string[];
}

export interface GateNodeConfig {
  command: string; cwd?: string; timeoutSec?: number; expectExitCode?: number;
  parseJsonMetricsPath?: string; repairTargetNodeId?: string;
}

export interface MergeNodeConfig {
  sourceNodeIds: string[]; landingMode?: "apply" | "branch_preview";
  conflictPolicy?: "spawn_resolver" | "ask_human" | "fail"; resolverRoleId?: string;
}

export type HumanNodeMode = "approval" | "input";
export type HumanOptionAction = "proceed" | "hold" | "cancel";

export interface HumanNodeConfig {
  prompt: string;
  options?: string[];
  allowFreeText?: boolean;
  mode?: HumanNodeMode;
  optionActions?: Record<string, HumanOptionAction>;
}

export interface FlowNodeSpec {
  id: string; title?: string; kind: NodeKind; role?: string; dependsOn: string[];
  join?: JoinStrategy; brief?: NodeBrief | string; tools?: string[]; writableScope?: string[];
  workspace?: WorkspaceMode; worktreeGroup?: string;
  sessionMode?: SessionReuseMode; sessionGroup?: string; parentGroupId?: string;
  phaseTools?: string[]; lockedProtected?: string[]; requiredArtifacts?: string[]; requiredChecks?: string[];
  isWorkflowPhase?: boolean; isFinalWorkflowPhase?: boolean; localRepairBudget?: number;
  fallbackModels?: string[]; repairTargetNodeId?: string;
  maxAttempts?: number; stallTimeoutSec?: number; skipOnUpstreamFail?: boolean;
  gate?: GateNodeConfig; merge?: MergeNodeConfig; human?: HumanNodeConfig;
}

export interface FlowPolicies {
  maxConcurrency: number; maxRepairRounds: number;
  workspaceStrategy: "auto_worktree" | "strict_scope" | "inherit_only";
  pauseOnWaitingInput: "branch_only" | "whole_flow";
  enableSessionReuse: boolean;
}

export const DEFAULT_FLOW_POLICIES: FlowPolicies = {
  maxConcurrency: 3, maxRepairRounds: 2, workspaceStrategy: "auto_worktree",
  pauseOnWaitingInput: "branch_only", enableSessionReuse: true,
};

export interface FlowGraphSpec {
  version: 1; goal: string; preset?: FlowPreset; nodes: FlowNodeSpec[]; policies: FlowPolicies;
}

export interface FlowGraphPatch {
  addNodes?: FlowNodeSpec[]; skipNodeIds?: string[];
  rewireDeps?: Array<{ nodeId: string; dependsOn: string[] }>;
}

export type GraphValidationIssueCode =
  | "empty_graph" | "invalid_node_id" | "duplicate_node_id" | "missing_dep"
  | "cycle_detected" | "invalid_node_config" | "unknown_role" | "internal_role_forbidden"
  | "scope_violation" | "write_collision" | "invalid_repair_target"
  | "invalid_merge_source" | "worktree_requires_git" | "missing_merge_delivery";

export interface GraphValidationIssue {
  code: GraphValidationIssueCode; nodeId?: string; otherNodeId?: string; message: string;
}

export interface GraphValidationResult {
  ok: boolean; issues: GraphValidationIssue[]; waveByNode: Record<string, number>; waves: string[][];
  effectiveWorkspaceByNode: Record<string, WorkspaceMode>;
  hasWritableNodes: boolean; usesWorktree: boolean; leaseMode: FlowLeaseMode;
  normalizedSpec?: FlowGraphSpec;
}

export type FlowBoardKind =
  | "brief" | "finding" | "handoff" | "user_steer" | "repair_feedback"
  | "gate_result" | "merge_result" | "system" | "done";

export interface FlowBoardEntry {
  seq?: number; eventId: string; flowId: string; nodeId?: string | null; kind: FlowBoardKind;
  speaker: string; target?: string | null; text: string; metadata?: Record<string, unknown>;
  createdAt: string; consumedAt?: string | null; consumedByNode?: string | null;
}

export interface RoleWorkflowExitGateSpec {
  command: string; timeoutSec?: number; expectExitCode?: number; parseJsonMetricsPath?: string;
}

export interface RoleWorkflowPhaseSpec {
  id: string; title?: string; kind?: "role" | "gate" | "human"; dependsOn?: string[];
  tools?: string[]; writable?: string[]; lockProtected?: string[]; exitArtifacts?: string[]; requiredChecks?: string[];
  exitGate?: RoleWorkflowExitGateSpec; prompt?: string; brief?: string;
  options?: string[]; allowFreeText?: boolean; mode?: HumanNodeMode; optionActions?: Record<string, HumanOptionAction>;
  maxAttempts?: number; fallbackModels?: string[];
}

export interface RoleWorkflowSpec {
  session?: "reuse" | "fresh"; repairEntry?: string; maxRepairRounds?: number;
  phases: RoleWorkflowPhaseSpec[];
}

export interface FlowNodeRuntime {
  nodeId: string; status: NodeStatus; waveIndex: number; effectiveWorkspace: WorkspaceMode;
  sessionResidency: SessionResidency; attempt: number; repairRound: number;
  activeStageId: string | null; worktreePath: string | null;
  commitRef: string | null; commitSha?: string | null;
  currentModel: string | null; triedModels: string[];
  lastHandoffId: string | null; lastHandoff: HandoffEnvelope | null;
  lastGateEvidence: VerificationEvidenceRecord | null;
  lastError: string | null; lastRepairFeedback: string | null;
  lastReply?: string | null; questionPrompt?: string | null; questionsForUser: string[];
  startedAt: string | null; endedAt: string | null;
}

export interface FlowMachineState {
  flowId: string; mandateId: string; cwd: string; spec: FlowGraphSpec; status: FlowMachineStatus;
  nodes: Record<string, FlowNodeRuntime>; nodeOrder: string[]; waves: string[][];
  repairRound: number; maxRepairRounds: number; lastRejectionSig: string | null;
  nextStageSeq: number; boardSeq: number; initialHandoffId: string | null; lastHandoffId: string | null;
  mergedRef: string | null; mergedCommitSha?: string | null; reason?: string;
  roleSnapshots?: Record<string, RoleSpec>;
  startedAt: string | null; endedAt: string | null;
}

export type FlowEvent =
  | { type: "FLOW_START" }
  | { type: "FLOW_RESUME"; replyText?: string; targetNodeId?: string }
  | { type: "FLOW_CANCEL"; reason?: string }
  | { type: "USER_STEER"; steerId: string; seq?: number; text: string; targetNodeId?: string; targetRole?: string }
  | { type: "NODE_WORKTREE_READY"; nodeId: string; worktreePath: string }
  | { type: "NODE_DISPATCHED"; nodeId: string; attempt: number; stageId: string; modelLabel?: string }
  | { type: "NODE_SUCCEEDED"; nodeId: string; handoff: HandoffEnvelope; sessionWarm?: boolean; commitRef?: string | null; commitSha?: string | null }
  | { type: "NODE_NEEDS_INPUT"; nodeId: string; handoff: HandoffEnvelope; questions: string[]; sessionWarm?: boolean }
  | { type: "NODE_REJECTED"; nodeId: string; handoff: HandoffEnvelope; targetNodeId?: string; feedback: string }
  | { type: "NODE_BLOCKED"; nodeId: string; handoff?: HandoffEnvelope; reason: string }
  | { type: "NODE_VIOLATION"; nodeId: string; violations: string[]; reason: string }
  | { type: "NODE_ABORTED_BY_SUPERVISOR"; nodeId: string; reason: string }
  | { type: "NODE_HOST_ERROR"; nodeId: string; error: string; retryable: boolean; currentModel?: string }
  | { type: "NODE_STALLED"; nodeId: string; idleSec: number; currentModel?: string }
  | { type: "GATE_COMPLETED"; nodeId: string; passed: boolean; evidence: VerificationEvidenceRecord; handoff?: HandoffEnvelope; feedback?: string }
  | { type: "MERGE_COMPLETED"; nodeId: string; ok: boolean; mergedRef?: string | null; mergedCommitSha?: string | null; summary: string; conflicts?: string[]; handoff?: HandoffEnvelope }
  | { type: "HUMAN_RESOLVED"; nodeId: string; replyText: string }
  | { type: "GRAPH_PATCH"; patch: FlowGraphPatch; validated?: GraphValidationResult };

export type FlowCommand =
  | { type: "PREPARE_WORKTREE"; nodeId: string; worktreeGroup?: string; baseCommitSha?: string; dependsOn: string[] }
  | {
      type: "DISPATCH_ROLE_NODE"; nodeId: string; stageId: string; attempt: number; repairRound: number;
      reuseSession: boolean; sessionGroup?: string; worktreePath?: string;
      targetCommitRef?: string; targetCommitSha?: string; modelOverride?: string;
      repairFeedback?: string; replyText?: string;
    }
  | { type: "RUN_GATE_NODE"; nodeId: string; stageId: string; attempt: number; worktreePath?: string; targetCommitRef?: string; targetCommitSha?: string; config: GateNodeConfig }
  | { type: "RUN_MERGE_NODE"; nodeId: string; stageId: string; attempt: number; sourceNodeIds: string[]; sourceRefs: Record<string, string>; baseCommitSha?: string; config: MergeNodeConfig }
  | { type: "RUN_HUMAN_NODE"; nodeId: string; stageId: string; config: HumanNodeConfig }
  | { type: "SWITCH_MODEL_AND_RESUME"; nodeId: string; stageId: string; nextModel: string; reason: string; attempt: number }
  | { type: "DELIVER_STEER"; nodeId: string; steerId: string; text: string }
  | { type: "ABORT_NODE"; nodeId: string; reason: string }
  | { type: "DISPOSE_SESSION"; nodeId: string }
  | { type: "CLEANUP_WORKTREES"; flowId: string }
  | { type: "APPEND_BOARD"; entry: Omit<FlowBoardEntry, "seq" | "eventId" | "flowId" | "createdAt"> }
  | { type: "WAKE_COORDINATOR"; kind: "needs_input" | "settled" | "conflict"; summary: string; nodeId?: string }
  | { type: "PERSIST_STATE" };

export interface FlowGraphNodeView {
  nodeId: string; title: string; kind: NodeKind; role?: string; waveIndex: number; dependsOn: string[];
  status: NodeStatus; workspace: WorkspaceMode; worktreePath: string | null; writableScope?: string[];
  sessionResidency: SessionResidency; attempt: number; repairRound: number;
  currentModel: string | null; triedModels: string[]; activeStageId: string | null;
  parentGroupId?: string; questionsForUser?: string[]; summary?: string;
}

export interface FlowGraphSnapshot {
  preset: FlowPreset; waves: string[][]; nodes: FlowGraphNodeView[];
  mergedRef: string | null; mergedCommitSha?: string | null;
}
