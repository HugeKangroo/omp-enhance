import { readFileSync } from "node:fs";
import { computeSnapshotFingerprint, type SnapshotEntry } from "../core/fs.ts";
import { WRITE_TOOLS } from "../core/policy.ts";
import type { EnhanceStore } from "../core/store.ts";
import type { ObservedToolCall, VerificationEvidenceRecord } from "../core/types.ts";
export { verifyAlgoDeliverables } from "./algo-evidence.ts";

export const MAX_LINE_CHECK_BYTES = 32 * 1024 * 1024;

const SEGMENT_ENV_PREFIX_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*/;
const SEGMENT_WRAPPER_PREFIX_RE = /^(?:(?:time|nohup)\s+|timeout\s+(?:-\S+\s+)*\S+\s+|env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)*/;
const NON_TEST_TRIVIAL_CMD_RE = /^(?:echo|printf|cat|ls|pwd|true|false|sleep|cd|export|unset|whoami|date|uname)\b/i;
const SEGMENT_TEST_RUNNER_RE = new RegExp(
  [
    "^bun\\s+(?:test\\b|x\\s+(?:tsc|vitest|jest|playwright|mocha)\\b|run\\s+(?:test|check|typecheck|verify)[\\w:-]*\\b)",
    "^(?:npm|pnpm|yarn)\\s+(?:test\\b|run\\s+(?:test|check|typecheck|verify)[\\w:-]*\\b)",
    "^(?:npx\\s+)?(?:vitest|jest|mocha|ava|tap|tsc|ctest|rspec|phpunit)\\b",
    "^(?:npx\\s+)?(?:playwright\\s+test|cypress\\s+run)\\b",
    "^(?:pytest|py\\.test|tox|nox)\\b",
    "^python3?\\s+-m\\s+(?:pytest|unittest)\\b",
    "^node\\s+--test\\b",
    "^go\\s+test\\b",
    "^cargo\\s+(?:test|nextest|check)\\b",
    "^bundle\\s+exec\\s+rspec\\b",
    "^mvn\\s+(?:test|verify)\\b",
    "^gradle\\s+(?:test|check)\\b",
    "^dotnet\\s+test\\b",
    "^zig\\s+build\\s+test\\b",
    "^make\\s+(?:test|check)\\b",
  ].join("|"),
  "i",
);

const TEST_OUTPUT_FAILURE_RE = /(?:^|\n)\s*(?:\(fail\)\s|FAIL(?:ED)?\b[:\s])|\b[1-9]\d*\s+fail(?:ed|ures?)?\b/i;
const SHELL_PIPEFAIL_RE = /\bset\s+(?:-[A-Za-z]*o\s+pipefail|-o\s+pipefail)\b/;
const SHELL_ERREXIT_RE = /\bset\s+(?:-[A-Za-z]*e[A-Za-z]*\b|-o\s+errexit\b)/;

function isTestRunnerSegment(rawSeg: string): boolean {
  const seg = rawSeg
    .trim()
    .replace(/^[()]+|[()]+$/g, "")
    .trim()
    .replace(SEGMENT_ENV_PREFIX_RE, "")
    .replace(SEGMENT_WRAPPER_PREFIX_RE, "")
    .trim();
  return Boolean(seg && !NON_TEST_TRIVIAL_CMD_RE.test(seg) && SEGMENT_TEST_RUNNER_RE.test(seg));
}

const SHELL_CONDITIONAL_RE = /\b(?:if|then|elif|else|fi|while|until|case)\b/;
const SHELL_BG_OP_RE = /(?:^|[^&>])&(?!&|>)/;

function splitShellStatements(rawCommand: string): Array<{ prevOp: string | null; stmt: string; nextOp: string | null }> {
  const tokens = rawCommand.split(/(\&\&|\|\||;|\n)/);
  const out: Array<{ prevOp: string | null; stmt: string; nextOp: string | null }> = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const stmt = (tokens[i] ?? "").trim();
    const prevOp = i > 0 ? (tokens[i - 1] ?? null) : null;
    const nextOp = tokens[i + 1] ?? null;
    if (stmt) out.push({ prevOp, stmt, nextOp });
  }
  return out;
}

function isVerifiableShellStage(rawCommand: string, matchStage: (stage: string) => boolean): boolean {
  const trimmed = rawCommand.trim();
  if (!trimmed || SHELL_CONDITIONAL_RE.test(trimmed) || SHELL_BG_OP_RE.test(trimmed)) return false;
  const statements = splitShellStatements(trimmed);
  let hasPipefail = false;
  let hasErrexit = false;
  for (let i = 0; i < statements.length; i++) {
    const { prevOp, stmt, nextOp } = statements[i]!;
    if (SHELL_PIPEFAIL_RE.test(stmt)) hasPipefail = true;
    if (SHELL_ERREXIT_RE.test(stmt)) hasErrexit = true;
    const pipeStages = stmt.split("|");
    const hitIdx = pipeStages.findIndex(matchStage);
    if (hitIdx < 0) continue;
    // Left of an unguarded pipe masks exit code (`bun test | tee log`).
    if (hitIdx < pipeStages.length - 1 && !hasPipefail) continue;
    // Right of `||` can be skipped; left of `||` masks failures.
    if (prevOp === "||" || nextOp === "||") continue;
    let maskedLater = false;
    for (let j = i; j < statements.length; j++) {
      const op = statements[j]!.nextOp;
      if (op === "||") { maskedLater = true; break; }
      if ((op === ";" || op === "\n") && j < statements.length - 1 && !hasErrexit) { maskedLater = true; break; }
    }
    if (maskedLater) continue;
    return true;
  }
  return false;
}

export function isRecognizedTestCommand(rawCommand: string): boolean {
  return isVerifiableShellStage(rawCommand, isTestRunnerSegment);
}

export function hasTestFailureOutput(output?: string | null): boolean {
  return Boolean(output && TEST_OUTPUT_FAILURE_RE.test(output));
}

function normalizeTestCmdKey(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

function stripSegmentWrappers(rawSeg: string): string {
  return rawSeg
    .trim()
    .replace(/^[()]+|[()]+$/g, "")
    .trim()
    .replace(SEGMENT_ENV_PREFIX_RE, "")
    .replace(SEGMENT_WRAPPER_PREFIX_RE, "")
    .trim();
}

export function extractUnderlyingTestCmd(rawCommand: string): string {
  const segments = rawCommand
    .split(/(?:&&|\|\||;|\n|\|)/)
    .map(stripSegmentWrappers)
    .filter((s) => s.length > 0 && isTestRunnerSegment(s));
  return segments.length > 0 ? normalizeTestCmdKey(segments.join(" && ")) : normalizeTestCmdKey(rawCommand);
}

function resolveCallShellInfo(call: ObservedToolCall, store: EnhanceStore): { cmd: string; statusOk: boolean; exitCode: number } | null {
  if (call.isBackgroundLaunch || (call.toolName !== "bash" && call.toolName !== "enhance_job")) return null;
  let cmd = call.command?.trim() ?? "";
  let statusOk = !call.isError && (call.exitCode === undefined || call.exitCode === 0);
  let ec = typeof call.exitCode === "number" ? call.exitCode : 0;
  if (call.toolName === "enhance_job" && call.outputSnippet?.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(call.outputSnippet) as {
        status?: unknown; exitCode?: unknown;
        job?: { jobId?: unknown; command?: unknown; status?: unknown; exitCode?: unknown };
      };
      const st = parsed.status ?? parsed.job?.status;
      const rawEc = parsed.exitCode ?? parsed.job?.exitCode;
      if (typeof rawEc === "number") ec = rawEc;
      if ((typeof st === "string" && st !== "completed") || ec !== 0) statusOk = false;
      if (!cmd && typeof parsed.job?.command === "string") cmd = parsed.job.command.trim();
      if (!cmd && typeof parsed.job?.jobId === "string") {
        const job = store.getJob(parsed.job.jobId);
        if (job) {
          cmd = job.command.trim();
          if (job.status !== "completed" || job.exitCode !== 0) { statusOk = false; ec = job.exitCode ?? 1; }
        }
      }
    } catch {}
  }
  return cmd ? { cmd, statusOk, exitCode: ec } : null;
}

function classifyTestCall(
  call: ObservedToolCall,
  store: EnhanceStore,
  requiredCheckKeys?: ReadonlySet<string>,
): { kind: "passed" | "failed" | "unverifiable" | "none"; command?: string; key?: string; exitCode?: number; outputShowedFailure?: boolean } {
  const info = resolveCallShellInfo(call, store);
  if (!info) return { kind: "none" };
  const { cmd, statusOk, exitCode } = info;
  const recognized = isRecognizedTestCommand(cmd);
  const splitSegs = cmd.split(/(?:&&|\|\||;|\n|\|)/).map(stripSegmentWrappers);
  const mentionsRunner = recognized || splitSegs.some(isTestRunnerSegment);
  const underlyingKey = mentionsRunner ? extractUnderlyingTestCmd(cmd) : normalizeTestCmdKey(cmd);

  let matchedReqKey: string | undefined;
  let reqVerifiable = false;
  if (requiredCheckKeys?.size) {
    matchedReqKey = requiredCheckKeys.has(underlyingKey)
      ? underlyingKey
      : splitSegs.map(normalizeTestCmdKey).find((seg) => requiredCheckKeys.has(seg));
    if (matchedReqKey) {
      reqVerifiable =
        (matchedReqKey === underlyingKey && recognized) ||
        isVerifiableShellStage(cmd, (s) => normalizeTestCmdKey(stripSegmentWrappers(s)) === matchedReqKey);
    }
  }
  if (!mentionsRunner && !matchedReqKey) return { kind: "none" };
  const outputShowedFailure = hasTestFailureOutput(call.outputSnippet);
  const key = matchedReqKey ?? underlyingKey;
  if (mentionsRunner ? !recognized : !reqVerifiable) {
    return { kind: "unverifiable", command: cmd, key, exitCode: outputShowedFailure ? 1 : exitCode, outputShowedFailure };
  }
  if (!statusOk || outputShowedFailure) {
    return { kind: "failed", command: cmd, key, exitCode: exitCode !== 0 ? exitCode : 1, outputShowedFailure };
  }
  return { kind: "passed", command: cmd, key, exitCode: 0 };
}

export function verifyQaTestExecution(
  roleId: string,
  observedCalls: readonly ObservedToolCall[],
  after: ReadonlyMap<string, SnapshotEntry>,
  store: EnhanceStore,
  stageId?: string,
  requiredChecks?: readonly string[],
): VerificationEvidenceRecord[] {
  const currentTreeFp = computeSnapshotFingerprint(after);
  let lastMutationIdx = -1;
  observedCalls.forEach((c, i) => {
    if (!c.isError && (WRITE_TOOLS[c.toolName] || c.touchedPaths.length > 0)) lastMutationIdx = i;
  });
  const reqEntries = (requiredChecks ?? [])
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => ({ raw, key: extractUnderlyingTestCmd(raw) }));
  const requiredCheckKeys = new Set(reqEntries.map((r) => r.key));

  let sawPreMutationTest = false;
  let sawStaleTest = false;
  let sawUnverifiableTest = false;
  const latestByCmd = new Map<
    string,
    { status: "passed" | "failed" | "unverifiable"; command: string; exitCode: number; outputShowedFailure?: boolean }
  >();
  const evidenceRecords: VerificationEvidenceRecord[] = [];
  let passedOnCurrentTree = 0;

  const toRecord = (c: ObservedToolCall, command: string, exitCode: number): VerificationEvidenceRecord => ({
    command,
    exitCode,
    outputSnippet: c.outputSnippet ?? c.summary ?? "",
    testedTreeFingerprint: c.testedTreeFingerprint ?? currentTreeFp,
    toolCallId: c.toolCallId,
    ...(c.stageId ?? stageId ? { stageId: c.stageId ?? stageId } : {}),
  });

  observedCalls.forEach((c, i) => {
    const cls = classifyTestCall(c, store, requiredCheckKeys);
    if (cls.kind === "none") return;
    const sameStage = !stageId || !c.stageId || c.stageId === stageId;
    const cmd = cls.command!;
    const key = cls.key ?? normalizeTestCmdKey(cmd);

    if (cls.kind === "unverifiable") {
      sawUnverifiableTest = true;
      if (sameStage) {
        evidenceRecords.push(toRecord(c, cmd, cls.exitCode ?? 1));
        latestByCmd.set(key, {
          status: "unverifiable",
          command: cmd,
          exitCode: cls.exitCode ?? 1,
          outputShowedFailure: cls.outputShowedFailure,
        });
      }
      return;
    }
    if (cls.kind === "failed") {
      if (sameStage) {
        evidenceRecords.push(toRecord(c, cmd, cls.exitCode ?? 1));
        latestByCmd.set(key, { status: "failed", command: cmd, exitCode: cls.exitCode ?? 1 });
      }
      return;
    }
    if (i <= lastMutationIdx) {
      sawPreMutationTest = true;
      return;
    }
    if (!sameStage || (c.testedTreeFingerprint && c.testedTreeFingerprint !== currentTreeFp)) {
      sawStaleTest = true;
      return;
    }
    evidenceRecords.push(toRecord(c, cmd, 0));
    latestByCmd.set(key, { status: "passed", command: cmd, exitCode: 0 });
    passedOnCurrentTree += 1;
  });

  const stillBlocking = [...latestByCmd.values()].filter((v) => v.status !== "passed");
  if (stillBlocking.length > 0) {
    const details = stillBlocking
      .map((f) =>
        f.status === "unverifiable"
          ? `"${f.command}" (${f.outputShowedFailure ? "masked failure / unverifiable pipe" : "masked or unverifiable exit status"})`
          : `"${f.command}" (exit=${f.exitCode})`,
      )
      .join(", ");
    throw new Error(
      `Role "${roleId}" cannot submit verdict="ready": failing or unverifiable test command(s) were not re-run cleanly to pass: ${details}.`,
    );
  }

  if (reqEntries.length > 0) {
    const unmet = reqEntries.filter((req) => latestByCmd.get(req.key)?.status !== "passed");
    if (unmet.length > 0) {
      throw new Error(
        `Role "${roleId}" cannot submit verdict="ready": required check(s) were not verified on the current workspace state: ${unmet.map((u) => `"${u.raw}"`).join(", ")}.`,
      );
    }
  }

  if (passedOnCurrentTree === 0) {
    if (sawUnverifiableTest) {
      throw new Error(
        `Role "${roleId}" cannot submit verdict="ready": test command exit status was masked or unverifiable (avoid piping tests into tee/tail without "set -o pipefail", avoid "|| true" or trailing commands, and ensure zero failing tests).`,
      );
    }
    if (sawPreMutationTest) {
      throw new Error(`Role "${roleId}" modified files after the last test execution; re-run tests against the final workspace state before submitting verdict="ready".`);
    }
    if (sawStaleTest) {
      throw new Error(`Role "${roleId}" workspace changed after the last verified test execution (or only prior-stage tests were observed); re-run tests against the current workspace state before submitting verdict="ready".`);
    }
    throw new Error(`Role "${roleId}" cannot submit verdict="ready" without a completed zero-exit test command in this turn (e.g. bun test, pytest, npm test, vitest, go test, cargo test; background launches and non-test shell commands like pwd/ls do not qualify).`);
  }
  return evidenceRecords;
}

function stripTrailingEvidenceNotes(rawRef: string): string {
  return rawRef.trim().replace(/\s+\([^)]*\)\s*$/, "").replace(/\s+(?:—|--)\s+[\s\S]*$/, "").replace(/\s*;\s+[\s\S]*$/, "").trim();
}

export function extractEvidenceLineRange(rawRef: string): { start: number; end: number; malformed?: boolean } | null {
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

export function stripEvidenceSelectorAndNotes(rawRef: string): string {
  let s = stripTrailingEvidenceNotes(rawRef), prev = "";
  while (s && s !== prev) {
    prev = s;
    s = s.replace(/:(?:raw|summary)$/i, "").replace(/#L\d+(?:-L?\d+)?$/i, "").replace(/:\d+(?:-\d+)?(?::\d+)?$/i, "").trim();
  }
  return s;
}

export function countFileLines(filePath: string): number {
  const raw = readFileSync(filePath, "utf8");
  if (raw.length === 0) return 0;
  const trimmedNewline = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  return trimmedNewline.replace(/\r/g, "").split("\n").length;
}
