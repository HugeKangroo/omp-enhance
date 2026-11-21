import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  diffSnapshots, findBoundaryViolations, matchesGlobList, normalizeRelPath, snapshotWorkspace,
  type SnapshotEntry,
} from "../core/fs.ts";
import { hasWriteBoundary, isValidExecutionEvidence } from "../core/policy.ts";
import type { EnhanceStore } from "../core/store.ts";
import type {
  ArtifactRecord, HandoffEnvelope, HandoffVerdict, Mandate, ObservedToolCall, RoleSpec,
  UsageSummary, VerifiedFact,
} from "../core/types.ts";

const TEST_GLOBS = ["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"] as const;

export class BoundaryViolationError extends Error {
  readonly violations: string[];
  readonly roleId: string;
  constructor(roleId: string, violations: readonly string[]) {
    const sorted = [...new Set(violations)].sort();
    super(`Role "${roleId}" violated workspace boundaries: ${sorted.join(", ")}`);
    this.name = "BoundaryViolationError";
    this.roleId = roleId;
    this.violations = sorted;
  }
}

export interface CreateHandoffInput {
  store: EnhanceStore;
  role: RoleSpec;
  cwd: string;
  summary: string;
  verdict: HandoffVerdict;
  mandate?: Mandate | null;
  defaultGoal?: string;
  sessionId?: string | null;
  flowId?: string | null;
  parentHandoffId?: string | null;
  toTarget?: string;
  artifactPaths?: readonly string[];
  baselineSnapshot?: ReadonlyMap<string, SnapshotEntry> | null;
  baselineConfigSnapshot?: ReadonlyMap<string, SnapshotEntry> | null;
  afterSnapshot?: ReadonlyMap<string, SnapshotEntry> | null;
  enforceConfigIntegrity?: boolean;
  observedCalls?: readonly ObservedToolCall[];
  verifiedFacts?: readonly VerifiedFact[];
  openRisks?: readonly string[];
  feedbackForUpstream?: string | null;
  observedUsage?: UsageSummary | null;
}

export function createAndVerifyHandoff(input: CreateHandoffInput): HandoffEnvelope {
  const summary = input.summary.trim();
  if (!summary) throw new Error("Handoff summary must be non-empty.");
  const feedbackForUpstream = input.feedbackForUpstream?.trim() || null;
  if (input.verdict === "rejected" && !feedbackForUpstream) {
    throw new Error("A rejected handoff requires concrete reproduction/mismatch feedback in feedbackForUpstream.");
  }
  const observedCalls = input.observedCalls ?? [];
  if (
    input.verdict === "ready" && input.role.exit.requireToolEvidence &&
    !observedCalls.some((call) => isValidExecutionEvidence(call.toolName, call.isError))
  ) {
    throw new Error(
      `Role "${input.role.id}" requires at least one successful non-companion tool execution before a ready handoff.`,
    );
  }

  const after = input.afterSnapshot ?? snapshotWorkspace(input.cwd);
  if (input.baselineSnapshot) {
    const checkIntegrity = input.enforceConfigIntegrity === true || hasWriteBoundary(input.role);
    const violations = findBoundaryViolations({
      cwd: input.cwd, before: input.baselineSnapshot, after, permissions: input.role.permissions,
      ...(checkIntegrity && input.baselineConfigSnapshot ? { beforeIntegrity: input.baselineConfigSnapshot } : {}),
    });
    if (violations.length > 0) throw new BoundaryViolationError(input.role.id, violations);
  }

  const candidates = new Set<string>(), deletedSet = new Set<string>();
  if (input.baselineSnapshot) {
    const diff = diffSnapshots(input.baselineSnapshot, after);
    for (const relPath of [...diff.added, ...diff.modified]) candidates.add(relPath);
    for (const relPath of diff.deleted) deletedSet.add(relPath);
  }
  for (const artifactPath of input.artifactPaths ?? []) {
    const rel = normalizeRelPath(path.relative(input.cwd, path.resolve(input.cwd, artifactPath)));
    if (!rel || rel === ".." || rel.startsWith("../")) continue;
    if (after.has(rel)) candidates.add(rel);
    else if (input.baselineSnapshot?.has(rel)) deletedSet.add(rel);
  }

  const artifacts: ArtifactRecord[] = [...candidates]
    .filter((relPath) => after.has(relPath))
    .map((relPath): ArtifactRecord => {
      const entry = after.get(relPath)!;
      return {
        path: relPath, sha256: entry.sha256, byteSize: entry.byteSize,
        role: matchesGlobList(relPath, TEST_GLOBS) ? "test" : "changed",
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const deletedFiles = [...deletedSet].sort();

  const existingMandate = input.mandate ?? input.store.getActiveMandate({
    ...(input.flowId ? { flowId: input.flowId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });

  const allowedEvidence = new Set<string>();
  const validCallIds: string[] = [];
  for (const call of observedCalls) {
    if (isValidExecutionEvidence(call.toolName, call.isError)) {
      allowedEvidence.add(call.toolCallId);
      validCallIds.push(call.toolCallId);
    }
  }
  const hasValidTool = validCallIds.length > 0;
  const priorMandateArtifacts = existingMandate ? input.store.listArtifacts(existingMandate.id) : [];
  for (const artifact of [...artifacts, ...priorMandateArtifacts]) {
    const live = after.get(artifact.path);
    if (live && live.sha256 === artifact.sha256) {
      allowedEvidence.add(artifact.sha256);
      allowedEvidence.add(artifact.path);
    }
  }

  const verifiedFacts = [...(input.verifiedFacts ?? [])];
  for (const fact of verifiedFacts) {
    const evidenceRef = fact.evidenceRef?.trim();
    let verified = Boolean(evidenceRef && allowedEvidence.has(evidenceRef));
    if (!verified && evidenceRef) {
      const stripped = evidenceRef.replace(/(?::\d+(?:-\d+)?(?::\d+)?|#L\d+(?:-L?\d+)?)$/i, "");
      if (stripped) {
        const normRel = normalizeRelPath(path.relative(input.cwd, path.resolve(input.cwd, stripped)));
        if (normRel && normRel !== ".." && !normRel.startsWith("../")) {
          verified = allowedEvidence.has(normRel) || (hasValidTool && after.has(normRel));
        }
      }
    }
    if (!verified) {
      const hint = validCallIds.length > 0
        ? `valid toolCallIds: ${validCallIds.join(", ")}, or workspace path[:line]`
        : "run a verification tool first and cite its toolCallId, artifact sha256, or workspace path[:line]";
      throw new Error(`Unverified verifiedFacts evidenceRef "${fact.evidenceRef}" for claim "${fact.claim}" (${hint}).`);
    }
  }

  const mandate = existingMandate ?? input.store.upsertMandate({
    goal: input.defaultGoal?.trim() || summary,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.flowId ? { flowId: input.flowId } : {}),
  });

  const envelope: HandoffEnvelope = {
    id: randomUUID(), mandateId: mandate.id, mandateRev: mandate.rev,
    parentHandoffId: input.parentHandoffId ?? null, fromRole: input.role.id,
    toTarget: input.toTarget ?? "user", verdict: input.verdict, summary, artifacts,
    ...(deletedFiles.length > 0 ? { deletedFiles } : {}), verifiedFacts,
    openRisks: [...(input.openRisks ?? [])], feedbackForUpstream,
    observedUsage: input.observedUsage ?? null, createdAt: new Date().toISOString(),
  };
  input.store.recordArtifacts(mandate.id, artifacts);
  input.store.saveHandoff(envelope);
  return envelope;
}
