import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  diffSnapshots, findBoundaryViolations, matchesGlobList, normalizeRelPath, snapshotWorkspace,
  type SnapshotEntry,
} from "../core/fs.ts";
import { hasWriteBoundary, isRoleReadOnly, isValidExecutionEvidence } from "../core/policy.ts";
import type { EnhanceStore } from "../core/store.ts";
import type {
  ArtifactRecord, HandoffEnvelope, HandoffVerdict, Mandate, ObservedToolCall, RoleSpec,
  UsageSummary, VerifiedFact,
} from "../core/types.ts";

const TEST_GLOBS = ["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"] as const;
const MAX_LINE_CHECK_BYTES = 32 * 1024 * 1024;

function stripTrailingEvidenceNotes(rawRef: string): string {
  return rawRef
    .trim()
    .replace(/\s+\([^)]*\)\s*$/, "")
    .replace(/\s+(?:—|--)\s+[\s\S]*$/, "")
    .replace(/\s*;\s+[\s\S]*$/, "")
    .trim();
}

function extractEvidenceLineRange(rawRef: string): { start: number; end: number; malformed?: boolean } | null {
  const cleaned = stripTrailingEvidenceNotes(rawRef).replace(/:(?:raw|summary)$/i, "").trim();
  const hashMatch = /#L(\d+)(?:-L?(\d+))?$/i.exec(cleaned);
  if (hashMatch) {
    const start = Number(hashMatch[1]), end = hashMatch[2] ? Number(hashMatch[2]) : start;
    return { start, end, malformed: start < 1 || end < start };
  }
  const colonMatch = /:(\d+)(?:-(\d+))?(?::\d+)?$/.exec(cleaned);
  if (colonMatch) {
    const start = Number(colonMatch[1]), end = colonMatch[2] ? Number(colonMatch[2]) : start;
    return { start, end, malformed: start < 1 || end < start };
  }
  return null;
}

function stripEvidenceSelectorAndNotes(rawRef: string): string {
  let s = stripTrailingEvidenceNotes(rawRef);
  let prev = "";
  while (s && s !== prev) {
    prev = s;
    s = s
      .replace(/:(?:raw|summary)$/i, "")
      .replace(/#L\d+(?:-L?\d+)?$/i, "")
      .replace(/:\d+(?:-\d+)?(?::\d+)?$/i, "")
      .trim();
  }
  return s;
}

function countFileLines(filePath: string): number {
  const raw = readFileSync(filePath, "utf8");
  if (raw.length === 0) return 0;
  const trimmedNewline = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  return trimmedNewline.replace(/\r/g, "").split("\n").length;
}

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
  questionsForUser?: readonly string[];
  feedbackForUpstream?: string | null;
  observedUsage?: UsageSummary | null;
  isConsultation?: boolean;
}

export function createAndVerifyHandoff(input: CreateHandoffInput): HandoffEnvelope {
  const summary = input.summary.trim();
  if (!summary) throw new Error("Handoff summary must be non-empty.");
  const feedbackForUpstream = input.feedbackForUpstream?.trim() || null;
  if (input.verdict === "rejected" && !feedbackForUpstream) {
    throw new Error("A rejected handoff requires concrete reproduction/mismatch feedback in feedbackForUpstream.");
  }
  const rawQuestions = (input.questionsForUser ?? []).map((q) => q.trim()).filter(Boolean);
  const questionsForUser = rawQuestions.length > 0 ? rawQuestions : (input.verdict === "needs_input" ? [summary] : []);

  const observedCalls = input.observedCalls ?? [];
  if (input.verdict === "ready") {
    if (
      input.role.exit.requireToolEvidence &&
      !observedCalls.some((call) => isValidExecutionEvidence(call.toolName, call.isError))
    ) {
      throw new Error(
        `Role "${input.role.id}" requires at least one successful non-companion tool execution before a ready handoff.`,
      );
    }
    const reqTools = !input.isConsultation ? (input.role.exit.requiredTools ?? []) : [];
    if (reqTools.length > 0) {
      const okTools = new Set(observedCalls.filter((c) => !c.isError).map((c) => c.toolName));
      const missingTools = reqTools.filter((req) => !okTools.has(req) && !(req === "bash" && okTools.has("enhance_job")));
      if (missingTools.length > 0) {
        throw new Error(
          `Role "${input.role.id}" cannot submit verdict="ready" without executing required verification tool(s): ${missingTools.join(", ")}.`,
        );
      }
    }
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

  const afterPaths = [...after.keys()];
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

  if (input.verdict === "ready" && !input.isConsultation && (input.role.exit.requiredArtifacts?.length ?? 0) > 0) {
    const missingPatterns: string[] = [];
    for (const pattern of input.role.exit.requiredArtifacts!) {
      const matched = afterPaths.filter((p) => matchesGlobList(p, [pattern]));
      if (matched.length === 0) missingPatterns.push(pattern);
      else for (const hit of matched) candidates.add(hit);
    }
    if (missingPatterns.length > 0) {
      throw new Error(
        `Role "${input.role.id}" cannot submit verdict="ready" without required deliverable artifact(s): ${missingPatterns.join(", ")}.`,
      );
    }
  }

  const artifacts: ArtifactRecord[] = [...candidates]
    .filter((relPath) => after.has(relPath))
    .map((relPath): ArtifactRecord => {
      const entry = after.get(relPath)!;
      const beforeSha = input.baselineSnapshot?.get(relPath)?.sha256;
      const unchanged = beforeSha !== undefined ? beforeSha === entry.sha256 : isRoleReadOnly(input.role);
      const digestKind = entry.digestKind === "sha256" || entry.digestKind === "stat_fingerprint" ? entry.digestKind : undefined;
      return {
        path: relPath, sha256: entry.sha256, byteSize: entry.byteSize,
        role: unchanged ? "inspected" : (matchesGlobList(relPath, TEST_GLOBS) ? "test" : "changed"),
        ...(digestKind ? { digestKind } : {}),
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

  const resolvedCwd = path.resolve(input.cwd);
  const verifiedFacts = [...(input.verifiedFacts ?? [])];
  const lineCountCache = new Map<string, number>();
  for (const fact of verifiedFacts) {
    const evidenceRef = fact.evidenceRef?.trim();
    let verified = Boolean(evidenceRef && allowedEvidence.has(evidenceRef));
    if (!verified && evidenceRef) {
      const lineRange = extractEvidenceLineRange(evidenceRef);
      if (lineRange?.malformed) {
        throw new Error(`Invalid verifiedFacts line range "${fact.evidenceRef}" for claim "${fact.claim}".`);
      }
      const stripped = stripEvidenceSelectorAndNotes(evidenceRef);
      if (stripped) {
        const absTarget = path.resolve(resolvedCwd, stripped);
        if (absTarget === resolvedCwd) {
          verified = !lineRange && hasValidTool && after.size > 0;
        } else {
          const normRel = normalizeRelPath(path.relative(resolvedCwd, absTarget));
          if (
            normRel &&
            normRel !== ".." &&
            !normRel.startsWith("../") &&
            normRel !== ".omp-enhance" &&
            !normRel.startsWith(".omp-enhance/")
          ) {
            const fileEntry = after.get(normRel);
            const fileAllowed = allowedEvidence.has(normRel) || (hasValidTool && fileEntry !== undefined);
            if (fileAllowed && lineRange && fileEntry && fileEntry.byteSize <= MAX_LINE_CHECK_BYTES && existsSync(absTarget)) {
              let totalLines = lineCountCache.get(absTarget);
              if (totalLines === undefined) {
                totalLines = countFileLines(absTarget);
                lineCountCache.set(absTarget, totalLines);
              }
              if (lineRange.start < 1 || lineRange.end > totalLines) {
                const span = lineRange.end !== lineRange.start ? `${lineRange.start}-${lineRange.end}` : `${lineRange.start}`;
                throw new Error(
                  `Out-of-bounds verifiedFacts line citation "${fact.evidenceRef}" for claim "${fact.claim}": line ${span} exceeds "${normRel}" (${totalLines} line${totalLines === 1 ? "" : "s"}).`,
                );
              }
            }
            const dirPrefix = `${normRel}/`;
            verified = fileAllowed || (!lineRange && hasValidTool && afterPaths.some((p) => p.startsWith(dirPrefix)));
          }
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
    openRisks: [...(input.openRisks ?? [])],
    ...(questionsForUser.length > 0 ? { questionsForUser } : {}),
    feedbackForUpstream, observedUsage: input.observedUsage ?? null, createdAt: new Date().toISOString(),
  };
  input.store.recordArtifacts(mandate.id, artifacts);
  input.store.saveHandoff(envelope);
  return envelope;
}
