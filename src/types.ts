/**
 * Core data contracts for omp-enhance.
 *
 * Unifies single-agent daily work (N = 1) and multi-agent collaboration (N > 1)
 * under two orthogonal primitives:
 *   1. RoleSpec (M_r): Declarative YAML internal methodology & capability bounds.
 *   2. HandoffEnvelope (H): Markov-isolated inter-agent/user delivery record.
 */

export type RoleSource = "project" | "global" | "builtin";
export type RoleThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface EnhanceSettings {
  /** Role ID activated on session start; null when configured to "off". */
  defaultRole: string | null;
  /** Whether to display active role & model badge in the OMP status bar. */
  showStatusBar: boolean;
  /** Whether runtime periodic supervisor monitoring is enabled. */
  supervisorEnabled: boolean;
  /** Default model/role alias used by supervisor (defaults to "@advisor"). */
  supervisorModel: string;
  /** Default thinking level used by supervisor (defaults to "off"). */
  supervisorThinking: RoleThinkingLevel;
  /** Initial delay in seconds before the first supervisor check (5..600). */
  supervisorInitialDelaySec: number;
  /** Default maximum automatic repair rounds in /flow (0..10). */
  flowMaxRepairRounds: number;
}

export interface RolePermissions {
  /** Allowed built-in tool names; companion `enhance_*` tools stay available. */
  tools?: string[];
  /** Relative path globs allowed for write/edit/apply_patch; [] means read-only. */
  writable?: string[];
  /** Relative path globs whose SHA-256 must remain unchanged across execution. */
  protected?: string[];
}
export interface RoleExitSpec {
  /** When true, a `ready` verdict requires >= 1 non-error tool call in the turn. */
  requireToolEvidence: boolean;
  /** Explicit checklist items verified before handoff completion. */
  criteria: string[];
}
export interface RoleSpec {
  id: string;
  name: string;
  description: string;
  /** Optional bound model: "inherit", "@advisor", "@smol", "@slow", or "provider/model-id". */
  model?: string;
  /** Optional thinking effort override for this role. */
  thinking?: RoleThinkingLevel;
  stance: string;
  method: string[];
  permissions: RolePermissions;
  exit: RoleExitSpec;
  source: RoleSource;
  filePath: string;
  contentSha256: string;
}
export interface Mandate {
  id: string;
  rev: number;
  goal: string;
  constraints: string[];
  acceptance: string[];
  status: "active" | "completed" | "archived";
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
  /** Required (non-empty) when kind === "fact". */
  evidenceRef: string | null;
  verificationPlan: string | null;
  status: EpistemicStatus;
  createdAt: string;
}
export type ArtifactRole = "input" | "changed" | "test" | "report" | "metrics";

export interface ArtifactRecord {
  path: string;
  sha256: string;
  byteSize: number;
  role: ArtifactRole;
}
export interface VerifiedFact {
  claim: string;
  /** Must match an observed toolCallId in this turn or a recorded artifact sha256/path. */
  evidenceRef: string;
}
export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
export type HandoffVerdict = "ready" | "rejected" | "blocked";

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
  verifiedFacts: VerifiedFact[];
  openRisks: string[];
  /** Required with concrete repro/mismatch details when verdict === "rejected". */
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
}
export type JobStatus = "running" | "completed" | "failed" | "cancelled" | "unknown";

export type SupervisorAction = "continue" | "steer" | "abort";

export interface SupervisorDecision {
  action: SupervisorAction;
  reason: string;
  /** Next check interval in seconds (clamped to [5, 600]). */
  nextCheckSec: number;
  evidence?: string;
  steerMessage?: string;
}
export interface SupervisorPulse {
  targetKind: "job" | "role_session";
  goal: string;
  checkNumber: number;
  elapsedSec: number;
  idleSec: number;
  deltaBytesOrCalls: number;
  deltaSummary: string;
}
export interface BackgroundJob {
  jobId: string;
  mandateId: string | null;
  hypothesisId: string | null;
  command: string;
  cwd: string;
  pid: number;
  pgid: number;
  logPath: string;
  exitFilePath: string;
  status: JobStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}
export interface FlowStepResult {
  stepIndex: number;
  roleId: string;
  round: number;
  envelope: HandoffEnvelope;
}
export interface FlowRunResult {
  status: "completed" | "rejected_max_rounds" | "stagnated" | "blocked" | "violation" | "aborted_by_supervisor";
  steps: FlowStepResult[];
  finalEnvelope: HandoffEnvelope | null;
  reason?: string;
}
