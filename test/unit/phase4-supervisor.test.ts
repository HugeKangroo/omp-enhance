import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createOmpSupervisorInspector, parseSupervisorDecision, runWithSessionSupervisor,
  watchBackgroundJob, type SupervisorInspector,
} from "../../src/supervisor.ts";
import { startBackgroundJob } from "../../src/jobs.ts";
import { EnhanceStore } from "../../src/store.ts";
import { discoverRoles } from "../../src/role-loader.ts";
import {
  createOmpRoleSessionRunner, executeRoleFlow, executeRoleStep,
  type RoleSessionRunner,
} from "../../src/orchestrator.ts";
import type { RoleSpec, SupervisorDecision, SupervisorPulse } from "../../src/types.ts";
import ompEnhance from "../../src/entry.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-enhance-phase4-"));
  tempDirs.push(dir);
  return dir;
}

function rolesFor(cwd: string): Map<string, RoleSpec> {
  return discoverRoles({ cwd, globalRolesDir: path.join(cwd, "missing-global") });
}

function decision(action: SupervisorDecision["action"], overrides: Partial<SupervisorDecision> = {}): SupervisorDecision {
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
    signal?: unknown,
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
    registerTool(tool: HarnessTool) { tools.set(tool.name, tool); },
    registerCommand() {},
    sendMessage() {},
    getAllTools: () => [{ name: "read" }],
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
    async exec(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      const response = await tool.execute("call", params, undefined, undefined, ctx);
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

describe("supervisor decision parsing", () => {
  test("accepts plain and fenced JSON, clamps intervals, and rejects malformed decisions", () => {
    expect(parseSupervisorDecision('{"action":"continue","reason":" training advances ","nextCheckSec":1}'))
      .toEqual({ action: "continue", reason: "training advances", nextCheckSec: 5 });
    expect(parseSupervisorDecision('```json\n{"action":"abort","reason":"loss=NaN","nextCheckSec":9999,"evidence":"epoch 4"}\n```'))
      .toMatchObject({ action: "abort", nextCheckSec: 600, evidence: "epoch 4" });
    expect(parseSupervisorDecision('{"action":"steer","reason":"off track","nextCheckSec":"60","steerMessage":"run tests"}'))
      .toMatchObject({ action: "steer", nextCheckSec: 60, steerMessage: "run tests" });
    expect(parseSupervisorDecision('{"action":"explode","reason":"x"}')).toBeNull();
    expect(parseSupervisorDecision('{"action":"abort","reason":"   "}')).toBeNull();
    expect(parseSupervisorDecision("not json at all")).toBeNull();
  });
});

describe("background job supervision", () => {
  // Real timers and detached processes are the system under test here: fake clocks cannot
  // drive shell jobs, log growth, or exit-file reconciliation.
  test("fast jobs complete before the initial delay with zero supervisor calls", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const job = startBackgroundJob({ store, cwd, command: 'sleep 0.02 && echo "finished_early"' });
      const inspector: SupervisorInspector = {
        async evaluatePulse() { throw new Error("supervisor must not run for fast jobs"); },
      };
      const result = await watchBackgroundJob({
        store, jobId: job.jobId, goal: "fast job", supervisorRole: rolesFor(cwd).get("supervisor")!,
        inspector, initialDelayMs: 2000, pollSliceMs: 10,
      });
      expect(result.status).toBe("completed");
      expect(result.checks).toBe(0);
      expect(result.decisions).toEqual([]);
      expect(result.logTail).toContain("finished_early");
    } finally {
      store.close();
    }
  });

  test("adaptive continue decisions poll until natural completion", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const job = startBackgroundJob({ store, cwd, command: 'sleep 0.18 && echo "epoch_done"' });
      const pulses: SupervisorPulse[] = [];
      const result = await watchBackgroundJob({
        store, jobId: job.jobId, goal: "train", supervisorRole: rolesFor(cwd).get("supervisor")!,
        inspector: { async evaluatePulse(pulse) { pulses.push(pulse); return decision("continue"); } },
        initialDelayMs: 10, minIntervalMs: 15, maxIntervalMs: 40, pollSliceMs: 10,
      });
      expect(result.status).toBe("completed");
      expect(result.checks).toBeGreaterThanOrEqual(2);
      expect(result.checks).toBe(pulses.length);
      expect(result.decisions.every((item) => item.action === "continue")).toBe(true);
      expect(pulses[0]?.targetKind).toBe("job");
      expect(pulses[0]?.goal).toBe("train");
      expect(result.logTail).toContain("epoch_done");
    } finally {
      store.close();
    }
  });

  test("idleSec advances only when genuinely new bytes arrive between inspections", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const job = startBackgroundJob({ store, cwd, command: 'sleep 0.05 && echo "progress"; sleep 0.8' });
      const pulses: SupervisorPulse[] = [];
      const result = await watchBackgroundJob({
        store, jobId: job.jobId, goal: "idle tracking", supervisorRole: rolesFor(cwd).get("supervisor")!,
        inspector: { async evaluatePulse(pulse) { pulses.push(pulse); return decision("continue"); } },
        initialDelayMs: 10, minIntervalMs: 10, maxIntervalMs: 700, pollSliceMs: 20,
      });
      expect(result.status).toBe("completed");
      expect(pulses.length).toBeGreaterThanOrEqual(2);
      expect(pulses[1]?.idleSec).toBeGreaterThan(0.2);
    } finally {
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
        store, jobId: job.jobId, goal: "train", supervisorRole: rolesFor(cwd).get("supervisor")!,
        inspector: {
          async evaluatePulse(pulse) {
            pulses.push(pulse);
            return pulse.deltaSummary.includes("loss=NaN")
              ? decision("abort", { reason: "loss=NaN", evidence: "loss=NaN" })
              : decision("continue");
          },
        },
        initialDelayMs: 10, minIntervalMs: 5, maxIntervalMs: 20, pollSliceMs: 5,
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

  test("monitor errors fail open and leave a healthy job running to completion", async () => {
    const cwd = tempDir();
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const job = startBackgroundJob({ store, cwd, command: 'sleep 0.25 && echo "still_healthy"' });
      let calls = 0;
      const result = await watchBackgroundJob({
        store, jobId: job.jobId, goal: "train", supervisorRole: rolesFor(cwd).get("supervisor")!,
        inspector: { async evaluatePulse() { calls += 1; throw new Error("transient model outage"); } },
        initialDelayMs: 10, minIntervalMs: 10, maxIntervalMs: 30, pollSliceMs: 10,
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
        action: "watch", command: 'sleep 0.02 && echo "watch_done"', initialDelaySec: 5, goal: "watch wiring",
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
  test("steer delivers guidance to a long-running session", async () => {
    const cwd = tempDir();
    const supervisorRole = rolesFor(cwd).get("supervisor")!;
    const steers: string[] = [];
    const gate = Promise.withResolvers<void>();
    const result = await runWithSessionSupervisor({
      supervisorRole, goal: "repair the build",
      inspector: {
        async evaluatePulse() {
          return decision("steer", { reason: "stuck on the wrong test", steerMessage: "focus on failing.test.ts" });
        },
      },
      run: async () => {
        await gate.promise;
        return "session finished";
      },
      getPulse: () => ({ calls: 2, summary: "bash:error, bash:error" }),
      onSteer: (message) => { steers.push(message); gate.resolve(); },
      initialDelayMs: 10, minIntervalMs: 10, maxIntervalMs: 20,
    });
    expect(result.result).toBe("session finished");
    expect(result.aborted).toBeNull();
    expect(result.decisions).toHaveLength(1);
    expect(steers).toEqual(["focus on failing.test.ts"]);
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
        abort() { state.aborted = true; gate.resolve(); },
        getLastAssistantText: () => "",
        getLastAssistantMessage: () => null,
        async dispose() {},
      };
      const fakePi = {
        getAllTools: () => [{ name: "read" }, { name: "bash" }],
        getThinkingLevel: () => "off",
        pi: { settings: {}, async createAgentSession() { return { session }; } },
      };
      const mandate = store.upsertMandate({ goal: "fix a stuck job" });
      const result = await executeRoleStep({
        cwd, store, role: roles.get("dev")!, mandate, upstreamHandoff: null, toTarget: "user",
        runner: createOmpRoleSessionRunner(fakePi, { modelRegistry: {} }),
        supervisor: {
          role: roles.get("supervisor")!,
          inspector: { async evaluatePulse() { return decision("abort", { reason: "waiting on stdin forever" }); } },
          initialDelayMs: 10, minIntervalMs: 10, maxIntervalMs: 20,
        },
      });
      expect(result).toMatchObject({
        ok: false, status: "aborted_by_supervisor", reason: "waiting on stdin forever",
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
          return { envelope: null, observedCalls: [], assistantText: "", usage: null, abortedBySupervisor: abort };
        },
      };
      const result = await executeRoleFlow({ cwd, store, mandate, runner, roles: [roles.get("dev")!] });
      expect(result.status).toBe("aborted_by_supervisor");
      expect(result.steps).toEqual([]);
      expect(result.reason).toBe("session deadlocked");
    } finally {
      store.close();
    }
  });
});

describe("OMP supervisor inspector", () => {
  test("creates a tool-free lightweight session and parses its decision", async () => {
    const cwd = tempDir();
    const supervisorRole = rolesFor(cwd).get("supervisor")!;
    let captured: Record<string, unknown> | null = null;
    let prompted = "";
    const pi = {
      pi: {
        settings: { theme: "dark" },
        async createAgentSession(options: Record<string, unknown>) {
          captured = options;
          return {
            session: {
              async prompt(text: string) { prompted = text; },
              getLastAssistantText: () => '```json\n{"action":"continue","reason":"normal training","nextCheckSec":120}\n```',
              async dispose() {},
            },
          };
        },
      },
    };
    const hostCtx = {
      cwd, modelRegistry: {}, model: "fallback-model",
      models: { resolve: (name: string) => name === "@advisor" ? "advisor-model" : undefined },
    };
    const inspector = createOmpSupervisorInspector(pi, hostCtx);
    const pulse: SupervisorPulse = {
      targetKind: "job", goal: "train", checkNumber: 1,
      elapsedSec: 30, idleSec: 1, deltaBytesOrCalls: 42, deltaSummary: "log grew",
    };
    const result = await inspector.evaluatePulse(pulse, supervisorRole);
    expect(result).toEqual({ action: "continue", reason: "normal training", nextCheckSec: 120 });
    expect(captured).not.toBeNull();
    expect(captured!.model).toBe("advisor-model");
    expect(captured!.thinkingLevel).toBe("off");
    expect(captured!.modelRegistry).toBe(hostCtx.modelRegistry);
    expect(captured!.toolNames).toEqual([]);
    expect(captured!.enableMCP).toBe(false);
    expect(captured!.enableLsp).toBe(false);
    expect(captured!.noContextFiles).toBe(true);
    expect(captured!.bindProcessState).toBe(false);
    expect(String(captured!.customSystemPrompt)).toContain("runtime supervisor");
    expect(prompted).toContain('"goal":"train"');
  });
});
