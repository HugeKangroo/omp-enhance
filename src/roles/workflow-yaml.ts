import type { RoleWorkflowExitGateSpec, RoleWorkflowPhaseSpec, RoleWorkflowSpec } from "../core/graph-types.ts";
import { applyPhasePermissions } from "../core/scope.ts";
import type { RoleSpec } from "../core/types.ts";

const PHASE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const WORKFLOW_KEYS: Record<string, true> = { session: true, repair_entry: true, max_repair_rounds: true, phases: true };
const PHASE_KEYS: Record<string, true> = {
  id: true, title: true, kind: true, depends_on: true, tools: true, writable: true,
  lock_protected: true, exit_artifacts: true, exit_gate: true, prompt: true, brief: true, max_attempts: true, fallback_models: true,
};
const GATE_KEYS: Record<string, true> = { command: true, timeout_sec: true, expect_exit_code: true, parse_json_metrics_path: true };

function assertAllowed(obj: Record<string, unknown>, allowed: Record<string, true>, scope: string, filePath: string): void {
  for (const key of Object.keys(obj)) if (!allowed[key]) throw new Error(`Unknown ${scope} field "${key}" in ${filePath}`);
}
function readStr(val: unknown, field: string, filePath: string): string {
  if (typeof val !== "string" || !val.trim()) throw new Error(`${field} must be a non-empty string in ${filePath}`);
  return val.trim();
}
function readStrList(val: unknown, field: string, filePath: string): string[] {
  if (!Array.isArray(val) || val.some((x) => typeof x !== "string" || !x.trim())) throw new Error(`${field} must be an array of non-empty strings in ${filePath}`);
  return (val as string[]).map((s) => s.trim());
}

function parseExitGate(raw: unknown, field: string, filePath: string): RoleWorkflowExitGateSpec {
  if (typeof raw === "string" && raw.trim()) return { command: raw.trim() };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${field} must be an object or command string in ${filePath}`);
  const g = raw as Record<string, unknown>;
  assertAllowed(g, GATE_KEYS, field, filePath);
  const command = readStr(g.command, `${field}.command`, filePath);
  if (g.timeout_sec !== undefined && (typeof g.timeout_sec !== "number" || g.timeout_sec <= 0)) throw new Error(`${field}.timeout_sec must be a positive number in ${filePath}`);
  if (g.expect_exit_code !== undefined && !Number.isInteger(g.expect_exit_code)) throw new Error(`${field}.expect_exit_code must be an integer in ${filePath}`);
  return {
    command,
    ...(typeof g.timeout_sec === "number" ? { timeoutSec: g.timeout_sec } : {}),
    ...(typeof g.expect_exit_code === "number" ? { expectExitCode: g.expect_exit_code } : {}),
    ...(g.parse_json_metrics_path !== undefined ? { parseJsonMetricsPath: readStr(g.parse_json_metrics_path, `${field}.parse_json_metrics_path`, filePath) } : {}),
  };
}

export function parseRoleWorkflowYaml(raw: unknown, baseRole: RoleSpec, filePath: string): RoleWorkflowSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`workflow must be an object in ${filePath}`);
  const wf = raw as Record<string, unknown>;
  assertAllowed(wf, WORKFLOW_KEYS, "workflow", filePath);
  let session: "reuse" | "fresh" | undefined;
  if (wf.session !== undefined) {
    if (wf.session !== "reuse" && wf.session !== "fresh") throw new Error(`workflow.session must be "reuse" or "fresh" in ${filePath}`);
    session = wf.session;
  }
  let maxRepairRounds: number | undefined;
  if (wf.max_repair_rounds !== undefined) {
    if (typeof wf.max_repair_rounds !== "number" || !Number.isInteger(wf.max_repair_rounds) || wf.max_repair_rounds < 0) {
      throw new Error(`workflow.max_repair_rounds must be a non-negative integer in ${filePath}`);
    }
    maxRepairRounds = wf.max_repair_rounds;
  }
  if (!Array.isArray(wf.phases) || wf.phases.length === 0) throw new Error(`workflow.phases must be a non-empty array in ${filePath}`);

  const seenIds = new Set<string>(), phases: RoleWorkflowPhaseSpec[] = [];
  for (let i = 0; i < wf.phases.length; i++) {
    const rawPhase = wf.phases[i];
    if (!rawPhase || typeof rawPhase !== "object" || Array.isArray(rawPhase)) throw new Error(`workflow.phases[${i}] must be an object in ${filePath}`);
    const p = rawPhase as Record<string, unknown>;
    assertAllowed(p, PHASE_KEYS, `workflow.phases[${i}]`, filePath);
    const id = readStr(p.id, `workflow.phases[${i}].id`, filePath);
    if (!PHASE_ID_RE.test(id)) throw new Error(`Invalid phase id "${id}" in ${filePath}`);
    if (seenIds.has(id)) throw new Error(`Duplicate phase id "${id}" in ${filePath}`);
    seenIds.add(id);
    const kind = (p.kind ?? "role") as RoleWorkflowPhaseSpec["kind"];
    if (kind !== "role" && kind !== "gate" && kind !== "human") throw new Error(`workflow.phases[${i}].kind must be "role", "gate", or "human" in ${filePath}`);
    if (kind === "human" && p.prompt === undefined && p.brief === undefined) throw new Error(`Human phase "${id}" requires prompt or brief in ${filePath}`);
    if (kind === "gate" && p.exit_gate === undefined) throw new Error(`Gate phase "${id}" requires exit_gate in ${filePath}`);
    phases.push({
      id, kind,
      ...(p.title !== undefined ? { title: readStr(p.title, `workflow.phases[${i}].title`, filePath) } : {}),
      ...(p.depends_on !== undefined ? { dependsOn: readStrList(p.depends_on, `workflow.phases[${i}].depends_on`, filePath) } : {}),
      ...(p.tools !== undefined ? { tools: readStrList(p.tools, `workflow.phases[${i}].tools`, filePath) } : {}),
      ...(p.writable !== undefined ? { writable: readStrList(p.writable, `workflow.phases[${i}].writable`, filePath) } : {}),
      ...(p.lock_protected !== undefined ? { lockProtected: readStrList(p.lock_protected, `workflow.phases[${i}].lock_protected`, filePath) } : {}),
      ...(p.exit_artifacts !== undefined ? { exitArtifacts: readStrList(p.exit_artifacts, `workflow.phases[${i}].exit_artifacts`, filePath) } : {}),
      ...(p.exit_gate !== undefined ? { exitGate: parseExitGate(p.exit_gate, `workflow.phases[${i}].exit_gate`, filePath) } : {}),
      ...(p.prompt !== undefined ? { prompt: readStr(p.prompt, `workflow.phases[${i}].prompt`, filePath) } : {}),
      ...(p.brief !== undefined ? { brief: readStr(p.brief, `workflow.phases[${i}].brief`, filePath) } : {}),
      ...(typeof p.max_attempts === "number" ? { maxAttempts: p.max_attempts } : {}),
      ...(p.fallback_models !== undefined ? { fallbackModels: readStrList(p.fallback_models, `workflow.phases[${i}].fallback_models`, filePath) } : {}),
    });
  }

  let repairEntry: string | undefined;
  if (wf.repair_entry !== undefined) {
    repairEntry = readStr(wf.repair_entry, "workflow.repair_entry", filePath);
    if (!seenIds.has(repairEntry)) throw new Error(`workflow.repair_entry "${repairEntry}" not found in phases in ${filePath}`);
  }

  const depMap = new Map<string, string[]>();
  phases.forEach((ph, idx) => {
    const deps = ph.dependsOn ?? (idx === 0 ? [] : [phases[idx - 1]!.id]);
    for (const d of deps) {
      if (!seenIds.has(d)) throw new Error(`Phase "${ph.id}" depends_on unknown phase "${d}" in ${filePath}`);
      if (d === ph.id) throw new Error(`Phase "${ph.id}" cannot depend on itself in ${filePath}`);
    }
    depMap.set(ph.id, deps);
  });
  const visiting = new Set<string>(), visited = new Set<string>();
  const dfs = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Cycle detected in workflow.phases involving "${id}" in ${filePath}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const d of depMap.get(id) ?? []) dfs(d);
    visiting.delete(id); visited.add(id);
  };
  for (const ph of phases) dfs(ph.id);

  let cumulativeLocks: string[] = [];
  for (let i = 0; i < phases.length; i++) {
    const ph = phases[i]!;
    if ((ph.kind ?? "role") === "role") {
      const checked = applyPhasePermissions(baseRole, ph, cumulativeLocks, i === phases.length - 1);
      if (!checked.ok) throw new Error(`Invalid workflow in ${filePath}: ${checked.reason}`);
      cumulativeLocks = checked.nextCumulativeProtected;
    }
  }
  return { ...(session ? { session } : {}), ...(repairEntry ? { repairEntry } : {}), ...(maxRepairRounds !== undefined ? { maxRepairRounds } : {}), phases };
}

export function serializeRoleWorkflowYaml(workflow: RoleWorkflowSpec): string[] {
  const arr = (xs: readonly string[]) => `[${xs.map((s) => JSON.stringify(s)).join(", ")}]`;
  const lines = ["workflow:"];
  if (workflow.session !== undefined) lines.push(`  session: ${workflow.session}`);
  if (workflow.repairEntry !== undefined) lines.push(`  repair_entry: ${JSON.stringify(workflow.repairEntry)}`);
  if (workflow.maxRepairRounds !== undefined) lines.push(`  max_repair_rounds: ${workflow.maxRepairRounds}`);
  lines.push("  phases:");
  for (const ph of workflow.phases) {
    lines.push(`    - id: ${JSON.stringify(ph.id)}`);
    if (ph.title !== undefined) lines.push(`      title: ${JSON.stringify(ph.title)}`);
    if (ph.kind && ph.kind !== "role") lines.push(`      kind: ${ph.kind}`);
    if (ph.dependsOn !== undefined) lines.push(`      depends_on: ${arr(ph.dependsOn)}`);
    if (ph.tools !== undefined) lines.push(`      tools: ${arr(ph.tools)}`);
    if (ph.writable !== undefined) lines.push(`      writable: ${arr(ph.writable)}`);
    if (ph.lockProtected !== undefined) lines.push(`      lock_protected: ${arr(ph.lockProtected)}`);
    if (ph.exitArtifacts !== undefined) lines.push(`      exit_artifacts: ${arr(ph.exitArtifacts)}`);
    if (ph.exitGate) {
      lines.push("      exit_gate:", `        command: ${JSON.stringify(ph.exitGate.command)}`);
      if (ph.exitGate.timeoutSec !== undefined) lines.push(`        timeout_sec: ${ph.exitGate.timeoutSec}`);
      if (ph.exitGate.expectExitCode !== undefined) lines.push(`        expect_exit_code: ${ph.exitGate.expectExitCode}`);
      if (ph.exitGate.parseJsonMetricsPath !== undefined) lines.push(`        parse_json_metrics_path: ${JSON.stringify(ph.exitGate.parseJsonMetricsPath)}`);
    }
    if (ph.prompt !== undefined) lines.push(`      prompt: ${JSON.stringify(ph.prompt)}`);
    if (ph.brief !== undefined) lines.push(`      brief: ${JSON.stringify(ph.brief)}`);
    if (ph.maxAttempts !== undefined) lines.push(`      max_attempts: ${ph.maxAttempts}`);
    if (ph.fallbackModels !== undefined) lines.push(`      fallback_models: ${arr(ph.fallbackModels)}`);
  }
  return lines;
}
