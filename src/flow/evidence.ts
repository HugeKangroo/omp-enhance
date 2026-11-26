import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { computeSnapshotFingerprint, matchesGlobList, normalizeRelPath, type SnapshotEntry } from "../core/fs.ts";
import { WRITE_TOOLS } from "../core/policy.ts";
import type { EnhanceStore } from "../core/store.ts";
import type { ObservedToolCall, VerificationEvidenceRecord } from "../core/types.ts";

export const MAX_LINE_CHECK_BYTES = 32 * 1024 * 1024;
const MIN_ALGO_REPORT_NON_WS_CHARS = 40;
const METRICS_NON_METRIC_NUM_KEYS = new Set(["version", "schemaVersion", "schema_version"]);

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

function splitShellStatements(rawCommand: string): Array<{ stmt: string; nextOp: string | null }> {
  const tokens = rawCommand.split(/(\&\&|\|\||;|\n)/);
  const out: Array<{ stmt: string; nextOp: string | null }> = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const stmt = (tokens[i] ?? "").trim();
    const nextOp = tokens[i + 1] ?? null;
    if (stmt) out.push({ stmt, nextOp });
  }
  return out;
}

export function isRecognizedTestCommand(rawCommand: string): boolean {
  const trimmed = rawCommand.trim();
  if (!trimmed) return false;
  const hasPipefail = SHELL_PIPEFAIL_RE.test(trimmed);
  const hasErrexit = SHELL_ERREXIT_RE.test(trimmed);
  const statements = splitShellStatements(trimmed);
  for (let i = 0; i < statements.length; i++) {
    const { stmt, nextOp } = statements[i]!;
    const pipeStages = stmt.split("|");
    const testStageIdx = pipeStages.findIndex((s) => isTestRunnerSegment(s));
    if (testStageIdx < 0) continue;
    // Left side of an unguarded pipe masks the test runner's exit code (e.g. `bun test | tee log`)
    if (testStageIdx < pipeStages.length - 1 && !hasPipefail) continue;
    // `|| ...` masks test failure; `; <later>` without `set -e` replaces exit code with the trailing command
    if (nextOp === "||") continue;
    if ((nextOp === ";" || nextOp === "\n") && i < statements.length - 1 && !hasErrexit) continue;
    return true;
  }
  return false;
}

export function hasTestFailureOutput(output?: string | null): boolean {
  return Boolean(output && TEST_OUTPUT_FAILURE_RE.test(output));
}

function resolveTestCallCommand(call: ObservedToolCall, store: EnhanceStore): { command: string | null; unverifiable: boolean } {
  if (call.isError || call.isBackgroundLaunch || (typeof call.exitCode === "number" && call.exitCode !== 0)) {
    return { command: null, unverifiable: false };
  }
  if (call.toolName === "bash") {
    const cmd = call.command?.trim() ?? "";
    if (!cmd) return { command: null, unverifiable: false };
    if (!isRecognizedTestCommand(cmd)) {
      const mentionsRunner = cmd.split(/(?:&&|\|\||;|\n|\|)/).some((s) => isTestRunnerSegment(s));
      return { command: null, unverifiable: mentionsRunner };
    }
    if (hasTestFailureOutput(call.outputSnippet)) return { command: null, unverifiable: true };
    return { command: cmd, unverifiable: false };
  }
  if (call.toolName === "enhance_job") {
    let cmd = call.command?.trim() ?? "";
    let statusOk = true;
    if (call.outputSnippet?.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(call.outputSnippet) as {
          status?: unknown; exitCode?: unknown;
          job?: { jobId?: unknown; command?: unknown; status?: unknown; exitCode?: unknown };
        };
        const st = parsed.status ?? parsed.job?.status, ec = parsed.exitCode ?? parsed.job?.exitCode;
        if ((typeof st === "string" && st !== "completed") || (typeof ec === "number" && ec !== 0)) statusOk = false;
        if (!cmd && typeof parsed.job?.command === "string") cmd = parsed.job.command.trim();
        if (!cmd && typeof parsed.job?.jobId === "string") {
          const lookedUp = store.getJob(parsed.job.jobId);
          if (lookedUp) {
            cmd = lookedUp.command.trim();
            if (lookedUp.status !== "completed" || lookedUp.exitCode !== 0) statusOk = false;
          }
        }
      } catch {}
    }
    if (!statusOk || !cmd) return { command: null, unverifiable: false };
    if (!isRecognizedTestCommand(cmd)) {
      const mentionsRunner = cmd.split(/(?:&&|\|\||;|\n|\|)/).some((s) => isTestRunnerSegment(s));
      return { command: null, unverifiable: mentionsRunner };
    }
    if (hasTestFailureOutput(call.outputSnippet)) return { command: null, unverifiable: true };
    return { command: cmd, unverifiable: false };
  }
  return { command: null, unverifiable: false };
}

export function verifyQaTestExecution(
  roleId: string,
  observedCalls: readonly ObservedToolCall[],
  after: ReadonlyMap<string, SnapshotEntry>,
  store: EnhanceStore,
  stageId?: string,
): VerificationEvidenceRecord[] {
  const currentTreeFp = computeSnapshotFingerprint(after);
  let lastMutationIdx = -1;
  observedCalls.forEach((c, i) => {
    if (!c.isError && (WRITE_TOOLS[c.toolName] || c.touchedPaths.length > 0)) lastMutationIdx = i;
  });
  let sawPreMutationTest = false, sawStaleTest = false, sawUnverifiableTest = false;
  const postMutationVerified: Array<{ call: ObservedToolCall; command: string }> = [];
  observedCalls.forEach((c, i) => {
    const resolved = resolveTestCallCommand(c, store);
    if (!resolved.command) {
      if (resolved.unverifiable) sawUnverifiableTest = true;
      return;
    }
    if (i <= lastMutationIdx) { sawPreMutationTest = true; return; }
    if ((stageId && c.stageId && c.stageId !== stageId) || (c.testedTreeFingerprint && c.testedTreeFingerprint !== currentTreeFp)) {
      sawStaleTest = true;
      return;
    }
    postMutationVerified.push({ call: c, command: resolved.command });
  });
  if (postMutationVerified.length === 0) {
    if (sawUnverifiableTest) {
      throw new Error(
        `Role "${roleId}" cannot submit verdict="ready": test command exit status was masked or unverifiable (avoid piping tests into tee/tail without "set -o pipefail", avoid "|| true" or trailing commands, and ensure zero failing tests).`,
      );
    }
    if (sawPreMutationTest) {
      throw new Error(
        `Role "${roleId}" modified files after the last test execution; re-run tests against the final workspace state before submitting verdict="ready".`,
      );
    }
    if (sawStaleTest) {
      throw new Error(
        `Role "${roleId}" workspace changed after the last verified test execution (or only prior-stage tests were observed); re-run tests against the current workspace state before submitting verdict="ready".`,
      );
    }
    throw new Error(
      `Role "${roleId}" cannot submit verdict="ready" without a completed zero-exit test command in this turn (e.g. bun test, pytest, npm test, vitest, go test, cargo test; background launches and non-test shell commands like pwd/ls do not qualify).`,
    );
  }
  return postMutationVerified.map(({ call, command }) => ({
    command,
    exitCode: typeof call.exitCode === "number" ? call.exitCode : 0,
    outputSnippet: call.outputSnippet ?? call.summary ?? "",
    testedTreeFingerprint: call.testedTreeFingerprint ?? currentTreeFp,
    toolCallId: call.toolCallId,
    ...(call.stageId ?? stageId ? { stageId: call.stageId ?? stageId } : {}),
  }));
}

function firstNonEmptyStr(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function hasNonEmptyValue(v: unknown): boolean {
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v && typeof v === "object" && Object.keys(v as object).length > 0);
}

function hasFiniteMetric(obj: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(obj)) {
    if (METRICS_NON_METRIC_NUM_KEYS.has(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) return true;
  }
  const nested = obj.metrics;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    for (const v of Object.values(nested as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) return true;
    }
  }
  return false;
}

function validateAlgoMetricsObject(
  cwd: string, relPath: string, after: ReadonlyMap<string, SnapshotEntry>, afterPaths: readonly string[],
): void {
  const fullPath = path.join(cwd, relPath);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(fullPath, "utf8")); }
  catch (err) { throw new Error(`Invalid JSON in "${relPath}": ${err instanceof Error ? err.message : String(err)}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Metrics file "${relPath}" must contain a JSON plain object.`);
  }
  const obj = parsed as Record<string, unknown>;
  const expId = firstNonEmptyStr(obj, ["experimentId", "runId", "expId", "exp_id", "run_id"]);
  const split = obj.split ?? obj.datasetSplit ?? obj.dataset_split ?? obj.splits;
  const evalVer = firstNonEmptyStr(obj, ["evaluatorVersion", "scorerVersion", "evaluator_version", "scorer_version", "evalSha256"]);
  const baselineVal = obj.baseline ?? obj.baselineSource ?? obj.baseline_source ?? (obj.isBaseline === true ? "self" : undefined);

  const missing: string[] = [];
  if (!expId) missing.push("experimentId/runId");
  if (!hasNonEmptyValue(split)) missing.push("split/datasetSplit");
  if (!evalVer) missing.push("evaluatorVersion/scorerVersion");
  if (!hasNonEmptyValue(baselineVal)) missing.push("baseline/baselineSource");
  if (!hasFiniteMetric(obj)) missing.push("numeric metric value");
  if (missing.length > 0) {
    throw new Error(`Metrics file "${relPath}" is missing required provenance/metric field(s): ${missing.join(", ")}.`);
  }

  const runDirMatch = /^algo_work\/runs\/([^/]+)\//.exec(relPath);
  if (runDirMatch?.[1] && expId) {
    const dirSlug = runDirMatch[1].toLowerCase(), idSlug = expId.toLowerCase();
    const aligned = dirSlug === idSlug || dirSlug.startsWith(`${idSlug}_`) || dirSlug.startsWith(`${idSlug}-`) ||
      idSlug.startsWith(`${dirSlug}_`) || idSlug.startsWith(`${dirSlug}-`);
    if (!aligned) {
      throw new Error(`Metrics file "${relPath}" has mismatched experimentId "${expId}" for run directory "${runDirMatch[1]}".`);
    }
  }

  if (obj.reusedBaseline === true) {
    const src = firstNonEmptyStr(obj, ["baselineSource", "baseline_source"]) ?? (typeof obj.baseline === "string" ? obj.baseline.trim() : undefined);
    if (!src) throw new Error(`Metrics file "${relPath}" sets reusedBaseline=true without a verifiable baselineSource.`);
    const normSrc = normalizeRelPath(src);
    const matchedBaseline = after.has(normSrc)
      ? normSrc
      : afterPaths.find((p) => p === `algo_work/runs/${src}/metrics.json` || (p.startsWith(`algo_work/runs/${src}_`) && p.endsWith("/metrics.json")));
    if (!matchedBaseline) {
      throw new Error(`Metrics file "${relPath}" sets reusedBaseline=true, but baselineSource "${src}" was not found in workspace.`);
    }
    if (matchedBaseline.endsWith(".json")) {
      try { JSON.parse(readFileSync(path.join(cwd, matchedBaseline), "utf8")); }
      catch { throw new Error(`Reused baseline file "${matchedBaseline}" referenced by "${relPath}" is not valid JSON.`); }
    }
  }
}

export function verifyAlgoDeliverables(input: {
  roleId: string;
  resolvedCwd: string;
  after: ReadonlyMap<string, SnapshotEntry>;
  afterPaths: readonly string[];
  hasBaselineSnapshot: boolean;
  turnChangedSet: ReadonlySet<string>;
  mandateMetricsSet?: ReadonlySet<string>;
  explicitRelPaths: ReadonlySet<string>;
}): void {
  const reportRel = "algo_work/REPORT.md";
  const reportFull = path.join(input.resolvedCwd, reportRel);
  if (!input.after.has(reportRel) || !existsSync(reportFull)) {
    throw new Error(`Role "${input.roleId}" cannot submit verdict="ready" without "${reportRel}".`);
  }
  const reportNonWs = readFileSync(reportFull, "utf8").replace(/\s+/g, "").length;
  if (reportNonWs < MIN_ALGO_REPORT_NON_WS_CHARS) {
    throw new Error(
      `Role "${input.roleId}" cannot submit verdict="ready": "${reportRel}" is empty or stub-only (${reportNonWs} non-whitespace chars; >= ${MIN_ALGO_REPORT_NON_WS_CHARS} required).`,
    );
  }
  const allMetricsPaths = input.afterPaths.filter((p) => matchesGlobList(p, ["algo_work/runs/**/metrics.json"])).sort();
  if (allMetricsPaths.length === 0) {
    throw new Error(`Role "${input.roleId}" cannot submit verdict="ready" without "algo_work/runs/**/metrics.json".`);
  }
  const currentTurnMetrics = input.hasBaselineSnapshot
    ? allMetricsPaths.filter((p) => input.turnChangedSet.has(p) || Boolean(input.mandateMetricsSet?.has(p)))
    : allMetricsPaths;
  if (currentTurnMetrics.length === 0) {
    throw new Error(
      `Role "${input.roleId}" cannot submit verdict="ready": no current-turn experiment metrics were generated or updated under algo_work/runs/**/metrics.json (only unchanged historical metrics found: ${allMetricsPaths.join(", ")}).`,
    );
  }
  const metricsToValidate = new Set<string>([
    ...currentTurnMetrics,
    ...allMetricsPaths.filter((p) => input.explicitRelPaths.has(p)),
  ]);
  for (const mPath of metricsToValidate) {
    validateAlgoMetricsObject(input.resolvedCwd, mPath, input.after, input.afterPaths);
  }
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
