/**
 * Core data contracts for omp-enhance.
 *
 * Unifies single-agent daily work (N = 1) and multi-agent collaboration (N > 1)
 * under RoleSpec (M_r) and HandoffEnvelope (H).
 */

export type RoleSource = "project" | "global" | "builtin";
export type RoleThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type FlowRoutingMode = "ask" | "auto" | "manual";

export interface EnhanceSettings {
  defaultRole: string | null;
  showStatusBar: boolean;
  supervisorEnabled: boolean;
  supervisorModel: string;
  supervisorThinking: RoleThinkingLevel;
  supervisorInitialDelaySec: number;
  flowMaxRepairRounds: number;
  flowRoutingMode: FlowRoutingMode;
}

export interface RolePermissions {
  tools?: string[];
  writable?: string[];
  protected?: string[];
}
export interface RoleExitSpec {
  requireToolEvidence: boolean;
  criteria: string[];
}
export interface RoleSpec {
  id: string; name: string; description: string;
  model?: string; thinking?: RoleThinkingLevel;
  stance: string; method: string[];
  permissions: RolePermissions; exit: RoleExitSpec;
  source: RoleSource; filePath: string; contentSha256: string;
}
export interface Mandate {
  id: string; rev: number; goal: string;
  constraints: string[]; acceptance: string[];
  status: "active" | "completed" | "archived";
  createdAt: string; updatedAt: string;
}
export type EpistemicKind = "fact" | "hypothesis" | "inquiry" | "decision";
export type EpistemicStatus = "open" | "verified" | "falsified" | "deferred";

export interface EpistemicItem {
  id: string; mandateId: string; kind: EpistemicKind; statement: string;
  evidenceRef: string | null; verificationPlan: string | null;
  status: EpistemicStatus; createdAt: string;
}
export type ArtifactRole = "input" | "changed" | "test" | "report" | "metrics";

export interface ArtifactRecord {
  path: string; sha256: string; byteSize: number; role: ArtifactRole;
}
export interface VerifiedFact {
  claim: string; evidenceRef: string;
}
export interface UsageSummary {
  inputTokens: number; outputTokens: number; costUsd: number;
}
export type HandoffVerdict = "ready" | "rejected" | "blocked";

export interface HandoffEnvelope {
  id: string; mandateId: string; mandateRev: number;
  parentHandoffId: string | null; fromRole: string; toTarget: "user" | string;
  verdict: HandoffVerdict; summary: string;
  artifacts: ArtifactRecord[]; verifiedFacts: VerifiedFact[];
  openRisks: string[]; feedbackForUpstream: string | null;
  observedUsage: UsageSummary | null; createdAt: string;
}
export interface ObservedToolCall {
  toolCallId: string; toolName: string; isError: boolean;
  touchedPaths: string[]; timestamp: string; summary?: string;
}
export interface RoomEntry {
  id: string; side: "left" | "right"; speaker: string;
  target?: string; badge?: string; tone?: "info" | "success" | "warning" | "error";
  text: string; timestamp: string; stageId?: string;
}
export interface FlowStageTrace {
  stageId: string; roleId: string; roleName: string; round: number;
  status: "running" | "ready" | "rejected" | "blocked" | "violation" | "aborted";
  modelLabel: string; startedAt: string; endedAt: string | null;
  activeTool: string | null; calls: ObservedToolCall[];
  assistantText: string; envelope: HandoffEnvelope | null; notes: string[];
}
export type JobStatus = "running" | "completed" | "failed" | "cancelled" | "unknown";
export type SupervisorAction = "continue" | "steer" | "abort";

export interface SupervisorDecision {
  action: SupervisorAction; reason: string; nextCheckSec: number;
  evidence?: string; steerMessage?: string;
}
export interface SupervisorPulse {
  targetKind: "job" | "role_session"; goal: string; checkNumber: number;
  elapsedSec: number; idleSec: number; deltaBytesOrCalls: number; deltaSummary: string;
}
export interface BackgroundJob {
  jobId: string; mandateId: string | null; hypothesisId: string | null;
  command: string; cwd: string; pid: number; pgid: number;
  logPath: string; exitFilePath: string; status: JobStatus;
  exitCode: number | null; startedAt: string; endedAt: string | null;
}
export interface FlowStepResult {
  stepIndex: number; roleId: string; round: number; envelope: HandoffEnvelope;
}
export interface FlowRunResult {
  status: "completed" | "rejected_max_rounds" | "stagnated" | "blocked" | "violation" | "aborted_by_supervisor" | "cancelled";
  steps: FlowStepResult[]; finalEnvelope: HandoffEnvelope | null; reason?: string;
}
