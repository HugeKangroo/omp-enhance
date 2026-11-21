import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { EnhanceSettings, RoleSpec, RoleThinkingLevel } from "../core/types.ts";
import { splitBraceSafeGlobs } from "../core/fs.ts";
import { COMPANION_TOOL_NAMES, READONLY_SUBAGENTS } from "../core/policy.ts";
import { DEFAULT_ENHANCE_SETTINGS } from "../core/settings.ts";
import {
  cloneRoleSpec, deleteCustomRole, hasBuiltinRole, parseRoleYaml, resetRoleOverride,
  ROLE_THINKING_LEVELS, saveRoleSpec, scaffoldRoleFile, serializeRoleYaml,
} from "../roles/loader.ts";
import { computeScrollWindow, padLeftCell as padCell, parseOverlayKey } from "./kit.ts";

export { parseOverlayKey };

export interface RoleStudioDeps {
  cwd: string; globalRolesDir: string; builtinRolesDir?: string; pi: any; ctx: any;
  getRoles: () => Map<string, RoleSpec>; refreshRoles: () => Map<string, RoleSpec>;
  getSettings?: () => EnhanceSettings;
  getActiveRoleId: () => string | null; activateRole: (roleId: string | null) => Promise<void>;
  runHandoff?: (roleId: string) => Promise<void>;
}

const PINNED_MODELS = ["inherit", "@vision", "@advisor", "@default", "@smol", "@slow", "@plan", "@task"];
const FALLBACK_TOOLS = ["read", "grep", "glob", "find", "lsp", "edit", "write", "apply_patch", "bash", "task", "wait"];
const targetDirFor = (deps: RoleStudioDeps, scope: "global" | "project"): string =>
  scope === "project" ? path.join(deps.cwd, ".omp", "roles") : deps.globalRolesDir;

function stripRoleDraft(role: RoleSpec, keepBuiltinSup = false): Omit<RoleSpec, "source" | "filePath" | "contentSha256"> {
  const omitSup = role.id === "supervisor" && role.source === "builtin" && !keepBuiltinSup;
  return {
    id: role.id, name: role.name, description: role.description,
    ...(!omitSup && role.model !== undefined ? { model: role.model } : {}),
    ...(!omitSup && role.thinking !== undefined ? { thinking: role.thinking } : {}),
    stance: role.stance, method: [...role.method],
    permissions: {
      ...(role.permissions.tools ? { tools: [...role.permissions.tools] } : {}),
      ...(role.permissions.writable ? { writable: [...role.permissions.writable] } : {}),
      ...(role.permissions.protected ? { protected: [...role.permissions.protected] } : {}),
    },
    exit: { requireToolEvidence: role.exit.requireToolEvidence, criteria: [...role.exit.criteria] },
  };
}

export function parseWritableGlobInput(raw: string): string[] | undefined {
  const t = raw.trim(), low = t.toLowerCase();
  if (t === "*" || t === "**" || low === "all" || low === "unrestricted") return undefined;
  return !t || low === "none" || t === "[]" || low === "readonly" ? [] : splitBraceSafeGlobs(t);
}

export function parseProtectedGlobInput(raw: string): string[] | undefined {
  const t = raw.trim(), low = t.toLowerCase();
  if (!t || low === "none" || t === "[]") return undefined;
  if (t === "*" || t === "**" || low === "all") return ["**"];
  const items = splitBraceSafeGlobs(t);
  return items.length > 0 ? items : undefined;
}

async function pickScope(ui: any, defaultScope: "global" | "project"): Promise<"global" | "project" | null> {
  const opts = defaultScope === "project" ? ["project (.omp/roles)", "global (~/.omp/enhance/roles)"] : ["global (~/.omp/enhance/roles)", "project (.omp/roles)"];
  const choice = await ui.select("保存位置 (Save scope)", opts, { outline: true });
  return choice ? (choice.startsWith("project") ? "project" : "global") : null;
}

async function pickRoleIdFromList(ui: any, title: string, list: readonly RoleSpec[]): Promise<string | undefined> {
  const picked: string | undefined = await ui.select(title, list.map((r) => `${r.id} [${r.source}] — ${r.description || r.name}`), { outline: true });
  return picked?.split(" [", 1)[0]?.trim() || undefined;
}

async function pickRoleModel(current: string | undefined, deps: RoleStudioDeps): Promise<string | null> {
  const ui = deps.ctx?.ui;
  const discovered: string[] = (Array.isArray(deps.ctx?.models?.list?.()) ? deps.ctx.models.list() : []).flatMap((m: any) => (m?.provider && m?.id ? [`${m.provider}/${m.id}`] : []));
  const choices = [...new Set([...PINNED_MODELS, ...discovered]), "Custom model / role alias..."];
  const picked: string | undefined = await ui.select("Select Role Model", choices, { outline: true, initialIndex: Math.max(0, choices.indexOf(current ?? "inherit")) });
  if (!picked) return null;
  if (picked !== "Custom model / role alias...") return picked;
  const custom = await ui.input("Model ID or @role alias (e.g. @advisor, provider/model)", current ?? "");
  return custom === undefined ? null : (String(custom).trim() || "inherit");
}

async function pickRoleTools(role: RoleSpec, deps: RoleStudioDeps): Promise<string[] | undefined | null> {
  const ui = deps.ctx?.ui, companion = new Set<string>(COMPANION_TOOL_NAMES);
  const discovered = (deps.pi?.getAllTools?.() ?? [])
    .map((t: any) => String(t?.name ?? "")).filter((n: string) => Boolean(n) && !companion.has(n));
  const existing = (role.permissions.tools ?? []).filter((n) => Boolean(n) && !companion.has(n));
  const hostTools = [...new Set<string>([...(discovered.length > 0 ? discovered : FALLBACK_TOOLS), ...existing])].sort();
  const selected = new Set<string>(role.permissions.tools ?? hostTools);
  let cursor = 0;

  if (typeof ui.custom === "function") {
    return ui.custom((tui: any, theme: any, kb: any, done: (res: string[] | undefined | null) => void) => {
      const fg = (c: string, s: string): string => (typeof theme?.fg === "function" ? theme.fg(c, s) : s);
      let focused = true;
      return {
        get focused() { return focused; }, set focused(v: boolean) { focused = v; },
        capturesInput() { return true; }, invalidate() {},
        handleInput(data: string) {
          const key = parseOverlayKey(data, kb);
          if (!key) return;
          if (key === "escape" || key === "q" || key === "Q") return done(null);
          if (key === "enter") return done(hostTools.filter((n) => selected.has(n)));
          if (key === "a" || key === "A") return done(undefined);
          if (key === "z" || key === "Z") return done([]);
          if (key === "up" || key === "k") { cursor = (cursor - 1 + hostTools.length) % hostTools.length; tui?.requestRender?.(); }
          else if (key === "down" || key === "j") { cursor = (cursor + 1) % hostTools.length; tui?.requestRender?.(); }
          else if (key === "space") {
            const name = hostTools[cursor]!;
            if (selected.has(name)) selected.delete(name); else selected.add(name);
            tui?.requestRender?.();
          }
        },
        render(width: number): string[] {
          const inner = Math.max(24, width - 4), win = computeScrollWindow(hostTools.length, cursor, Math.max(6, (process.stdout?.rows ?? 28) - 8));
          const lines = [fg("border", `╭─ ${padCell(`工具权限 · ${role.id} (已勾选 ${selected.size}/${hostTools.length})`, inner - 2)} ─╮`)];
          if (win.hasAbove) lines.push(`${fg("border", "│")} ${fg("dim", padCell(`↑ 上方还有 ${win.start} 项`, inner))} ${fg("border", "│")}`);
          for (let i = win.start; i < win.end; i++) {
            const name = hostTools[i]!, on = selected.has(name), cur = i === cursor;
            const row = `${cur ? "▸" : " "} [${on ? "✓" : " "}] ${name}`;
            const styled = cur ? fg("accent", padCell(row, inner)) : on ? fg("success", padCell(row, inner)) : padCell(row, inner);
            lines.push(`${fg("border", "│")} ${styled} ${fg("border", "│")}`);
          }
          if (win.hasBelow) lines.push(`${fg("border", "│")} ${fg("dim", padCell(`↓ 下方还有 ${hostTools.length - win.end} 项`, inner))} ${fg("border", "│")}`);
          lines.push(
            fg("border", `├─${"─".repeat(inner)}─┤`),
            `${fg("border", "│")} ${fg("dim", padCell("Space 勾选/取消 · Enter 保存 · a 不限制 · z 全禁 · Esc 返回", inner))} ${fg("border", "│")}`,
            fg("border", `╰─${"─".repeat(inner)}─╯`),
          );
          return lines;
        },
      };
    }, { overlay: true });
  }

  const saveLabel = "✓ Save tool selection", allLabel = "[Unrestricted: allow all host tools]", noneLabel = "[No host tools]";
  while (true) {
    const checkedIndices = hostTools.flatMap((name, idx) => (selected.has(name) ? [idx] : []));
    const choice: string | undefined = await ui.select(
      `Allowed Tools · ${role.id}`, [...hostTools, saveLabel, allLabel, noneLabel],
      { outline: true, selectionMarker: "checkbox", checkedIndices, markableCount: hostTools.length, initialIndex: cursor },
    );
    if (!choice) return null;
    if (choice === saveLabel) return hostTools.filter((name) => selected.has(name));
    if (choice === allLabel) return undefined;
    if (choice === noneLabel) return [];
    const idx = hostTools.indexOf(choice);
    if (idx >= 0) { cursor = idx; if (selected.has(choice)) selected.delete(choice); else selected.add(choice); }
  }
}

export async function openCreateRoleWizard(deps: RoleStudioDeps, defaultScope: "global" | "project" = "global"): Promise<string | null> {
  const ui = deps.ctx?.ui, id = String((await ui.input("新建角色 ID (字母、数字、_ 或 -)", "")) ?? "").trim();
  if (!id) return null;
  const rawDesc = await ui.input(`"${id}" 的一句话描述`, id);
  if (rawDesc === undefined) return null;
  const scope = await pickScope(ui, defaultScope);
  if (!scope) return null;
  const modeChoice = await ui.select("权限预设 (Permission preset)", ["writable (允许修改工作区文件)", "readonly (纯只读验证，受保护路径 **)"], { outline: true });
  if (!modeChoice) return null;
  const pickedModel = await pickRoleModel("inherit", deps);
  if (pickedModel === null) return null;
  try {
    const created = scaffoldRoleFile({
      id, description: String(rawDesc).trim() || id, targetDir: targetDirFor(deps, scope),
      globalRolesDir: deps.globalRolesDir, readOnly: modeChoice.startsWith("readonly"), model: pickedModel === "inherit" ? undefined : pickedModel,
    });
    deps.refreshRoles(); ui.notify?.(`Created role "${created.role.id}" [${created.source}]`, "info");
    return created.role.id;
  } catch (err) { ui.notify?.(err instanceof Error ? err.message : String(err), "warning"); return null; }
}

export async function openCloneRoleWizard(sourceRole: RoleSpec, deps: RoleStudioDeps, defaultScope: "global" | "project" = "global"): Promise<string | null> {
  const ui = deps.ctx?.ui, newId = String((await ui.input(`基于 "${sourceRole.id}" 拷贝的新角色 ID`, `${sourceRole.id}-copy`)) ?? "").trim();
  if (!newId) return null;
  const rawDesc = await ui.input(`"${newId}" 的一句话描述`, sourceRole.description || sourceRole.name);
  if (rawDesc === undefined) return null;
  const scope = await pickScope(ui, defaultScope);
  if (!scope) return null;
  try {
    const cloned = cloneRoleSpec({ sourceRole, newId, description: String(rawDesc).trim(), targetDir: targetDirFor(deps, scope), globalRolesDir: deps.globalRolesDir });
    deps.refreshRoles(); ui.notify?.(`Copied "${sourceRole.id}" → "${cloned.role.id}" [${cloned.source}]`, "info");
    return cloned.role.id;
  } catch (err) { ui.notify?.(err instanceof Error ? err.message : String(err), "warning"); return null; }
}

async function confirmAndDeleteRole(roleId: string, deps: RoleStudioDeps): Promise<boolean> {
  const ui = deps.ctx?.ui;
  if (hasBuiltinRole(roleId, deps.builtinRolesDir)) {
    ui.notify?.(`内置默认角色 "${roleId}" 不可删除（若修改过可在编辑页重置默认）`, "warning");
    return false;
  }
  if ((await ui.confirm?.("删除自定义角色", `确定永久删除自定义角色 "${roleId}" 吗？`)) !== true) return false;
  deleteCustomRole({ id: roleId, cwd: deps.cwd, globalRolesDir: deps.globalRolesDir, builtinRolesDir: deps.builtinRolesDir });
  const roles = deps.refreshRoles();
  if (deps.getActiveRoleId() === roleId) {
    const pref = deps.getSettings?.().defaultRole;
    await deps.activateRole(pref === null ? null : (pref && roles.has(pref) ? pref : (roles.has("general") ? "general" : null)));
  }
  ui.notify?.(`Deleted role "${roleId}"`, "info");
  return true;
}

export async function openRoleEditor(roleId: string, deps: RoleStudioDeps, initialScope?: "global" | "project"): Promise<void> {
  const ui = deps.ctx?.ui;
  let currentId = roleId;
  let scope: "global" | "project" = initialScope ?? (deps.getRoles().get(currentId)?.source === "project" ? "project" : "global");
  while (true) {
    const role = deps.refreshRoles().get(currentId);
    if (!role) return;
    const settings = deps.getSettings?.() ?? DEFAULT_ENHANCE_SETTINGS;
    const builtin = hasBuiltinRole(role.id, deps.builtinRolesDir), isSup = role.id === "supervisor";
    const modelLabel = isSup && (role.source === "builtin" || role.model === undefined)
      ? `${settings.supervisorModel} (via /settings)` : (role.model ?? "inherit");
    const thinkingLabel = isSup && (role.source === "builtin" || role.thinking === undefined)
      ? `${settings.supervisorThinking} (via /settings)` : (role.thinking ?? "inherit");
    const items = [
      deps.getActiveRoleId() === role.id ? `Active in session (${role.id})` : `Activate "${role.id}" in current session`,
      `Model: ${modelLabel}`, `Thinking: ${thinkingLabel}`,
      `Allowed tools: ${role.permissions.tools ? `[${role.permissions.tools.join(", ") || "none"}]` : "unrestricted"}`,
      `Writable globs: ${role.permissions.writable ? `[${role.permissions.writable.join(", ") || "readonly"}]` : "unrestricted"}`,
      `Protected globs: ${role.permissions.protected?.length ? `[${role.permissions.protected.join(", ")}]` : "none"}`,
      `Require tool evidence: ${role.exit.requireToolEvidence}`,
      "Edit full role YAML...", "Copy as new role...", `Save scope (Copy-on-Write): ${scope}`,
      ...(builtin && role.source !== "builtin" ? [`Reset ${role.source} override`] : []),
      ...(!builtin ? ["Delete custom role"] : []), "← Back",
    ];
    const choice: string | undefined = await ui.select(
      `Role Studio · ${role.id} [${role.source}] — ${role.description || role.name}`, items, { outline: true },
    );
    if (!choice || choice === "← Back") return;
    const persist = (fn: (draft: ReturnType<typeof stripRoleDraft>) => void): void => {
      const draft = stripRoleDraft(role, false); fn(draft);
      saveRoleSpec(draft, targetDirFor(deps, scope), { globalRolesDir: deps.globalRolesDir });
      deps.refreshRoles();
      if (role.source === "project" && scope === "global") {
        ui.notify?.(`Saved to global scope, but project override (.omp/roles/${role.id}.yaml) still takes precedence.`, "warning");
      }
    };
    if (choice.startsWith("Activate ")) {
      await deps.activateRole(role.id); ui.notify?.(`Activated role "${role.id}"`, "info");
    } else if (choice.startsWith("Model:")) {
      const picked = await pickRoleModel(isSup && role.source === "builtin" ? settings.supervisorModel : role.model, deps);
      if (picked !== null) {
        persist((d) => { if (picked === "inherit") { if (isSup) d.model = "inherit"; else delete d.model; } else d.model = picked; });
        if (deps.getActiveRoleId() === role.id) await deps.activateRole(role.id);
      }
    } else if (choice.startsWith("Thinking:")) {
      const curThink = isSup && role.source === "builtin" ? settings.supervisorThinking : (role.thinking ?? "inherit");
      const picked: string | undefined = await ui.select("Select Thinking Level", [...ROLE_THINKING_LEVELS], {
        outline: true, initialIndex: Math.max(0, ROLE_THINKING_LEVELS.indexOf(curThink)),
      });
      if (picked) {
        persist((d) => { if (picked === "inherit") { if (isSup) d.thinking = "inherit"; else delete d.thinking; } else d.thinking = picked as RoleThinkingLevel; });
        if (deps.getActiveRoleId() === role.id) await deps.activateRole(role.id);
      }
    } else if (choice.startsWith("Allowed tools:")) {
      const tools = await pickRoleTools(role, deps);
      if (tools !== null) {
        persist((d) => { if (tools === undefined) delete d.permissions.tools; else d.permissions.tools = tools; });
        if (deps.getActiveRoleId() === role.id) await deps.activateRole(role.id);
      }
    } else if (choice.startsWith("Writable globs:")) {
      const cur = role.permissions.writable === undefined ? "*" : (role.permissions.writable.join(", ") || "none");
      const raw = await ui.input("Writable globs ('*' = all, 'none' = read-only, or comma-separated)", cur);
      if (raw !== undefined) {
        const parsed = parseWritableGlobInput(String(raw));
        persist((d) => { if (parsed === undefined) delete d.permissions.writable; else d.permissions.writable = parsed; });
      }
    } else if (choice.startsWith("Protected globs:")) {
      const raw = await ui.input("Protected globs ('*' = all, 'none' = none, or comma-separated)", role.permissions.protected?.join(", ") || "none");
      if (raw !== undefined) {
        const parsed = parseProtectedGlobInput(String(raw));
        persist((d) => { if (!parsed?.length) delete d.permissions.protected; else d.permissions.protected = parsed; });
      }
    } else if (choice.startsWith("Require tool evidence:")) {
      persist((d) => { d.exit.requireToolEvidence = !role.exit.requireToolEvidence; });
    } else if (choice === "Edit full role YAML...") {
      let draftYaml = role.source === scope && existsSync(role.filePath)
        ? readFileSync(role.filePath, "utf8") : serializeRoleYaml(stripRoleDraft(role, false));
      while (true) {
        const edited = await ui.editor(`YAML · ${role.id}.yaml (${scope})`, draftYaml);
        if (edited === undefined) break;
        draftYaml = String(edited);
        try {
          const outDir = targetDirFor(deps, scope), outPath = path.join(outDir, `${role.id}.yaml`);
          parseRoleYaml(draftYaml, scope, outPath);
          mkdirSync(outDir, { recursive: true }); resetRoleOverride({ id: role.id, targetDir: outDir });
          writeFileSync(outPath, draftYaml.endsWith("\n") ? draftYaml : `${draftYaml}\n`, "utf8");
          deps.refreshRoles();
          if (deps.getActiveRoleId() === role.id) await deps.activateRole(role.id);
          break;
        } catch (err) { ui.notify?.(err instanceof Error ? err.message : String(err), "warning"); }
      }
    } else if (choice === "Copy as new role...") {
      const clonedId = await openCloneRoleWizard(role, deps, scope);
      if (clonedId) { currentId = clonedId; scope = deps.getRoles().get(clonedId)?.source === "project" ? "project" : "global"; }
    } else if (choice.startsWith("Save scope")) {
      scope = scope === "global" ? "project" : "global";
    } else if (choice.startsWith("Reset ")) {
      const resetScope = role.source === "project" ? "project" : "global";
      if ((await ui.confirm?.("Reset Role Override", `Delete ${resetScope} override for "${role.id}"?`)) === true) {
        resetRoleOverride({ id: role.id, targetDir: targetDirFor(deps, resetScope) });
        const refreshed = deps.refreshRoles().get(role.id);
        if (!refreshed) return;
        scope = refreshed.source === "project" ? "project" : "global";
        if (deps.getActiveRoleId() === role.id) await deps.activateRole(role.id);
      }
    } else if (choice === "Delete custom role") {
      if (await confirmAndDeleteRole(role.id, deps)) return;
    }
  }
}

type ActionKind = "new" | "copy-pick" | "edit-pick" | "delete-pick" | "off" | "close";
type NavEntry = { kind: "role"; role: RoleSpec; label: string } | { kind: ActionKind; label: string; detail: string };
type OverlayAction =
  | { act: "activate" | "edit" | "copy" | "delete" | "handoff"; roleId: string }
  | { act: Exclude<ActionKind, "close"> } | undefined;

function buildStudioDetailRows(cur: NavEntry, settings: EnhanceSettings, builtinDir?: string): Array<{ text: string; style?: "head" | "accent" }> {
  if (cur.kind !== "role") {
    return [{ text: cur.label, style: "head" }, { text: "" }, { text: cur.detail }, { text: "" }, { text: "按 Enter 执行此操作，或按 Esc 退出。", style: "accent" }];
  }
  const sel = cur.role, builtin = hasBuiltinRole(sel.id, builtinDir), isSup = sel.id === "supervisor";
  const effModel = isSup && (sel.source === "builtin" || sel.model === undefined) ? `${settings.supervisorModel} (via /settings)` : (sel.model ?? "inherit (session model)");
  const effThink = isSup && (sel.source === "builtin" || sel.thinking === undefined) ? `${settings.supervisorThinking} (via /settings)` : (sel.thinking ?? "inherit");
  const subRule = sel.permissions.writable !== undefined || (sel.permissions.protected?.length ?? 0) > 0 ? `read-only (${READONLY_SUBAGENTS.join(", ")})` : "all OMP subagents";
  return [
    { text: `${sel.id} — ${sel.name} [${sel.source}${builtin ? " · 内置保护" : " · 自定义"}]`, style: "head" },
    { text: sel.description || "(no description)" },
    { text: `Model: ${effModel} · Thinking: ${effThink}` },
    { text: `Tools: ${sel.permissions.tools ? (sel.permissions.tools.join(", ") || "none") : "unrestricted"}` },
    { text: `Subagents: ${subRule}` },
    { text: `Writable: ${sel.permissions.writable ? (sel.permissions.writable.join(", ") || "read-only []") : "*"} · Protected: ${sel.permissions.protected?.join(", ") || "none"}` },
    { text: `Stance: ${sel.stance.trim().replace(/\s+/g, " ")}` },
    ...sel.method.slice(0, 2).map((m, idx) => ({ text: `${idx + 1}. ${m}` })),
    { text: `操作: Enter 切换 · e/→ 修改 · c 拷贝${builtin ? "" : " · d 删除"} · h 交接`, style: "accent" },
  ];
}

export async function openRoleStudioHome(deps: RoleStudioDeps): Promise<void> {
  const ui = deps.ctx?.ui;
  let cursor = -1;

  if (typeof ui.custom === "function") {
    while (true) {
      const roles = [...deps.refreshRoles().values()].sort((a, b) => a.id.localeCompare(b.id));
      const customRoles = roles.filter((r) => !hasBuiltinRole(r.id, deps.builtinRolesDir));
      const activeId = deps.getActiveRoleId(), settings = deps.getSettings?.() ?? DEFAULT_ENHANCE_SETTINGS;
      const entries: NavEntry[] = [
        ...roles.map((role): NavEntry => ({ kind: "role", role, label: `${activeId === role.id ? "●" : " "} ${role.id} [${role.source[0]}]` })),
        { kind: "new", label: "+ 新建角色 (New)", detail: "从模板向导创建新的纯 YAML 角色，创建后直接进入模型与工具配置页。" },
        { kind: "copy-pick", label: "⧉ 拷贝角色 (Copy)", detail: "以任意内置或自定义角色为蓝本拷贝出新角色（完整保留方法论、模型与工具设置供微调）。" },
        { kind: "edit-pick", label: "✎ 修改角色 (Edit)", detail: "选择角色修改绑定模型、Thinking、工具复选框、路径边界或完整 YAML（内置角色自动写时复制）。" },
        ...(customRoles.length > 0 ? [{ kind: "delete-pick" as const, label: "🗑 删除角色 (Del)", detail: "删除用户自建/拷贝的自定义角色（全部内置默认角色均受保护不可删除）。" }] : []),
        { kind: "off", label: "○ 关闭角色 (Off)", detail: "关闭当前主会话的角色条件化注入，恢复无附加角色的状态。" },
        { kind: "close", label: "✕ 退出面板 (Esc)", detail: "关闭面板返回主对话（也可在任意位置按 Esc 或 q 直接退出）。" },
      ];
      if (cursor < 0) cursor = Math.max(0, roles.findIndex((r) => r.id === activeId));
      cursor = Math.min(cursor, entries.length - 1);

      const action = await ui.custom((tui: any, theme: any, kb: any, done: (res: OverlayAction) => void) => {
        const fg = (c: string, s: string): string => (typeof theme?.fg === "function" ? theme.fg(c, s) : s);
        const bold = (s: string): string => (typeof theme?.bold === "function" ? theme.bold(s) : s);
        let focused = true;
        return {
          get focused() { return focused; }, set focused(v: boolean) { focused = v; },
          capturesInput() { return true; }, invalidate() {},
          handleInput(data: string) {
            const key = parseOverlayKey(data, kb);
            if (!key) return;
            const cur = entries[cursor]!;
            if (key === "escape" || key === "q" || key === "Q") return done(undefined);
            if (key === "up" || key === "k") { cursor = (cursor - 1 + entries.length) % entries.length; tui?.requestRender?.(); return; }
            if (key === "down" || key === "j") { cursor = (cursor + 1) % entries.length; tui?.requestRender?.(); return; }
            if (key === "n" || key === "N") return done({ act: "new" });
            if (key === "o" || key === "O") return done({ act: "off" });
            if (cur.kind === "role") {
              if (key === "enter") return done({ act: "activate", roleId: cur.role.id });
              if (key === "e" || key === "E" || key === "right" || key === "tab") return done({ act: "edit", roleId: cur.role.id });
              if (key === "c" || key === "C") return done({ act: "copy", roleId: cur.role.id });
              if (key === "d" || key === "D" || key === "backspace") return done({ act: "delete", roleId: cur.role.id });
              if (key === "h" || key === "H") return done({ act: "handoff", roleId: cur.role.id });
            } else if (key === "enter" || key === "right") {
              return done(cur.kind === "close" ? undefined : { act: cur.kind });
            } else if (key === "c" || key === "C") return done({ act: "copy-pick" });
            else if (key === "e" || key === "E") return done({ act: "edit-pick" });
            else if ((key === "d" || key === "D") && customRoles.length > 0) return done({ act: "delete-pick" });
          },
          render(width: number): string[] {
            const inner = Math.max(44, width - 4), leftW = Math.min(26, Math.max(20, Math.floor(inner * 0.32))), rightW = Math.max(18, inner - leftW - 3);
            const rightRows = buildStudioDetailRows(entries[cursor]!, settings, deps.builtinRolesDir);
            const win = computeScrollWindow(entries.length, cursor, Math.max(10, (process.stdout?.rows ?? 30) - 8));
            const visibleEntries = entries.slice(win.start, win.end), rowCount = Math.max(visibleEntries.length, rightRows.length);
            const out = [fg("border", `╭─ ${padCell(`OMP Enhance · Roles  [当前: ${activeId ?? "off"}]`, inner - 2)} ─╮`)];
            for (let r = 0; r < rowCount; r++) {
              const absIdx = win.start + r, item = r < visibleEntries.length ? visibleEntries[r] : undefined, rRow = rightRows[r];
              const leftRaw = item ? `${absIdx === cursor ? "▸" : " "}${item.label}` : "";
              const leftCell = item && absIdx === cursor ? fg("accent", bold(padCell(leftRaw, leftW)))
                : (item?.kind === "role" && activeId === item.role.id ? fg("success", padCell(leftRaw, leftW)) : padCell(leftRaw, leftW));
              const rPadded = padCell(rRow?.text ?? "", rightW);
              const rightCell = rRow?.style === "head" ? fg("accent", bold(rPadded)) : (rRow?.style === "accent" ? fg("accent", rPadded) : rPadded);
              out.push(`${fg("border", "│")} ${leftCell} ${fg("border", "│")} ${rightCell} ${fg("border", "│")}`);
            }
            out.push(fg("border", `├─${"─".repeat(inner)}─┤`), `${fg("border", "│")} ${fg("dim", padCell("↑/↓ 选择 · Enter 确认 · e 修改 · c 拷贝 · d 删除 · n 新建 · Esc 退出", inner))} ${fg("border", "│")}`, fg("border", `╰─${"─".repeat(inner)}─╯`));
            return out;
          },
        };
      }, { overlay: true });

      if (!action) return;
      if (action.act === "activate") { await deps.activateRole(action.roleId); ui.notify?.(`Session role: ${action.roleId}`, "info"); return; }
      if (action.act === "off") { await deps.activateRole(null); ui.notify?.("Role conditioning disabled", "info"); return; }
      if (action.act === "handoff") { await deps.runHandoff?.(action.roleId); return; }
      if (action.act === "edit") await openRoleEditor(action.roleId, deps);
      else if (action.act === "copy" || action.act === "copy-pick") {
        const srcId = action.act === "copy" ? action.roleId : await pickRoleIdFromList(ui, "选择作为拷贝模板的角色 (Select source role to copy)", roles);
        const clonedId = srcId && deps.getRoles().get(srcId) ? await openCloneRoleWizard(deps.getRoles().get(srcId)!, deps) : null;
        if (clonedId) { await openRoleEditor(clonedId, deps); cursor = Math.max(0, [...deps.getRoles().keys()].sort().indexOf(clonedId)); }
      } else if (action.act === "delete") await confirmAndDeleteRole(action.roleId, deps);
      else if (action.act === "edit-pick") {
        const id = await pickRoleIdFromList(ui, "选择要修改的角色 (Select role to edit)", roles);
        if (id && deps.getRoles().has(id)) await openRoleEditor(id, deps);
      } else if (action.act === "delete-pick") {
        const id = await pickRoleIdFromList(ui, "选择要删除的自定义角色 (Select custom role to delete)", customRoles);
        if (id) await confirmAndDeleteRole(id, deps);
      } else if (action.act === "new") {
        const createdId = await openCreateRoleWizard(deps);
        if (createdId) { await openRoleEditor(createdId, deps); cursor = Math.max(0, [...deps.getRoles().keys()].sort().indexOf(createdId)); }
      }
    }
  }

  while (true) {
    const roles = [...deps.refreshRoles().values()].sort((a, b) => a.id.localeCompare(b.id));
    const activeId = deps.getActiveRoleId(), roleMap = new Map<string, string>(), options: string[] = [];
    for (const role of roles) {
      const label = `${activeId === role.id ? "*" : " "} ${role.id} [${role.source}] (model: ${role.model ?? "inherit"}) — ${role.description || role.name}`;
      roleMap.set(label, role.id); options.push(label);
    }
    options.push("+ Create new role...", ...(activeId ? ["Disable active role (/role off)"] : []));
    const picked: string | undefined = await ui.select(`OMP Enhance · Role Studio (active: ${activeId ?? "off"})`, options, { outline: true });
    if (!picked) return;
    if (picked === "+ Create new role...") { const id = await openCreateRoleWizard(deps); if (id) await openRoleEditor(id, deps); }
    else if (picked.startsWith("Disable active role")) { await deps.activateRole(null); ui.notify?.("Role conditioning disabled", "info"); }
    else { const id = roleMap.get(picked); if (id) await openRoleEditor(id, deps); }
  }
}
