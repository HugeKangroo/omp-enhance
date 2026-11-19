import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cancelJob, readJobLogTail, reconcileJobs, startBackgroundJob } from "../../src/jobs.ts";
import { EnhanceStore } from "../../src/store.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-enhance-jobs-"));
  tempDirs.push(dir);
  return dir;
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await Bun.sleep(25);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("background jobs", () => {
  test("reconciles a completed job across a store restart", async () => {
    const cwd = tempDir();
    const dbPath = path.join(cwd, "state.sqlite");
    const store = new EnhanceStore(dbPath);
    let jobId: string;
    let exitFilePath: string;
    try {
      const job = startBackgroundJob({
        store,
        cwd,
        command: 'sleep 0.15 && echo "epoch_loss=0.12"',
      });
      jobId = job.jobId;
      exitFilePath = job.exitFilePath;
      expect(job.status).toBe("running");
      expect(job.exitCode).toBeNull();
      expect(job.pid).toBeGreaterThan(0);
      expect(job.pgid).toBe(job.pid);
      expect(store.getJob(job.jobId)?.status).toBe("running");
    } finally {
      store.close();
    }

    await waitUntil(() => existsSync(exitFilePath));
    const restarted = new EnhanceStore(dbPath);
    try {
      const jobs = reconcileJobs(restarted);
      const completed = jobs.find((job) => job.jobId === jobId);
      expect(completed?.status).toBe("completed");
      expect(completed?.exitCode).toBe(0);
      expect(completed?.endedAt).not.toBeNull();
      expect(readJobLogTail(completed!)).toContain("epoch_loss=0.12");
      expect(restarted.listJobs("running")).toEqual([]);
    } finally {
      restarted.close();
    }
  });

  test("cancels a long job and terminates its process group", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    const job = startBackgroundJob({ store, cwd, command: "sleep 30" });
    try {
      const cancelled = cancelJob(store, job.jobId);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.endedAt).not.toBeNull();
      expect(store.getJob(job.jobId)?.status).toBe("cancelled");
      await waitUntil(() => !processAlive(job.pid));
      expect(processAlive(job.pid)).toBe(false);
    } finally {
      try {
        process.kill(-job.pgid, "SIGKILL");
      } catch {
        // Already terminated.
      }
      store.close();
    }
  });
});
