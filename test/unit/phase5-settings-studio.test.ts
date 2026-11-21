import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkToolCallAllowed, DEFAULT_READONLY_TOOLS, resolveRoleActiveTools, TurnTracker,
} from "../../src/core/policy.ts";
import {
  DEFAULT_ENHANCE_SETTINGS, loadEnhanceSettings, normalizeModelSpec,
  resolveDefaultPluginLockPath, resolveModelSpec, resolveRoleRuntimeConfig,
} from "../../src/core/settings.ts";
import { ROLE_THINKING_LEVELS, type RoleSpec } from "../../src/core/types.ts";
import {
  discoverRoles, parseRoleYaml, resetRoleOverride, saveRoleSpec, serializeRoleYaml,
} from "../../src/roles/loader.ts";
import { parseOverlayKey } from "../../src/ui/kit.ts";
import {
  openRoleEditor, openRoleStudioHome, parseProtectedGlobInput, parseWritableGlobInput,
  type RoleStudioDeps,
} from "../../src/ui/role-studio.ts";
import ompEnhance from "../../src/entry.ts";

const tempDirs: string[] = [];
const repoRoot = path.resolve(import.meta.dir, "../..");
const builtinRolesDir = path.join(repoRoot, "roles");

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

describe("package.json omp.settings parity & native OMP settings loader", () => {
  test("keeps package.json omp.settings keys, defaults, and thinking levels (including xhigh) in sync with runtime", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const schema = pkg?.omp?.settings as Record<string, any>;
    expect(Object.keys(schema).sort()).toEqual(Object.keys(DEFAULT_ENHANCE_SETTINGS).sort());
    expect(schema.defaultRole.default).toBe(DEFAULT_ENHANCE_SETTINGS.defaultRole);
    expect(schema.showStatusBar.default).toBe(DEFAULT_ENHANCE_SETTINGS.showStatusBar);
    expect(schema.supervisorEnabled.default).toBe(DEFAULT_ENHANCE_SETTINGS.supervisorEnabled);
    expect(schema.supervisorModel.default).toBe(DEFAULT_ENHANCE_SETTINGS.supervisorModel);
    expect(schema.supervisorThinking.default).toBe(DEFAULT_ENHANCE_SETTINGS.supervisorThinking);
    expect(schema.supervisorInitialDelaySec.default).toBe(DEFAULT_ENHANCE_SETTINGS.supervisorInitialDelaySec);
    expect(schema.flowMaxRepairRounds.default).toBe(DEFAULT_ENHANCE_SETTINGS.flowMaxRepairRounds);
    expect(schema.flowRoutingMode.default).toBe(DEFAULT_ENHANCE_SETTINGS.flowRoutingMode);
    expect([...schema.supervisorThinking.values].sort()).toEqual([...ROLE_THINKING_LEVELS].sort());
    expect(schema.supervisorThinking.values).toContain("xhigh");
    expect(schema.supervisorThinking.values).toContain("max");
    expect(schema.supervisorThinking.values).toContain("auto");
    expect(schema.supervisorThinking.default).toBe("inherit");
  });

  test("merges lockfile < parent/project plugin-overrides < .omp/enhance.yaml, clamps bounds, supports --profile, and gates untrusted projects", () => {
    const root = tempDir();
    const monorepoRoot = path.join(root, "repo");
    const cwd = path.join(monorepoRoot, "packages", "sub");
    const lockPath = path.join(root, "omp-plugins.lock.json");
    mkdirSync(path.join(monorepoRoot, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    expect(resolveDefaultPluginLockPath("work")).toContain(
      path.join(".omp", "profiles", "work", "plugins", "omp-plugins.lock.json"),
    );
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
      supervisorThinking: "inherit",
      supervisorInitialDelaySec: 5,
      flowMaxRepairRounds: 10,
      flowRoutingMode: "ask",
    });

    // Parent monorepo .omp/plugin-overrides.json applies to nested packages/sub cwd
    writeText(path.join(monorepoRoot, ".omp", "plugin-overrides.json"), JSON.stringify({
      settings: {
        "omp-enhance": {
          defaultRole: "off",
          supervisorEnabled: false,
          supervisorThinking: "xhigh",
          supervisorInitialDelaySec: 9999,
          flowMaxRepairRounds: -4,
          flowRoutingMode: "auto",
        },
      },
    }));
    expect(loadEnhanceSettings({ cwd, pluginLockPath: lockPath })).toEqual({
      defaultRole: null,
      showStatusBar: false,
      supervisorEnabled: false,
      supervisorModel: "smol",
      supervisorThinking: "xhigh",
      supervisorInitialDelaySec: 600,
      flowMaxRepairRounds: 0,
      flowRoutingMode: "auto",
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

    // Untrusted workspace (isProjectTrusted: false) ignores .omp/plugin-overrides.json & .omp/enhance.yaml!
    const warnings: string[] = [];
    const untrusted = loadEnhanceSettings({
      cwd, pluginLockPath: lockPath, isProjectTrusted: false, onWarning: (w) => warnings.push(w),
    });
    expect(untrusted.defaultRole).toBe("qa");
    expect(untrusted.flowRoutingMode).toBe("ask");
    expect(untrusted.supervisorEnabled).toBe(true);
    expect(warnings.some((w) => w.includes("not trusted"))).toBe(true);

    // Malformed optional files degrade gracefully while emitting diagnostic warning
    const parseWarnings: string[] = [];
    writeText(path.join(cwd, ".omp", "enhance.yaml"), "::: invalid yaml ::: [");
    expect(loadEnhanceSettings({
      cwd, pluginLockPath: lockPath, onWarning: (w) => parseWarnings.push(w),
    }).defaultRole).toBeNull();
    expect(parseWarnings.some((w) => w.includes("enhance.yaml"))).toBe(true);
  });
});

describe("model & @advisor inheritance resolution", () => {
  test("builtin supervisor defaults to @advisor + inherit, extracts @role:thinking & provider/model:thinking suffixes, and avoids fuzzy @role substring matches", () => {
    const root = tempDir();
    const roles = discoverRoles({ cwd: root, globalRolesDir: path.join(root, "global"), builtinRolesDir });
    const supervisor = roles.get("supervisor")!;
    const vision = roles.get("vision")!;
    expect(supervisor.model).toBe("@advisor");
    expect(supervisor.thinking).toBe("inherit");

    expect(normalizeModelSpec("advisor")).toBe("@advisor");
    expect(normalizeModelSpec("advisor:xhigh")).toBe("@advisor:xhigh");
    expect(normalizeModelSpec("@smol")).toBe("@smol");
    expect(normalizeModelSpec("inherit")).toBeUndefined();
    expect(normalizeModelSpec("deepseek/deepseek-flash:max")).toBe("deepseek/deepseek-flash:max");

    const qwenAdvisor = { provider: "openrouter", id: "qwen/qwen3.8-27b", input: ["text"] };
    const qwenVision = { provider: "openrouter", id: "qwen/qwen3.8-flash", input: ["text", "image"] };
    const gptSlow = { provider: "openai-codex", id: "gpt-6.1-sol", input: ["text", "image"] };
    const roleSpecs: Record<string, string> = {
      default: "deepseek/deepseek-flash:max",
      advisor: "openrouter/qwen/qwen3.8-27b:xhigh",
      vision: "openrouter/qwen/qwen3.8-flash:medium",
      slow: "openai-codex/gpt-6.1-sol:max",
    };

    const hostCtx = {
      model: "session-default-model",
      models: {
        resolve: (spec: string) =>
          spec === "@advisor" ? qwenAdvisor
            : spec === "@vision" ? qwenVision
              : spec === "@slow" ? gptSlow
                : undefined,
        list: () => [qwenAdvisor, qwenVision, gptSlow, { provider: "custom", id: "local-70b" }],
      },
    };
    const pi = {
      getThinkingLevel: () => "max",
      pi: { settings: { getModelRole: (r: string) => roleSpecs[r] } },
    };

    // 1. Default settings -> supervisor inherits OMP @advisor model AND its :xhigh suffix (not session :max!)
    expect(resolveRoleRuntimeConfig(supervisor, pi, hostCtx, DEFAULT_ENHANCE_SETTINGS)).toEqual({
      model: qwenAdvisor,
      thinkingLevel: "xhigh",
    });

    // 1b. Builtin vision has explicit thinking: "low"; when thinking is "inherit"/undefined, @vision's :medium suffix wins over session :max
    expect(resolveRoleRuntimeConfig(vision, pi, hostCtx, DEFAULT_ENHANCE_SETTINGS)).toEqual({
      model: qwenVision,
      thinkingLevel: "low",
    });
    expect(resolveRoleRuntimeConfig({ ...vision, thinking: "inherit" }, pi, hostCtx, DEFAULT_ENHANCE_SETTINGS)).toEqual({
      model: qwenVision,
      thinkingLevel: "medium",
    });

    // 2. Native /settings override on supervisorModel + supervisorThinking -> explicit thinking wins over @slow:max
    expect(resolveRoleRuntimeConfig(supervisor, pi, hostCtx, {
      ...DEFAULT_ENHANCE_SETTINGS, supervisorModel: "slow", supervisorThinking: "low",
    })).toEqual({
      model: gptSlow,
      thinkingLevel: "low",
    });

    // 2b. supervisorThinking: "auto" or "max" supported cleanly
    expect(resolveRoleRuntimeConfig(supervisor, pi, hostCtx, {
      ...DEFAULT_ENHANCE_SETTINGS, supervisorModel: "slow", supervisorThinking: "auto",
    })).toEqual({
      model: gptSlow,
      thinkingLevel: "auto",
    });

    // 3. Explicit custom "provider/model:thinking" in global supervisor.yaml strips :max for lookup & extracts thinking
    const customSupervisor = saveRoleSpec({
      id: "supervisor", name: supervisor.name, description: supervisor.description,
      model: "custom/local-70b:high", thinking: "inherit", stance: supervisor.stance,
      method: supervisor.method, permissions: supervisor.permissions, exit: supervisor.exit,
    }, path.join(root, "global"));
    expect(resolveRoleRuntimeConfig(customSupervisor, pi, hostCtx, DEFAULT_ENHANCE_SETTINGS)).toEqual({
      model: { provider: "custom", id: "local-70b" },
      thinkingLevel: "high",
    });

    // 4. Explicit `inherit` override in global supervisor.yaml -> inherits session model & session thinking ("max")
    const inheritSupervisor = saveRoleSpec({
      id: "supervisor", name: supervisor.name, description: supervisor.description,
      model: "inherit", thinking: "inherit", stance: supervisor.stance,
      method: supervisor.method, permissions: supervisor.permissions, exit: supervisor.exit,
    }, path.join(root, "global"));
    expect(inheritSupervisor.model).toBe("inherit");
    expect(inheritSupervisor.thinking).toBe("inherit");
    expect(resolveRoleRuntimeConfig(inheritSupervisor, pi, hostCtx, DEFAULT_ENHANCE_SETTINGS)).toEqual({
      model: "session-default-model",
      thinkingLevel: "max",
    });

    // 5. Unconfigured @advisor / @vision NEVER calls resolve("advisor") / resolve("vision") fuzzy substring match!
    const resolveQueries: string[] = [];
    const fuzzyTrapCtx = {
      model: { provider: "deepseek", id: "deepseek-chat", input: ["text"] },
      models: {
        resolve: (q: string) => {
          resolveQueries.push(q);
          // Simulate OMP's fuzzy substring matching when '@' is stripped!
          if (q === "advisor") return { provider: "trap", id: "bad-advisor-substring" };
          if (q === "vision") return { provider: "deepseek", id: "deepseek-v4-flash-vision-exp", input: ["text"] };
          return undefined;
        },
        list: () => [
          { provider: "deepseek", id: "deepseek-v4-flash-vision-exp", input: ["text"] },
          { provider: "openrouter", id: "real-multimodal-vl", input: ["text", "image"] },
        ],
      },
    };
    expect(resolveModelSpec("@advisor", fuzzyTrapCtx)).toEqual(fuzzyTrapCtx.model);
    expect(resolveModelSpec("@vision", fuzzyTrapCtx)).toEqual({
      provider: "openrouter", id: "real-multimodal-vl", input: ["text", "image"],
    });
    expect(resolveQueries).toEqual(["@advisor", "@vision"]);
  });
});

describe("Role Studio strict UI, glob parsing, supervisor CoW/inherit, and tool union", () => {
  function createStudioHarness(cwd: string, globalDir: string, hostToolNames: string[]) {
    let roles = discoverRoles({ cwd, globalRolesDir: globalDir, builtinRolesDir });
    let activeRoleId: string | null = "general";
    const activeToolHistory: string[][] = [];
    const modelHistory: unknown[] = [];
    const notifications: Array<{ text: string; level?: string }> = [];

    const pi = {
      getAllTools: () => hostToolNames.map((name) => ({ name })),
      async setActiveTools(names: string[]) { activeToolHistory.push(names); },
      async setModel(m: unknown) { modelHistory.push(m); },
      setThinkingLevel() {},
      getThinkingLevel: () => "medium",
    };

    const makeDeps = (ctx: any): RoleStudioDeps => ({
      cwd,
      globalRolesDir: globalDir,
      builtinRolesDir,
      pi,
      ctx,
      getRoles: () => roles,
      refreshRoles: () => {
        roles = discoverRoles({ cwd, globalRolesDir: globalDir, builtinRolesDir });
        return roles;
      },
      getSettings: () => ({ ...DEFAULT_ENHANCE_SETTINGS, supervisorModel: "@slow", supervisorThinking: "low" }),
      getActiveRoleId: () => activeRoleId,
      async activateRole(id: string | null) {
        activeRoleId = id;
        const r = id ? roles.get(id) ?? null : null;
        await pi.setActiveTools(r ? resolveRoleActiveTools(r, hostToolNames) : hostToolNames);
        if (r?.model && r.model !== "inherit") {
          const resolved = resolveModelSpec(r.model, ctx);
          if (resolved) await pi.setModel(resolved);
        }
      },
    });

    return { makeDeps, getRoles: () => roles, getActiveRoleId: () => activeRoleId, activeToolHistory, modelHistory, notifications };
  }

  test("validates every ui.select option strictly, preserves brace globs, maps Protected '*' -> ['**'], and handles supervisor CoW/inherit/reset", async () => {
    expect(parseProtectedGlobInput("*")).toEqual(["**"]);
    expect(parseProtectedGlobInput("all")).toEqual(["**"]);
    expect(parseProtectedGlobInput("none")).toBeUndefined();
    expect(parseProtectedGlobInput("src/**/*.{ts,tsx}, config/**")).toEqual(["src/**/*.{ts,tsx}", "config/**"]);
    expect(parseWritableGlobInput("*")).toBeUndefined();
    expect(parseWritableGlobInput("none")).toEqual([]);
    expect(parseWritableGlobInput("src/**/*.{ts,tsx}, test/**")).toEqual(["src/**/*.{ts,tsx}", "test/**"]);

    const root = tempDir();
    const cwd = path.join(root, "workspace");
    const globalDir = path.join(root, "global-roles");
    mkdirSync(cwd, { recursive: true });

    const builtinReviewerPath = path.join(builtinRolesDir, "reviewer.yaml");
    const builtinReviewerHashBefore = createHash("sha256").update(readFileSync(builtinReviewerPath)).digest("hex");

    const h = createStudioHarness(cwd, globalDir, ["read", "grep", "edit", "write", "bash", "enhance_mandate"]);

    // Strict selectQueue: EVERY non-undefined choice MUST exist verbatim in `_options`!
    const selectQueue: Array<string | undefined> = [
      "+ Create new role...",
      "project (.omp/roles)",
      "readonly (纯只读验证，受保护路径 **)",
      "@slow",
      `Allowed tools: [${[...DEFAULT_READONLY_TOOLS].join(", ")}]`,
      "bash", // toggle bash ON while preserving unloaded DEFAULT_READONLY_TOOLS (glob, find, lsp, task, wait)!
      "✓ Save tool selection",
      "Protected globs: [**]",
      "Writable globs: [readonly]",
      "Edit full role YAML...",
      'Activate "sec-audit" in current session',
      undefined, // exit role editor
      undefined, // exit studio home
    ];
    const inputQueue: Array<string | undefined> = [
      "sec-audit",
      "Security auditor",
      "*",                          // Protected globs: '*' MUST become ["**"], NOT deleted!
      "src/**/*.{ts,tsx}, test/**", // Brace-safe writable globs!
    ];
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
        async select(title: string, options: string[]) {
          const next = selectQueue.shift();
          if (next !== undefined) {
            expect(options).toContain(next);
          }
          return next;
        },
        async input() { return inputQueue.shift(); },
        async editor(_title: string, prefill: string) {
          editorAttempt += 1;
          if (editorAttempt === 1) return `${prefill}\nunknown_field: 123\n`;
          return prefill.replace("\nunknown_field: 123\n", "\n").replaceAll("Security auditor", "Hardened security auditor");
        },
        async confirm() { return true; },
        notify(text: string, level?: string) { h.notifications.push({ text, level }); },
      },
    };

    await openRoleStudioHome(h.makeDeps(ctx));

    const createdPath = path.join(cwd, ".omp", "roles", "sec-audit.yaml");
    expect(existsSync(createdPath)).toBe(true);
    const parsedCreated = parseRoleYaml(readFileSync(createdPath, "utf8"), "project", createdPath);
    expect(parsedCreated.model).toBe("@slow");
    expect(parsedCreated.description).toBe("Hardened security auditor");
    // Unloaded tools (find, glob, lsp, task, wait) were NOT wiped when toggling bash!
    expect(parsedCreated.permissions.tools).toEqual(["bash", "find", "glob", "grep", "lsp", "read", "task", "wait"]);
    expect(parsedCreated.permissions.protected).toEqual(["**"]);
    expect(parsedCreated.permissions.writable).toEqual(["src/**/*.{ts,tsx}", "test/**"]);
    expect(h.notifications.some((n) => n.level === "warning" && n.text.includes("unknown_field"))).toBe(true);
    expect(h.modelHistory).toEqual(["resolved-slow-model"]);

    // Supervisor Copy-on-Write:
    // 1) Toggling `Require tool evidence` on builtin supervisor MUST NOT bake `@advisor`/`off` into override
    selectQueue.push(
      "Require tool evidence: false",
      undefined,
    );
    await openRoleEditor("supervisor", h.makeDeps(ctx));
    const supOverridePath = path.join(globalDir, "supervisor.yaml");
    const supAfterToggle = parseRoleYaml(readFileSync(supOverridePath, "utf8"), "global", supOverridePath);
    expect(supAfterToggle.exit.requireToolEvidence).toBe(true);
    expect(supAfterToggle.model).toBeUndefined();
    expect(supAfterToggle.thinking).toBeUndefined();
    expect(resolveRoleRuntimeConfig(
      supAfterToggle, { getThinkingLevel: () => "high" }, ctx,
      { ...DEFAULT_ENHANCE_SETTINGS, supervisorModel: "@slow", supervisorThinking: "low" },
    )).toEqual({ model: "resolved-slow-model", thinkingLevel: "low" });

    // 2) Choosing `Model: inherit` & `Thinking: inherit` on supervisor saves explicit "inherit" (not snapping to @slow/low)
    selectQueue.push(
      "Model: @slow (via /settings)",
      "inherit",
      "Thinking: low (via /settings)",
      "inherit",
      undefined,
    );
    await openRoleEditor("supervisor", h.makeDeps(ctx));
    const supInherit = parseRoleYaml(readFileSync(supOverridePath, "utf8"), "global", supOverridePath);
    expect(supInherit.model).toBe("inherit");
    expect(supInherit.thinking).toBe("inherit");
    expect(resolveRoleRuntimeConfig(
      supInherit, { getThinkingLevel: () => "high" }, { model: "user-session-model" },
      { ...DEFAULT_ENHANCE_SETTINGS, supervisorModel: "@slow", supervisorThinking: "low" },
    )).toEqual({ model: "user-session-model", thinkingLevel: "high" });

    // 3) Copy-on-Write on builtin reviewer + defensive confirm (false/undefined refuses reset) + true resets & re-activates
    await h.makeDeps(ctx).activateRole("reviewer");
    selectQueue.push("Model: inherit", "@slow", undefined);
    await openRoleEditor("reviewer", h.makeDeps(ctx));
    const globalReviewerPath = path.join(globalDir, "reviewer.yaml");
    expect(existsSync(globalReviewerPath)).toBe(true);
    expect(createHash("sha256").update(readFileSync(builtinReviewerPath)).digest("hex")).toBe(builtinReviewerHashBefore);

    // If ui.confirm is missing/undefined, Reset override fails closed and keeps override intact
    const noConfirmCtx = { ...ctx, ui: { ...ctx.ui, confirm: undefined } };
    selectQueue.push("Reset global override", undefined);
    await openRoleEditor("reviewer", h.makeDeps(noConfirmCtx));
    expect(existsSync(globalReviewerPath)).toBe(true);

    // With confirm() === true, Reset deletes override and re-runs activateRole("reviewer")
    const prevActivations = h.activeToolHistory.length;
    selectQueue.push("Reset global override", undefined);
    await openRoleEditor("reviewer", h.makeDeps(ctx));
    expect(existsSync(globalReviewerPath)).toBe(false);
    expect(h.activeToolHistory.length).toBeGreaterThan(prevActivations);
    expect(resetRoleOverride({ id: "reviewer", targetDir: globalDir })).toBe(false);

    // Check serializeRoleYaml rejects invalid thinking level on parse
    const badYaml = serializeRoleYaml({
      id: "qa", name: "QA", description: "QA", stance: "s", method: ["m"],
      permissions: {}, exit: { requireToolEvidence: false, criteria: [] },
    }).replace("id: qa", "id: qa\nthinking: ultra");
    expect(() => parseRoleYaml(badYaml, "global", path.join(globalDir, "qa.yaml"))).toThrow(/thinking must be one of/);
  });

  test("preserves unloaded YAML tools in custom checkbox overlay, supports Kitty colon subparams, and restricts subagents", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    const globalDir = path.join(root, "global-roles");
    mkdirSync(cwd, { recursive: true });

    // Only 4 tools loaded in session, while built-in qa has 11 tools in YAML!
    const h = createStudioHarness(cwd, globalDir, ["read", "grep", "bash", "task"]);
    const qaBefore = h.getRoles().get("qa")!;
    expect(qaBefore.permissions.tools).toHaveLength(11);

    // Verify subagent write-escalation guard on TurnTracker / checkToolCallAllowed
    const tracker = new TurnTracker();
    tracker.resetTurn(cwd);
    expect(checkToolCallAllowed(cwd, h.getRoles().get("dev")!, { toolName: "task", input: { agent: "sonic", task: "refactor" } }))
      .toEqual({ block: false });
    expect(checkToolCallAllowed(cwd, qaBefore, { toolName: "task", input: { agent: "scout", task: "scan" } }))
      .toEqual({ block: false });
    expect(checkToolCallAllowed(cwd, qaBefore, { toolName: "task", input: { agent: "sonic", task: "edit src" } }))
      .toMatchObject({ block: true });

    // Verify Kitty CSI-u parser including alternate/base-layout colon sub-parameters
    expect(parseOverlayKey("\x1b[27u")).toBe("escape");
    expect(parseOverlayKey("\x1b[27;1:1u")).toBe("escape");
    expect(parseOverlayKey("\x1b[27::27;1:1u")).toBe("escape");
    expect(parseOverlayKey("\x1b[27;1:3u")).toBeNull();
    expect(parseOverlayKey("\x1b[99;5u")).toBe("escape");
    expect(parseOverlayKey("\x1b[101:69:101;1:1;101u")).toBe("e");
    expect(parseOverlayKey("\x1b[32;1:1u")).toBe("space");
    expect(parseOverlayKey("\x1b[13;1:1u")).toBe("enter");

    // Drive custom overlay: switch to qa -> press 'e' -> Space-toggle index 0 (`apply_patch`) + Enter -> Back -> Esc
    const customScripts: string[][] = [
      ["\x1b[1;1:1B", "\x1b[1;1:1B", "\x1b[13;1:1u"], // general (idx 2) -> ml-engineer (3) -> qa (4) + Enter!
      ["\x1b[101:69:101;1:1u"],                       // Kitty 'e' with colon sub-params -> open editor on qa
      ["\x1b[32;1:1u", "\x1b[13;1:1u"],               // Space (uncheck `apply_patch`) + Enter in checkbox overlay
      ["\x1b[27::27;1:1u"],                           // Kitty Esc with colon sub-params exits studio cleanly!
    ];
    const selectScripts: Array<string | undefined> = [
      `Allowed tools: [${qaBefore.permissions.tools!.join(", ")}]`,
      "← Back",
    ];

    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        async custom(factory: any) {
          const keys = customScripts.shift() ?? ["\x1b[27u"];
          let resolved: unknown;
          const comp = factory({ requestRender() {} }, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, (res: unknown) => {
            resolved = res;
          });
          comp.render(100);
          for (const key of keys) comp.handleInput(key);
          return resolved;
        },
        async select(_title: string, options: string[]) {
          const next = selectScripts.shift();
          if (next !== undefined) expect(options).toContain(next);
          return next;
        },
        notify() {},
      },
    };

    await openRoleStudioHome(h.makeDeps(ctx));
    expect(h.getActiveRoleId()).toBe("qa");

    await openRoleStudioHome(h.makeDeps(ctx));
    const savedQaPath = path.join(globalDir, "qa.yaml");
    expect(existsSync(savedQaPath)).toBe(true);
    const savedQa = parseRoleYaml(readFileSync(savedQaPath, "utf8"), "global", savedQaPath);
    // CRITICAL REGRESSION CHECK (#11 B8.2 / Section 4.1):
    // Only `apply_patch` (index 0) was unchecked; ALL 10 other tools (including unloaded edit/write/glob/find/lsp/wait) are preserved!
    expect(savedQa.permissions.tools).toEqual([
      "bash", "edit", "find", "glob", "grep", "lsp", "read", "task", "wait", "write",
    ]);
  });
});

describe("ompEnhance slash-command economy, Tab completions, and protection of all 8 built-in roles", () => {
  test("registers zero extra slash commands, completes role args, and protects all 8 built-in roles from deletion", async () => {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    const globalDir = path.join(root, "global-roles");
    const lockPath = path.join(root, "lock.json");
    mkdirSync(cwd, { recursive: true });

    const commands = new Map<string, {
      handler: (args: string, ctx: any) => Promise<void>;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string }>;
    }>();
    const messages: string[] = [];

    const pi = {
      cwd,
      on() {},
      registerTool() {},
      registerCommand(name: string, spec: any) { commands.set(name, spec); },
      sendMessage(msg: { content: string }) { messages.push(msg.content); },
      getAllTools: () => [{ name: "read" }, { name: "grep" }, { name: "task" }],
      async setActiveTools() {},
      getThinkingLevel: () => "off",
      pi: { settings: {} },
    };

    ompEnhance(pi, { globalRolesDir: globalDir, builtinRolesDir, pluginLockPath: lockPath });
    expect([...commands.keys()].sort()).toEqual(["enhance-handoff", "enhance-status", "flow", "role"]);

    const roleCmd = commands.get("role")!;
    expect(roleCmd.getArgumentCompletions!("q").map((c) => c.value)).toEqual(["qa"]);
    expect(roleCmd.getArgumentCompletions!("edit rev").map((c) => c.value)).toEqual(["edit reviewer"]);
    expect(commands.get("enhance-handoff")!.getArgumentCompletions!("").some((c) => c.value === "supervisor")).toBe(false);
    expect(commands.get("flow")!.getArgumentCompletions!("dev,q").map((c) => c.value)).toEqual(["dev,qa"]);

    const cliCtx = { cwd, hasUI: false, ui: { notify() {}, setStatus() {} } };

    // All 8 built-in roles MUST be protected from CLI deletion
    for (const builtinId of ["algo", "dev", "general", "ml-engineer", "qa", "reviewer", "supervisor", "vision"]) {
      await roleCmd.handler(`delete ${builtinId}`, cliCtx);
      expect(messages.at(-1)).toContain(`Built-in role "${builtinId}" cannot be deleted`);
    }

    // Copy built-in reviewer -> sql-reviewer (--project), then delete custom role cleanly
    await roleCmd.handler("copy reviewer sql-reviewer --project SQL security auditor", cliCtx);
    const sqlPath = path.join(cwd, ".omp", "roles", "sql-reviewer.yaml");
    expect(existsSync(sqlPath)).toBe(true);
    expect(roleCmd.getArgumentCompletions!("delete ").map((c) => c.value)).toEqual(["delete sql-reviewer"]);

    await roleCmd.handler("delete sql-reviewer", cliCtx);
    expect(existsSync(sqlPath)).toBe(false);
  });
});
