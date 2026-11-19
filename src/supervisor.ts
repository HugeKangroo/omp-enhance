import { existsSync, statSync } from "node:fs";
import type { BackgroundJob, EnhanceSettings, RoleSpec, SupervisorDecision, SupervisorPulse } from "./types.ts";
import type { EnhanceStore } from "./store.ts";
import { cancelJob, readJobLogTail, reconcileJobs } from "./jobs.ts";
import { resolveRoleRuntimeConfig } from "./settings.ts";
export interface SupervisorInspector { evaluatePulse(pulse: SupervisorPulse, supervisorRole: RoleSpec): Promise<SupervisorDecision>; }
export interface SessionSupervisorControl { readonly aborted: boolean; readonly decisions: readonly SupervisorDecision[]; }
export interface SupervisedSessionResult<T> { result: T | null; decisions: SupervisorDecision[]; aborted: SupervisorDecision | null; }
export interface WatchBackgroundJobResult {
  status: "completed" | "failed" | "cancelled" | "unknown" | "aborted_by_supervisor";
  job: BackgroundJob; checks: number; decisions: SupervisorDecision[]; logTail: string;
}
export interface RunWithSessionSupervisorInput<T> {
  supervisorRole: RoleSpec; inspector: SupervisorInspector; goal: string;
  run: (control: SessionSupervisorControl) => Promise<T>; getPulse: () => { calls: number; summary: string };
  onSteer?: (message: string) => void | Promise<void>; onAbort?: () => void | Promise<void>;
  initialDelayMs?: number; minIntervalMs?: number; maxIntervalMs?: number;
}
export interface WatchBackgroundJobInput {
  store: EnhanceStore; jobId: string; goal?: string; supervisorRole: RoleSpec; inspector: SupervisorInspector;
  initialDelayMs?: number; minIntervalMs?: number; maxIntervalMs?: number; pollSliceMs?: number; signal?: AbortSignal;
}
const MIN_SEC = 5, MAX_SEC = 600, MIN_MS = 5_000, MAX_MS = 600_000;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function parseSupervisorDecision(rawText: string, fallbackSec = 60): SupervisorDecision | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawText);
  const source = fenced?.[1] ?? rawText;
  let value: unknown;
  try { value = JSON.parse(source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1)); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { action, reason: rawReason, nextCheckSec, evidence: rawEvidence, steerMessage: rawSteer } =
    value as Record<string, unknown>;
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if ((action !== "continue" && action !== "steer" && action !== "abort") || !reason) return null;
  const sec = typeof nextCheckSec === "number" && Number.isFinite(nextCheckSec)
    ? Math.round(nextCheckSec) : Math.round(fallbackSec);
  const evidence = typeof rawEvidence === "string" ? rawEvidence.trim() : "";
  const steer = typeof rawSteer === "string" ? rawSteer.trim() : "";
  return { action, reason, nextCheckSec: clamp(sec, MIN_SEC, MAX_SEC),
    ...(evidence ? { evidence } : {}), ...(steer ? { steerMessage: steer } : {}) };
}
function renderSupervisorPrompt(role: RoleSpec): string {
  return [
    `You are "${role.id}" (${role.name}), the runtime supervisor for omp-enhance.`,
    role.stance.trim(), "Method:", ...role.method.map((step, index) => `${index + 1}. ${step}`),
    ...(role.exit.criteria.length ? ["Exit criteria:", ...role.exit.criteria.map((item) => `- ${item}`)] : []),
    "Inspect the pulse and reply with ONLY a JSON object:",
    '{"action":"continue"|"steer"|"abort","reason":"...","nextCheckSec":60,"evidence":"...","steerMessage":"..."}',
    "Long runtime alone is not a reason to abort; abort only on concrete destructive evidence.",
  ].join("\n");
}
export function createOmpSupervisorInspector(pi: any, hostCtx: any, settings?: EnhanceSettings): SupervisorInspector {
  return { async evaluatePulse(pulse, supervisorRole) {
      const { model, thinkingLevel } = resolveRoleRuntimeConfig(supervisorRole, pi, hostCtx, settings);
      const created = await pi.pi.createAgentSession({
        cwd: hostCtx.cwd, modelRegistry: hostCtx.modelRegistry, ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        settings: pi.pi.settings, bindProcessState: false, disableExtensionDiscovery: true, noContextFiles: true,
        enableMCP: false, enableLsp: false, toolNames: [], customSystemPrompt: renderSupervisorPrompt(supervisorRole),
      });
      try {
        await created.session.prompt([
          "Runtime pulse:", JSON.stringify(pulse),
          'Reply ONLY with JSON: {"action":"continue"|"steer"|"abort","reason":"...","nextCheckSec":60,"evidence":"...","steerMessage":"..."}.',
        ].join("\n"));
        const text = created.session.getLastAssistantText?.() ?? "";
        const decision = parseSupervisorDecision(text);
        if (!decision) throw new Error(`Supervisor returned an invalid decision: ${text.slice(0, 500)}`);
        return decision;
      } finally {
        await created.session.dispose();
      }
    },
  };
}
function requireJob(store: EnhanceStore, jobId: string): BackgroundJob {
  const job = store.getJob(jobId);
  if (!job) throw new Error(`Job "${jobId}" not found.`);
  return job;
}
export async function watchBackgroundJob(input: WatchBackgroundJobInput): Promise<WatchBackgroundJobResult> {
  const initialDelayMs = input.initialDelayMs ?? 30_000, minIntervalMs = input.minIntervalMs ?? MIN_MS;
  const maxIntervalMs = input.maxIntervalMs ?? MAX_MS, pollSliceMs = input.pollSliceMs ?? 200;
  const startedMs = Date.now(), goal = input.goal ?? requireJob(input.store, input.jobId).command;
  const decisions: SupervisorDecision[] = [];
  let lastOutputMs = startedMs, lastSize = 0, observedSize = 0, checks = 0, nextWaitMs = Math.max(0, initialDelayMs);
  while (true) {
    const deadline = Date.now() + nextWaitMs;
    while (Date.now() < deadline) {
      if (input.signal?.aborted) throw new DOMException("Supervisor watch aborted.", "AbortError");
      await Bun.sleep(pollSliceMs);
      reconcileJobs(input.store);
      const job = requireJob(input.store, input.jobId);
      if (job.status !== "running") return { status: job.status, job, checks, decisions, logTail: readJobLogTail(job) };
      const size = existsSync(job.logPath) ? statSync(job.logPath).size : observedSize;
      if (size > observedSize) lastOutputMs = Date.now();
      observedSize = size;
    }
    reconcileJobs(input.store);
    const job = requireJob(input.store, input.jobId);
    if (job.status !== "running") return { status: job.status, job, checks, decisions, logTail: readJobLogTail(job) };
    const currentSize = existsSync(job.logPath) ? statSync(job.logPath).size : 0;
    const delta = Math.max(0, currentSize - lastSize), now = Date.now(), tail = readJobLogTail(job, 2500);
    lastSize = currentSize; observedSize = currentSize; checks += 1;
    const pulse: SupervisorPulse = { targetKind: "job", goal, checkNumber: checks, deltaBytesOrCalls: delta,
      elapsedSec: Math.round((now - startedMs) / 100) / 10, idleSec: Math.round((now - lastOutputMs) / 100) / 10,
      deltaSummary: `${delta > 0 ? `log grew by ${delta} bytes` : "no new log output"}${tail ? `; tail: ${tail.slice(-800).trim()}` : ""}` };
    const decision = await input.inspector.evaluatePulse(pulse, input.supervisorRole).catch(() => null);
    if (!decision) { nextWaitMs = clamp(30_000, minIntervalMs, maxIntervalMs); continue; }
    decisions.push(decision);
    if (decision.action === "abort") {
      return { status: "aborted_by_supervisor", job: cancelJob(input.store, input.jobId), checks, decisions, logTail: tail };
    }
    nextWaitMs = clamp(decision.nextCheckSec * 1000, minIntervalMs, maxIntervalMs);
  }
}
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
export async function runWithSessionSupervisor<T>(input: RunWithSessionSupervisorInput<T>): Promise<SupervisedSessionResult<T>> {
  const initialDelayMs = input.initialDelayMs ?? 30_000, minIntervalMs = input.minIntervalMs ?? MIN_MS;
  const maxIntervalMs = input.maxIntervalMs ?? MAX_MS, startedMs = Date.now();
  const decisions: SupervisorDecision[] = [];
  let aborted: SupervisorDecision | null = null, lastCalls = 0, lastActivityMs = startedMs;
  let nextWaitMs = Math.max(0, initialDelayMs);
  const control: SessionSupervisorControl = { get aborted() { return aborted !== null; }, get decisions() { return decisions; } };
  const settled: Promise<Settled<T>> = Promise.resolve().then(() => input.run(control))
    .then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
  while (true) {
    const timerTick = Promise.withResolvers<"tick">(), timer = setTimeout(timerTick.resolve, nextWaitMs);
    const tick = await Promise.race([settled.then((result) => ({ kind: "settled" as const, result })),
      timerTick.promise.then(() => ({ kind: "tick" as const }))]);
    clearTimeout(timer);
    if (tick.kind === "settled") {
      if (aborted) return { result: tick.result.ok ? tick.result.value : null, decisions, aborted };
      if (!tick.result.ok) throw tick.result.error;
      return { result: tick.result.value, decisions, aborted: null };
    }
    const snapshot = input.getPulse();
    if (snapshot.calls > lastCalls) lastActivityMs = Date.now();
    const delta = Math.max(0, snapshot.calls - lastCalls), now = Date.now();
    lastCalls = snapshot.calls;
    const pulse: SupervisorPulse = { targetKind: "role_session", goal: input.goal,
      checkNumber: decisions.length + 1, deltaBytesOrCalls: delta,
      elapsedSec: Math.round((now - startedMs) / 100) / 10, idleSec: Math.round((now - lastActivityMs) / 100) / 10,
      deltaSummary: snapshot.summary || (delta > 0 ? `${delta} new tool calls` : "no new tool calls") };
    const decision = await input.inspector.evaluatePulse(pulse, input.supervisorRole).catch(() => null);
    if (!decision) { nextWaitMs = clamp(30_000, minIntervalMs, maxIntervalMs); continue; }
    decisions.push(decision);
    if (decision.action === "abort") {
      aborted = decision; await input.onAbort?.(); const result = await settled;
      return { result: result.ok ? result.value : null, decisions, aborted };
    }
    if (decision.action === "steer") await input.onSteer?.(decision.steerMessage ?? decision.reason);
    nextWaitMs = clamp(decision.nextCheckSec * 1000, minIntervalMs, maxIntervalMs);
  }
}
