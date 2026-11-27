import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { snapshotWorkspace } from "../src/core/fs.ts";
import { EnhanceStore } from "../src/core/store.ts";

const repoRoot = path.resolve(import.meta.dir, "..");
const defaultOmp = path.join(homedir(), ".local", "bin", "omp");
const ompBin = process.env.OMP_BIN ?? process.env.OMP_COMMAND ?? (existsSync(defaultOmp) ? defaultOmp : "omp");

export type EvalArm =
  | "vanilla-omp"
  | "single-planner"
  | "coord-planner-reviewer"
  | "coord-autonomous";

export interface CiPilotCaseSpec {
  id: string;
  title: string;
  logRelPath: string;
  expectedAbstain: boolean;
  rootCauseFile?: string;
  mechanismKeywords: string[];
  contradictionPatterns?: RegExp[];
  nonAnswerPatterns?: RegExp[];
  requiredEvidenceFiles: string[];
  nextStepKeywords: string[];
  setup(caseDir: string): { baseCommit: string; headCommit: string };
}

export interface CitationCheckResult {
  validCitations: string[];
  invalidCitations: string[];
}

export interface RubricScore {
  passed: boolean;
  rootCauseOrAbstentionOk: boolean;
  noContradictionOrNonAnswer: boolean;
  citationsValid: boolean;
  citedRequiredEvidence: boolean;
  actionableStepOk: boolean;
  validCitations: string[];
  invalidCitations: string[];
  notes: string[];
}

export interface PilotTrialRecord {
  trialId: string;
  caseId: string;
  arm: EvalArm;
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  failed: boolean;
  error?: string;
  /** Pure user-visible final reply (used for primary scoring and blind review). */
  responseText: string;
  /** Internal specialist handoff trace (scored separately; NEVER concatenated into responseText or blind bundle). */
  internalTraceSummary?: string;
  executedRoles?: string[];
  score: RubricScore;
  traceScore?: RubricScore;
}

export interface BlindReviewItem {
  candidateId: string;
  caseId: string;
  caseTitle: string;
  logRelPath: string;
  responseText: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runGit(cwd: string, args: string[], dateIso = "2026-11-20T10:00:00Z"): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CI Fixture",
      GIT_AUTHOR_EMAIL: "ci@example.com",
      GIT_COMMITTER_NAME: "CI Fixture",
      GIT_COMMITTER_EMAIL: "ci@example.com",
      GIT_AUTHOR_DATE: dateIso,
      GIT_COMMITTER_DATE: dateIso,
    },
  });
  assert(res.status === 0, `git ${args.join(" ")} failed in ${cwd}: ${res.stderr}`);
  return (res.stdout ?? "").trim();
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

export const PILOT_CASES: readonly CiPilotCaseSpec[] = [
  {
    id: "case-1-tz-settlement",
    title: "Known cause #1: local-timezone Date parsing drops early-UTC transactions on non-UTC CI runner",
    logRelPath: "ci/failing-build-418.log",
    expectedAbstain: false,
    rootCauseFile: "src/settlement/window.ts",
    mechanismKeywords: ["utc", "timezone", "时区", "t00:00:00", "los_angeles"],
    contradictionPatterns: [
      /(?:已?排除|并非|不是|与.{0,8}无关|not caused by|ruled out|unrelated to).{0,28}(?:时区|timezone|utc|window\.ts|date\b)/i,
      /(?:时区|timezone|utc|window\.ts).{0,20}(?:已?排除|不是根因|并非根因|无关|ruled out|not the root cause)/i,
      /(?:根因|真正原因|主因|root cause).{0,12}(?:是|在于|为|is)\s*(?:连接池|数据库|网络|内存泄漏|并发竞争|connection pool|database|oom|race condition)/i,
    ],
    requiredEvidenceFiles: ["src/settlement/window.ts", "ci/failing-build-418.log"],
    nextStepKeywords: ["tz=", "utc", "settlement.test", "window.ts"],
    setup(caseDir) {
      runGit(caseDir, ["init", "-q"]);
      writeFiles(caseDir, {
        "src/settlement/window.ts": [
          "export interface DayWindow {",
          "  startMs: number;",
          "  endMs: number;",
          "}",
          "",
          "export function computeUtcDayWindow(dayIso: string): DayWindow {",
          "  const [y, m, d] = dayIso.split('-').map((v) => Number.parseInt(v, 10));",
          "  const startMs = Date.UTC(y!, m! - 1, d!, 0, 0, 0, 0);",
          "  return { startMs, endMs: startMs + 86_400_000 };",
          "}",
          "",
        ].join("\n"),
        "src/settlement/aggregator.ts": [
          "import { computeUtcDayWindow } from './window.ts';",
          "",
          "export interface LedgerTx { id: string; settledAtIso: string; cents: number }",
          "",
          "export function sumDayCents(dayIso: string, txs: readonly LedgerTx[]): number {",
          "  const win = computeUtcDayWindow(dayIso);",
          "  let total = 0;",
          "  for (const tx of txs) {",
          "    const ts = Date.parse(tx.settledAtIso);",
          "    if (ts >= win.startMs && ts < win.endMs) total += tx.cents;",
          "  }",
          "  return total;",
          "}",
          "",
        ].join("\n"),
        "test/settlement.test.ts": [
          "import { expect, test } from 'bun:test';",
          "import { sumDayCents } from '../src/settlement/aggregator.ts';",
          "",
          "test('includes early-morning UTC settlements inside 2026-11-20 window', () => {",
          "  const total = sumDayCents('2026-11-20', [",
          "    { id: 'tx_904', settledAtIso: '2026-11-20T03:15:00Z', cents: 6500 },",
          "    { id: 'tx_905', settledAtIso: '2026-11-20T14:20:00Z', cents: 12000 },",
          "  ]);",
          "  expect(total).toBe(18500);",
          "});",
          "",
        ].join("\n"),
      });
      runGit(caseDir, ["add", "-A"]);
      runGit(caseDir, ["commit", "-q", "-m", "feat(settlement): initial UTC day window aggregator"], "2026-11-19T09:00:00Z");
      const baseCommit = runGit(caseDir, ["rev-parse", "--short", "HEAD"]);

      // Regression commit: replaced Date.UTC(...) with local-timezone new Date(`${dayIso}T00:00:00`) without trailing Z.
      writeFiles(caseDir, {
        "src/settlement/window.ts": [
          "export interface DayWindow {",
          "  startMs: number;",
          "  endMs: number;",
          "}",
          "",
          "export function computeUtcDayWindow(dayIso: string): DayWindow {",
          "  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(dayIso)) {",
          "    throw new Error(`Invalid day format: ${dayIso}`);",
          "  }",
          "  const startMs = new Date(`${dayIso}T00:00:00`).getTime();",
          "  return { startMs, endMs: startMs + 86_400_000 };",
          "}",
          "",
        ].join("\n"),
      });
      runGit(caseDir, ["add", "-A"]);
      runGit(caseDir, ["commit", "-q", "-m", "refactor(settlement): validate ISO date string in computeUtcDayWindow"], "2026-11-20T08:30:00Z");
      const headCommit = runGit(caseDir, ["rev-parse", "--short", "HEAD"]);
      const recentPatch = runGit(caseDir, ["log", "-n", "2", "--stat", "-p"]);

      writeFiles(caseDir, {
        "ci/recent-commits.patch": `${recentPatch}\n`,
        "ci/failing-build-418.log": [
          `[CI build #418] commit=${headCommit} prev_green=${baseCommit} runner=macos-14 CI_RUNNER_TZ=America/Los_Angeles`,
          "$ bun test test/settlement.test.ts",
          "test/settlement.test.ts:",
          "✗ includes early-morning UTC settlements inside 2026-11-20 window [2.14ms]",
          "  error: expect(received).toBe(expected)",
          "  Expected: 18500",
          "  Received: 12000",
          "  at test/settlement.test.ts:9:17",
          "1 fail, 0 pass",
          "Error: Process completed with exit code 1.",
          "",
        ].join("\n"),
      });
      runGit(caseDir, ["add", "ci/recent-commits.patch", "ci/failing-build-418.log"]);
      runGit(caseDir, ["commit", "-q", "-m", "ci: attach failing build #418 log"], "2026-11-20T08:35:00Z");
      return { baseCommit, headCommit };
    },
  },
  {
    id: "case-2-env-schema-coercion",
    title: "Known cause #2: uncoerced string WEBHOOK_MAX_RETRIES='0' env override triggers string concatenation in retry policy",
    logRelPath: "ci/failing-build-502.log",
    expectedAbstain: false,
    rootCauseFile: "src/config/loader.ts",
    mechanismKeywords: ["string", "number", "webhook_max_retries", "01", "字符串", "类型"],
    contradictionPatterns: [
      /(?:已?排除|并非|不是|与.{0,8}无关|not caused by|ruled out|unrelated to).{0,28}(?:字符串|类型|webhook_max_retries|loader\.ts|coercion|string)/i,
      /(?:字符串|类型|webhook_max_retries|loader\.ts).{0,20}(?:已?排除|不是根因|并非根因|无关|ruled out|not the root cause)/i,
      /(?:根因|真正原因|主因|root cause).{0,12}(?:是|在于|为|is)\s*(?:连接池|时区|数据库|网络|内存泄漏|connection pool|timezone|database|oom)/i,
    ],
    requiredEvidenceFiles: ["src/config/loader.ts", "ci/failing-build-502.log"],
    nextStepKeywords: ["webhook_max_retries", "loader.ts", "number", "retry"],
    setup(caseDir) {
      runGit(caseDir, ["init", "-q"]);
      writeFiles(caseDir, {
        "config/webhook.default.json": JSON.stringify({ maxRetries: 3, baseBackoffMs: 200 }, null, 2) + "\n",
        "src/config/loader.ts": [
          "import { readFileSync } from 'node:fs';",
          "",
          "export interface WebhookConfig { maxRetries: number; baseBackoffMs: number }",
          "",
          "export function loadWebhookConfig(jsonPath: string, env: Record<string, string | undefined>): WebhookConfig {",
          "  const defaults = JSON.parse(readFileSync(jsonPath, 'utf8')) as WebhookConfig;",
          "  const maxRetries = env.WEBHOOK_MAX_RETRIES !== undefined",
          "    ? Number.parseInt(env.WEBHOOK_MAX_RETRIES, 10)",
          "    : defaults.maxRetries;",
          "  return { ...defaults, maxRetries };",
          "}",
          "",
        ].join("\n"),
        "src/worker/retry-policy.ts": [
          "import type { WebhookConfig } from '../config/loader.ts';",
          "",
          "export function computeMaxAttempts(cfg: WebhookConfig): number {",
          "  const ceiling = (cfg.maxRetries as unknown as number) + 1;",
          "  if (typeof ceiling !== 'number' || !Number.isInteger(ceiling) || ceiling < 1 || ceiling > 10) {",
          "    throw new RangeError(`Invalid attempt ceiling: ${String(ceiling)} (expected integer 1..10)`);",
          "  }",
          "  return ceiling;",
          "}",
          "",
        ].join("\n"),
      });
      runGit(caseDir, ["add", "-A"]);
      runGit(caseDir, ["commit", "-q", "-m", "feat(webhook): initial config loader and retry policy"], "2026-11-18T12:00:00Z");
      const baseCommit = runGit(caseDir, ["rev-parse", "--short", "HEAD"]);

      // Regression commit: generic object spread overwrote numeric maxRetries with raw env string "0".
      writeFiles(caseDir, {
        "src/config/loader.ts": [
          "import { readFileSync } from 'node:fs';",
          "",
          "export interface WebhookConfig { maxRetries: number; baseBackoffMs: number }",
          "",
          "export function loadWebhookConfig(jsonPath: string, env: Record<string, string | undefined>): WebhookConfig {",
          "  const defaults = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;",
          "  const overrides: Record<string, unknown> = {};",
          "  if (env.WEBHOOK_MAX_RETRIES !== undefined) overrides.maxRetries = env.WEBHOOK_MAX_RETRIES;",
          "  if (env.WEBHOOK_BASE_BACKOFF_MS !== undefined) overrides.baseBackoffMs = Number(env.WEBHOOK_BASE_BACKOFF_MS);",
          "  return { ...defaults, ...overrides } as unknown as WebhookConfig;",
          "}",
          "",
        ].join("\n"),
      });
      runGit(caseDir, ["add", "-A"]);
      runGit(caseDir, ["commit", "-q", "-m", "feat(config): support WEBHOOK_BASE_BACKOFF_MS env override"], "2026-11-20T11:10:00Z");
      const headCommit = runGit(caseDir, ["rev-parse", "--short", "HEAD"]);
      const recentPatch = runGit(caseDir, ["log", "-n", "2", "--stat", "-p"]);

      writeFiles(caseDir, {
        "ci/recent-commits.patch": `${recentPatch}\n`,
        "ci/failing-build-502.log": [
          `[CI build #502] matrix_leg=retry-disabled WEBHOOK_MAX_RETRIES="0" commit=${headCommit} prev_green=${baseCommit}`,
          "$ bun run check:worker-smoke",
          "RangeError: Invalid attempt ceiling: 01 (expected integer 1..10)",
          "    at computeMaxAttempts (src/worker/retry-policy.ts:6:11)",
          "    at runSmoke (scripts/worker-smoke.ts:14:22)",
          "Error: Process completed with exit code 1.",
          "",
        ].join("\n"),
      });
      runGit(caseDir, ["add", "ci/recent-commits.patch", "ci/failing-build-502.log"]);
      runGit(caseDir, ["commit", "-q", "-m", "ci: attach failing build #502 log"], "2026-11-20T11:15:00Z");
      return { baseCommit, headCommit };
    },
  },
  {
    id: "case-3-truncated-oom-control",
    title: "Insufficient-evidence control: outer container killed with 137 and shard logs missing",
    logRelPath: "ci/failing-build-619.log",
    expectedAbstain: true,
    mechanismKeywords: ["证据不足", "不足以", "无法确定", "insufficient", "cannot determine", "missing log", "日志缺失", "无法唯一定因"],
    requiredEvidenceFiles: ["ci/failing-build-619.log"],
    nextStepKeywords: ["shard", "137", "oom", "always()", "dmesg", "memory", "内存", "日志"],
    setup(caseDir) {
      runGit(caseDir, ["init", "-q"]);
      writeFiles(caseDir, {
        "src/exporter/csv.ts": [
          "export function formatCsvRow(values: readonly string[]): string {",
          "  return values.map((v) => `\"${v.replaceAll('\"', '\"\"')}\"`).join(',') + '\\n';",
          "}",
          "",
        ].join("\n"),
        "src/exporter/parquet.ts": [
          "export interface ColumnChunk { name: string; count: number }",
          "export function summarizeChunks(chunks: readonly ColumnChunk[]): number {",
          "  return chunks.reduce((acc, c) => acc + c.count, 0);",
          "}",
          "",
        ].join("\n"),
        "src/db/pool.ts": [
          "export interface PoolOptions { maxConnections: number }",
          "export function createPoolConfig(maxConnections = 8): PoolOptions {",
          "  return { maxConnections: Math.max(1, maxConnections) };",
          "}",
          "",
        ].join("\n"),
      });
      runGit(caseDir, ["add", "-A"]);
      runGit(caseDir, ["commit", "-q", "-m", "chore: baseline exporter and db pool modules"], "2026-11-20T11:55:00Z");
      const headCommit = runGit(caseDir, ["rev-parse", "--short", "HEAD"]);
      const recentPatch = runGit(caseDir, ["log", "-n", "1", "--stat", "-p"]);

      writeFiles(caseDir, {
        "ci/recent-commits.patch": `${recentPatch}\n`,
        "ci/failing-build-619.log": [
          "[CI build #619] workflow=nightly-e2e shard_count=3 runner=ubuntu-latest",
          "[02:14:01] Launching docker compose integration shards (shard-1, shard-2, shard-3)...",
          "[02:19:44] ##[error]Process completed with exit code 137.",
          "[02:19:45] ##[warning]Artifact upload step skipped because previous step failed (missing if: always()); /tmp/shard-*.log and container inspect output were not preserved.",
          "",
        ].join("\n"),
      });
      runGit(caseDir, ["add", "ci/recent-commits.patch", "ci/failing-build-619.log"]);
      runGit(caseDir, ["commit", "-q", "-m", "ci: attach truncated nightly build #619 log"], "2026-11-20T12:00:00Z");
      return { baseCommit: headCommit, headCommit };
    },
  },
];

export function verifyCitations(caseDir: string, text: string): CitationCheckResult {
  const validCitations: string[] = [];
  const invalidCitations: string[] = [];
  const pattern = /\b((?:src|config|test|ci)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)?/g;
  const seen = new Set<string>();

  for (const match of text.matchAll(pattern)) {
    const rawCitation = match[0]!;
    if (seen.has(rawCitation)) continue;
    seen.add(rawCitation);
    const relPath = match[1]!;
    const absPath = path.resolve(caseDir, relPath);
    if (!absPath.startsWith(path.resolve(caseDir) + path.sep) || !existsSync(absPath)) {
      invalidCitations.push(rawCitation);
      continue;
    }
    const startRaw = match[2] ?? match[4];
    const endRaw = match[3] ?? match[5];
    if (startRaw !== undefined) {
      const totalLines = readFileSync(absPath, "utf8").split(/\r?\n/).length;
      const start = Number.parseInt(startRaw, 10);
      const end = endRaw !== undefined ? Number.parseInt(endRaw, 10) : start;
      if (start < 1 || end < start || end > totalLines) {
        invalidCitations.push(`${rawCitation} (max line ${totalLines})`);
        continue;
      }
    }
    validCitations.push(rawCitation);
  }
  return { validCitations, invalidCitations };
}

const DEFAULT_NON_ANSWER_PATTERNS: readonly RegExp[] = [
  /(?:下轮再(?:调查|分析|排查|定位)|下一轮再(?:查|调查|分析|排查)|稍后再(?:调查|分析|排查)|暂未(?:调查|排查|定位)|还没来得及(?:查|调查|分析)|will investigate (?:in the )?next turn|investigate later)/i,
];

const BLIND_REVIEW_LEAK_PATTERNS: readonly RegExp[] = [
  /\[(?:planner|reviewer|dev|qa|algo|vision|coordinator)\s+handoff\]/i,
  /\b(?:vanilla-omp|single-planner|coord-planner-reviewer|coord-autonomous)\b/i,
  /\benhance_(?:flow|handoff|mandate|job)\b/i,
];

export function detectBlindReviewLeaks(item: BlindReviewItem): string[] {
  const leaks: string[] = [];
  if ("arm" in (item as unknown as Record<string, unknown>)) leaks.push("field:arm");
  if ("internalTraceSummary" in (item as unknown as Record<string, unknown>)) leaks.push("field:internalTraceSummary");
  for (const re of BLIND_REVIEW_LEAK_PATTERNS) {
    const m = re.exec(item.responseText);
    if (m) leaks.push(m[0]);
  }
  return leaks;
}

export function scoreCaseOutput(spec: CiPilotCaseSpec, caseDir: string, responseText: string): RubricScore {
  const lower = responseText.toLowerCase();
  const citations = verifyCitations(caseDir, responseText);
  const citationsValid = citations.invalidCitations.length === 0 && citations.validCitations.length > 0;
  const citedRequiredEvidence = spec.requiredEvidenceFiles.every((req) => responseText.includes(req));
  const actionableStepOk = spec.nextStepKeywords.some((kw) => lower.includes(kw.toLowerCase()));
  const notes: string[] = [];

  const nonAnswerMatchers = [...DEFAULT_NON_ANSWER_PATTERNS, ...(spec.nonAnswerPatterns ?? [])];
  const hitNonAnswer = nonAnswerMatchers.some((re) => re.test(responseText));
  const hitContradiction = (spec.contradictionPatterns ?? []).some((re) => re.test(responseText));
  const noContradictionOrNonAnswer = !hitNonAnswer && !hitContradiction;
  if (hitNonAnswer) notes.push("Response deferred investigation (non-answer) instead of delivering a diagnosis.");
  if (hitContradiction) notes.push("Response contradicted the true root cause or blamed an unrelated culprit.");

  let rootCauseOrAbstentionOk = false;
  if (spec.expectedAbstain) {
    const statedInsufficient = spec.mechanismKeywords.some((kw) => lower.includes(kw.toLowerCase()));
    const fabricatedCertainCulprit =
      /(?:唯一根因是|根因已确认为|已经?确定根因|肯定是因为|root cause is definitely|caused by a bug in)\s*`?src\//i.test(responseText);
    rootCauseOrAbstentionOk = statedInsufficient && !fabricatedCertainCulprit && noContradictionOrNonAnswer;
    if (!statedInsufficient) notes.push("Did not explicitly state that log evidence is insufficient.");
    if (fabricatedCertainCulprit) notes.push("Fabricated a definitive source-file bug despite truncated log.");
  } else {
    const hitFile = Boolean(spec.rootCauseFile && responseText.includes(spec.rootCauseFile));
    const hitMechanism = spec.mechanismKeywords.some((kw) => lower.includes(kw.toLowerCase()));
    const wronglyAbstained = /(?:证据不足以确定|无法定位根因|insufficient evidence to identify)/.test(lower) && !hitFile;
    rootCauseOrAbstentionOk = hitFile && hitMechanism && !wronglyAbstained && noContradictionOrNonAnswer;
    if (!hitFile) notes.push(`Missing root cause file ${spec.rootCauseFile}.`);
    if (!hitMechanism) notes.push("Missing causal mechanism explanation.");
  }
  if (!citationsValid) notes.push(`Invalid or missing citations: ${citations.invalidCitations.join(", ") || "none cited"}`);
  if (!citedRequiredEvidence) notes.push(`Did not cite all required files (${spec.requiredEvidenceFiles.join(", ")}).`);
  if (!actionableStepOk) notes.push("Missing discriminating verification or evidence-collection step.");

  return {
    passed: rootCauseOrAbstentionOk && noContradictionOrNonAnswer && citationsValid && citedRequiredEvidence && actionableStepOk,
    rootCauseOrAbstentionOk,
    noContradictionOrNonAnswer,
    citationsValid,
    citedRequiredEvidence,
    actionableStepOk,
    validCitations: citations.validCitations,
    invalidCitations: citations.invalidCitations,
    notes,
  };
}

export function buildBlindReviewBundle(trials: readonly PilotTrialRecord[]): {
  blindItems: BlindReviewItem[];
  answerKey: Record<string, { trialId: string; caseId: string; arm: EvalArm; objectiveScore: RubricScore }>;
} {
  const blindItems: BlindReviewItem[] = [];
  const answerKey: Record<string, { trialId: string; caseId: string; arm: EvalArm; objectiveScore: RubricScore }> = {};
  const sorted = [...trials].sort((a, b) => {
    const ha = createHash("sha256").update(`${a.caseId}:${a.trialId}`).digest("hex");
    const hb = createHash("sha256").update(`${b.caseId}:${b.trialId}`).digest("hex");
    return ha.localeCompare(hb);
  });

  sorted.forEach((trial, idx) => {
    const candidateId = `cand-${String(idx + 1).padStart(2, "0")}-${trial.trialId.slice(0, 6)}`;
    const spec = PILOT_CASES.find((c) => c.id === trial.caseId)!;
    blindItems.push({
      candidateId,
      caseId: trial.caseId,
      caseTitle: spec.title,
      logRelPath: spec.logRelPath,
      responseText: trial.responseText,
    });
    answerKey[candidateId] = {
      trialId: trial.trialId,
      caseId: trial.caseId,
      arm: trial.arm,
      objectiveScore: trial.score,
    };
  });
  return { blindItems, answerKey };
}

function runDryRunSelfCheck(sandboxRoot: string): void {
  const syntheticTrials: PilotTrialRecord[] = [];

  for (const spec of PILOT_CASES) {
    const caseDir = path.join(sandboxRoot, spec.id);
    mkdirSync(caseDir, { recursive: true });
    const commits = spec.setup(caseDir);
    assert(commits.headCommit.length >= 6, `Failed to initialize git commits for ${spec.id}`);
    assert(existsSync(path.join(caseDir, spec.logRelPath)), `Missing CI log ${spec.logRelPath} in ${spec.id}`);
    const beforeSnap = snapshotWorkspace(caseDir);
    assert(beforeSnap.size >= 2, `Expected populated workspace snapshot for ${spec.id}`);
  }

  // 1) Case 1 positive vs hallucinated-line negative check
  const c1Dir = path.join(sandboxRoot, "case-1-tz-settlement");
  const c1Good = scoreCaseOutput(
    PILOT_CASES[0]!,
    c1Dir,
    "根因位于 src/settlement/window.ts:10：新提交使用 new Date(`${dayIso}T00:00:00`) 按本地时区解析而非 Date.UTC，在 ci/failing-build-418.log:1 的 America/Los_Angeles 时区下窗口偏移 8 小时漏掉 03:15Z 交易。复验步骤：对比 TZ=UTC bun test test/settlement.test.ts 与 TZ=America/Los_Angeles bun test test/settlement.test.ts。",
  );
  assert(c1Good.passed, `Expected Case 1 good sample to pass rubric: ${JSON.stringify(c1Good)}`);

  const c1BadLine = scoreCaseOutput(
    PILOT_CASES[0]!,
    c1Dir,
    "根因位于 src/settlement/window.ts:999（时区 UTC 偏移），见 ci/failing-build-418.log:1，运行 TZ=UTC bun test test/settlement.test.ts 复验。",
  );
  assert(!c1BadLine.passed && !c1BadLine.citationsValid, "Expected out-of-bounds line citation (window.ts:999) to fail.");

  // 1b) Contradiction negative check: mentions real keywords/files yet rules out timezone and blames connection pool
  const c1Contradiction = scoreCaseOutput(
    PILOT_CASES[0]!,
    c1Dir,
    "查看 src/settlement/window.ts:10 和 ci/failing-build-418.log:1 后，已排除时区和 UTC 解析问题，真正根因是连接池太小导致超时。建议运行 TZ=UTC bun test test/settlement.test.ts 复验。",
  );
  assert(
    !c1Contradiction.passed && !c1Contradiction.noContradictionOrNonAnswer,
    `Expected opposite-conclusion contradiction to fail: ${JSON.stringify(c1Contradiction)}`,
  );

  // 1c) Non-answer / deferred investigation negative check
  const c1Deferred = scoreCaseOutput(
    PILOT_CASES[0]!,
    c1Dir,
    "已读取 ci/failing-build-418.log:1 与 src/settlement/window.ts:10（UTC 时区相关），下轮再调查具体原因并运行 TZ=UTC bun test test/settlement.test.ts。",
  );
  assert(
    !c1Deferred.passed && !c1Deferred.noContradictionOrNonAnswer,
    `Expected deferred non-answer to fail: ${JSON.stringify(c1Deferred)}`,
  );

  // 2) Case 2 positive check
  const c2Dir = path.join(sandboxRoot, "case-2-env-schema-coercion");
  const c2Good = scoreCaseOutput(
    PILOT_CASES[1]!,
    c2Dir,
    "根因位于 src/config/loader.ts:8：环境变量 WEBHOOK_MAX_RETRIES=\"0\" 未转为 number 即覆盖 maxRetries，导致 src/worker/retry-policy.ts:4 计算 '0' + 1 得到字符串 '01'（见 ci/failing-build-502.log:3）。复验步骤：传入 WEBHOOK_MAX_RETRIES=0 检查 typeof loadWebhookConfig(...).maxRetries === 'number'。",
  );
  assert(c2Good.passed, `Expected Case 2 good sample to pass rubric: ${JSON.stringify(c2Good)}`);

  // 3) Case 3 honest abstention positive vs fabricated culprit negative check
  const c3Dir = path.join(sandboxRoot, "case-3-truncated-oom-control");
  const c3Good = scoreCaseOutput(
    PILOT_CASES[2]!,
    c3Dir,
    "当前证据不足，无法唯一定因：ci/failing-build-619.log:3-4 仅显示外层进程收到 exit code 137 (SIGKILL) 且 /tmp/shard-*.log 因缺少 if: always() 未上传，src/exporter/csv.ts:1 与 src/db/pool.ts:1 均无异常改动。下一步取证动作：在 workflow 上传步骤加上 if: always() 保留 /tmp/shard-*.log 并采集容器 OOM / dmesg 内存峰值。",
  );
  assert(c3Good.passed, `Expected Case 3 honest abstention to pass rubric: ${JSON.stringify(c3Good)}`);

  const c3Speculative = scoreCaseOutput(
    PILOT_CASES[2]!,
    c3Dir,
    "唯一根因是 src/exporter/csv.ts:2 发生内存泄漏导致 exit 137（见 ci/failing-build-619.log:3），建议检查 shard 内存。",
  );
  assert(!c3Speculative.passed && !c3Speculative.rootCauseOrAbstentionOk, "Expected Case 3 fabricated culprit to fail.");

  syntheticTrials.push(
    {
      trialId: randomUUID(), caseId: PILOT_CASES[0]!.id, arm: "vanilla-omp", model: "dry-run",
      durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failed: false,
      responseText: "Case 1 sample A", score: c1Good,
    },
    {
      trialId: randomUUID(), caseId: PILOT_CASES[0]!.id, arm: "coord-planner-reviewer", model: "dry-run",
      durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failed: false,
      responseText: "Case 1 sample B",
      internalTraceSummary: "[planner handoff]: internal only, must never appear in blind review",
      score: c1Good,
    },
    {
      trialId: randomUUID(), caseId: PILOT_CASES[0]!.id, arm: "coord-autonomous", model: "dry-run",
      durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failed: false,
      responseText: "Case 1 autonomous sample",
      score: c1Good,
    },
    {
      trialId: randomUUID(), caseId: PILOT_CASES[2]!.id, arm: "single-planner", model: "dry-run",
      durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failed: false,
      responseText: "Case 3 honest abstention sample", score: c3Good,
    },
  );

  const bundle = buildBlindReviewBundle(syntheticTrials);
  assert(bundle.blindItems.length === 4, "Expected 4 blind review items.");
  for (const item of bundle.blindItems) {
    const leaks = detectBlindReviewLeaks(item);
    assert(leaks.length === 0, `Blind review item leaked arm/internal markers: ${leaks.join(", ")}`);
    assert(Boolean(bundle.answerKey[item.candidateId]), `Missing answerKey entry for ${item.candidateId}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "dry-run",
        casesVerified: PILOT_CASES.map((c) => c.id),
        rubricChecksPassed: 8,
        blindCandidatesGenerated: bundle.blindItems.length,
      },
      null,
      2,
    ),
  );
}

async function runLiveArmTrial(options: {
  spec: CiPilotCaseSpec;
  arm: EvalArm;
  model: string;
  sandboxRoot: string;
}): Promise<PilotTrialRecord> {
  const trialId = randomUUID();
  const caseDir = path.join(options.sandboxRoot, `${options.spec.id}-${options.arm}`);
  mkdirSync(caseDir, { recursive: true });
  options.spec.setup(caseDir);
  const beforeSnap = snapshotWorkspace(caseDir);

  const ctrlDir = path.join(options.sandboxRoot, `ctrl-${trialId}`);
  mkdirSync(ctrlDir, { recursive: true });
  const cfgPath = path.join(ctrlDir, "pilot-config.yml");
  writeFileSync(cfgPath, "advisor:\n  enabled: false\n", "utf8");
  const lockPath = path.join(ctrlDir, "lock.json");
  writeFileSync(
    lockPath,
    JSON.stringify({ settings: { "omp-enhance": { supervisorEnabled: false } } }),
    "utf8",
  );

  const diagnosisPrompt = [
    `请只读诊断该仓库的 CI 失败日志 \`${options.spec.logRelPath}\`（严禁修改任何工作区文件，近期提交补丁已归档于 \`ci/recent-commits.patch\`）。`,
    "请严格依据仓库真实代码、Git 提交补丁与日志回答：",
    "1. 根因结论（若现有日志不足以唯一确定根因，必须明确回答“证据不足/无法唯一定因”，绝不猜测编造）；",
    "2. 支持结论的精确文件路径与行号引用（如 `src/foo.ts:12`、`ci/failing-build-xxx.log:3`）；",
    "3. 一条可区分候选原因的最小复验命令，或（当证据不足时）下一步具体取证动作。",
  ].join("\n");

  const args = [
    ompBin, "--mode", "rpc", "--no-ui",
    "--config", cfgPath,
    "--model", options.model,
    "--thinking", "low",
    "--cwd", caseDir,
    "--no-session", "--no-skills", "--no-rules", "--no-context-files",
    "--no-lsp", "--no-extensions", "--no-title", "--auto-approve",
    ...(options.arm === "vanilla-omp"
      ? ["--tools", "read,grep,glob,find"]
      : ["--extension", repoRoot]),
  ];

  const startedMs = Date.now();
  const proc = Bun.spawn(args, {
    cwd: caseDir,
    env: {
      ...(process.env as Record<string, string>),
      OMP_ENHANCE_HOME: path.join(ctrlDir, "home"),
      OMP_ENHANCE_GLOBAL_ROLES_DIR: path.join(ctrlDir, "roles"),
      OMP_ENHANCE_PLUGIN_LOCK_PATH: lockPath,
      OMP_ENHANCE_CMD_OUT: path.join(ctrlDir, "cmd.out"),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderrTask = new Response(proc.stderr).text().catch(() => "");

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let agentEnds = 0;
  const assistantTexts: string[] = [];
  const responseIds = new Set<string>();

  const stdoutTask = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try {
              const ev = JSON.parse(line) as Record<string, unknown>;
              if (ev.type === "agent_end") agentEnds += 1;
              if (ev.type === "response" && typeof ev.id === "string") responseIds.add(ev.id);
              if (ev.type === "message_end" && ev.message && typeof ev.message === "object") {
                const msg = ev.message as Record<string, unknown>;
                if (msg.role === "assistant") {
                  const u = msg.usage as Record<string, any> | undefined;
                  if (u) {
                    inputTokens += Number(u.input ?? 0) + Number(u.cacheRead ?? 0);
                    outputTokens += Number(u.output ?? 0);
                    costUsd += Number(u.cost?.total ?? 0);
                  }
                  const content = msg.content;
                  const txt = typeof content === "string"
                    ? content
                    : Array.isArray(content)
                      ? content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n").trim()
                      : "";
                  if (txt) assistantTexts.push(txt);
                }
              }
            } catch {}
          }
          nl = buf.indexOf("\n");
        }
      }
    } catch {}
  })();

  const waitUntil = async (pred: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (!pred() && Date.now() < deadline && proc.exitCode === null) await Bun.sleep(150);
    return pred();
  };

  const dbPath = path.join(caseDir, ".omp-enhance", "state.sqlite");
  const countRecordedHandoffs = (): number => {
    if (!existsSync(dbPath)) return 0;
    const s = new EnhanceStore(dbPath);
    try {
      return s.listHandoffs().filter((h) => h.fromRole !== "user").length;
    } catch {
      return 0;
    } finally {
      s.close();
    }
  };

  let failed = false;
  let errorMsg: string | undefined;
  let stderrText = "";
  try {
    if (options.arm !== "vanilla-omp") {
      proc.stdin.write(`${JSON.stringify({ id: "c1", type: "prompt", message: "/coord" })}\n`);
      await proc.stdin.flush();
      await waitUntil(() => responseIds.has("c1"), 20_000);
    }

    const isFixedChainArm = options.arm === "single-planner" || options.arm === "coord-planner-reviewer";
    const rolesChain = options.arm === "single-planner" ? '["planner"]' : '["planner", "reviewer"]';
    const promptMsg = options.arm === "vanilla-omp"
      ? diagnosisPrompt
      : options.arm === "coord-autonomous"
        ? `无需询问确认，我已授权立即执行（严格只读，严禁修改工作区文件）。请根据任务复杂度自行判断是否直接诊断或委派给合适的只读专员协作，并最终直接给我完整、可核验的结论：\n\n${diagnosisPrompt}`
        : `无需询问确认，我已授权立即执行：请直接调用 enhance_flow(action="start", roles=${rolesChain}, goal=${JSON.stringify(diagnosisPrompt)}, wait=true)，完成后将专员核实的根因/证据不足结论、精确文件行号引用与下一步复验/取证动作完整汇报给我。`;

    const beforeEnds = agentEnds;
    proc.stdin.write(`${JSON.stringify({ id: "diag", type: "prompt", message: promptMsg })}\n`);
    await proc.stdin.flush();
    let ok = await waitUntil(() => agentEnds > beforeEnds, 240_000);

    if (ok && isFixedChainArm && countRecordedHandoffs() === 0 && proc.exitCode === null) {
      const retryEnds = agentEnds;
      const confirmMsg = `好，确认立即执行！请现在直接调用 enhance_flow(action="start", roles=${rolesChain}, goal=${JSON.stringify(diagnosisPrompt)}, wait=true) 并将核实后的完整结论与精确行号汇报给我。`;
      proc.stdin.write(`${JSON.stringify({ id: "diag2", type: "prompt", message: confirmMsg })}\n`);
      await proc.stdin.flush();
      ok = await waitUntil(() => agentEnds > retryEnds, 240_000);
    }

    if (!ok) {
      failed = true;
      errorMsg = proc.exitCode !== null
        ? `omp exited early (code=${proc.exitCode}) before diagnosis turn completed.`
        : "Timed out waiting for diagnosis turn.";
    }
  } catch (err) {
    failed = true;
    errorMsg = err instanceof Error ? err.message : String(err);
  } finally {
    try { proc.stdin.end(); } catch {}
    try { proc.kill("SIGTERM"); } catch {}
    await Promise.race([proc.exited, Bun.sleep(3_000)]);
    if (proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch {}
    }
    await Promise.race([stdoutTask, Bun.sleep(1_000)]);
    stderrText = (await Promise.race([stderrTask, Bun.sleep(1_000).then(() => "")])).trim();
    if (failed && stderrText) {
      errorMsg = `${errorMsg ?? "Trial failed"} | stderr: ${stderrText.slice(0, 300)}`;
    }
  }

  // Keep primary responseText strictly user-visible; score internal specialist handoff trace separately.
  const userVisibleResponse = assistantTexts.at(-1) ?? "";
  const traceSections: string[] = [];
  const executedRoles = new Set<string>();
  if (existsSync(dbPath)) {
    const store = new EnhanceStore(dbPath);
    try {
      const seenReadyRole = new Set<string>();
      for (const h of store.listHandoffs()) {
        if (h.fromRole !== "user") executedRoles.add(h.fromRole);
        if (h.observedUsage) {
          inputTokens += h.observedUsage.inputTokens;
          outputTokens += h.observedUsage.outputTokens;
          costUsd += h.observedUsage.costUsd;
        }
        if (h.fromRole !== "user" && h.verdict === "ready" && !seenReadyRole.has(h.fromRole)) {
          seenReadyRole.add(h.fromRole);
          const factLines = h.verifiedFacts.map((f) => `- ${f.claim} (${f.evidenceRef})`).join("\n");
          traceSections.push(`[${h.fromRole} handoff]: ${h.summary}${factLines ? `\n${factLines}` : ""}`);
        }
      }
    } finally {
      store.close();
    }
  }
  const internalTraceSummary = traceSections.length > 0 ? traceSections.join("\n\n") : undefined;

  if (!failed && options.arm === "single-planner" && !executedRoles.has("planner")) {
    failed = true;
    errorMsg = "single-planner arm did not execute planner stage.";
  }
  if (!failed && options.arm === "coord-planner-reviewer" && (!executedRoles.has("planner") || !executedRoles.has("reviewer"))) {
    failed = true;
    errorMsg = `coord-planner-reviewer arm missing required specialist stage(s): executed=[${[...executedRoles].join(",")}].`;
  }

  // Verify read-only invariance across all arms.
  const afterSnap = snapshotWorkspace(caseDir);
  const mutated = [...beforeSnap.entries()].some(([k, v]) => afterSnap.get(k)?.sha256 !== v.sha256) || afterSnap.size !== beforeSnap.size;
  if (mutated) {
    failed = true;
    errorMsg = "Read-only diagnosis trial mutated workspace files.";
  }

  const score = scoreCaseOutput(options.spec, caseDir, userVisibleResponse);
  const traceScore = internalTraceSummary ? scoreCaseOutput(options.spec, caseDir, internalTraceSummary) : undefined;
  return {
    trialId,
    caseId: options.spec.id,
    arm: options.arm,
    model: options.model,
    durationMs: Date.now() - startedMs,
    inputTokens,
    outputTokens,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    failed,
    ...(errorMsg ? { error: errorMsg } : {}),
    responseText: userVisibleResponse,
    ...(internalTraceSummary ? { internalTraceSummary } : {}),
    ...(executedRoles.size > 0 ? { executedRoles: [...executedRoles].sort() } : {}),
    score,
    ...(traceScore ? { traceScore } : {}),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const isLive = argv.includes("--live");
  const modelIdx = argv.indexOf("--model");
  const model = (modelIdx >= 0 ? argv[modelIdx + 1] : undefined) ?? process.env.OMP_PILOT_MODEL ?? "@task";
  const outIdx = argv.indexOf("--out");
  const explicitOut = outIdx >= 0 ? argv[outIdx + 1] : undefined;

  const sandboxRoot = mkdtempSync(path.join(tmpdir(), "omp-ci-pilot-"));
  try {
    if (!isLive) {
      runDryRunSelfCheck(sandboxRoot);
      return;
    }

    assert(existsSync(ompBin), `omp binary not found at ${ompBin}`);
    const armsIdx = argv.indexOf("--arms");
    const defaultArms: EvalArm[] = ["vanilla-omp", "single-planner", "coord-planner-reviewer", "coord-autonomous"];
    const validArmSet = new Set<EvalArm>(defaultArms);
    const arms: EvalArm[] = armsIdx >= 0 && argv[armsIdx + 1]
      ? argv[armsIdx + 1]!
          .split(",")
          .map((s) => s.trim() as EvalArm)
          .filter((a) => validArmSet.has(a))
      : defaultArms;
    assert(arms.length > 0, "At least one valid --arms value is required.");
    const trials: PilotTrialRecord[] = [];

    for (const spec of PILOT_CASES) {
      for (const arm of arms) {
        console.log(`running [${spec.id}] arm=${arm} model=${model}...`);
        const record = await runLiveArmTrial({ spec, arm, model, sandboxRoot });
        trials.push(record);
        console.log(
          `  -> passed=${record.score.passed && !record.failed} failed=${record.failed} duration=${record.durationMs}ms tokens=${record.inputTokens + record.outputTokens} cost=$${record.costUsd}${record.error ? ` err=${record.error}` : ""}`,
        );
      }
    }

    const bundle = buildBlindReviewBundle(trials);
    const byArm = Object.fromEntries(
      arms.map((arm) => {
        const subset = trials.filter((t) => t.arm === arm);
        return [
          arm,
          {
            passedCount: subset.filter((t) => t.score.passed && !t.failed).length,
            totalCases: subset.length,
            failedTrials: subset.filter((t) => t.failed).length,
            totalDurationMs: subset.reduce((s, t) => s + t.durationMs, 0),
            totalTokens: subset.reduce((s, t) => s + t.inputTokens + t.outputTokens, 0),
            totalCostUsd: Math.round(subset.reduce((s, t) => s + t.costUsd, 0) * 1_000_000) / 1_000_000,
          },
        ];
      }),
    );

    const reportPath = explicitOut
      ? path.resolve(explicitOut)
      : path.join(tmpdir(), `omp-enhance-ci-pilot-${Date.now()}.json`);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(
      reportPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), model, summaryByArm: byArm, blindBundle: bundle.blindItems, answerKey: bundle.answerKey, trials }, null, 2) + "\n",
      "utf8",
    );
    console.log(`saved CI pilot report: ${reportPath}`);
    console.log(JSON.stringify(byArm, null, 2));
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
