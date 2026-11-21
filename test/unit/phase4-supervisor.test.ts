import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EnhanceStore } from "../../src/core/store.ts";
import type { RoleSpec, SupervisorDecision, SupervisorPulse } from "../../src/core/types.ts";
import ompEnhance from "../../src/entry.ts";
import {
  executeRoleFlow,
  executeRoleStep,
  type RoleSessionRunner,
} from "../../src/flow/orchestrator.ts";
import { cancelJob, startBackgroundJob } from "../../src/jobs/runner.ts";
import {
  computeErrorBackoffMs,
  parseSupervisorDecision,
  renderSupervisorPrompt,
  runWithSessionSupervisor,
  watchBackgroundJob,
  type SupervisorInspector,
} from "../../src/jobs/supervisor.ts";
import {
  createOmpRoleSessionRunner,
  createOmpSupervisorInspector,
} from "../../src/omp/session.ts";
import { discoverRoles } from "../../src/roles/loader.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-enhance-phase4-"));
  tempDirs.push(dir);
  return dir;
}

function rolesFor(cwd: string): Map<string, RoleSpec> {
  return discoverRoles({ cwd, globalRolesDir: path.join(cwd, "missing-global") });
}

function decision(
  action: SupervisorDecision["action"],
  overrides: Partial<SupervisorDecision> = {},
): SupervisorDecision {
  return { action, reason: `${action} reason`, nextCheckSec: 5, ...overrides };
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await Bun.sleep(10);
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

interface HarnessTool {
  name: string;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function createEntryHarness(cwd: string, root: string) {
  const tools = new Map<string, HarnessTool>();
  const handlers = new Map<string, Array<() => unknown>>();
  const pi = {
    on(name: string, handler: () => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: HarnessTool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage() {},
    getAllTools: () => [{ name: "read" }, { name: "bash" }],
    async setActiveTools() {},
    getThinkingLevel: () => "off",
    pi: { settings: {} },
  };
  ompEnhance(pi, {
    globalRolesDir: path.join(root, "global-roles"),
    builtinRolesDir: path.resolve(import.meta.dir, "../../roles"),
  });
  const ctx = { cwd, ui: { notify() {} }, modelRegistry: {} };
  return {
    async exec(name: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      const response = await tool.execute("call", params, signal, undefined, ctx);
      return JSON.parse(response.content[0]!.text) as Record<string, unknown>;
    },
    shutdown() {
      for (const handler of handlers.get("session_shutdown") ?? []) handler();
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("supervisor decision parsing & prompt rendering", () => {
  test("accepts plain, fenced, and prose-braced JSON, clamps intervals, and rejects malformed decisions", () => {
    expect(parseSupervisorDecision('{"action":"continue","reason":" training advances ","nextCheckSec":1}')).toEqual({
      action: "continue",
      reason: "training advances",
      nextCheckSec: 5,
    });
    expect(
      parseSupervisorDecision(
        '```json\n{"action":"abort","reason":"loss=NaN","nextCheckSec":9999,"evidence":"epoch 4"}\n```',
      ),
    ).toMatchObject({ action: "abort", nextCheckSec: 600, evidence: "epoch 4" });
    expect(
      parseSupervisorDecision(
        '{"action":"steer","reason":"off track","nextCheckSec":"60","steerMessage":"run tests"}',
      ),
    ).toMatchObject({ action: "steer", nextCheckSec: 60, steerMessage: "run tests" });

    // Regression B3.4: balanced JSON scanner handles surrounding prose containing `{...}` blocks
    expect(
      parseSupervisorDecision(
        'Evaluated pulse {"checkNumber":2,"idleSec":45} {note: non-json}: {"action":"abort","reason":"stuck on prompt","nextCheckSec":30}',
      ),
    ).toEqual({ action: "abort", reason: "stuck on prompt", nextCheckSec: 30 });

    expect(parseSupervisorDecision('{"action":"explode","reason":"x"}')).toBeNull();
    expect(parseSupervisorDecision('{"action":"abort","reason":"   "}')).toBeNull();
    expect(parseSupervisorDecision("not json at all")).toBeNull();
  });

  test("omits steer from job supervisor prompts and computes exponential error backoff (A9.1, B3.4)", () => {
    const cwd = tempDir();
    const role = rolesFor(cwd).get("supervisor")!;
    const jobPrompt = renderSupervisorPrompt(role, "job");
    const sessionPrompt = renderSupervisorPrompt(role, "role_session");

    expect(jobPrompt).toContain('"action":"continue"|"abort"');
    expect(jobPrompt).not.toContain('"steerMessage"');
    expect(jobPrompt).toContain("untrusted runtime telemetry");

    expect(sessionPrompt).toContain('"action":"continue"|"steer"|"abort"');
    expect(sessionPrompt).toContain('"steerMessage"');

    expect(computeErrorBackoffMs(1, 5_000, 600_000)).toBe(30_000);
    expect(computeErrorBackoffMs(2, 5_000, 600_000)).toBe(60_000);
    expect(computeErrorBackoffMs(3, 5_000, 600_000)).toBe(120_000);
    expect(computeErrorBackoffMs(20, 5_000, 600_000)).toBe(600_000);
  });
});

describe("background job supervision", () => {
  test("fast jobs complete before the initial delay with zero supervisor calls", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const job = startBackgroundJob({ store, cwd, command: 'sleep 0.02 && echo "finished_early"' });
      const inspector: SupervisorInspector = {
        async evaluatePulse() {
          throw new Error("supervisor must not run for fast jobs");
        },
      };
      const result = await watchBackgroundJob({
        store,
        jobId: job.jobId,
        goal: "fast job",
        supervisorRole: rolesFor(cwd).get("supervisor")!,
        inspector,
        initialDelayMs: 2000,
        pollSliceMs: 10,
      });
      expect(result.status).toBe("completed");
      expect(result.checks).toBe(0);
      expect(result.decisions).toEqual([]);
      expect(result.logTail).toContain("finished_early");
    } finally {
      store.close();
    }
  });

  test("adaptive continue decisions poll until natural completion and populate priorDecisions", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const job = startBackgroundJob({ store, cwd, command: 'sleep 0.18 && echo "epoch_done"' });
      const pulses: SupervisorPulse[] = [];
      const result = await watchBackgroundJob({
        store,
        jobId: job.jobId,
        goal: "train",
        supervisorRole: rolesFor(cwd).get("supervisor")!,
        inspector: {
          async evaluatePulse(pulse) {
            pulses.push(pulse);
            return decision("continue", { reason: `ok-${pulse.checkNumber}` });
          },
        },
        initialDelayMs: 10,
        minIntervalMs: 15,
        maxIntervalMs: 40,
        pollSliceMs: 10,
      });
      expect(result.status).toBe("completed");
      expect(result.checks).toBeGreaterThanOrEqual(2);
      expect(result.checks).toBe(pulses.length);
      expect(pulses[0]?.targetKind).toBe("job");
      expect(pulses[0]?.priorDecisions).toEqual([]);
      expect(pulses[1]?.priorDecisions).toEqual([
        { checkNumber: 1, action: "continue", reason: "ok-1" },
      ]);
      expect(result.logTail).toContain("epoch_done");
    } finally {
      store.close();
    }
  });

  test("idleSec advances only when new bytes arrive and frames untrusted log tails", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const job = startBackgroundJob({
        store,
        cwd,
        command: 'sleep 0.04 && echo "progress >>> inject"; sleep 0.55',
      });
      const pulses: SupervisorPulse[] = [];
      const result = await watchBackgroundJob({
        store,
        jobId: job.jobId,
        goal: "idle tracking",
        supervisorRole: rolesFor(cwd).get("supervisor")!,
        inspector: {
          async evaluatePulse(pulse) {
            pulses.push(pulse);
            return decision("continue");
          },
        },
        initialDelayMs: 10,
        minIntervalMs: 10,
        maxIntervalMs: 500,
        pollSliceMs: 15,
      });
      expect(result.status).toBe("completed");
      expect(pulses.length).toBeGreaterThanOrEqual(2);
      expect(pulses.at(-1)?.idleSec).toBeGreaterThan(0.15);
      expect(pulses.at(-1)?.deltaSummary).toContain("untrusted_log_tail: <<<");
      expect(pulses.at(-1)?.deltaSummary).not.toContain("inject>>>>>>");
    } finally {
      store.close();
    }
  });

  test("attaching to a pre-existing running job uses job.startedAt and existing log size/mtime", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    const job = startBackgroundJob({ store, cwd, command: "sleep 30" });
    try {
      const tenMinAgo = new Date(Date.now() - 600_000);
      const nineMinAgo = new Date(Date.now() - 540_000);
      writeFileSync(job.logPath, "old_banner_output\n", "utf8");
      utimesSync(job.logPath, nineMinAgo, nineMinAgo);
      store.saveJob({ ...job, startedAt: tenMinAgo.toISOString() });

      const pulses: SupervisorPulse[] = [];
      const result = await watchBackgroundJob({
        store,
        jobId: job.jobId,
        goal: "attach pre-existing",
        supervisorRole: rolesFor(cwd).get("supervisor")!,
        inspector: {
          async evaluatePulse(pulse) {
            pulses.push(pulse);
            return decision("abort", { reason: "hung for 9m" });
          },
        },
        initialDelayMs: 10,
        minIntervalMs: 10,
        maxIntervalMs: 30,
        pollSliceMs: 5,
      });

      expect(result.status).toBe("aborted_by_supervisor");
      expect(pulses).toHaveLength(1);
      expect(pulses[0]!.elapsedSec).toBeGreaterThan(590);
      expect(pulses[0]!.idleSec).toBeGreaterThan(530);
      expect(pulses[0]!.deltaBytesOrCalls).toBe(0);
      expect(pulses[0]!.deltaSummary).toContain("no new log output");
      await waitUntil(() => !processAlive(job.pid));
    } finally {
      try { cancelJob(store, job.jobId, { graceMs: 20 }); } catch {}
      store.close();
    }
  });

  test("supervisorEnabled=false polls job to completion with zero @advisor calls (A9.2)", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const job = startBackgroundJob({ store, cwd, command: 'sleep 0.06 && echo "unsupervised_ok"' });
      let inspectorCalled = 0;
      const result = await watchBackgroundJob({
        store,
        jobId: job.jobId,
        supervisorEnabled: false,
        supervisorRole: rolesFor(cwd).get("supervisor")!,
        inspector: {
          async evaluatePulse() {
            inspectorCalled += 1;
            return decision("abort");
          },
        },
        initialDelayMs: 5,
        pollSliceMs: 10,
      });
      expect(result.status).toBe("completed");
      expect(inspectorCalled).toBe(0);
      expect(result.checks).toBe(0);
      expect(result.logTail).toContain("unsupervised_ok");
    } finally {
      store.close();
    }
  });

  test("job finishing while evaluatePulse is in flight is NOT clobbered by a late abort (B3.1)", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const job = startBackgroundJob({ store, cwd, command: 'sleep 0.06 && echo "clean_finish"' });
      const result = await watchBackgroundJob({
        store,
        jobId: job.jobId,
        goal: "race",
        supervisorRole: rolesFor(cwd).get("supervisor")!,
        inspector: {
          async evaluatePulse() {
            await Bun.sleep(250);
            return decision("abort", { reason: "stale abort" });
          },
        },
        initialDelayMs: 10,
        pollSliceMs: 10,
      });
      expect(result.status).toBe("completed");
      expect(result.job.status).toBe("completed");
      expect(result.logTail).toContain("clean_finish");
    } finally {
      store.close();
    }
  });

  test("AbortSignal cancels watchBackgroundJob immediately without killing the running job (B3.2)", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    const job = startBackgroundJob({ store, cwd, command: "sleep 30" });
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 35);
      await expect(
        watchBackgroundJob({
          store,
          jobId: job.jobId,
          supervisorRole: rolesFor(cwd).get("supervisor")!,
          inspector: {
            async evaluatePulse() {
              await Bun.sleep(5_000);
              return decision("continue");
            },
          },
          initialDelayMs: 10,
          pollSliceMs: 10,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/aborted/i);

      // Watch was cancelled, but the background job itself remains alive until explicitly cancelled.
      expect(processAlive(job.pid)).toBe(true);
    } finally {
      cancelJob(store, job.jobId, { graceMs: 20 });
      await waitUntil(() => !processAlive(job.pid));
      store.close();
    }
  });

  test("abort terminates the process group and reports aborted_by_supervisor", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const job = startBackgroundJob({ store, cwd, command: 'echo "loss=NaN"; sleep 30' });
      const pulses: SupervisorPulse[] = [];
      const result = await watchBackgroundJob({
        store,
        jobId: job.jobId,
        goal: "train",
        supervisorRole: rolesFor(cwd).get("supervisor")!,
        inspector: {
          async evaluatePulse(pulse) {
            pulses.push(pulse);
            return pulse.deltaSummary.includes("loss=NaN")
              ? decision("abort", { reason: "loss=NaN", evidence: "loss=NaN" })
              : decision("continue");
          },
        },
        initialDelayMs: 10,
        minIntervalMs: 5,
        maxIntervalMs: 20,
        pollSliceMs: 5,
      });
      expect(result.status).toBe("aborted_by_supervisor");
      expect(result.checks).toBe(pulses.length);
      expect(pulses.at(-1)?.deltaSummary).toContain("loss=NaN");
      expect(result.decisions.at(-1)?.reason).toBe("loss=NaN");
      expect(result.job.status).toBe("cancelled");
      expect(store.getJob(job.jobId)?.status).toBe("cancelled");
      await waitUntil(() => !processAlive(job.pid));
    } finally {
      store.close();
    }
  });

  test("monitor errors fail open and apply exponential backoff", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const job = startBackgroundJob({ store, cwd, command: 'sleep 0.22 && echo "still_healthy"' });
      let calls = 0;
      const result = await watchBackgroundJob({
        store,
        jobId: job.jobId,
        goal: "train",
        supervisorRole: rolesFor(cwd).get("supervisor")!,
        inspector: {
          async evaluatePulse() {
            calls += 1;
            throw new Error("transient model outage");
          },
        },
        initialDelayMs: 10,
        minIntervalMs: 10,
        maxIntervalMs: 30,
        pollSliceMs: 10,
      });
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(result.status).toBe("completed");
      expect(result.decisions).toEqual([]);
      expect(store.getJob(job.jobId)?.status).toBe("completed");
      expect(result.logTail).toContain("still_healthy");
    } finally {
      store.close();
    }
  });

  test("enhance_job watch starts and supervises a fast job through the extension", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    const harness = createEntryHarness(cwd, root);
    try {
      const payload = await harness.exec("enhance_job", {
        action: "watch",
        command: 'sleep 0.02 && echo "watch_done"',
        initialDelaySec: 5,
        goal: "watch wiring",
      });
      expect(payload.started).toBe(true);
      expect(payload.status).toBe("completed");
      expect(payload.checks).toBe(0);
      expect(payload.decisions).toEqual([]);
      expect(String(payload.logTail)).toContain("watch_done");
    } finally {
      harness.shutdown();
    }
  });
});

describe("role session supervision", () => {
  test("steer delivers guidance and fails open if onSteer throws", async () => {
    const cwd = tempDir();
    const supervisorRole = rolesFor(cwd).get("supervisor")!;
    const steers: string[] = [];
    const gate = Promise.withResolvers<void>();
    const result = await runWithSessionSupervisor({
      supervisorRole,
      goal: "repair the build",
      inspector: {
        async evaluatePulse(pulse) {
          return pulse.checkNumber === 1
            ? decision("steer", { reason: "try once", steerMessage: "first steer throws", nextCheckSec: 5 })
            : decision("steer", { reason: "stuck on wrong test", steerMessage: "focus on failing.test.ts" });
        },
      },
      run: async () => {
        await gate.promise;
        return "session finished";
      },
      getPulse: () => ({ calls: 2, summary: "bash:error, bash:error" }),
      onSteer: (message) => {
        steers.push(message);
        if (steers.length === 1) throw new Error("session temporarily busy");
        gate.resolve();
      },
      initialDelayMs: 5,
      minIntervalMs: 5,
      maxIntervalMs: 15,
    });
    expect(result.result).toBe("session finished");
    expect(result.aborted).toBeNull();
    expect(result.decisions).toHaveLength(2);
    expect(steers).toEqual(["first steer throws", "focus on failing.test.ts"]);
  });

  test("reports activeTool without repeating stale :error summaries and caps priorDecisions at 5 (A9.1)", async () => {
    const cwd = tempDir();
    const supervisorRole = rolesFor(cwd).get("supervisor")!;
    const pulses: SupervisorPulse[] = [];
    const gate = Promise.withResolvers<void>();

    const result = await runWithSessionSupervisor({
      supervisorRole,
      goal: "long test run",
      inspector: {
        async evaluatePulse(pulse) {
          pulses.push(pulse);
          if (pulses.length >= 7) gate.resolve();
          return decision("continue", { reason: `step-${pulse.checkNumber}`, nextCheckSec: 5 });
        },
      },
      run: async () => {
        await gate.promise;
        return "done";
      },
      getPulse: () =>
        pulses.length === 0
          ? { calls: 1, summary: "bash:error" }
          : pulses.length === 1
            ? {
                calls: 1,
                summary: "bash:error",
                activeTool: { name: "bash", elapsedSec: 38, summary: "bash bun test" },
              }
            : { calls: 1, summary: "bash:error", activeTool: null },
      initialDelayMs: 5,
      minIntervalMs: 5,
      maxIntervalMs: 8,
    });

    expect(result.result).toBe("done");
    // Pulse 1 had delta=1 -> includes "bash:error"
    expect(pulses[0]!.deltaSummary).toBe("bash:error");
    // Pulse 2 had delta=0 while activeTool was running -> idleSec=0, reports activeTool, NOT stale bash:error!
    expect(pulses[1]!.idleSec).toBe(0);
    expect(pulses[1]!.activeTool).toEqual({ name: "bash", elapsedSec: 38, summary: "bash bun test" });
    expect(pulses[1]!.deltaSummary).toContain("active tool running: bash bun test");
    expect(pulses[1]!.deltaSummary).not.toContain("bash:error");
    // Pulse 3 had delta=0 and no activeTool -> "no new tool calls" (not stale bash:error)
    expect(pulses[2]!.deltaSummary).toBe("no new tool calls");
    // Pulse 7 carries only the last 5 prior decisions (checks 2..6)
    expect(pulses[6]!.priorDecisions).toHaveLength(5);
    expect(pulses[6]!.priorDecisions![0]!.checkNumber).toBe(2);
    expect(pulses[6]!.priorDecisions![4]!.checkNumber).toBe(6);
  });

  test("session completing while evaluatePulse is in flight is NOT clobbered by a late abort (B3.1)", async () => {
    const cwd = tempDir();
    const supervisorRole = rolesFor(cwd).get("supervisor")!;
    let onAbortCalled = false;

    const result = await runWithSessionSupervisor({
      supervisorRole,
      goal: "race completion",
      inspector: {
        async evaluatePulse() {
          await Bun.sleep(250);
          return decision("abort", { reason: "stale advisor decision" });
        },
      },
      run: async () => {
        await Bun.sleep(30);
        return "verified_envelope";
      },
      getPulse: () => ({ calls: 1, summary: "read" }),
      onAbort: () => {
        onAbortCalled = true;
      },
      initialDelayMs: 5,
      minIntervalMs: 5,
      maxIntervalMs: 20,
    });

    expect(result.result).toBe("verified_envelope");
    expect(result.aborted).toBeNull();
    expect(onAbortCalled).toBe(false);
  });

  test("abort aborts a stuck role session and executeRoleStep reports aborted_by_supervisor", async () => {
    const cwd = tempDir();
    const roles = rolesFor(cwd);
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const state = { aborted: false, prompted: [] as string[] };
      const gate = Promise.withResolvers<void>();
      const session = {
        messages: [],
        async prompt(text: string) {
          state.prompted.push(text);
          await gate.promise;
        },
        steer() {},
        abort() {
          state.aborted = true;
          gate.resolve();
        },
        getLastAssistantText: () => "",
        getLastAssistantMessage: () => null,
        async dispose() {},
      };
      const fakePi = {
        getAllTools: () => [{ name: "read" }, { name: "bash" }],
        getThinkingLevel: () => "off",
        pi: {
          settings: {},
          SessionManager: { inMemory: () => ({ kind: "mem" }) },
          async createAgentSession() {
            return { session };
          },
        },
      };
      const mandate = store.upsertMandate({ goal: "fix a stuck job" });
      const result = await executeRoleStep({
        cwd,
        store,
        role: roles.get("dev")!,
        mandate,
        upstreamHandoff: null,
        toTarget: "user",
        runner: createOmpRoleSessionRunner(fakePi, { cwd, modelRegistry: {} }),
        supervisor: {
          role: roles.get("supervisor")!,
          inspector: {
            async evaluatePulse() {
              return decision("abort", { reason: "waiting on stdin forever" });
            },
          },
          initialDelayMs: 10,
          minIntervalMs: 10,
          maxIntervalMs: 20,
        },
      });
      expect(result).toMatchObject({
        ok: false,
        status: "aborted_by_supervisor",
        reason: "waiting on stdin forever",
      });
      if (!result.ok && result.status === "aborted_by_supervisor") {
        expect(result.decision.action).toBe("abort");
      }
      expect(state.aborted).toBe(true);
      expect(state.prompted).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("executeRoleFlow propagates aborted_by_supervisor from a step", async () => {
    const cwd = tempDir();
    const roles = rolesFor(cwd);
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const mandate = store.upsertMandate({ goal: "flow abort" });
      const abort = decision("abort", { reason: "session deadlocked" });
      const runner: RoleSessionRunner = {
        async runRoleTurn() {
          return {
            envelope: null,
            observedCalls: [],
            assistantText: "",
            usage: null,
            abortedBySupervisor: abort,
          };
        },
      };
      const result = await executeRoleFlow({
        cwd,
        store,
        mandate,
        runner,
        roles: [roles.get("dev")!],
      });
      expect(result.status).toBe("aborted_by_supervisor");
      expect(result.steps).toEqual([]);
      expect(result.reason).toBe("session deadlocked");
    } finally {
      store.close();
    }
  });
});

describe("OMP supervisor inspector (src/omp/session.ts)", () => {
  test("creates an isolated in-memory tool-free session and protects host modelRegistry", async () => {
    const cwd = tempDir();
    const supervisorRole = rolesFor(cwd).get("supervisor")!;
    let captured: Record<string, unknown> | null = null;
    let prompted = "";
    let cleared = false;
    const inMem = { id: "in-memory-session" };
    const pi = {
      pi: {
        settings: { theme: "dark" },
        SessionManager: { inMemory: () => inMem },
        async createAgentSession(options: Record<string, unknown>) {
          captured = options;
          return {
            session: {
              async prompt(text: string) {
                prompted = text;
              },
              getLastAssistantText: () =>
                '```json\n{"action":"continue","reason":"normal training","nextCheckSec":120}\n```',
              async dispose() {},
            },
          };
        },
      },
    };
    const hostCtx = {
      cwd,
      modelRegistry: {
        authStorage: { ok: true },
        clearSourceRegistrations() {
          cleared = true;
        },
      },
      model: "fallback-model",
      models: { resolve: (name: string) => (name === "@advisor" ? "advisor-model" : undefined) },
    };
    const inspector = createOmpSupervisorInspector(pi, hostCtx);
    const pulse: SupervisorPulse = {
      targetKind: "job",
      goal: "train",
      checkNumber: 1,
      elapsedSec: 30,
      idleSec: 1,
      deltaBytesOrCalls: 42,
      deltaSummary: "log grew",
    };
    const result = await inspector.evaluatePulse(pulse, supervisorRole);
    expect(result).toEqual({ action: "continue", reason: "normal training", nextCheckSec: 120 });
    expect(captured).not.toBeNull();
    expect(captured!.model).toBe("advisor-model");
    expect(captured!.thinkingLevel).toBe("off");
    expect(captured!.sessionManager).toBe(inMem);
    expect(captured!.hasUI).toBe(false);
    expect(captured!.restrictToolNames).toBe(true);
    expect(captured!.toolNames).toEqual([]);
    expect(captured!.skills).toEqual([]);
    expect(captured!.rules).toEqual([]);
    expect(captured!.enableMCP).toBe(false);
    expect(captured!.enableLsp).toBe(false);
    expect(captured!.noContextFiles).toBe(true);
    expect(captured!.bindProcessState).toBe(false);
    // Verify modelRegistry proxy blocks clearSourceRegistrations from mutating host registry (A4)
    (captured!.modelRegistry as { clearSourceRegistrations: () => void }).clearSourceRegistrations();
    expect(cleared).toBe(false);
    expect(String(captured!.customSystemPrompt)).toContain("runtime supervisor");
    expect(String(captured!.customSystemPrompt)).not.toContain('"steerMessage"');
    expect(prompted).toContain('"goal":"train"');
    expect(prompted).not.toContain('"steerMessage"');
  });
});
