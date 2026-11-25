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
  cloneRoleSpec, discoverRoles, listUserVisibleRoles, parseRoleYaml, resetRoleOverride, saveRoleSpec, serializeRoleYaml,
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
    expect(schema.defaultRole.default).toBe("off");
    expect(DEFAULT_ENHANCE_SETTINGS.defaultRole).toBeNull();
    expect(schema.showStatusBar.default).toBe(DEFAULT_ENHANCE_SETTINGS.showStatusBar);
    expect(schema.supervisorEnabled.default).toBe(DEFAULT_ENHANCE_SETTINGS.supervisorEnabled);
    expect(schema.supervisorModel.default).toBe(DEFAULT_ENHANCE_SETTINGS.supervisorModel);
    expect(schema.supervisorThinking.default).toBe(DEFAULT_ENHANCE_SETTINGS.supervisorThinking);
    expect(schema.supervisorInitialDelaySec.default).toBe(DEFAULT_ENHANCE_SETTINGS.supervisorInitialDelaySec);
    expect(schema.flowMaxRepairRounds.default).toBe(DEFAULT_ENHANCE_SETTINGS.flowMaxRepairRounds);
    expect(schema.flowRoutingMode.default).toBe("auto");
    expect(DEFAULT_ENHANCE_SETTINGS.flowRoutingMode).toBe("auto");
    expect([...schema.supervisorThinking.values].sort()).toEqual([...ROLE_THINKING_LEVELS].sort());
    expect(schema.supervisorThinking.values).toContain("xhigh");
    expect(schema.supervisorThinking.values).toContain("max");
    expect(schema.supervisorThinking.values).toContain("auto");
    expect(schema.supervisorThinking.default).toBe("inherit");
  });

  test("uses OMP native lockfile + .omp/plugin-overrides.json exclusively, warns on deprecated .omp/enhance.yaml, clamps bounds, and gates untrusted projects", () => {
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
      flowRoutingMode: "auto",
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
          flowRoutingMode: "ask",
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
      flowRoutingMode: "ask",
    });

    // Deprecated .omp/enhance.yaml is IGNORED (never applied!) and emits a single clear deprecation warning
    writeText(path.join(cwd, ".omp", "enhance.yaml"), [
      "defaultRole: reviewer",
      "supervisorModel: openai-codex/gpt-6.1-sol",
      "flowMaxRepairRounds: 4",
    ].join("\n"));
    const depWarnings: string[] = [];
    const withDeprecatedYaml = loadEnhanceSettings({
      cwd, pluginLockPath: lockPath, onWarning: (w) => depWarnings.push(w),
    });
    expect(withDeprecatedYaml).toEqual({
      defaultRole: null,
      showStatusBar: false,
      supervisorEnabled: false,
      supervisorModel: "smol",
      supervisorThinking: "xhigh",
      supervisorInitialDelaySec: 600,
      flowMaxRepairRounds: 0,
      flowRoutingMode: "ask",
    });
    expect(depWarnings).toHaveLength(1);
    expect(depWarnings[0]).toContain("Deprecated config file");
    expect(depWarnings[0]).toContain("enhance.yaml");
    expect(depWarnings[0]).toContain("plugin-overrides.json");

    // Untrusted workspace (isProjectTrusted: false) ignores .omp/plugin-overrides.json!
    const warnings: string[] = [];
    const untrusted = loadEnhanceSettings({
      cwd, pluginLockPath: lockPath, isProjectTrusted: false, onWarning: (w) => warnings.push(w),
    });
    expect(untrusted.defaultRole).toBe("qa");
    expect(untrusted.flowRoutingMode).toBe("auto");
    expect(untrusted.supervisorEnabled).toBe(true);
    expect(warnings.some((w) => w.includes("not trusted"))).toBe(true);

    // Malformed plugin-overrides.json degrades gracefully while emitting diagnostic warning
    const parseWarnings: string[] = [];
    writeText(path.join(cwd, ".omp", "plugin-overrides.json"), "{ invalid json");
    expect(loadEnhanceSettings({
      cwd, pluginLockPath: lockPath, onWarning: (w) => parseWarnings.push(w),
    }).defaultRole).toBeNull();
    expect(parseWarnings.some((w) => w.includes("plugin-overrides.json"))).toBe(true);
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

describe("Role Studio strict UI, glob parsing, coordinator/specialist grouping, internal supervisor hiding, and tool union", () => {
  function createStudioHarness(cwd: string, globalDir: string, hostToolNames: string[]) {
    let roles = discoverRoles({ cwd, globalRolesDir: globalDir, builtinRolesDir });
    let activeRoleId: string | null = null;
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
      "+ 新建自定义专员...",
      "project (.omp/roles)",
      "readonly (纯只读验证，受保护路径 **)",
      "@slow",
      "高级路径与工具设置",
      `可用工具列表: [${[...DEFAULT_READONLY_TOOLS].join(", ")}]`,
      "bash", // toggle bash ON while preserving unloaded DEFAULT_READONLY_TOOLS (glob, find, lsp, task, wait)!
      "✓ 保存工具勾选",
      "受保护路径 Globs: [**]",
      "可写路径 Globs: [readonly]",
      "返回", // back from 高级路径与工具设置
      "编辑完整 YAML...",
      "返回", // exit role editor (note: non-dispatch specialist omits "在当前会话启用")
      undefined, // exit studio home
    ];
    const inputQueue: Array<string | undefined> = [
      "sec-audit",
      "Security auditor",
      "*",                          // Protected globs: '*' MUST become ["**"], NOT deleted!
      "src/**/*.{ts,tsx}, test/**", // Brace-safe writable globs!
    ];
    let editorAttempt = 0;
    const specialistEditorMenus: string[][] = [];

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
          // Internal supervisor must NEVER appear in Role Studio picker options
          expect(options.some((opt) => opt.includes("supervisor"))).toBe(false);
          if (title.includes("[后台专员]")) specialistEditorMenus.push(options);
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

    // Non-dispatch specialist editor omits foreground activation item and uses natural Chinese labels
    expect(specialistEditorMenus.length).toBeGreaterThan(0);
    for (const menu of specialistEditorMenus) {
      expect(menu.some((opt) => opt.includes("在当前会话启用") || opt.includes("Activate"))).toBe(false);
      expect(menu.some((opt) => opt.startsWith("模型绑定:"))).toBe(true);
      expect(menu.some((opt) => opt.startsWith("推理档位:"))).toBe(true);
      expect(menu.some((opt) => opt.startsWith("权限边界预设:"))).toBe(true);
      expect(menu).toContain("高级路径与工具设置");
      expect(menu).toContain("编辑完整 YAML...");
      expect(menu).toContain("拷贝为新角色...");
      expect(menu).toContain("返回");
    }

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

    // Internal supervisor is hidden from Role Studio editor (managed via /settings -> Plugins -> omp-enhance)
    await openRoleEditor("supervisor", h.makeDeps(ctx));
    expect(existsSync(path.join(globalDir, "supervisor.yaml"))).toBe(false);
    expect(h.notifications.some((n) => n.text.includes("/settings"))).toBe(true);

    // Coordinator editor DOES expose foreground activation and CoW preserves permissions.dispatch: true
    selectQueue.push('在当前会话启用 "coordinator"', "模型绑定: inherit", "@slow", "返回");
    await openRoleEditor("coordinator", h.makeDeps(ctx));
    expect(h.getActiveRoleId()).toBe("coordinator");
    expect(h.modelHistory).toEqual(["resolved-slow-model"]);
    const coordOverridePath = path.join(globalDir, "coordinator.yaml");
    const coordSaved = parseRoleYaml(readFileSync(coordOverridePath, "utf8"), "global", coordOverridePath);
    expect(coordSaved.model).toBe("@slow");
    expect(coordSaved.permissions.dispatch).toBe(true);
    resetRoleOverride({ id: "coordinator", targetDir: globalDir });

    // 3) Copy-on-Write on builtin reviewer + defensive confirm (false/undefined refuses reset) + true resets & re-activates
    await h.makeDeps(ctx).activateRole("reviewer");
    selectQueue.push("模型绑定: inherit", "@slow", "返回");
    await openRoleEditor("reviewer", h.makeDeps(ctx));
    const globalReviewerPath = path.join(globalDir, "reviewer.yaml");
    expect(existsSync(globalReviewerPath)).toBe(true);
    expect(createHash("sha256").update(readFileSync(builtinReviewerPath)).digest("hex")).toBe(builtinReviewerHashBefore);

    // If ui.confirm is missing/undefined, Reset override fails closed and keeps override intact
    const noConfirmCtx = { ...ctx, ui: { ...ctx.ui, confirm: undefined } };
    selectQueue.push("恢复内置默认", "返回");
    await openRoleEditor("reviewer", h.makeDeps(noConfirmCtx));
    expect(existsSync(globalReviewerPath)).toBe(true);

    // With confirm() === true, Reset deletes override and re-runs activateRole("reviewer")
    const prevActivations = h.activeToolHistory.length;
    selectQueue.push("恢复内置默认", "返回");
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

    // Visible order: [coordinator (0), algo (1), dev (2), planner (3), qa (4), reviewer (5), vision (6)]
    expect(listUserVisibleRoles(h.getRoles()).map((r) => r.id)).toEqual([
      "coordinator", "algo", "dev", "planner", "qa", "reviewer", "vision",
    ]);

    // Drive custom overlay:
    // 1) Enter on coordinator (idx 0) activates coordinator; second open + Enter on coordinator toggles back to off (null)!
    // 2) Move down 4 to qa (idx 4), press dead 'h' (ignored!), then Enter -> opens openRoleEditor("qa") directly WITHOUT foreground activation!
    const renderedFrames: string[][] = [];
    const customScripts: string[][] = [
      ["\x1b[13;1:1u"], // Enter on coordinator (idx 0) -> activates coordinator
      ["\x1b[13;1:1u"], // Enter on coordinator again -> toggles back to off (null)
      ["\x1b[1;1:1B", "\x1b[1;1:1B", "\x1b[1;1:1B", "\x1b[1;1:1B", "h", "\x1b[13;1:1u"], // down 4 -> qa(4), 'h' is ignored, Enter opens editor!
      ["\x1b[32;1:1u", "\x1b[13;1:1u"],               // Space (uncheck `apply_patch`) + Enter in checkbox overlay
      ["\x1b[27::27;1:1u"],                           // Kitty Esc with colon sub-params exits studio cleanly!
    ];
    const selectScripts: Array<string | undefined> = [
      "高级路径与工具设置",
      `可用工具列表: [${qaBefore.permissions.tools!.join(", ")}]`,
      "返回",
      "返回",
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
          renderedFrames.push(comp.render(110));
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
    expect(h.getActiveRoleId()).toBe("coordinator");
    await openRoleStudioHome(h.makeDeps(ctx));
    expect(h.getActiveRoleId()).toBeNull();
    const homeLines = renderedFrames[0]!.join("\n");
    expect(homeLines).toContain("[总控入口] coordinator");
    expect(homeLines).toContain("[后台专员] planner");
    expect(homeLines).toContain("↑↓ 选择 · Enter 配置/切换 · n 新建 · c 拷贝 · x 退回标准OMP · Esc/q 关闭面板");
    expect(homeLines).not.toContain("h 交接");
    expect(homeLines).not.toContain("x 关闭(Off)");
    expect(homeLines).not.toContain("supervisor");

    // Pressing Enter on specialist qa (idx 4) opens editor directly and keeps activeRoleId === null!
    await openRoleStudioHome(h.makeDeps(ctx));
    expect(h.getActiveRoleId()).toBeNull();
    const savedQaPath = path.join(globalDir, "qa.yaml");
    expect(existsSync(savedQaPath)).toBe(true);
    const savedQa = parseRoleYaml(readFileSync(savedQaPath, "utf8"), "global", savedQaPath);
    // CRITICAL REGRESSION CHECK (#11 B8.2 / Section 4.1):
    // Only `apply_patch` (index 0) was unchecked; ALL 10 other tools (including unloaded edit/write/glob/find/lsp/wait) are preserved!
    expect(savedQa.permissions.tools).toEqual([
      "bash", "edit", "find", "glob", "grep", "lsp", "read", "task", "wait", "write",
    ]);
    // Wave 2S: Role Studio edit & clone preserve required_tools (qa) and required_artifacts (algo)
    expect(savedQa.exit.requiredTools).toEqual(["bash"]);

    selectScripts.push("推理档位: inherit", "high", "返回");
    await openRoleEditor("algo", h.makeDeps(ctx));
    const savedAlgoPath = path.join(globalDir, "algo.yaml");
    const savedAlgo = parseRoleYaml(readFileSync(savedAlgoPath, "utf8"), "global", savedAlgoPath);
    expect(savedAlgo.thinking).toBe("high");
    expect(savedAlgo.exit.requiredArtifacts).toEqual(["algo_work/REPORT.md", "algo_work/runs/**/metrics.json"]);

    const builtinRoles = discoverRoles({ cwd, globalRolesDir: path.join(root, "empty-global"), builtinRolesDir });
    const clonedAlgo = cloneRoleSpec({ sourceRole: builtinRoles.get("algo")!, newId: "algo-ts", targetDir: globalDir });
    expect(clonedAlgo.role.exit.requiredArtifacts).toEqual(["algo_work/REPORT.md", "algo_work/runs/**/metrics.json"]);
    expect(clonedAlgo.role.exit.requireAlgoDeliverables).toBe(true);
    const clonedQa = cloneRoleSpec({ sourceRole: builtinRoles.get("qa")!, newId: "qa-strict", targetDir: globalDir });
    expect(clonedQa.role.exit.requiredTools).toEqual(["bash"]);
    expect(clonedQa.role.exit.requireTestExecution).toBe(true);
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
    expect([...commands.keys()].sort()).toEqual(["coord", "flow", "role"]);

    const roleCmd = commands.get("role")!;
    expect(roleCmd.getArgumentCompletions!("").some((c) => c.value === "supervisor")).toBe(false);
    expect(roleCmd.getArgumentCompletions!("q").map((c) => c.value)).toEqual(["qa"]);
    expect(roleCmd.getArgumentCompletions!("edit rev").map((c) => c.value)).toEqual(["edit reviewer"]);
    expect(commands.get("coord")!.getArgumentCompletions!("").map((c) => c.value)).toEqual(["on", "off", "status", "toggle"]);
    expect(commands.get("coord")!.getArgumentCompletions!("st").map((c) => c.value)).toEqual(["status"]);
    expect(commands.get("flow")!.getArgumentCompletions!("").map((c) => c.value)).toEqual(["status", "cancel"]);
    expect(commands.get("flow")!.getArgumentCompletions!("ca").map((c) => c.value)).toEqual(["cancel"]);

    const cliCtx = { cwd, hasUI: false, ui: { notify() {}, setStatus() {} } };

    // All 8 built-in roles MUST be protected from CLI deletion
    for (const builtinId of ["algo", "coordinator", "dev", "planner", "qa", "reviewer", "supervisor", "vision"]) {
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
