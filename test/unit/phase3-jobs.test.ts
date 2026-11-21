import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EnhanceStore } from "../../src/core/store.ts";
import {
  cancelJob,
  readJobLogTail,
  reconcileJobs,
  startBackgroundJob,
} from "../../src/jobs/runner.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-enhance-jobs-"));
  tempDirs.push(dir);
  return dir;
}

async function waitUntil(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await Bun.sleep(20);
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

describe("background jobs (src/jobs/runner.ts)", () => {
  test("reconciles a completed job across a store restart and records process identity", async () => {
    const cwd = tempDir();
    const dbPath = path.join(cwd, "state.sqlite");
    const store = new EnhanceStore(dbPath);
    let jobId: string;
    let exitFilePath: string;
    try {
      const job = startBackgroundJob({
        store,
        cwd,
        command: 'sleep 0.12 && echo "epoch_loss=0.12"',
      });
      jobId = job.jobId;
      exitFilePath = job.exitFilePath;
      expect(job.status).toBe("running");
      expect(job.exitCode).toBeNull();
      expect(job.pid).toBeGreaterThan(0);
      expect(job.pgid).toBe(job.pid);
      expect(job.ownerPid).toBe(process.pid);
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

  test("captures accurate exit codes for exit N, set -e failures, exec, and syntax errors", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const explicitExit = startBackgroundJob({ store, cwd, command: "echo before_exit; exit 42" });
      const errexitJob = startBackgroundJob({ store, cwd, command: "set -e\nfalse\necho never_printed" });
      const execJob = startBackgroundJob({ store, cwd, command: 'exec printf "exec_replaced_ok\\n"' });
      const syntaxJob = startBackgroundJob({ store, cwd, command: "if [" });

      await waitUntil(() =>
        [explicitExit, errexitJob, execJob, syntaxJob].every((j) => existsSync(j.exitFilePath)),
      );
      reconcileJobs(store);

      const j1 = store.getJob(explicitExit.jobId)!;
      expect(j1.status).toBe("failed");
      expect(j1.exitCode).toBe(42);
      expect(readJobLogTail(j1)).toContain("before_exit");

      const j2 = store.getJob(errexitJob.jobId)!;
      expect(j2.status).toBe("failed");
      expect(j2.exitCode).toBe(1);
      expect(readJobLogTail(j2)).not.toContain("never_printed");

      const j3 = store.getJob(execJob.jobId)!;
      expect(j3.status).toBe("completed");
      expect(j3.exitCode).toBe(0);
      expect(readJobLogTail(j3)).toContain("exec_replaced_ok");

      const j4 = store.getJob(syntaxJob.jobId)!;
      expect(j4.status).toBe("failed");
      expect(j4.exitCode).not.toBe(0);
      expect(j4.exitCode).not.toBeNull();
    } finally {
      store.close();
    }
  });

  test("does not shell-expand $VAR or backticks in cwd and sets OMP_ENHANCE_SUBPROCESS=1", async () => {
    const root = tempDir();
    const markerFile = path.join(root, "pwned");
    const trickyCwd = path.join(root, `dir-$HOME-\`touch "${markerFile}"\``);
    mkdirSync(trickyCwd, { recursive: true });
    const prevCmdOut = process.env.OMP_ENHANCE_CMD_OUT;
    process.env.OMP_ENHANCE_CMD_OUT = path.join(root, "should-not-inherit.out");

    const store = new EnhanceStore(path.join(root, "state.sqlite"));
    try {
      const job = startBackgroundJob({
        store,
        cwd: trickyCwd,
        command: 'printf "sub=%s|out=%s\\n" "$OMP_ENHANCE_SUBPROCESS" "$OMP_ENHANCE_CMD_OUT"',
      });
      await waitUntil(() => existsSync(job.exitFilePath));
      reconcileJobs(store);

      const done = store.getJob(job.jobId)!;
      expect(done.status).toBe("completed");
      expect(done.exitCode).toBe(0);
      expect(existsSync(markerFile)).toBe(false);
      expect(readJobLogTail(done)).toContain("sub=1|out=");
    } finally {
      if (prevCmdOut === undefined) delete process.env.OMP_ENHANCE_CMD_OUT;
      else process.env.OMP_ENHANCE_CMD_OUT = prevCmdOut;
      store.close();
    }
  });

  test("falls through to liveness check when .exit is 0-byte or corrupt instead of wedging running", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const job = startBackgroundJob({ store, cwd, command: "sleep 30" });
      try {
        process.kill(-job.pgid, "SIGKILL");
      } catch {}
      await waitUntil(() => !processAlive(job.pid));

      // Simulate disk-full / crash leaving an empty 0-byte .exit file on disk.
      writeFileSync(job.exitFilePath, "", "utf8");
      reconcileJobs(store);

      const reconciled = store.getJob(job.jobId)!;
      expect(reconciled.status).toBe("unknown");
      expect(reconciled.endedAt).not.toBeNull();
    } finally {
      store.close();
    }
  });

  test("protects unrelated processes from cancelJob when PID was reused after crash", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    const bystander = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore", detached: true });
    bystander.unref();
    const reusedPid = bystander.pid!;

    try {
      expect(processAlive(reusedPid)).toBe(true);
      store.saveJob({
        jobId: "stale-pid-reused-job",
        mandateId: null,
        hypothesisId: null,
        command: "python old_train.py",
        cwd,
        pid: reusedPid,
        pgid: reusedPid,
        ownerPid: 999999,
        processStartToken: "ps:Mon Jan  1 00:00:00 1990",
        logPath: path.join(cwd, "stale.log"),
        exitFilePath: path.join(cwd, "stale.exit"),
        status: "running",
        exitCode: null,
        startedAt: new Date(Date.now() - 3600_000).toISOString(),
        endedAt: null,
      });

      const result = cancelJob(store, "stale-pid-reused-job");
      // Mismatched processStartToken proves PID reuse: job becomes unknown and bystander is untouched!
      expect(result.status).toBe("unknown");
      expect(processAlive(reusedPid)).toBe(true);
    } finally {
      try {
        process.kill(-reusedPid, "SIGKILL");
      } catch {
        try { process.kill(reusedPid, "SIGKILL"); } catch {}
      }
      store.close();
    }
  });

  test("terminates grandchild processes and escalates SIGTERM -> SIGKILL without ESRCH crashes", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    const pidRecordPath = path.join(cwd, "grandchild.pid");
    const job = startBackgroundJob({
      store,
      cwd,
      command: `sh -c 'trap "" TERM; echo $$ > "${pidRecordPath}"; sleep 30' & wait`,
    });
    let grandchildPid = 0;

    try {
      await waitUntil(() => existsSync(pidRecordPath));
      await waitUntil(() => {
        const text = Bun.file(pidRecordPath);
        return text.size > 0;
      });
      const rawPid = await Bun.file(pidRecordPath).text();
      grandchildPid = Number.parseInt(rawPid.trim(), 10);
      expect(grandchildPid).toBeGreaterThan(0);
      expect(processAlive(grandchildPid)).toBe(true);

      const cancelled = cancelJob(store, job.jobId, { graceMs: 60 });
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.endedAt).not.toBeNull();
      expect(store.getJob(job.jobId)?.status).toBe("cancelled");

      // Grandchild ignored SIGTERM, so escalation must SIGKILL the process group cleanly.
      await waitUntil(() => !processAlive(job.pid) && !processAlive(grandchildPid), 3000);
      expect(processAlive(job.pid)).toBe(false);
      expect(processAlive(grandchildPid)).toBe(false);
    } finally {
      for (const pid of [job.pgid, grandchildPid]) {
        if (pid > 0) {
          try { process.kill(-pid, "SIGKILL"); } catch {}
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
      store.close();
    }
  });

  test("reads trailing bytes from large logs and strips split UTF-8 continuation bytes cleanly", () => {
    const cwd = tempDir();
    const logPath = path.join(cwd, "huge.log");
    const prefix = "x".repeat(256 * 1024);
    const tailBlock = "训练轮次完成：指标正常 🚀\n".repeat(20);
    writeFileSync(logPath, prefix + tailBlock, "utf8");

    const fakeJob = {
      jobId: "tail-test",
      mandateId: null,
      hypothesisId: null,
      command: "echo",
      cwd,
      pid: 1,
      pgid: 1,
      logPath,
      exitFilePath: path.join(cwd, "huge.exit"),
      status: "completed" as const,
      exitCode: 0,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };

    // Test multiple byte offsets to ensure mid-codepoint UTF-8 splits never produce U+FFFD.
    for (const maxBytes of [37, 38, 39, 40, 41, 128]) {
      const tail = readJobLogTail(fakeJob, maxBytes);
      expect(tail.length).toBeGreaterThan(0);
      expect(tail.includes("\uFFFD")).toBe(false);
      expect(tailBlock.endsWith(tail)).toBe(true);
    }
  });
});
