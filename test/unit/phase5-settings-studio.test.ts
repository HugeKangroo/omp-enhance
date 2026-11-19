import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_ENHANCE_SETTINGS, loadEnhanceSettings, normalizeModelSpec, resolveModelSpec,
  resolveRoleRuntimeConfig,
} from "../../src/settings.ts";
import {
  discoverRoles, parseRoleYaml, resetRoleOverride, saveRoleSpec, serializeRoleYaml,
} from "../../src/role-loader.ts";
import { createOmpRoleSessionRunner } from "../../src/orchestrator.ts";
import { TurnTracker } from "../../src/session-tracker.ts";
import { EnhanceStore } from "../../src/store.ts";
import ompEnhance from "../../src/entry.ts";

const tempDirs: string[] = [];
const builtinRolesDir = path.resolve(import.meta.dir, "../../roles");

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-enhance-phase5-"));
  tempDirs.push(dir);
  return dir;
}

function writeText(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("native OMP plugin settings loader", () => {
  test("merges lockfile < project plugin-overrides < .omp/enhance.yaml and clamps bounds", () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    const lockPath = path.join(root, "omp-plugins.lock.json");
    mkdirSync(cwd, { recursive: true });

    expect(loadEnhanceSettings({ cwd, pluginLockPath: lockPath })).toEqual(DEFAULT_ENHANCE_SETTINGS);

    writeText(lockPath, JSON.stringify({
      settings: {
        "omp-enhance": {
          defaultRole: "qa",
          showStatusBar: false,
          supervisorModel: "smol",
          supervisorInitialDelaySec: 1,
          flowMaxRepairRounds: 99,
        },
      },
    }));
    expect(loadEnhanceSettings({ cwd, pluginLockPath: lockPath })).toEqual({
      defaultRole: "qa",
      showStatusBar: false,
      supervisorEnabled: true,
      supervisorModel: "smol",
      supervisorThinking: "off",
      supervisorInitialDelaySec: 5,
      flowMaxRepairRounds: 10,
    });

    writeText(path.join(cwd, ".omp", "plugin-overrides.json"), JSON.stringify({
      settings: {
        "omp-enhance": {
          defaultRole: "off",
          supervisorEnabled: false,
          supervisorThinking: "low",
          supervisorInitialDelaySec: 9999,
          flowMaxRepairRounds: -4,
        },
      },
    }));
    expect(loadEnhanceSettings({ cwd, pluginLockPath: lockPath })).toEqual({
      defaultRole: null,
      showStatusBar: false,
      supervisorEnabled: false,
      supervisorModel: "smol",
      supervisorThinking: "low",
      supervisorInitialDelaySec: 600,
      flowMaxRepairRounds: 0,
    });

    writeText(path.join(cwd, ".omp", "enhance.yaml"), [
      "defaultRole: reviewer",
      "supervisorModel: openai-codex/gpt-6.1-sol",
      "flowMaxRepairRounds: 4",
    ].join("\n"));
    expect(loadEnhanceSettings({ cwd, pluginLockPath: lockPath })).toMatchObject({
      defaultRole: "reviewer",
      supervisorModel: "openai-codex/gpt-6.1-sol",
      flowMaxRepairRounds: 4,
    });

    // Malformed optional files degrade gracefully without throwing.
    writeText(path.join(cwd, ".omp", "enhance.yaml"), "::: invalid yaml ::: [");
    expect(loadEnhanceSettings({ cwd, pluginLockPath: lockPath }).defaultRole).toBeNull();
  });
});

describe("model & @advisor inheritance resolution", () => {
  test("builtin supervisor defaults to @advisor, normalizes bare aliases, and respects overrides", () => {
    const root = tempDir();
    const roles = discoverRoles({ cwd: root, globalRolesDir: path.join(root, "global"), builtinRolesDir });
    const supervisor = roles.get("supervisor")!;
    expect(supervisor.model).toBe("@advisor");
    expect(supervisor.thinking).toBe("off");

    expect(normalizeModelSpec("advisor")).toBe("@advisor");
    expect(normalizeModelSpec("@smol")).toBe("@smol");
    expect(normalizeModelSpec("inherit")).toBeUndefined();
    expect(normalizeModelSpec("deepseek/deepseek-flash")).toBe("deepseek/deepseek-flash");

    const hostCtx = {
      model: "session-default-model",
      models: {
        resolve: (spec: string) =>
          spec === "@advisor" ? "advisor-resolved" : spec === "@slow" ? "slow-resolved" : undefined,
        list: () => [{ provider: "custom", id: "local-70b" }],
      },
    };
    const pi = { getThinkingLevel: () => "medium" };

    // 1. Default settings -> inherits OMP @advisor
    expect(resolveRoleRuntimeConfig(supervisor, pi, hostCtx, DEFAULT_ENHANCE_SETTINGS)).toEqual({
      model: "advisor-resolved",
      thinkingLevel: "off",
    });

    // 2. Native /settings override on supervisorModel -> overrides builtin supervisor.yaml
    expect(resolveRoleRuntimeConfig(supervisor, pi, hostCtx, {
      ...DEFAULT_ENHANCE_SETTINGS, supervisorModel: "slow", supervisorThinking: "low",
    })).toEqual({
      model: "slow-resolved",
      thinkingLevel: "low",
    });

    // 3. Explicit user override in global/project supervisor.yaml -> wins over /settings default
    const customSupervisor = saveRoleSpec({
      id: "supervisor", name: supervisor.name, description: supervisor.description,
      model: "custom/local-70b", thinking: "high", stance: supervisor.stance,
      method: supervisor.method, permissions: supervisor.permissions, exit: supervisor.exit,
    }, path.join(root, "global"));
    expect(customSupervisor.source).toBe("global");
    expect(resolveRoleRuntimeConfig(customSupervisor, pi, hostCtx, DEFAULT_ENHANCE_SETTINGS)).toEqual({
      model: { provider: "custom", id: "local-70b" },
      thinkingLevel: "high",
    });

    // 4. Unconfigured @advisor falls back cleanly to current session model
    expect(resolveModelSpec("@advisor", { model: "session-fallback", models: { resolve: () => undefined } }))
      .toBe("session-fallback");
  });

  test("orchestrator binds per-role model and thinkingLevel when creating child sessions", async () => {
    const root = tempDir();
    const cwd = path.join(root, "work");
    mkdirSync(cwd, { recursive: true });
    const store = new EnhanceStore(path.join(cwd, "state.sqlite"));
    try {
      const customReviewer = saveRoleSpec({
        id: "reviewer", name: "Heterogeneous Reviewer", description: "Cross-model reviewer",
        model: "@slow", thinking: "high", stance: "Strict audit", method: ["Audit diff"],
        permissions: { tools: ["read"], writable: [], protected: ["**"] },
        exit: { requireToolEvidence: false, criteria: [] },
      }, path.join(cwd, ".omp", "roles"));

      let capturedOptions = null as Record<string, unknown> | null;
      const fakePi = {
        getAllTools: () => [{ name: "read" }, { name: "write" }],
        getThinkingLevel: () => "low",
        pi: {
          settings: {},
          async createAgentSession(opts: Record<string, unknown>) {
            capturedOptions = opts;
            const handoffTool = (opts.customTools as any[])[0];
            return {
              session: {
                messages: [],
                async prompt() {
                  if (capturedOptions) {
                    await handoffTool.execute("call-h", { verdict: "ready", summary: "Audited with @slow" });
                  }
                },
                getLastAssistantText: () => "done",
                getLastAssistantMessage: () => null,
                async dispose() {},
              },
            };
          },
        },
      };
      const hostCtx = {
        cwd, modelRegistry: {}, model: "default-session-model",
        models: { resolve: (s: string) => (s === "@slow" ? "gpt-slow-auditor" : undefined) },
      };
      const runner = createOmpRoleSessionRunner(fakePi, hostCtx, DEFAULT_ENHANCE_SETTINGS);
      const mandate = store.upsertMandate({ goal: "Audit module" });
      const outcome = await runner.runRoleTurn({
        cwd, store, role: customReviewer, mandate, epistemicItems: [],
        upstreamHandoff: null, toTarget: "user", conditioningPrompt: "cond", taskPrompt: "task",
      });
      expect(outcome.envelope?.summary).toBe("Audited with @slow");
      expect(capturedOptions?.model).toBe("gpt-slow-auditor");
      expect(capturedOptions?.thinkingLevel).toBe("high");
    } finally {
      store.close();
    }
  });
});

describe("Role Studio & zero-extra-slash-command integration", () => {
  test("registers zero extra slash commands and drives Role Studio create, checkbox tools, CoW, and reset", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    const globalDir = path.join(root, "global-roles");
    const lockPath = path.join(root, "lock.json");
    mkdirSync(cwd, { recursive: true });

    const builtinReviewerPath = path.join(builtinRolesDir, "reviewer.yaml");
    const builtinReviewerHashBefore = createHash("sha256")
      .update(readFileSync(builtinReviewerPath)).digest("hex");

    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const activeToolHistory: string[][] = [];
    const modelHistory: unknown[] = [];
    const statusHistory: Array<string | undefined> = [];
    const notifications: Array<{ text: string; level?: string }> = [];

    const pi = {
      on() {},
      registerTool() {},
      registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, spec);
      },
      sendMessage() {},
      getAllTools: () => [
        { name: "read" }, { name: "grep" }, { name: "edit" }, { name: "write" }, { name: "bash" },
        { name: "enhance_mandate" },
      ],
      async setActiveTools(names: string[]) { activeToolHistory.push(names); },
      async setModel(m: unknown) { modelHistory.push(m); },
      setThinkingLevel() {},
      getThinkingLevel: () => "off",
      pi: { settings: {} },
    };

    ompEnhance(pi, { globalRolesDir: globalDir, builtinRolesDir, pluginLockPath: lockPath });

    // Strict slash-command economy: NO /enhance-settings command added!
    expect([...commands.keys()].sort()).toEqual([
      "enhance-handoff", "enhance-status", "flow", "handoff", "role",
    ]);

    // Scripted UI responses for:
    // 1) /role (opens home) -> "+ Create new role..." -> id "sec-audit", desc "Security auditor",
    //    project scope, readonly, model "@slow" -> enters editor -> Allowed tools (toggle bash ON, Save) ->
    //    Edit full YAML (1st invalid -> warning, 2nd valid) -> Activate -> Esc editor -> Esc home.
    const selectQueue: Array<string | undefined> = [
      "+ Create new role...",
      "project (.omp/roles)",
      "readonly (read/verify only, protects **)",
      "@slow",
      "Allowed tools: unrestricted",
      "edit",   // uncheck edit
      "write",  // uncheck write
      "✓ Save tool selection",
      "Edit full role YAML...",
      'Activate "sec-audit" in current session',
      undefined, // exit role editor
      undefined, // exit studio home
    ];
    const inputQueue: Array<string | undefined> = ["sec-audit", "Security auditor"];
    let editorAttempt = 0;

    const ctx = {
      cwd,
      hasUI: true,
      model: "base-model",
      models: {
        resolve: (spec: string) => (spec === "@slow" ? "resolved-slow-model" : undefined),
        list: () => [{ provider: "openai-codex", id: "gpt-6.1-sol" }],
      },
      ui: {
        async select(_title: string, _options: string[], _opts?: Record<string, unknown>) {
          return selectQueue.shift();
        },
        async input() { return inputQueue.shift(); },
        async editor(_title: string, prefill: string) {
          editorAttempt += 1;
          if (editorAttempt === 1) return `${prefill}\nunknown_field: 123\n`;
          return prefill.replace("\nunknown_field: 123\n", "\n").replaceAll("Security auditor", "Hardened security auditor");
        },
        async confirm() { return true; },
        notify(text: string, level?: string) { notifications.push({ text, level }); },
        setStatus(_key: string, badge?: string) { statusHistory.push(badge); },
      },
    };

    await commands.get("role")!.handler("", ctx);

    const createdPath = path.join(cwd, ".omp", "roles", "sec-audit.yaml");
    expect(existsSync(createdPath)).toBe(true);
    const parsedCreated = parseRoleYaml(readFileSync(createdPath, "utf8"), "project", createdPath);
    expect(parsedCreated.model).toBe("@slow");
    expect(parsedCreated.description).toBe("Hardened security auditor");
    expect(parsedCreated.permissions.tools).toEqual(["bash", "grep", "read"]);
    expect(parsedCreated.permissions.writable).toEqual([]);
    expect(notifications.some((n) => n.level === "warning" && n.text.includes("unknown_field"))).toBe(true);
    expect(modelHistory).toEqual(["resolved-slow-model"]);
    expect(statusHistory.at(-1)).toBe("enhance:sec-audit (@slow)");
    expect(activeToolHistory.at(-1)).toContain("enhance_mandate");
    expect(activeToolHistory.at(-1)).not.toContain("write");

    // 2) Copy-on-Write on builtin reviewer -> writes to globalDir without touching builtin roles/reviewer.yaml, then resets
    selectQueue.push(
      "Model: inherit",
      "@advisor",
      undefined,
    );
    await commands.get("role")!.handler("edit reviewer", ctx);
    const globalReviewerPath = path.join(globalDir, "reviewer.yaml");
    expect(existsSync(globalReviewerPath)).toBe(true);
    expect(createHash("sha256").update(readFileSync(builtinReviewerPath)).digest("hex"))
      .toBe(builtinReviewerHashBefore);

    selectQueue.push("Reset global override", undefined);
    await commands.get("role")!.handler("edit reviewer", ctx);
    expect(existsSync(globalReviewerPath)).toBe(false);
    expect(resetRoleOverride({ id: "reviewer", targetDir: globalDir })).toBe(false);

    // 3) Check serializeRoleYaml rejects invalid thinking level on parse
    const badYaml = serializeRoleYaml({
      id: "qa", name: "QA", description: "QA", stance: "s", method: ["m"],
      permissions: {}, exit: { requireToolEvidence: false, criteria: [] },
    }).replace("id: qa", "id: qa\nthinking: ultra");
    expect(() => parseRoleYaml(badYaml, "global", path.join(globalDir, "qa.yaml"))).toThrow(/thinking must be one of/);
  });

  test("allows roles to spawn OMP subagents while blocking write-escalation subagents on restricted roles", () => {
    const root = tempDir();
    const roles = discoverRoles({ cwd: root, globalRolesDir: path.join(root, "global"), builtinRolesDir });
    const dev = roles.get("dev")!;
    const qa = roles.get("qa")!;
    const reviewer = roles.get("reviewer")!;

    expect(qa.permissions.tools).toContain("task");
    expect(qa.permissions.tools).toContain("wait");
    expect(reviewer.permissions.tools).toContain("task");
    expect(reviewer.permissions.tools).toContain("glob");

    const tracker = new TurnTracker();
    tracker.resetTurn(root);

    // dev is unrestricted: can spawn any OMP subagent (scout, sonic, default task worker)
    expect(tracker.checkToolCallAllowed(root, dev, { toolName: "task", input: { agent: "sonic", task: "refactor" } }))
      .toEqual({ block: false });
    expect(tracker.checkToolCallAllowed(root, dev, { toolName: "task", input: { task: "general work" } }))
      .toEqual({ block: false });

    // qa & reviewer may spawn read-only subagents (single or batch)
    expect(tracker.checkToolCallAllowed(root, qa, { toolName: "task", input: { agent: "scout", task: "find callers" } }))
      .toEqual({ block: false });
    expect(tracker.checkToolCallAllowed(root, reviewer, {
      toolName: "task",
      input: { tasks: [{ agent: "scout", task: "scan a" }, { agent: "security-reviewer", task: "audit b" }] },
    })).toEqual({ block: false });

    // qa & reviewer MUST NOT launder writes through writable subagents (sonic, task, or omitted default agent)
    expect(tracker.checkToolCallAllowed(root, qa, { toolName: "task", input: { agent: "sonic", task: "edit src" } }))
      .toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(root, reviewer, { toolName: "task", input: { task: "default worker" } }))
      .toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(root, qa, {
      toolName: "task",
      input: { tasks: [{ agent: "scout", task: "ok" }, { agent: "sonic", task: "sneaky write" }] },
    })).toMatchObject({ block: true });
  });

  test("drives split-pane custom /role overlay (1-key Enter switch, h handoff, Space tool toggle) and Tab completions", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    const globalDir = path.join(root, "global-roles");
    const lockPath = path.join(root, "lock.json");
    mkdirSync(cwd, { recursive: true });

    const commands = new Map<string, {
      handler: (args: string, ctx: any) => Promise<void>;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string }>;
    }>();
    const workingMessages: Array<string | undefined> = [];
    let activeRoleSwitched = null as string | null;

    const pi = {
      cwd,
      on() {},
      registerTool() {},
      registerCommand(name: string, spec: any) { commands.set(name, spec); },
      sendMessage() {},
      getAllTools: () => [{ name: "read" }, { name: "grep" }, { name: "bash" }, { name: "task" }],
      async setActiveTools() {},
      getThinkingLevel: () => "off",
      pi: { settings: {} },
    };

    ompEnhance(pi, {
      globalRolesDir: globalDir,
      builtinRolesDir,
      pluginLockPath: lockPath,
      runnerFactory: (_pi, hostCtx) => ({
        async runRoleTurn(stepCtx) {
          hostCtx?.ui?.setWorkingMessage?.(`stage:${stepCtx.role.id} → read`);
          const env = stepCtx.store.getLatestHandoff(stepCtx.mandate.id);
          hostCtx?.ui?.setWorkingMessage?.(undefined);
          return { envelope: env, observedCalls: [], assistantText: "ok", usage: null };
        },
      }),
    });

    // Verify Tab argument completions for /role, /handoff, and comma-chained /flow
    const roleComp = commands.get("role")!.getArgumentCompletions!;
    expect(roleComp("q").map((c) => c.value)).toEqual(["qa"]);
    expect(roleComp("edit rev").map((c) => c.value)).toEqual(["edit reviewer"]);
    const handoffComp = commands.get("handoff")!.getArgumentCompletions!;
    expect(handoffComp("").some((c) => c.value === "supervisor")).toBe(false);
    expect(handoffComp("rev").map((c) => c.value)).toEqual(["reviewer"]);
    const flowComp = commands.get("flow")!.getArgumentCompletions!;
    expect(flowComp("dev,q").map((c) => c.value)).toEqual(["dev,qa"]);

    // Drive split-pane custom overlay: Down (from dev -> ml-engineer -> qa) + Enter -> 1-step switch to qa!
    const renderedSnapshots: string[][] = [];
    const customScripts: string[][] = [
      ["\x1b[B", "\x1b[B", "\r"], // Overlay call 1: move down twice to qa, press Enter to activate!
      ["e"],                      // Overlay call 2: press 'e' on qa to open editor
      [" ", "\r"],                // Tool checkbox custom overlay: toggle 1st tool ('bash'), press Enter to save
      ["h"],                      // Return to split-pane overlay: press 'h' to handoff to qa!
    ];
    const selectScripts: Array<string | undefined> = [
      "Allowed tools: [read, grep, glob, find, lsp, edit, write, bash, task, wait]",
      undefined, // exit role editor back to split-pane overlay
    ];

    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        async custom(factory: any) {
          const keys = customScripts.shift() ?? ["\x1b"];
          let resolved: unknown;
          const comp = factory({ requestRender() {} }, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, (res: unknown) => {
            resolved = res;
          });
          renderedSnapshots.push(comp.render(100));
          for (const key of keys) comp.handleInput(key);
          return resolved;
        },
        async select() { return selectScripts.shift(); },
        notify() {},
        setStatus(_k: string, badge?: string) { activeRoleSwitched = badge ?? null; },
        setWorkingMessage(msg?: string) { workingMessages.push(msg); },
      },
    };

    // 1st /role: Down, Down, Enter -> instant switch to qa!
    await commands.get("role")!.handler("", ctx);
    expect(activeRoleSwitched).toBe("enhance:qa");
    expect(renderedSnapshots[0]!.some((line) => line.includes("OMP Enhance · Roles"))).toBe(true);
    expect(renderedSnapshots[0]!.some((line) => line.includes("Enter switch session"))).toBe(true);

    // 2nd /role: 'e' -> Space-toggle tool in custom checkbox overlay -> Esc editor -> 'h' handoff!
    await commands.get("role")!.handler("", ctx);
    const savedQaPath = path.join(globalDir, "qa.yaml");
    expect(existsSync(savedQaPath)).toBe(true);
    expect(workingMessages).toContain("stage:qa → read");
    expect(workingMessages.at(-1)).toBeUndefined();
  });
});
