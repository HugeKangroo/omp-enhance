import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createOmpRoleSessionRunner, executeRoleFlow, executeRoleStep,
  type RoleSessionRunner, type RoleStepContext,
} from "../../src/orchestrator.ts";
import { discoverRoles } from "../../src/role-loader.ts";
import { EnhanceStore } from "../../src/store.ts";
import type { HandoffEnvelope, HandoffVerdict, Mandate, RoleSpec } from "../../src/types.ts";
import ompEnhance from "../../src/entry.ts";

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
  test("passes mandate, role, and upstream handoff but no upstream chat transcript", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "src/math.ts", "export const add = (a: number, b: number): number => a + b;\n");
    const roles = rolesFor(cwd, root);
    const store = new EnhanceStore(path.join(root, "state.sqlite"));
    try {
      const mandate = store.upsertMandate({
        goal: "MARKOV_GOAL",
        constraints: ["No new dependencies"],
        acceptance: ["Math functions are correct"],
      });
      const upstream: HandoffEnvelope & { chatTranscript: string } = {
        ...envelope("dev", "ready", "UPSTREAM_SUMMARY", { mandateId: mandate.id }),
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
            usage: null,
          };
        },
      };

      const result = await executeRoleStep({
        cwd, store, role: roles.get("reviewer")!, mandate, upstreamHandoff: upstream,
        toTarget: "user", runner,
      });

      expect(result.ok).toBe(true);
      expect(captured).not.toBeNull();
      for (const prompt of [captured!.conditioningPrompt, captured!.taskPrompt]) {
        expect(prompt).toContain("MARKOV_GOAL");
        expect(prompt).toContain("reviewer");
        expect(prompt).toContain("UPSTREAM_SUMMARY");
        expect(prompt).not.toContain("SECRET_TRANSCRIPT");
      }
      expect(captured!.conditioningPrompt).toContain("<omp-enhance-conditioning>");
      expect(captured!.conditioningPrompt).toContain("Original Mandate");
      expect(captured!.conditioningPrompt).toContain("Upstream Handoff");
      expect(captured!.conditioningPrompt).toContain(roles.get("reviewer")!.stance.trim());
      expect(captured!.taskPrompt).toContain(mandate.goal);
      expect(captured!.toTarget).toBe("user");
      expect(captured!.epistemicItems).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("detects a protected-path escape after the role turn", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "src/index.ts", "export const value = 1;\n");
    const roles = rolesFor(cwd, root);
    const store = new EnhanceStore(path.join(root, "state.sqlite"));
    try {
      const mandate = store.upsertMandate({ goal: "Protect source" });
      const runner: RoleSessionRunner = {
        async runRoleTurn() {
          writeFile(cwd, "src/index.ts", "export const value = 999;\n");
          return { envelope: envelope("qa", "ready", "Looks fine"), observedCalls: [], assistantText: "", usage: null };
        },
      };
      const result = await executeRoleStep({
        cwd, store, role: roles.get("qa")!, mandate, upstreamHandoff: null,
        toTarget: "user", runner,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe("violation");
        expect(result.reason).toContain("modified protected paths");
        if (result.status === "violation") expect(result.violations).toEqual(["src/index.ts"]);
      }
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

describe("child role session guard", () => {
  test("binds the inline guard and blocks qa writes outside writable globs", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "src/app.ts", "export const value = 1;\n");
    writeFile(cwd, "test/app.test.ts", "test('app', () => {});\n");
    const roles = rolesFor(cwd, root);
    const store = new EnhanceStore(path.join(root, "state.sqlite"));
    try {
      const mandate = store.upsertMandate({ goal: "Guard the child session" });
      const childHandlers = new Map<string, Array<(event: Record<string, unknown>) => unknown>>();
      const childPi = {
        on(name: string, handler: (event: Record<string, unknown>) => unknown) {
          childHandlers.set(name, [...(childHandlers.get(name) ?? []), handler]);
        },
      };
      interface CapturedChildOptions {
        restrictToolNames?: boolean;
        toolNames?: string[];
        extensions?: Array<(api: typeof childPi) => void>;
      }
      const captures: CapturedChildOptions[] = [];
      const fakePi = {
        getAllTools: () => ["read", "write", "edit", "bash", "enhance_handoff"].map((name) => ({ name })),
        getThinkingLevel: () => "off",
        pi: {
          settings: {},
          async createAgentSession(options: CapturedChildOptions) {
            captures.push(options);
            for (const extension of options.extensions ?? []) extension(childPi);
            return {
              session: {
                messages: [],
                async prompt() {},
                getLastAssistantText: () => "",
                getLastAssistantMessage: () => null,
                async dispose() {},
              },
            };
          },
        },
      };
      const runner = createOmpRoleSessionRunner(fakePi, { modelRegistry: {} });
      await runner.runRoleTurn({
        cwd, store, role: roles.get("qa")!, mandate, epistemicItems: [],
        upstreamHandoff: null, toTarget: "user", conditioningPrompt: "", taskPrompt: "",
      });

      const captured = captures[0];
      expect(captured).toBeDefined();
      expect(captured!.restrictToolNames).not.toBe(true);
      expect(captured!.extensions).toHaveLength(1);
      expect(captured!.toolNames).toContain("enhance_handoff");
      const guard = childHandlers.get("tool_call")?.[0];
      expect(guard).toBeDefined();
      interface BlockDecision { block?: boolean }
      const blocked = guard!({ toolName: "write", input: { path: "docs/outside.md" } }) as BlockDecision;
      expect(blocked.block).toBe(true);
      expect(guard!({ toolName: "write", input: { path: "test/app.test.ts" } })).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("role flow repair loop", () => {
  function setup() {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    const roles = rolesFor(cwd, root);
    const store = new EnhanceStore(path.join(root, "state.sqlite"));
    const mandate = store.upsertMandate({ goal: "Repair the bug" });
    return { root, cwd, roles, store, mandate };
  }

  test("dev -> qa rejected -> dev fix -> qa ready -> reviewer ready", async () => {
    const { cwd, roles, store, mandate } = setup();
    try {
      let qaCalls = 0;
      let devCalls = 0;
      const runner: RoleSessionRunner = {
        async runRoleTurn(ctx) {
          if (ctx.role.id === "dev") {
            devCalls += 1;
            return {
              envelope: envelope("dev", "ready", `DEV_ROUND_${devCalls}`, {
                mandateId: mandate.id, parentHandoffId: ctx.upstreamHandoff?.id ?? null,
              }),
              observedCalls: [], assistantText: "", usage: null,
            };
          }
          if (ctx.role.id === "qa") {
            qaCalls += 1;
            return {
              envelope: qaCalls === 1
                ? envelope("qa", "rejected", "QA_FOUND_BUG", {
                  mandateId: mandate.id, parentHandoffId: ctx.upstreamHandoff?.id ?? null,
                  feedbackForUpstream: "Repro: bun test; expected 2, received 3",
                })
                : envelope("qa", "ready", "QA_PASSED", {
                  mandateId: mandate.id, parentHandoffId: ctx.upstreamHandoff?.id ?? null,
                }),
              observedCalls: [], assistantText: "", usage: null,
            };
          }
          return {
            envelope: envelope("reviewer", "ready", "REVIEW_READY", {
              mandateId: mandate.id, parentHandoffId: ctx.upstreamHandoff?.id ?? null,
            }),
            observedCalls: [], assistantText: "", usage: null,
          };
        },
      };

      const result = await executeRoleFlow({
        cwd, store, mandate, runner,
        roles: [roles.get("dev")!, roles.get("qa")!, roles.get("reviewer")!],
      });

      expect(result.status).toBe("completed");
      expect(result.steps.map((step) => step.roleId)).toEqual(["dev", "qa", "dev", "qa", "reviewer"]);
      expect(result.steps.map((step) => step.round)).toEqual([0, 0, 1, 1, 1]);
      expect(result.finalEnvelope?.fromRole).toBe("reviewer");
      expect(result.finalEnvelope?.summary).toBe("REVIEW_READY");
      expect(result.steps[1]?.envelope.verdict).toBe("rejected");
      expect(result.steps[3]?.envelope.verdict).toBe("ready");
    } finally {
      store.close();
    }
  });

  test("stagnates on identical normalized rejection feedback", async () => {
    const { cwd, roles, store, mandate } = setup();
    try {
      let qaCalls = 0;
      const runner: RoleSessionRunner = {
        async runRoleTurn(ctx) {
          if (ctx.role.id === "dev") {
            return { envelope: envelope("dev", "ready", "DEV"), observedCalls: [], assistantText: "", usage: null };
          }
          qaCalls += 1;
          return {
            envelope: envelope("qa", "rejected", "STILL_BROKEN", {
              mandateId: mandate.id,
              feedbackForUpstream: qaCalls === 1 ? "  SAME   BUG  " : "same bug",
            }),
            observedCalls: [], assistantText: "", usage: null,
          };
        },
      };

      const result = await executeRoleFlow({
        cwd, store, mandate, runner, roles: [roles.get("dev")!, roles.get("qa")!],
      });

      expect(result.status).toBe("stagnated");
      expect(result.steps).toHaveLength(4);
      expect(result.reason).toBe("Identical rejection feedback repeated without progress.");
    } finally {
      store.close();
    }
  });

  test("stops after maxRepairRounds when feedback keeps changing", async () => {
    const { cwd, roles, store, mandate } = setup();
    try {
      let qaCalls = 0;
      const runner: RoleSessionRunner = {
        async runRoleTurn(ctx) {
          if (ctx.role.id === "dev") {
            return { envelope: envelope("dev", "ready", "DEV"), observedCalls: [], assistantText: "", usage: null };
          }
          qaCalls += 1;
          return {
            envelope: envelope("qa", "rejected", `BUG_${qaCalls}`, {
              mandateId: mandate.id, feedbackForUpstream: `bug number ${qaCalls}`,
            }),
            observedCalls: [], assistantText: "", usage: null,
          };
        },
      };
      const result = await executeRoleFlow({
        cwd, store, mandate, runner, roles: [roles.get("dev")!, roles.get("qa")!], maxRepairRounds: 1,
      });
      expect(result.status).toBe("rejected_max_rounds");
      expect(result.steps).toHaveLength(4);
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
}

interface HarnessTool {
  name: string;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

interface HarnessCommand {
  description: string;
  handler(args: string, ctx: TestContext): Promise<void> | void;
}

function createHarness(cwd: string, root: string) {
  const handlers = new Map<string, Array<(event: Record<string, unknown>, ctx: TestContext) => unknown>>();
  const tools = new Map<string, HarnessTool>();
  const commands = new Map<string, HarnessCommand>();
  const messages: string[] = [];
  const notifications: string[] = [];
  let activeTools: string[] = [];
  const allToolNames = [
    "read", "grep", "lsp", "bash", "edit", "write", "web_search",
    "enhance_mandate", "enhance_handoff", "enhance_flow", "enhance_job",
  ];
  const ctx: TestContext = {
    cwd,
    ui: { notify: (message: string) => { notifications.push(message); } },
    modelRegistry: {},
  };
  const pi = {
    on(name: string, handler: (event: Record<string, unknown>, ctx: TestContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: HarnessTool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: HarnessCommand) {
      commands.set(name, command);
    },
    sendMessage(message: { content: string }) {
      messages.push(message.content);
    },
    getAllTools() {
      return allToolNames.map((name) => ({ name }));
    },
    async setActiveTools(names: string[]) {
      activeTools = names;
    },
    getThinkingLevel() {
      return "off";
    },
    pi: { settings: {} },
  };
  ompEnhance(pi, {
    globalRolesDir: path.join(root, "global-roles"),
    builtinRolesDir: path.resolve(import.meta.dir, "../../roles"),
  });
  const runHook = (name: string, event: Record<string, unknown>): unknown => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      const value = handler(event, ctx);
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
    ctx, tools, commands, messages, notifications, runHook, execTool, runCommand,
    activeTools: () => activeTools,
  };
}

describe("entry extension", () => {
  test("wires role commands, hooks, mandate, handoff, and status", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "src/app.ts", "export const value = 1;\n");
    writeFile(cwd, "test/app.test.ts", "test('app', () => {});\n");
    const harness = createHarness(cwd, root);

    const mandatePayload = await harness.execTool("enhance_mandate", {
      action: "set", goal: "MANDATE_X", constraints: ["no deps"], acceptance: ["tests pass"],
    });
    // Tool output shape is produced by this extension; assert the named contract at the boundary.
    const mandate = mandatePayload.mandate as Mandate;
    expect(mandate.goal).toBe("MANDATE_X");
    const mandateId = mandate.id;

    const start = harness.runHook("before_agent_start", { systemPrompt: ["BASE"], prompt: "hello" });
    const systemPrompt = (start as { systemPrompt: string[] }).systemPrompt;
    expect(systemPrompt[0]).toBe("BASE");
    expect(systemPrompt[1]).toContain("<omp-enhance-conditioning>");
    expect(systemPrompt[1]).toContain("Active Role: dev");
    expect(systemPrompt[1]).toContain("MANDATE_X");

    expect(harness.runHook("input", { text: "/handoff reviewer" }))
      .toEqual({ text: "/enhance-handoff reviewer" });
    expect(harness.runHook("input", { text: "/role list" })).toBeUndefined();

    await harness.runCommand("role", "list");
    expect(harness.messages.at(-1)).toContain("* dev [builtin]");
    expect(harness.messages.at(-1)).toContain("qa [builtin]");

    await harness.runCommand("role", "create custom-auditor --project Check edge cases");
    const rolePath = path.join(cwd, ".omp", "roles", "custom-auditor.yaml");
    expect(existsSync(rolePath)).toBe(true);
    expect(readFileSync(rolePath, "utf8")).toContain('description: "Check edge cases"');
    expect(harness.messages.at(-1)).toContain("Created role \"custom-auditor\" [project]");

    await harness.runCommand("role", "list");
    expect(harness.messages.at(-1)).toContain("custom-auditor [project]");

    await harness.runCommand("role", "qa");
    expect(harness.messages.at(-1)).toContain("Active role: qa [builtin]");
    expect(harness.activeTools()).toContain("bash");
    expect(harness.activeTools()).toContain("edit");
    expect(harness.activeTools()).toContain("enhance_handoff");
    expect(harness.activeTools()).not.toContain("web_search");

    const blocked = harness.runHook("tool_call", { toolName: "write", input: { path: "src/app.ts" } });
    expect(blocked).toMatchObject({ block: true });
    expect(harness.runHook("tool_call", { toolName: "write", input: { path: "test/app.test.ts" } }))
      .toBeUndefined();
    expect(harness.runHook("tool_call", { toolName: "shell", input: {} })).toMatchObject({ block: true });

    await harness.runCommand("role", "off");
    expect(harness.messages.at(-1)).toContain("Role conditioning disabled");
    expect(harness.activeTools()).toContain("web_search");

    await harness.runCommand("role", "dev");
    const handoffPayload = await harness.execTool("enhance_handoff", {
      verdict: "ready", summary: "Delivered the mandate",
    });
    const handoff = handoffPayload.handoff as HandoffEnvelope;
    expect(handoff.fromRole).toBe("dev");
    expect(handoff.toTarget).toBe("user");
    expect(handoff.summary).toBe("Delivered the mandate");

    const inspect = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    try {
      expect(inspect.getLatestHandoff(mandateId)?.id).toBe(handoff.id);
    } finally {
      inspect.close();
    }

    await harness.runCommand("enhance-status", "");
    // Command output shape is produced by this extension; assert the named contract at the boundary.
    const status = JSON.parse(harness.messages.at(-1)!) as {
      activeRoleId: string | null;
      roleCount: number;
      epistemicCount: number;
      latestHandoff: { id: string } | null;
    };
    expect(status.activeRoleId).toBe("dev");
    expect(status.roleCount).toBe(6);
    expect(status.epistemicCount).toBe(0);
    expect(status.latestHandoff?.id).toBe(handoff.id);

    harness.runHook("session_shutdown", {});
  });
});
