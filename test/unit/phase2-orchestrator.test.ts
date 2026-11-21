import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { EnhanceStore } from "../../src/core/store.ts";
import type { HandoffEnvelope, HandoffVerdict, Mandate, ObservedToolCall, RoleSpec } from "../../src/core/types.ts";
import ompEnhance from "../../src/entry.ts";
import { createAndVerifyHandoff } from "../../src/flow/handoff.ts";
import {
  executeRoleFlow, executeRoleStep, type RoleSessionRunner, type RoleStepContext,
} from "../../src/flow/orchestrator.ts";
import {
  countActiveAsyncJobs,
  createChildSettingsProxy,
  createOmpRoleSessionRunner,
  createOmpSupervisorInspector,
} from "../../src/omp/session.ts";
import { schemaKit } from "../../src/omp/tools.ts";
import { discoverRoles } from "../../src/roles/loader.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-enhance-phase2-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relPath: string, content: string): void {
  const fullPath = path.join(root, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function envelope(
  fromRole: string,
  verdict: HandoffVerdict,
  summary: string,
  overrides: Partial<HandoffEnvelope> = {},
): HandoffEnvelope {
  return {
    id: randomUUID(),
    mandateId: "mandate-fixed",
    mandateRev: 1,
    parentHandoffId: null,
    fromRole,
    toTarget: "user",
    verdict,
    summary,
    artifacts: [],
    verifiedFacts: [],
    openRisks: [],
    feedbackForUpstream: verdict === "rejected" ? "default feedback" : null,
    observedUsage: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function rolesFor(cwd: string, root: string): Map<string, RoleSpec> {
  return discoverRoles({ cwd, globalRolesDir: path.join(root, "missing-global") });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Markov role conditioning", () => {
  test("passes mandate, role, verifiedFacts, deletedFiles, userSteers, and upstream handoff without chat transcript", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "src/math.ts", "export const add = (a: number, b: number): number => a + b;\n");
    writeFile(cwd, "src/legacy.ts", "export const legacy = true;\n");
    const roles = rolesFor(cwd, root);
    const store = new EnhanceStore(path.join(root, "state.sqlite"));
    try {
      const mandate = store.upsertMandate({
        goal: "MARKOV_GOAL",
        constraints: ["No new dependencies"],
        acceptance: ["Math functions are correct"],
      });
      const baseline = (await import("../../src/core/fs.ts")).snapshotWorkspace(cwd);
      rmSync(path.join(cwd, "src", "legacy.ts"));
      const devCall: ObservedToolCall = {
        toolCallId: "dev-tc-1", toolName: "bash", isError: false,
        touchedPaths: [], timestamp: new Date().toISOString(), summary: "bash bun test",
      };
      const realUpstream = createAndVerifyHandoff({
        store, role: roles.get("dev")!, cwd, mandate, toTarget: "reviewer",
        verdict: "ready", summary: "UPSTREAM_SUMMARY",
        baselineSnapshot: baseline, observedCalls: [devCall],
        verifiedFacts: [
          { claim: "Legacy module removed cleanly", evidenceRef: "dev-tc-1" },
          { claim: "add(a, b) returns a + b", evidenceRef: "src/math.ts:1" },
          { claim: "raw selector supported", evidenceRef: "src/math.ts:1-1:raw" },
          { claim: "summary selector supported", evidenceRef: "src/math.ts:summary" },
          { claim: "parenthetical note supported", evidenceRef: "src/math.ts:1 (raw read; 60B)" },
          { claim: "em-dash note supported", evidenceRef: "src/math.ts:1 — `export const add`" },
          { claim: "semicolon note supported", evidenceRef: "src/math.ts:1; directory listing" },
          { claim: "workspace root dir supported", evidenceRef: "." },
          { claim: "src directory prefix supported", evidenceRef: "src/" },
        ],
      });
      expect(realUpstream.deletedFiles).toEqual(["src/legacy.ts"]);
      expect(realUpstream.verifiedFacts).toHaveLength(9);
      expect(() =>
        createAndVerifyHandoff({
          store, role: roles.get("dev")!, cwd, mandate, toTarget: "reviewer",
          verdict: "ready", summary: "BAD_DB_REF", observedCalls: [devCall],
          verifiedFacts: [{ claim: "internal sqlite", evidenceRef: ".omp-enhance/state.sqlite" }],
        }),
      ).toThrow(/Unverified verifiedFacts evidenceRef/);
      expect(() =>
        createAndVerifyHandoff({
          store, role: roles.get("dev")!, cwd, mandate, toTarget: "reviewer",
          verdict: "ready", summary: "BAD_DIR_REF", observedCalls: [devCall],
          verifiedFacts: [{ claim: "missing dir", evidenceRef: "nonexistent-dir/" }],
        }),
      ).toThrow(/Unverified verifiedFacts evidenceRef/);

      const upstream: HandoffEnvelope & { chatTranscript: string } = {
        ...realUpstream,
        chatTranscript: "SECRET_TRANSCRIPT",
      };
      let captured: RoleStepContext | null = null;
      const runner: RoleSessionRunner = {
        async runRoleTurn(ctx) {
          captured = ctx;
          return {
            envelope: envelope("reviewer", "ready", "REVIEW_DONE", {
              mandateId: mandate.id, parentHandoffId: ctx.upstreamHandoff?.id ?? null,
            }),
            observedCalls: [],
            assistantText: "reviewed",
            usage: { inputTokens: 120, outputTokens: 45, costUsd: 0.002 },
          };
        },
      };

      const result = await executeRoleStep({
        cwd, store, role: roles.get("reviewer")!, mandate, upstreamHandoff: upstream,
        userSteers: [
          { text: "Verify zero side effects", createdAt: new Date().toISOString() },
          { text: "Dev-only note", targetRole: "dev", createdAt: new Date().toISOString() },
        ],
        toTarget: "user", runner,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.envelope.observedUsage).toEqual({ inputTokens: 120, outputTokens: 45, costUsd: 0.002 });
      }
      expect(captured).not.toBeNull();
      for (const prompt of [captured!.conditioningPrompt, captured!.taskPrompt]) {
        expect(prompt).toContain("MARKOV_GOAL");
        expect(prompt).toContain("reviewer");
        expect(prompt).toContain("UPSTREAM_SUMMARY");
        expect(prompt).toContain("Legacy module removed cleanly");
        expect(prompt).toContain("src/legacy.ts");
        expect(prompt).toContain("Verify zero side effects");
        expect(prompt).not.toContain("Dev-only note");
        expect(prompt).not.toContain("SECRET_TRANSCRIPT");
      }
      expect(captured!.conditioningPrompt).toContain("<omp-enhance-conditioning>");
      expect(captured!.conditioningPrompt).toContain("## User Interjections");
      expect(captured!.taskPrompt).toContain("Verification mode: static/read-only source inspection");
      expect(captured!.taskPrompt).toContain("do NOT attempt shell execution or spawn subagents for shell access");
      expect(captured!.taskPrompt).toContain("do NOT read or grep .omp-enhance/state.sqlite directly");
    } finally {
      store.close();
    }
  });

  test("blocks boundary & .omp config violations inside createAndVerifyHandoff without poisoning SQLite", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "src/index.ts", "export const value = 1;\n");
    const roles = rolesFor(cwd, root);
    const store = new EnhanceStore(path.join(root, "state.sqlite"));
    try {
      const mandate = store.upsertMandate({ goal: "Protect source & .omp" });
      const fakePi = {
        getAllTools: () => ["read", "write", "edit", "bash"].map((name) => ({ name })),
        getThinkingLevel: () => "off",
        pi: {
          settings: {},
          SessionManager: { inMemory: () => ({ id: "mem" }) },
          async createAgentSession(opts: any) {
            const handoffTool = opts.customTools[0];
            return {
              session: {
                messages: [{ role: "toolResult", toolCallId: "qa-bash-1", toolName: "bash", isError: false }],
                async prompt() {
                  // qa modifies protected src/index.ts AND tampers with .omp/enhance.yaml via bash
                  writeFile(cwd, "src/index.ts", "export const value = 999;\n");
                  writeFile(cwd, ".omp/enhance.yaml", "flowRoutingMode: auto\n");
                  await handoffTool.execute("h-bad", { verdict: "ready", summary: "Looks fine" });
                },
                getLastAssistantText: () => "",
                getLastAssistantMessage: () => null,
                async dispose() {},
              },
            };
          },
        },
      };

      const runner = createOmpRoleSessionRunner(fakePi, { modelRegistry: {} });
      const result = await executeRoleStep({
        cwd, store, role: roles.get("qa")!, mandate, upstreamHandoff: null,
        toTarget: "user", runner,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe("violation");
        expect(result.reason).toContain("modified protected paths");
        if (result.status === "violation") {
          expect(result.violations).toContain("src/index.ts");
          expect(result.violations).toContain(".omp/enhance.yaml");
        }
      }
      // SQLite was NOT poisoned with a bogus ready handoff!
      expect(store.getLatestHandoff(mandate.id)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("returns missing_handoff when the role submits no envelope", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    const roles = rolesFor(cwd, root);
    const store = new EnhanceStore(path.join(root, "state.sqlite"));
    try {
      const mandate = store.upsertMandate({ goal: "No envelope" });
      const result = await executeRoleStep({
        cwd, store, role: roles.get("dev")!, mandate, upstreamHandoff: null, toTarget: "user",
        runner: { async runRoleTurn() { return { envelope: null, observedCalls: [], assistantText: "", usage: null }; } },
      });
      expect(result).toMatchObject({ ok: false, status: "missing_handoff" });
    } finally {
      store.close();
    }
  });
});

describe("child role & supervisor session isolation (F-A1, F-A2, F-A4, F-A6, F-C2)", () => {
  test("passes sub-session identity, child settings overlay/proxy, preloadedPreparedExtensions with restrictToolNames: true, pulse metadata, and stage abort job cleanup", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "src/app.ts", "export const value = 1;\n");
    writeFile(cwd, "test/app.test.ts", "test('app', () => {});\n");
    const roles = rolesFor(cwd, root);
    const store = new EnhanceStore(path.join(root, "state.sqlite"));
    try {
      const mandate = store.upsertMandate({ goal: "Guard child & supervisor sessions" });
      let customProvidersCleared = false;
      class MockModelRegistry {
        #secret = true;
        get authStorage() { return { ok: this.#secret }; }
        syncExtensionSources() { customProvidersCleared = true; }
        clearSourceRegistrations() { customProvidersCleared = true; }
      }
      class MockOmpSettings {
        #secret = "settings-ok";
        overrides: Record<string, unknown>;
        constructor(overrides: Record<string, unknown> = {}) { this.overrides = overrides; }
        get secret() { return this.#secret; }
        overlay(patch: Record<string, unknown>) { return new MockOmpSettings({ ...this.overrides, ...patch }); }
      }
      const hostModelRegistry = new MockModelRegistry();
      const hostSettings = new MockOmpSettings({ "advisor.enabled": true, "memory.backend": "local" });

      // Verify plain-object fallback proxy also disables advisor/memory/autolearn cleanly
      const plainWrapped = createChildSettingsProxy({ advisor: { enabled: true, model: "x" }, memory: { backend: "local", enabled: true }, autolearn: { enabled: true } });
      expect(plainWrapped.advisor).toEqual({ enabled: false, model: "x" });
      expect(plainWrapped.memory).toEqual({ backend: "off", enabled: false });
      expect(plainWrapped.autolearn).toEqual({ enabled: false });
      expect(plainWrapped.get("advisor.enabled")).toBe(false);
      expect(plainWrapped.get("memory.backend")).toBe("off");
      expect(countActiveAsyncJobs({ getAsyncJobSnapshot: () => ({ running: [{ id: "bg_1" }, { id: "bg_2" }] }) })).toBe(2);

      const childHandlers = new Map<string, Array<(event: Record<string, unknown>) => unknown>>();
      const captures: any[] = [];
      const inMemorySentinel = { kind: "in-memory-session" };
      const fakePi = {
        getAllTools: () => ["read", "write", "edit", "bash", "enhance_handoff"].map((name) => ({ name })),
        getThinkingLevel: () => "off",
        pi: {
          settings: hostSettings,
          SessionManager: { inMemory: (dir: string) => ({ ...inMemorySentinel, dir }) },
          async createAgentSession(options: any) {
            captures.push(options);
            expect(options.modelRegistry?.authStorage).toEqual({ ok: true });
            expect(options.settings?.secret).toBe("settings-ok");
            expect(options.settings?.overrides).toMatchObject({ "advisor.enabled": false, "memory.backend": "off" });
            options.modelRegistry?.syncExtensionSources?.([]);
            options.modelRegistry?.clearSourceRegistrations?.(new Set());
            // Mirror OMP 19.0.1 sdk.ts: when restrictToolNames === true, t.extensions is skipped and ONLY preloadedPreparedExtensions bind!
            const factories = options.restrictToolNames
              ? (options.preloadedPreparedExtensions ?? []).map((e: any) => e.factory)
              : (options.extensions ?? []);
            for (const extension of factories) {
              extension({
                on(name: string, handler: (event: Record<string, unknown>) => unknown) {
                  childHandlers.set(name, [...(childHandlers.get(name) ?? []), handler]);
                },
              });
            }
            return {
              session: {
                messages: [{ role: "assistant", usage: { input: 50, output: 20, cost: { total: 0.001 } } }],
                getAsyncJobSnapshot: () => ({ running: [{ id: "bg_3" }] }),
                async prompt() {},
                getLastAssistantText: () => '{"action":"continue","reason":"healthy","nextCheckSec":45}',
                getLastAssistantMessage: () => ({ role: "assistant", stopReason: "stop", usage: { input: 50, output: 20, cost: { total: 0.001 } } }),
                async dispose() {},
              },
            };
          },
        },
      };

      // 1) Stage session (qa) gets sub-session identity, restrictToolNames: true, autoApprove: true, enableMemory: false, and preloadedPreparedExtensions
      const runner = createOmpRoleSessionRunner(fakePi, { cwd, modelRegistry: hostModelRegistry }, undefined, roles);
      await runner.runRoleTurn({
        cwd, store, role: roles.get("qa")!, mandate, epistemicItems: [],
        upstreamHandoff: null, toTarget: "user", conditioningPrompt: "", taskPrompt: "", stageId: "qa-r0",
      });

      const stageCap = captures[0]!;
      expect(customProvidersCleared).toBe(false);
      expect(stageCap.sessionManager).toMatchObject({ kind: "in-memory-session", dir: cwd });
      expect(stageCap.agentId).toBe("enhance-stage-qa-r0");
      expect(stageCap.parentTaskPrefix).toBe("enhance-stage-qa-r0");
      expect(stageCap.taskDepth).toBe(1);
      expect(stageCap.hasUI).toBe(false);
      expect(stageCap.autoApprove).toBe(true);
      expect(stageCap.enableMemory).toBe(false);
      expect(stageCap.restrictToolNames).toBe(true);
      expect(stageCap.allowRestrictedCustomTools).toBe(true);
      expect(stageCap.toolNames).toContain("enhance_handoff");
      expect(stageCap.toolNames).toContain("enhance_mandate");
      expect(stageCap.toolNames).toContain("enhance_job");
      expect(stageCap.customTools.map((t: any) => t.name)).toEqual(["enhance_handoff", "enhance_mandate", "enhance_job"]);
      // F-A6: pure protocol tools omit approval: "write", while enhance_job retains approval: "exec"
      expect(stageCap.customTools[0]!.approval).toBeUndefined();
      expect(stageCap.customTools[1]!.approval).toBeUndefined();
      expect(stageCap.customTools[2]!.approval).toBe("exec");

      const guard = childHandlers.get("tool_call")?.[0]!;
      expect((guard({ toolName: "write", input: { path: "docs/outside.md" } }) as { block?: boolean }).block).toBe(true);
      expect(guard({ toolName: "write", input: { path: "test/app.test.ts" } })).toBeUndefined();
      expect(childHandlers.get("tool_execution_start")).toHaveLength(1);

      // 2) Read-only stage (reviewer) forwards roleId/readOnly/allowedTools/activeAsyncJobs in supervisor pulse!
      const seenPulses: any[] = [];
      await runner.runRoleTurn({
        cwd, store, role: roles.get("reviewer")!, mandate, epistemicItems: [],
        upstreamHandoff: null, toTarget: "user", conditioningPrompt: "", taskPrompt: "",
        supervisor: {
          role: roles.get("supervisor")!,
          initialDelayMs: 5,
          inspector: {
            async evaluatePulse(pulse) {
              seenPulses.push(pulse);
              return { action: "abort", reason: "test abort", nextCheckSec: 30 };
            },
          },
        },
      });
      expect(captures[1]!.toolNames).not.toContain("enhance_job");
      expect(captures[1]!.toolNames).toContain("enhance_mandate");

      // 3) Stage-started enhance_job(action="start") is automatically cancelled if stage aborts (F-C2)!
      let startedJobId = "";
      const abortingPi = {
        ...fakePi,
        pi: {
          ...fakePi.pi,
          async createAgentSession(options: any) {
            const jobTool = options.customTools.find((t: any) => t.name === "enhance_job");
            return {
              session: {
                messages: [],
                getAsyncJobSnapshot: () => ({ running: [{ id: "bg_9" }] }),
                async prompt() {
                  const res = await jobTool.execute("jb-1", { action: "start", command: "sleep 30" });
                  startedJobId = JSON.parse(res.content[0].text).job.jobId;
                  await Bun.sleep(40);
                },
                getLastAssistantText: () => "",
                getLastAssistantMessage: () => null,
                async dispose() {},
              },
            };
          },
        },
      };
      const abortRunner = createOmpRoleSessionRunner(abortingPi, { cwd, modelRegistry: hostModelRegistry }, undefined, roles);
      const abortOutcome = await abortRunner.runRoleTurn({
        cwd, store, role: roles.get("qa")!, mandate, epistemicItems: [],
        upstreamHandoff: null, toTarget: "user", conditioningPrompt: "", taskPrompt: "",
        supervisor: {
          role: roles.get("supervisor")!,
          initialDelayMs: 10,
          inspector: {
            async evaluatePulse(pulse) {
              seenPulses.push(pulse);
              return { action: "abort", reason: "stage stuck", nextCheckSec: 30 };
            },
          },
        },
      });
      expect(abortOutcome.abortedBySupervisor?.reason).toBe("stage stuck");
      expect(startedJobId).not.toBe("");
      expect(store.getJob(startedJobId)?.status).toBe("cancelled");
      const qaPulse = seenPulses.find((p) => p.roleId === "qa");
      expect(qaPulse).toMatchObject({ roleId: "qa", readOnly: false, activeAsyncJobs: 1 });
      expect(qaPulse.allowedTools).toContain("bash");

      // 4) Supervisor inspector passes sub-session identity, autoApprove: true, enableMemory: false, and restrictToolNames: true
      const inspector = createOmpSupervisorInspector(fakePi, { cwd, modelRegistry: hostModelRegistry });
      const decision = await inspector.evaluatePulse({
        targetKind: "job", goal: "Train", checkNumber: 1, elapsedSec: 30, idleSec: 5, deltaBytesOrCalls: 100, deltaSummary: "ok",
      }, roles.get("supervisor")!);
      expect(decision.action).toBe("continue");
      expect(captures[2]!).toMatchObject({
        hasUI: false,
        autoApprove: true,
        enableMemory: false,
        taskDepth: 1,
        restrictToolNames: true,
        toolNames: [],
        skills: [],
        rules: [],
        promptTemplates: [],
        slashCommands: [],
      });
      expect(String(captures[2]!.agentId)).toStartWith("enhance-sup-1-");
      expect(captures[2]!.parentTaskPrefix).toBe(captures[2]!.agentId);
      expect(captures[2]!.sessionManager).toMatchObject({ kind: "in-memory-session", dir: cwd });
    } finally {
      store.close();
    }
  });
});

describe("role flow repair loop & mandate completion", () => {
  function setup() {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    const roles = rolesFor(cwd, root);
    const store = new EnhanceStore(path.join(root, "state.sqlite"));
    const mandate = store.upsertMandate({ goal: "Repair the bug" });
    return { root, cwd, roles, store, mandate };
  }

  test("dev -> qa rejected (toTarget=dev) -> dev fix -> qa ready -> reviewer ready & completes mandate", async () => {
    const { cwd, roles, store, mandate } = setup();
    try {
      let qaCalls = 0;
      let devCalls = 0;
      const runner: RoleSessionRunner = {
        async runRoleTurn(ctx) {
          if (ctx.role.id === "dev") {
            devCalls += 1;
            const env = createAndVerifyHandoff({
              store, role: ctx.role, cwd, mandate, parentHandoffId: ctx.upstreamHandoff?.id ?? null,
              toTarget: ctx.toTarget, verdict: "ready", summary: `DEV_ROUND_${devCalls}`,
            });
            return { envelope: env, observedCalls: [], assistantText: "", usage: null };
          }
          if (ctx.role.id === "qa") {
            qaCalls += 1;
            const call: ObservedToolCall = { toolCallId: `qa-${qaCalls}`, toolName: "bash", isError: false, touchedPaths: [], timestamp: new Date().toISOString() };
            const env = qaCalls === 1
              ? createAndVerifyHandoff({
                  store, role: ctx.role, cwd, mandate, parentHandoffId: ctx.upstreamHandoff?.id ?? null,
                  toTarget: ctx.toTarget, verdict: "rejected", summary: "QA_FOUND_BUG",
                  feedbackForUpstream: "Repro: bun test; expected 2, received 3", observedCalls: [call],
                })
              : createAndVerifyHandoff({
                  store, role: ctx.role, cwd, mandate, parentHandoffId: ctx.upstreamHandoff?.id ?? null,
                  toTarget: ctx.toTarget, verdict: "ready", summary: "QA_PASSED", observedCalls: [call],
                });
            return { envelope: env, observedCalls: [call], assistantText: "", usage: null };
          }
          const revCall: ObservedToolCall = { toolCallId: "rev-1", toolName: "read", isError: false, touchedPaths: [], timestamp: new Date().toISOString() };
          const env = createAndVerifyHandoff({
            store, role: ctx.role, cwd, mandate, parentHandoffId: ctx.upstreamHandoff?.id ?? null,
            toTarget: ctx.toTarget, verdict: "ready", summary: "REVIEW_READY", observedCalls: [revCall],
          });
          return { envelope: env, observedCalls: [revCall], assistantText: "", usage: null };
        },
      };

      const result = await executeRoleFlow({
        cwd, store, mandate, runner,
        roles: [roles.get("dev")!, roles.get("qa")!, roles.get("reviewer")!],
      });

      expect(result.status).toBe("completed");
      expect(result.steps.map((step) => step.roleId)).toEqual(["dev", "qa", "dev", "qa", "reviewer"]);
      expect(result.steps.map((step) => step.round)).toEqual([0, 0, 1, 1, 1]);
      // Rejected envelope in dev -> qa -> reviewer points toTarget="dev" (repair target), NOT "reviewer"!
      expect(result.steps[1]?.envelope.toTarget).toBe("dev");
      expect(store.getHandoff(result.steps[1]!.envelope.id)?.toTarget).toBe("dev");
      // Completed Flow transitions Mandate status to "completed" so it doesn't pollute future turns!
      expect(store.getMandate(mandate.id)?.status).toBe("completed");
      expect(store.getActiveMandate()).toBeNull();
    } finally {
      store.close();
    }
  });

  test("rewinds to first write-capable role instead of read-only roles[0] (vision -> dev -> qa)", async () => {
    const { cwd, roles, store, mandate } = setup();
    try {
      let qaCalls = 0;
      const executed: string[] = [];
      const runner: RoleSessionRunner = {
        async runRoleTurn(ctx) {
          executed.push(ctx.role.id);
          if (ctx.role.id === "qa" && ++qaCalls === 1) {
            return {
              envelope: envelope("qa", "rejected", "BUG", { mandateId: mandate.id, feedbackForUpstream: "fix edge case" }),
              observedCalls: [], assistantText: "", usage: null,
            };
          }
          return { envelope: envelope(ctx.role.id, "ready", "OK", { mandateId: mandate.id }), observedCalls: [], assistantText: "", usage: null };
        },
      };

      const result = await executeRoleFlow({
        cwd, store, mandate, runner,
        roles: [roles.get("vision")!, roles.get("dev")!, roles.get("qa")!],
      });
      expect(result.status).toBe("completed");
      // vision (idx=0, read-only) is NOT re-executed on repair; rewind lands on dev (idx=1)!
      expect(executed).toEqual(["vision", "dev", "qa", "dev", "qa"]);
      expect(result.steps[2]?.envelope.toTarget).toBe("dev");
    } finally {
      store.close();
    }
  });

  test("stagnates on identical normalized rejection feedback and stops after maxRepairRounds", async () => {
    const { cwd, roles, store, mandate } = setup();
    try {
      let qaCalls = 0;
      const stagRunner: RoleSessionRunner = {
        async runRoleTurn(ctx) {
          if (ctx.role.id === "dev") return { envelope: envelope("dev", "ready", "DEV"), observedCalls: [], assistantText: "", usage: null };
          qaCalls += 1;
          return {
            envelope: envelope("qa", "rejected", "STILL_BROKEN", {
              mandateId: mandate.id, feedbackForUpstream: qaCalls === 1 ? "  SAME   BUG  " : "same bug",
            }),
            observedCalls: [], assistantText: "", usage: null,
          };
        },
      };
      const stagResult = await executeRoleFlow({ cwd, store, mandate, runner: stagRunner, roles: [roles.get("dev")!, roles.get("qa")!] });
      expect(stagResult.status).toBe("stagnated");

      let maxCalls = 0;
      const maxRunner: RoleSessionRunner = {
        async runRoleTurn(ctx) {
          if (ctx.role.id === "dev") return { envelope: envelope("dev", "ready", "DEV"), observedCalls: [], assistantText: "", usage: null };
          maxCalls += 1;
          return {
            envelope: envelope("qa", "rejected", `BUG_${maxCalls}`, { mandateId: mandate.id, feedbackForUpstream: `bug ${maxCalls}` }),
            observedCalls: [], assistantText: "", usage: null,
          };
        },
      };
      const maxResult = await executeRoleFlow({ cwd, store, mandate, runner: maxRunner, roles: [roles.get("dev")!, roles.get("qa")!], maxRepairRounds: 1 });
      expect(maxResult.status).toBe("rejected_max_rounds");
    } finally {
      store.close();
    }
  });
});

interface TestContext {
  cwd: string;
  ui: { notify(message: string, level: string): void };
  modelRegistry: Record<string, never>;
  model?: unknown;
  models?: { resolve(spec: string): unknown; list(): unknown[] };
}

function createHarness(cwd: string, root: string) {
  const handlers = new Map<string, Array<(event: Record<string, unknown>, ctx: TestContext) => unknown>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const messages: string[] = [];
  const rawMessages: Array<{ content: string; excludeFromContext?: boolean }> = [];
  const notifications: string[] = [];
  let activeTools: string[] = [];
  let currentModel: unknown = { provider: "anthropic", id: "claude-sonnet-4" };
  let thinkingLevel = "high";
  const branchEntries: unknown[] = [
    { type: "message", message: { role: "assistant", usage: { input: 240, output: 80, cost: { total: 0.004 } } } },
  ];

  const allToolNames = [
    "read", "grep", "lsp", "bash", "edit", "write", "web_search",
    "enhance_mandate", "enhance_handoff", "enhance_flow", "enhance_job",
  ];
  const ctx: TestContext & { sessionManager?: { getBranch(): unknown[] } } = {
    cwd,
    ui: { notify: (message: string) => { notifications.push(message); } },
    modelRegistry: {},
    get model() { return currentModel; },
    models: {
      resolve: (spec: string) => (spec === "@vision" ? { provider: "openrouter", id: "qwen-vl", input: ["text", "image"] } : undefined),
      list: () => [],
    },
    sessionManager: { getBranch: () => branchEntries },
  };
  const pi = {
    on(name: string, handler: (event: Record<string, unknown>, ctx: TestContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    sendMessage(message: { content: string; excludeFromContext?: boolean }) {
      messages.push(message.content);
      rawMessages.push(message);
    },
    getAllTools() { return allToolNames.map((name) => ({ name })); },
    async setActiveTools(names: string[]) { activeTools = names; },
    async setModel(m: unknown) { currentModel = m; },
    setThinkingLevel(level: string) { thinkingLevel = level; },
    getThinkingLevel() { return thinkingLevel; },
    pi: { settings: {} },
  };
  ompEnhance(pi, {
    globalRolesDir: path.join(root, "global-roles"),
    builtinRolesDir: path.resolve(import.meta.dir, "../../roles"),
  });
  const runHook = async (name: string, event: Record<string, unknown>, customCtx: TestContext = ctx): Promise<unknown> => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      const value = await handler(event, customCtx);
      if (value !== undefined) result = value;
    }
    return result;
  };
  const execTool = async (name: string, params: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    const response = await tool.execute("call", params, undefined, undefined, ctx);
    return JSON.parse(response.content[0]!.text) as Record<string, unknown>;
  };
  const runCommand = async (name: string, args: string): Promise<void> => {
    const command = commands.get(name);
    if (!command) throw new Error(`Missing command ${name}`);
    await command.handler(args, ctx);
  };
  return {
    ctx, tools, commands, messages, rawMessages, notifications, runHook, execTool, runCommand,
    activeTools: () => activeTools,
    currentModel: () => currentModel,
    thinkingLevel: () => thinkingLevel,
  };
}

describe("entry extension", () => {
  test("wires role commands, leaves native /handoff untouched, awaits session-switch role sync, and restores baseline model/thinking", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "src/app.ts", "export const value = 1;\n");
    writeFile(cwd, "test/app.test.ts", "test('app', () => {});\n");
    const harness = createHarness(cwd, root);

    const mandatePayload = await harness.execTool("enhance_mandate", {
      action: "set", goal: "MANDATE_X", constraints: ["no deps"], acceptance: ["tests pass"],
    });
    const mandate = mandatePayload.mandate as Mandate;
    expect(mandate.goal).toBe("MANDATE_X");
    const mandateId = mandate.id;

    const start = await harness.runHook("before_agent_start", { systemPrompt: ["BASE"], prompt: "hello" });
    const systemPrompt = (start as { systemPrompt: string[] }).systemPrompt;
    expect(systemPrompt[0]).toBe("BASE");
    expect(systemPrompt[1]).toContain("<omp-enhance-conditioning>");
    expect(systemPrompt[1]).toContain("Active Role: general");
    expect(systemPrompt[1]).toContain("MANDATE_X");

    // Native OMP `/handoff` (`/compact handoff`) is NEVER intercepted, with or without arguments!
    expect(await harness.runHook("input", { text: "/handoff" })).toBeUndefined();
    expect(await harness.runHook("input", { text: "/handoff reviewer" })).toBeUndefined();
    expect(await harness.runHook("input", { text: "/role list" })).toBeUndefined();

    // Switching to vision overrides model/thinking, and switching back to general/off restores baseline!
    await harness.runCommand("role", "vision");
    expect(harness.currentModel()).toMatchObject({ provider: "openrouter", id: "qwen-vl" });
    expect(harness.thinkingLevel()).toBe("low");
    expect(harness.activeTools()).not.toContain("enhance_job");

    // Session transition inside before_agent_start awaits applyActiveRole before returning!
    const nextSessionCtx = Object.assign(Object.create(harness.ctx), {
      sessionManager: { getSessionId: () => "sess-switched", getBranch: () => [] },
    });
    await harness.runHook("before_agent_start", { systemPrompt: ["BASE"] }, nextSessionCtx);
    expect(harness.currentModel()).toMatchObject({ provider: "anthropic", id: "claude-sonnet-4" });
    expect(harness.thinkingLevel()).toBe("high");
    expect(harness.activeTools()).toContain("enhance_job");

    await harness.runCommand("role", "general");
    expect(harness.currentModel()).toMatchObject({ provider: "anthropic", id: "claude-sonnet-4" });
    expect(harness.thinkingLevel()).toBe("high");

    await harness.runCommand("role", "list");
    expect(harness.messages.at(-1)).toContain("* general [builtin]");
    expect(harness.messages.at(-1)).toContain("qa [builtin]");

    // Preserves --* words inside /role create description and handles duplicate errors gracefully
    await harness.runCommand("role", "create custom-auditor --project Check --strict edge cases");
    const rolePath = path.join(cwd, ".omp", "roles", "custom-auditor.yaml");
    expect(existsSync(rolePath)).toBe(true);
    expect(readFileSync(rolePath, "utf8")).toContain('description: "Check --strict edge cases"');
    expect(harness.messages.at(-1)).toContain('Created role "custom-auditor" [project]');

    await harness.runCommand("role", "create custom-auditor --project Duplicate attempt");
    expect(harness.messages.at(-1)).toContain("already exists");

    await harness.runCommand("role", "qa");
    expect(harness.messages.at(-1)).toContain("Active role: qa [builtin]");
    expect(harness.activeTools()).toContain("bash");
    expect(harness.activeTools()).toContain("edit");
    expect(harness.activeTools()).toContain("enhance_handoff");
    expect(harness.activeTools()).not.toContain("web_search");

    expect(await harness.runHook("tool_call", { toolName: "write", input: { path: "src/app.ts" } })).toMatchObject({ block: true });
    expect(await harness.runHook("tool_call", { toolName: "write", input: { path: "test/app.test.ts" } })).toBeUndefined();
    expect(await harness.runHook("tool_call", { toolName: "shell", input: {} })).toMatchObject({ block: true });

    await harness.runCommand("role", "off");
    expect(harness.messages.at(-1)).toContain("Role conditioning disabled");
    expect(harness.activeTools()).toContain("web_search");

    await harness.runCommand("role", "dev");
    // F-A6 & F-A9: protocol tools omit approval: "write", schemaKit enforces additionalProperties: false
    expect(harness.tools.get("enhance_mandate")!.approval).toBeUndefined();
    expect(harness.tools.get("enhance_handoff")!.approval).toBeUndefined();
    expect(harness.tools.get("enhance_flow")!.approval).toBe("exec");
    expect(harness.tools.get("enhance_job")!.approval).toBe("exec");
    let capturedObjOpts: unknown = null;
    const kit = schemaKit({
      typebox: {
        Type: {
          String: () => ({ type: "string" }),
          Optional: (v: unknown) => ({ opt: v }),
          Object: (props: unknown, opts: unknown) => { capturedObjOpts = opts; return { props, opts }; },
        },
      },
    });
    kit.obj({ verdict: kit.str() }, ["verdict"]);
    expect(capturedObjOpts).toEqual({ additionalProperties: false });

    const handoffPayload = await harness.execTool("enhance_handoff", {
      verdict: "ready", summary: "Delivered the mandate",
    });
    const handoff = handoffPayload.handoff as HandoffEnvelope;
    expect(handoff.fromRole).toBe("dev");
    expect(handoff.toTarget).toBe("user");
    // F-A9: foreground enhance_handoff extracts observedUsage from sessionManager.getBranch()!
    expect(handoff.observedUsage).toEqual({ inputTokens: 240, outputTokens: 80, costUsd: 0.004 });

    const inspect = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    try {
      expect(inspect.getLatestHandoff(mandateId)?.id).toBe(handoff.id);
    } finally {
      inspect.close();
    }

    await harness.runCommand("enhance-status", "");
    expect(harness.rawMessages.at(-1)?.excludeFromContext).toBe(true);
    const status = JSON.parse(harness.messages.at(-1)!) as {
      activeRoleId: string | null;
      roleCount: number;
      epistemicCount: number;
      latestHandoff: { id: string } | null;
    };
    expect(status.activeRoleId).toBe("dev");
    expect(status.roleCount).toBe(9);
    expect(status.epistemicCount).toBe(0);
    expect(status.latestHandoff?.id).toBe(handoff.id);

    await harness.runHook("session_shutdown", {});
  });
});
