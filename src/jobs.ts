import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BackgroundJob } from "./types.ts";
import type { EnhanceStore } from "./store.ts";

export interface StartBackgroundJobInput {
  store: EnhanceStore;
  cwd: string;
  command: string;
  mandateId?: string | null;
  hypothesisId?: string | null;
}

export function startBackgroundJob(input: StartBackgroundJobInput): BackgroundJob {
  const jobsDir = path.join(input.cwd, ".omp-enhance", "jobs");
  mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  const jobId = randomUUID();
  const logPath = path.join(jobsDir, `${jobId}.log`);
  const exitFilePath = path.join(jobsDir, `${jobId}.exit`);
  const logFd = openSync(logPath, "a");
  let child;
  try {
    const script = `${input.command}\n__omp_ec=$?\nprintf "%s\\n" "$__omp_ec" > ${JSON.stringify(exitFilePath)}\nexit "$__omp_ec"`;
    child = spawn("sh", ["-c", script], {
      cwd: input.cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  const job: BackgroundJob = {
    jobId,
    mandateId: input.mandateId ?? null,
    hypothesisId: input.hypothesisId ?? null,
    command: input.command,
    cwd: input.cwd,
    pid: child.pid!,
    pgid: child.pid!,
    logPath,
    exitFilePath,
    status: "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  input.store.saveJob(job);
  return job;
}

export function reconcileJobs(store: EnhanceStore): BackgroundJob[] {
  for (const job of store.listJobs("running")) {
    let next: Partial<BackgroundJob> | null = null;
    if (existsSync(job.exitFilePath)) {
      const code = Number.parseInt(readFileSync(job.exitFilePath, "utf8").trim(), 10);
      if (Number.isInteger(code)) {
        next = {
          status: code === 0 ? "completed" : "failed",
          exitCode: code,
          endedAt: new Date().toISOString(),
        };
      }
    } else {
      try {
        process.kill(job.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          next = { status: "unknown", endedAt: new Date().toISOString() };
        }
      }
    }
    if (next) store.saveJob({ ...job, ...next });
  }
  return store.listJobs();
}

export function cancelJob(store: EnhanceStore, jobId: string): BackgroundJob {
  reconcileJobs(store);
  const job = store.getJob(jobId);
  if (!job) throw new Error(`Job "${jobId}" not found.`);
  if (job.status !== "running") return job;
  try {
    process.kill(-job.pgid, "SIGTERM");
  } catch {
    process.kill(job.pid, "SIGTERM");
  }
  const cancelled: BackgroundJob = {
    ...job,
    status: "cancelled",
    endedAt: new Date().toISOString(),
  };
  store.saveJob(cancelled);
  return cancelled;
}

export function readJobLogTail(job: BackgroundJob, maxBytes = 4096): string {
  if (!existsSync(job.logPath)) return "";
  return readFileSync(job.logPath).subarray(-maxBytes).toString("utf8");
}
