/**
 * Core data contracts for omp-enhance.
 *
 * Unifies single-agent daily work (N = 1) and multi-agent collaboration (N > 1)
 * under RoleSpec (M_r) and HandoffEnvelope (H).
 */

export type RoleSource = "project" | "global" | "builtin";

export const ROLE_THINKING_LEVELS = [
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
] as const;

export type RoleThinkingLevel = (typeof ROLE_THINKING_LEVELS)[number];
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
  dispatch?: boolean;
}

export interface RoleExitSpec {
  requireToolEvidence: boolean;
  requiredTools?: string[];
  requiredArtifacts?: string[];
  requireTestExecution?: boolean;
  requireAlgoDeliverables?: boolean;
  criteria: string[];
}

export interface RoleSpec {
  id: string;
  name: string;
  description: string;
  /** Explicit "inherit" overrides builtin defaults (e.g. supervisor) to inherit session model. */
  model?: "inherit" | (string & {});
  thinking?: RoleThinkingLevel;
  internal?: boolean;
  stance: string;
  method: string[];
  permissions: RolePermissions;
  exit: RoleExitSpec;
  source: RoleSource;
  filePath: string;
  contentSha256: string;
}

export interface RoleLoadDiagnostic {
  filePath: string;
  source: RoleSource;
  error: string;
}

export type MandateStatus = "active" | "completed" | "archived";

export interface Mandate {
  id: string;
  rev: number;
  goal: string;
  constraints: string[];
  acceptance: string[];
  status: MandateStatus;
  sessionId?: string | null;
  flowId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EpistemicKind = "fact" | "hypothesis" | "inquiry" | "decision";
export type EpistemicStatus = "open" | "verified" | "falsified" | "deferred";

export interface EpistemicItem {
  id: string;
  mandateId: string;
  kind: EpistemicKind;
  statement: string;
  evidenceRef: string | null;
  verificationPlan: string | null;
  status: EpistemicStatus;
  createdAt: string;
}

export type ArtifactRole = "input" | "inspected" | "changed" | "test" | "report" | "metrics";
export type ArtifactDigestKind = "sha256" | "stat_fingerprint";

export interface ArtifactRecord {
  path: string;
  sha256: string;
  byteSize: number;
  role: ArtifactRole;
  digestKind?: ArtifactDigestKind;
}

export interface VerifiedFact {
  claim: string;
  evidenceRef: string;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface VerificationEvidenceRecord {
  command: string;
  exitCode: number;
  outputSnippet: string;
  testedTreeFingerprint: string;
  toolCallId: string;
}

export type HandoffVerdict = "ready" | "needs_input" | "rejected" | "blocked";

export interface HandoffEnvelope {
  id: string;
  mandateId: string;
  mandateRev: number;
  parentHandoffId: string | null;
  fromRole: string;
  toTarget: "user" | string;
  verdict: HandoffVerdict;
  summary: string;
  artifacts: ArtifactRecord[];
  deletedFiles?: string[];
  verifiedFacts: VerifiedFact[];
  verificationEvidence?: VerificationEvidenceRecord[];
  openRisks: string[];
  questionsForUser?: string[];
  feedbackForUpstream: string | null;
  observedUsage: UsageSummary | null;
  createdAt: string;
}

export interface ObservedToolCall {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  touchedPaths: string[];
  timestamp: string;
  summary?: string;
  command?: string;
  exitCode?: number | null;
  outputSnippet?: string;
  isBackgroundLaunch?: boolean;
}

export interface RoomEntry {
  id: string;
  side: "left" | "right";
  speaker: string;
  target?: string;
  badge?: string;
  tone?: "info" | "success" | "warning" | "error";
  text: string;
  timestamp: string;
  stageId?: string;
}

export type FlowStageStatus =
  | "running"
  | "ready"
  | "needs_input"
  | "rejected"
  | "blocked"
  | "host_error"
  | "missing_handoff"
  | "failed"
  | "violation"
  | "aborted";

export interface FlowStageTrace {
  stageId: string;
  roleId: string;
  roleName: string;
  round: number;
  status: FlowStageStatus;
  hostError?: string | null;
  modelLabel: string;
  startedAt: string;
  endedAt: string | null;
  activeTool: string | null;
  calls: ObservedToolCall[];
  assistantText: string;
  envelope: HandoffEnvelope | null;
  notes: string[];
}

export type JobStatus = "running" | "completed" | "failed" | "cancelled" | "unknown";
export type SupervisorAction = "continue" | "steer" | "abort";

export interface SupervisorDecision {
  action: SupervisorAction;
  reason: string;
  nextCheckSec: number;
  evidence?: string;
  steerMessage?: string;
}

export interface SupervisorActiveTool {
  name: string;
  elapsedSec: number;
  summary?: string;
}

export interface SupervisorPriorDecision {
  checkNumber: number;
  action: SupervisorAction;
  reason: string;
}

export interface SupervisorPulse {
  targetKind: "job" | "role_session";
  goal: string;
  checkNumber: number;
  elapsedSec: number;
  idleSec: number;
  deltaBytesOrCalls: number;
  deltaSummary: string;
  roleId?: string;
  readOnly?: boolean;
  allowedTools?: string[];
  activeAsyncJobs?: number;
  activeTool?: SupervisorActiveTool | null;
  priorDecisions?: SupervisorPriorDecision[];
}

export interface BackgroundJob {
  jobId: string;
  mandateId: string | null;
  hypothesisId: string | null;
  idempotencyKey?: string | null;
  reused?: boolean;
  command: string;
  cwd: string;
  pid: number;
  pgid: number;
  ownerPid?: number | null;
  processStartToken?: string | null;
  logPath: string;
  exitFilePath: string;
  status: JobStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface FlowUserSteer {
  steerId?: string;
  seq?: number;
  text: string;
  targetRole?: string | null;
  createdAt: string;
  consumedAt?: string | null;
  consumedByStage?: string | null;
}

export type FlowRoomStatus =
  | "idle"
  | "running"
  | "waiting_input"
  | "interrupted"
  | "completed"
  | "blocked"
  | "violation"
  | "failed"
  | "cancelled";

export interface PersistedFlowCheckpoint {
  flowId: string;
  mandateId: string;
  goal: string;
  cwd?: string;
  roleChain: string[];
  status: string;
  currentIndex: number;
  repairRound: number;
  lastHandoffId: string | null;
  maxRepairRounds: number;
  snapshotJson: string;
  updatedAt: string;
  ownerPid?: number | null;
  ownerStartToken?: string | null;
  leaseToken?: string | null;
  stateVersion?: number;
  nextStageSeq?: number;
  lastRejectionSig?: string | null;
  userSteers?: FlowUserSteer[];
}

export interface FlowStepResult {
  stepIndex: number;
  roleId: string;
  round: number;
  envelope: HandoffEnvelope;
}

export interface FlowRunResult {
  status:
    | "completed"
    | "waiting_input"
    | "rejected_max_rounds"
    | "stagnated"
    | "blocked"
    | "failed"
    | "violation"
    | "aborted_by_supervisor"
    | "cancelled";
  cwd?: string;
  steps: FlowStepResult[];
  finalEnvelope: HandoffEnvelope | null;
  reason?: string;
}
