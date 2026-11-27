import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { matchesGlobList, normalizeRelPath, type SnapshotEntry } from "../core/fs.ts";

const MIN_ALGO_REPORT_NON_WS_CHARS = 40;
const METRICS_NON_METRIC_NUM_KEYS = new Set(["version", "schemaVersion", "schema_version"]);

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
  if (missing.length > 0) throw new Error(`Metrics file "${relPath}" is missing required provenance/metric field(s): ${missing.join(", ")}.`);

  const runDirMatch = /^algo_work\/runs\/([^/]+)\//.exec(relPath);
  if (runDirMatch?.[1] && expId) {
    const dirSlug = runDirMatch[1].toLowerCase(), idSlug = expId.toLowerCase();
    const aligned =
      dirSlug === idSlug || dirSlug.startsWith(`${idSlug}_`) || dirSlug.startsWith(`${idSlug}-`) ||
      idSlug.startsWith(`${dirSlug}_`) || idSlug.startsWith(`${dirSlug}-`);
    if (!aligned) throw new Error(`Metrics file "${relPath}" has mismatched experimentId "${expId}" for run directory "${runDirMatch[1]}".`);
  }

  if (obj.reusedBaseline === true) {
    const src = firstNonEmptyStr(obj, ["baselineSource", "baseline_source"]) ?? (typeof obj.baseline === "string" ? obj.baseline.trim() : undefined);
    if (!src) throw new Error(`Metrics file "${relPath}" sets reusedBaseline=true without a verifiable baselineSource.`);
    const normSrc = normalizeRelPath(src);
    const matchedBaseline = after.has(normSrc)
      ? normSrc
      : afterPaths.find((p) => p === `algo_work/runs/${src}/metrics.json` || (p.startsWith(`algo_work/runs/${src}_`) && p.endsWith("/metrics.json")));
    if (!matchedBaseline) throw new Error(`Metrics file "${relPath}" sets reusedBaseline=true, but baselineSource "${src}" was not found in workspace.`);
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
