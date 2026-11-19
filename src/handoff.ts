import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ArtifactRecord, HandoffEnvelope, HandoffVerdict, Mandate, ObservedToolCall, RoleSpec, UsageSummary, VerifiedFact,
} from "./types.ts";
import {
  diffSnapshots, EnhanceStore, matchesGlobList, snapshotWorkspace, type SnapshotEntry,
} from "./store.ts";
import { isCompanionTool } from "./session-tracker.ts";

const TEST_GLOBS = ["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"] as const;

export interface CreateHandoffInput {
  store: EnhanceStore;
  role: RoleSpec;
  cwd: string;
  summary: string;
  verdict: HandoffVerdict;
  mandate?: Mandate | null;
  defaultGoal?: string;
  parentHandoffId?: string | null;
  toTarget?: string;
  artifactPaths?: readonly string[];
  baselineSnapshot?: ReadonlyMap<string, SnapshotEntry> | null;
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
    !observedCalls.some((call) => !call.isError && !isCompanionTool(call.toolName))
  ) {
    throw new Error(`Role "${input.role.id}" requires at least one successful non-companion tool execution before a ready handoff.`);
  }

  const mandate = input.mandate ?? input.store.getActiveMandate() ??
    input.store.upsertMandate({ goal: input.defaultGoal?.trim() || summary });
  const after = snapshotWorkspace(input.cwd);
  const candidates = new Set<string>();
  for (const artifactPath of input.artifactPaths ?? []) {
    candidates.add(path.relative(input.cwd, path.resolve(input.cwd, artifactPath)).replaceAll("\\", "/"));
  }
  if (input.baselineSnapshot) {
    const diff = diffSnapshots(input.baselineSnapshot, after);
    for (const relPath of [...diff.added, ...diff.modified]) candidates.add(relPath);
  }
  const artifacts: ArtifactRecord[] = [...candidates]
    .filter((relPath) => after.has(relPath))
    .map((relPath): ArtifactRecord => {
      const entry = after.get(relPath)!;
      return {
        path: relPath,
        sha256: entry.sha256,
        byteSize: entry.byteSize,
        role: matchesGlobList(relPath, TEST_GLOBS) ? "test" : "changed",
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  const allowedEvidence = new Set<string>();
  for (const call of observedCalls) allowedEvidence.add(call.toolCallId);
  for (const artifact of [...artifacts, ...input.store.listArtifacts(mandate.id)]) {
    allowedEvidence.add(artifact.sha256);
    allowedEvidence.add(artifact.path);
  }
  const verifiedFacts = [...(input.verifiedFacts ?? [])];
  for (const fact of verifiedFacts) {
    const evidenceRef = fact.evidenceRef?.trim();
    if (!evidenceRef || !allowedEvidence.has(evidenceRef)) {
      throw new Error(`Unverified verifiedFacts evidenceRef "${fact.evidenceRef}" for claim "${fact.claim}".`);
    }
  }

  const envelope: HandoffEnvelope = {
    id: randomUUID(),
    mandateId: mandate.id,
    mandateRev: mandate.rev,
    parentHandoffId: input.parentHandoffId ?? null,
    fromRole: input.role.id,
    toTarget: input.toTarget ?? "user",
    verdict: input.verdict,
    summary,
    artifacts,
    verifiedFacts,
    openRisks: [...(input.openRisks ?? [])],
    feedbackForUpstream,
    observedUsage: input.observedUsage ?? null,
    createdAt: new Date().toISOString(),
  };
  input.store.recordArtifacts(mandate.id, artifacts);
  input.store.saveHandoff(envelope);
  return envelope;
}
