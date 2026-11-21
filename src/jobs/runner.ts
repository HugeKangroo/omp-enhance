import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { captureProcessStartToken, isProcessAliveWithToken, type EnhanceStore } from "../core/store.ts";
import type { BackgroundJob } from "../core/types.ts";

export interface StartBackgroundJobInput {
  store: EnhanceStore; cwd: string; command: string;
  mandateId?: string | null; hypothesisId?: string | null;
}

export interface CancelJobOptions { graceMs?: number }

const WRAPPER_SCRIPT = [
  "__omp_done=0",
  "__omp_write_exit() {",
  '  [ "$__omp_done" -eq 1 ] && return 0; __omp_done=1',
  '  __tmp="${OMP_ENHANCE_JOB_EXIT}.tmp.$$"',
  '  printf "%s\\n" "$1" > "$__tmp" 2>/dev/null && mv -f "$__tmp" "$OMP_ENHANCE_JOB_EXIT" 2>/dev/null || rm -f "$__tmp" 2>/dev/null',
  "}",
  "trap '__omp_write_exit 143; exit 143' TERM",
  "trap '__omp_write_exit 130; exit 130' INT",
  "trap '__omp_write_exit 129; exit 129' HUP",
  'sh -c "$OMP_ENHANCE_JOB_CMD"',
  '__omp_ec=$?; __omp_write_exit "$__omp_ec"; exit "$__omp_ec"',
].join("\n");

function parseExitCode(exitFilePath: string): number | null {
  if (!existsSync(exitFilePath)) return null;
  try {
    const raw = readFileSync(exitFilePath, "utf8").trim();
    if (!/^-?\d+$/.test(raw)) return null;
    const code = Number.parseInt(raw, 10);
    return Number.isSafeInteger(code) ? code : null;
  } catch { return null; }
}

function isProcessGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try { process.kill(-pgid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

export function startBackgroundJob(input: StartBackgroundJobInput): BackgroundJob {
  const jobsDir = path.join(input.cwd, ".omp-enhance", "jobs");
  mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  const jobId = randomUUID();
  const logPath = path.join(jobsDir, `${jobId}.log`), exitFilePath = path.join(jobsDir, `${jobId}.exit`);
  const logFd = openSync(logPath, "a");
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env, OMP_ENHANCE_SUBPROCESS: "1", OMP_ENHANCE_JOB_CMD: input.command, OMP_ENHANCE_JOB_EXIT: exitFilePath,
  };
  delete childEnv.OMP_ENHANCE_CMD_OUT;

  let child;
  try {
    child = spawn("sh", ["-c", WRAPPER_SCRIPT], { cwd: input.cwd, env: childEnv, detached: true, stdio: ["ignore", logFd, logFd] });
  } finally {
    closeSync(logFd);
  }
  child.on("error", () => {});
  if (typeof child.pid !== "number" || child.pid <= 0) throw new Error("Failed to spawn background job process.");

  const processStartToken = captureProcessStartToken(child.pid);
  child.unref();

  const job: BackgroundJob = {
    jobId, mandateId: input.mandateId ?? null, hypothesisId: input.hypothesisId ?? null,
    command: input.command, cwd: input.cwd, pid: child.pid, pgid: child.pid,
    ownerPid: process.pid, processStartToken, logPath, exitFilePath,
    status: "running", exitCode: null, startedAt: new Date().toISOString(), endedAt: null,
  };
  input.store.saveJob(job);
  return job;
}

function reconcileRunningJobRecord(store: EnhanceStore, job: BackgroundJob): BackgroundJob {
  if (job.status !== "running") return job;
  const finishWithCode = (code: number): BackgroundJob =>
    store.transitionJobStatus(job.jobId, ["running"], {
      status: code === 0 ? "completed" : "failed", exitCode: code, endedAt: new Date().toISOString(),
    }) ?? job;

  const first = parseExitCode(job.exitFilePath);
  if (first !== null) return finishWithCode(first);
  if (isProcessAliveWithToken(job.pid, job.processStartToken)) return job;

  const second = parseExitCode(job.exitFilePath);
  if (second !== null) return finishWithCode(second);
  return store.transitionJobStatus(job.jobId, ["running"], { status: "unknown", endedAt: new Date().toISOString() }) ?? job;
}

export function reconcileSingleJob(store: EnhanceStore, jobId: string): BackgroundJob | null {
  const job = store.getJob(jobId);
  return job ? (job.status === "running" ? reconcileRunningJobRecord(store, job) : job) : null;
}

export function reconcileJobs(store: EnhanceStore): BackgroundJob[] {
  for (const job of store.listJobs("running", 0)) reconcileRunningJobRecord(store, job);
  return store.listJobs();
}

export function cancelJob(store: EnhanceStore, jobId: string, options?: CancelJobOptions): BackgroundJob {
  const current = reconcileSingleJob(store, jobId);
  if (!current) throw new Error(`Job "${jobId}" not found.`);
  if (current.status !== "running") return current;

  if (isProcessAliveWithToken(current.pid, current.processStartToken)) {
    let sentGroup = false;
    if (current.pgid > 0) {
      try { process.kill(-current.pgid, "SIGTERM"); sentGroup = true; } catch {}
    }
    if (!sentGroup) {
      try { process.kill(current.pid, "SIGTERM"); } catch {}
    }
    const timer = setTimeout(() => {
      if (current.pgid > 0 && isProcessGroupAlive(current.pgid)) {
        try { process.kill(-current.pgid, "SIGKILL"); } catch {}
      }
      if (isProcessAliveWithToken(current.pid, current.processStartToken)) {
        try { process.kill(current.pid, "SIGKILL"); } catch {}
      }
    }, Math.max(10, options?.graceMs ?? 200));
    (timer as { unref?: () => void }).unref?.();
  }

  const endedAt = new Date().toISOString();
  return store.transitionJobStatus(jobId, ["running"], { status: "cancelled", endedAt })
    ?? store.getJob(jobId) ?? { ...current, status: "cancelled", endedAt };
}

export function readJobLogTail(job: BackgroundJob, maxBytes = 4096): string {
  const cap = Math.floor(maxBytes);
  if (cap <= 0 || !existsSync(job.logPath)) return "";
  let fd: number;
  try { fd = openSync(job.logPath, "r"); } catch { return ""; }
  try {
    const { size } = fstatSync(fd);
    if (size <= 0) return "";
    const length = Math.min(size, cap), offset = Math.max(0, size - length);
    const buffer = Buffer.allocUnsafe(length), bytesRead = readSync(fd, buffer, 0, length, offset);
    if (bytesRead <= 0) return "";
    let slice = buffer.subarray(0, bytesRead);
    if (offset > 0) {
      let start = 0;
      while (start < slice.length && start < 3 && (slice[start]! & 0xc0) === 0x80) start += 1;
      slice = slice.subarray(start);
    }
    return slice.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
