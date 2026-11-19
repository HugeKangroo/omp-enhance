import path from "node:path";
import { writeFileSync } from "node:fs";
import type { EnhanceSettings, RoleSpec, RoleThinkingLevel } from "./types.ts";
import {
  cloneRoleSpec, deleteCustomRole, hasBuiltinRole, parseRoleYaml, resetRoleOverride,
  ROLE_THINKING_LEVELS, saveRoleSpec, scaffoldRoleFile, serializeRoleYaml,
} from "./role-loader.ts";
import { COMPANION_TOOL_NAMES, READONLY_SUBAGENTS } from "./session-tracker.ts";
import { DEFAULT_ENHANCE_SETTINGS } from "./settings.ts";
import { padLeftCell as padCell } from "./flow-room.ts";

export interface RoleStudioDeps {
  cwd: string; globalRolesDir: string; builtinRolesDir?: string; pi: any; ctx: any;
  getRoles: () => Map<string, RoleSpec>; refreshRoles: () => Map<string, RoleSpec>;
  getSettings?: () => EnhanceSettings;
  getActiveRoleId: () => string | null; activateRole: (roleId: string | null) => Promise<void>;
  runHandoff?: (roleId: string) => Promise<void>;
}

const PINNED_MODELS = ["inherit", "@advisor", "@default", "@smol", "@slow", "@plan", "@task"];
const targetDirFor = (deps: RoleStudioDeps, scope: "global" | "project"): string =>
  scope === "project" ? path.join(deps.cwd, ".omp", "roles") : deps.globalRolesDir;

/** Normalize raw ANSI & Kitty keyboard protocol (CSI-u) input sequences. */
export function parseOverlayKey(data: string, kb?: any): string | null {
  if (!data || data.startsWith("\x1b[<")) return null;
  if (/^\x1b\[[0-9;:]*:3[u~A-Z]$/.test(data)) return null;
  if (kb?.matches?.(data, "tui.select.cancel") || kb?.matches?.(data, "app.interrupt")) return "escape";
  if (kb?.matches?.(data, "tui.select.up") || kb?.matches?.(data, "tui.editor.cursorUp")) return "up";
  if (kb?.matches?.(data, "tui.select.down") || kb?.matches?.(data, "tui.editor.cursorDown")) return "down";
  if (kb?.matches?.(data, "tui.editor.cursorRight")) return "right";
  if (kb?.matches?.(data, "tui.editor.cursorLeft")) return "left";
  if (kb?.matches?.(data, "tui.select.confirm") || kb?.matches?.(data, "tui.input.submit")) return "enter";
  if (kb?.matches?.(data, "tui.input.tab")) return "tab";

  const kitty = /^\x1b\[(\d+)(?::(\d+))?(?:;(\d+)(?::(\d+))?)?u$/.exec(data);
  if (kitty) {
    if (kitty[4] === "3") return null;
    const cp = Number(kitty[1]), shiftedCp = kitty[2] ? Number(kitty[2]) : undefined;
    const mod = kitty[3] ? Number(kitty[3]) - 1 : 0;
    if (cp === 27 || ((mod & 4) !== 0 && cp === 99)) return "escape";
    if (cp === 13 || cp === 10) return "enter";
    if (cp === 9) return "tab";
    if (cp === 127 || cp === 8) return "backspace";
    if (cp === 32 && (mod & ~1) === 0) return "space";
    if ((mod & ~1) === 0 && cp >= 33 && cp <= 126) {
      if ((mod & 1) !== 0 && shiftedCp && shiftedCp >= 33 && shiftedCp <= 126) return String.fromCodePoint(shiftedCp);
      const ch = String.fromCodePoint(cp);
      return (mod & 1) !== 0 ? ch.toUpperCase() : ch;
    }
    return null;
  }
  if (data === "\x1b" || data === "\x1b\x1b" || data === "\x03") return "escape";
  if (data === "\r" || data === "\n") return "enter";
  if (data === "\t") return "tab";
  if (data === " ") return "space";
  if (data === "\x7f" || data === "\b" || data === "\x1b[3~") return "backspace";
  if (/^\x1b\[(?:1;\d+(?::[12])?)?A$/.test(data) || data === "\x1bOA") return "up";
  if (/^\x1b\[(?:1;\d+(?::[12])?)?B$/.test(data) || data === "\x1bOB") return "down";
  if (/^\x1b\[(?:1;\d+(?::[12])?)?C$/.test(data) || data === "\x1bOC") return "right";
  if (/^\x1b\[(?:1;\d+(?::[12])?)?D$/.test(data) || data === "\x1bOD") return "left";
  return data.length === 1 && data >= "!" && data <= "~" ? data : null;
}

function stripRoleDraft(role: RoleSpec): Omit<RoleSpec, "source" | "filePath" | "contentSha256"> {
  return {
    id: role.id, name: role.name, description: role.description,
    ...(role.model ? { model: role.model } : {}), ...(role.thinking ? { thinking: role.thinking } : {}),
    stance: role.stance, method: [...role.method],
    permissions: {
      ...(role.permissions.tools ? { tools: [...role.permissions.tools] } : {}),
      ...(role.permissions.writable ? { writable: [...role.permissions.writable] } : {}),
      ...(role.permissions.protected ? { protected: [...role.permissions.protected] } : {}),
    },
    exit: { requireToolEvidence: role.exit.requireToolEvidence, criteria: [...role.exit.criteria] },
  };
}

function parseGlobInput(raw: string): string[] | undefined {
  const t = raw.trim();
  if (t === "*" || t.toLowerCase() === "all" || t.toLowerCase() === "unrestricted") return undefined;
  if (!t || t.toLowerCase() === "none" || t === "[]") return [];
  return t.split(",").map((part) => part.trim()).filter(Boolean);
}

async function pickScope(ui: any, defaultScope: "global" | "project"): Promise<"global" | "project" | null> {
  const choice = await ui.select("保存位置 (Save scope)", [
    defaultScope === "project" ? "project (.omp/roles)" : "global (~/.omp/enhance/roles)",
    defaultScope === "project" ? "global (~/.omp/enhance/roles)" : "project (.omp/roles)",
  ], { outline: true });
  return choice ? (choice.startsWith("project") ? "project" : "global") : null;
}

async function pickRoleModel(current: string | undefined, deps: RoleStudioDeps): Promise<string | undefined | null> {
  const ui = deps.ctx?.ui;
  const discovered: string[] = (Array.isArray(deps.ctx?.models?.list?.()) ? deps.ctx.models.list() : [])
    .flatMap((m: any) => (m?.provider && m?.id ? [`${m.provider}/${m.id}`] : []));
  const choices = [...new Set([...PINNED_MODELS, ...discovered]), "Custom model / role alias..."];
  const picked: string | undefined = await ui.select("Select Role Model", choices, {
    outline: true, initialIndex: Math.max(0, choices.indexOf(current ?? "inherit")),
  });
  if (!picked) return null;
  if (picked === "Custom model / role alias...") {
    const custom = await ui.input("Model ID or @role alias (e.g. @advisor, provider/model)", current ?? "");
    if (custom === undefined) return null;
    const trimmed = String(custom).trim();
    return !trimmed || trimmed === "inherit" ? undefined : trimmed;
  }
  return picked === "inherit" ? undefined : picked;
}

async function pickRoleTools(role: RoleSpec, deps: RoleStudioDeps): Promise<string[] | undefined | null> {
  const ui = deps.ctx?.ui, companion = new Set<string>(COMPANION_TOOL_NAMES);
  const hostTools: string[] = [...new Set<string>(
    (deps.pi?.getAllTools?.() ?? []).map((t: any) => String(t?.name ?? "")).filter((n: string) => Boolean(n) && !companion.has(n)),
  )].sort();
  if (hostTools.length === 0) hostTools.push("read", "grep", "glob", "find", "lsp", "edit", "write", "bash", "task", "wait");
  const selected = new Set<string>(role.permissions.tools ?? hostTools);
  let cursor = 0;

  if (typeof ui.custom === "function") {
    return ui.custom((tui: any, theme: any, kb: any, done: (res: string[] | undefined | null) => void) => {
      const fg = (c: string, s: string): string => (typeof theme?.fg === "function" ? theme.fg(c, s) : s);
      let focused = true;
      return {
        get focused() { return focused; },
        set focused(v: boolean) { focused = v; },
        capturesInput() { return true; },
        invalidate() {},
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
          const inner = Math.max(24, width - 4);
          const lines = [fg("border", `╭─ ${padCell(`工具权限 · ${role.id} (已勾选 ${selected.size}/${hostTools.length})`, inner - 2)} ─╮`)];
          for (let i = 0; i < hostTools.length; i++) {
            const name = hostTools[i]!, on = selected.has(name), cur = i === cursor;
            const row = `${cur ? "▸" : " "} [${on ? "✓" : " "}] ${name}`;
            const styled = cur ? fg("accent", padCell(row, inner)) : on ? fg("success", padCell(row, inner)) : padCell(row, inner);
            lines.push(`${fg("border", "│")} ${styled} ${fg("border", "│")}`);
          }
          lines.push(fg("border", `├─${"─".repeat(inner)}─┤`));
          lines.push(`${fg("border", "│")} ${fg("dim", padCell("Space 勾选/取消 · Enter 保存 · a 不限制 · z 全禁 · Esc 返回", inner))} ${fg("border", "│")}`);
          lines.push(fg("border", `╰─${"─".repeat(inner)}─╯`));
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

export async function openCreateRoleWizard(
  deps: RoleStudioDeps, defaultScope: "global" | "project" = "global",
): Promise<string | null> {
  const ui = deps.ctx?.ui;
  const id = String((await ui.input("新建角色 ID (字母、数字、_ 或 -)", "")) ?? "").trim();
  if (!id) return null;
  const rawDesc = await ui.input(`"${id}" 的一句话描述`, id);
  if (rawDesc === undefined) return null;
  const scope = await pickScope(ui, defaultScope);
  if (!scope) return null;
  const modeChoice = await ui.select("权限预设 (Permission preset)", [
    "writable (允许修改工作区文件)", "readonly (纯只读验证，受保护路径 **)",
  ], { outline: true });
  if (!modeChoice) return null;
  const model = await pickRoleModel("inherit", deps);
  if (model === null) return null;
  try {
    const created = scaffoldRoleFile({
      id, description: String(rawDesc).trim() || id, targetDir: targetDirFor(deps, scope),
      readOnly: modeChoice.startsWith("readonly"), model,
    });
    deps.refreshRoles();
    ui.notify?.(`Created role "${created.role.id}" [${created.source}]`, "info");
    return created.role.id;
  } catch (err) {
    ui.notify?.(err instanceof Error ? err.message : String(err), "warning");
    return null;
  }
}

export async function openCloneRoleWizard(
  sourceRole: RoleSpec, deps: RoleStudioDeps, defaultScope: "global" | "project" = "global",
): Promise<string | null> {
  const ui = deps.ctx?.ui;
  const newId = String((await ui.input(`基于 "${sourceRole.id}" 拷贝的新角色 ID`, `${sourceRole.id}-copy`)) ?? "").trim();
  if (!newId) return null;
  const rawDesc = await ui.input(`"${newId}" 的一句话描述`, sourceRole.description || sourceRole.name);
  if (rawDesc === undefined) return null;
  const scope = await pickScope(ui, defaultScope);
  if (!scope) return null;
  try {
    const cloned = cloneRoleSpec({
      sourceRole, newId, description: String(rawDesc).trim(), targetDir: targetDirFor(deps, scope),
    });
    deps.refreshRoles();
    ui.notify?.(`Copied "${sourceRole.id}" → "${cloned.role.id}" [${cloned.source}]`, "info");
    return cloned.role.id;
  } catch (err) {
    ui.notify?.(err instanceof Error ? err.message : String(err), "warning");
    return null;
  }
}

async function confirmAndDeleteRole(roleId: string, deps: RoleStudioDeps): Promise<boolean> {
  const ui = deps.ctx?.ui;
  if (hasBuiltinRole(roleId, deps.builtinRolesDir)) {
    ui.notify?.(`内置默认角色 "${roleId}" 不可删除（若修改过可在编辑页重置默认）`, "warning");
    return false;
  }
  const ok = (await ui.confirm?.("删除自定义角色", `确定永久删除自定义角色 "${roleId}" 吗？`)) ?? true;
  if (!ok) return false;
  deleteCustomRole({ id: roleId, cwd: deps.cwd, globalRolesDir: deps.globalRolesDir, builtinRolesDir: deps.builtinRolesDir });
  const roles = deps.refreshRoles();
  if (deps.getActiveRoleId() === roleId) {
    const pref = deps.getSettings?.().defaultRole;
    const next = pref === null ? null : (pref && roles.has(pref) ? pref : (roles.has("general") ? "general" : null));
    await deps.activateRole(next);
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
    const builtin = hasBuiltinRole(role.id, deps.builtinRolesDir);
    const items = [
      deps.getActiveRoleId() === role.id ? `Active in session (${role.id})` : `Activate "${role.id}" in current session`,
      `Model: ${role.model ?? "inherit"}`,
      `Thinking: ${role.thinking ?? "inherit"}`,
      `Allowed tools: ${role.permissions.tools ? `[${role.permissions.tools.join(", ") || "none"}]` : "unrestricted"}`,
      `Writable globs: ${role.permissions.writable ? `[${role.permissions.writable.join(", ") || "readonly"}]` : "unrestricted"}`,
      `Protected globs: ${role.permissions.protected?.length ? `[${role.permissions.protected.join(", ")}]` : "none"}`,
      `Require tool evidence: ${role.exit.requireToolEvidence}`,
      "Edit full role YAML...",
      "Copy as new role...",
      `Save scope (Copy-on-Write): ${scope}`,
      ...(builtin && role.source !== "builtin" ? [`Reset ${role.source} override`] : []),
      ...(!builtin ? ["Delete custom role"] : []),
      "← Back",
    ];
    const choice: string | undefined = await ui.select(
      `Role Studio · ${role.id} [${role.source}] — ${role.description || role.name}`, items, { outline: true },
    );
    if (!choice || choice === "← Back") return;
    const persist = (fn: (draft: ReturnType<typeof stripRoleDraft>) => void): void => {
      const draft = stripRoleDraft(role); fn(draft);
      saveRoleSpec(draft, targetDirFor(deps, scope)); deps.refreshRoles();
    };
    if (choice.startsWith("Activate ")) {
      await deps.activateRole(role.id); ui.notify?.(`Activated role "${role.id}"`, "info");
    } else if (choice.startsWith("Model:")) {
      const picked = await pickRoleModel(role.model, deps);
      if (picked !== null) {
        persist((d) => { if (picked) d.model = picked; else delete d.model; });
        if (deps.getActiveRoleId() === role.id) await deps.activateRole(role.id);
      }
    } else if (choice.startsWith("Thinking:")) {
      const picked: string | undefined = await ui.select("Select Thinking Level", [...ROLE_THINKING_LEVELS], {
        outline: true, initialIndex: Math.max(0, ROLE_THINKING_LEVELS.indexOf(role.thinking ?? "inherit")),
      });
      if (picked) {
        persist((d) => { if (picked === "inherit") delete d.thinking; else d.thinking = picked as RoleThinkingLevel; });
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
        const parsed = parseGlobInput(String(raw));
        persist((d) => { if (parsed === undefined) delete d.permissions.writable; else d.permissions.writable = parsed; });
      }
    } else if (choice.startsWith("Protected globs:")) {
      const raw = await ui.input("Protected globs ('none' or comma-separated)", role.permissions.protected?.join(", ") || "none");
      if (raw !== undefined) {
        const parsed = parseGlobInput(String(raw));
        persist((d) => { if (!parsed?.length) delete d.permissions.protected; else d.permissions.protected = parsed; });
      }
    } else if (choice.startsWith("Require tool evidence:")) {
      persist((d) => { d.exit.requireToolEvidence = !role.exit.requireToolEvidence; });
    } else if (choice === "Edit full role YAML...") {
      let draftYaml = serializeRoleYaml(stripRoleDraft(role));
      while (true) {
        const edited = await ui.editor(`YAML · ${role.id}.yaml (${scope})`, draftYaml);
        if (edited === undefined) break;
        draftYaml = String(edited);
        try {
          const outDir = targetDirFor(deps, scope), outPath = path.join(outDir, `${role.id}.yaml`);
          saveRoleSpec(stripRoleDraft(parseRoleYaml(draftYaml, scope, outPath)), outDir);
          writeFileSync(outPath, draftYaml.endsWith("\n") ? draftYaml : `${draftYaml}\n`, "utf8");
          deps.refreshRoles();
          if (deps.getActiveRoleId() === role.id) await deps.activateRole(role.id);
          break;
        } catch (err) { ui.notify?.(err instanceof Error ? err.message : String(err), "warning"); }
      }
    } else if (choice === "Copy as new role...") {
      const clonedId = await openCloneRoleWizard(role, deps, scope);
      if (clonedId) {
        currentId = clonedId;
        scope = deps.getRoles().get(clonedId)?.source === "project" ? "project" : "global";
      }
    } else if (choice.startsWith("Save scope")) {
      scope = scope === "global" ? "project" : "global";
    } else if (choice.startsWith("Reset ")) {
      const resetScope = role.source === "project" ? "project" : "global";
      if ((await ui.confirm?.("Reset Role Override", `Delete ${resetScope} override for "${role.id}"?`)) ?? true) {
        resetRoleOverride({ id: role.id, targetDir: targetDirFor(deps, resetScope) });
        if (!deps.refreshRoles().has(role.id)) return;
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
  | { act: Exclude<ActionKind, "close"> }
  | undefined;

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
        ...(customRoles.length > 0 ? [{ kind: "delete-pick" as const, label: "🗑 删除角色 (Del)", detail: "删除用户自建/拷贝的自定义角色（6 个内置默认角色受保护不可删除）。" }] : []),
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
          get focused() { return focused; },
          set focused(v: boolean) { focused = v; },
          capturesInput() { return true; },
          invalidate() {},
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
              if (cur.kind === "close") return done(undefined);
              return done({ act: cur.kind });
            } else if (key === "c" || key === "C") return done({ act: "copy-pick" });
            else if (key === "e" || key === "E") return done({ act: "edit-pick" });
            else if ((key === "d" || key === "D") && customRoles.length > 0) return done({ act: "delete-pick" });
          },
          render(width: number): string[] {
            const inner = Math.max(44, width - 4);
            const leftW = Math.min(26, Math.max(20, Math.floor(inner * 0.32))), rightW = Math.max(18, inner - leftW - 3);
            const cur = entries[cursor]!;
            let rightRows: Array<{ text: string; style?: "head" | "accent" }>;
            if (cur.kind === "role") {
              const sel = cur.role, builtin = hasBuiltinRole(sel.id, deps.builtinRolesDir);
              const effModel = sel.id === "supervisor" && sel.source === "builtin"
                ? `${settings.supervisorModel} (via /settings)` : (sel.model ?? "inherit (session model)");
              const subRule = sel.permissions.writable !== undefined || (sel.permissions.protected?.length ?? 0) > 0
                ? `read-only (${READONLY_SUBAGENTS.join(", ")})` : "all OMP subagents";
              rightRows = [
                { text: `${sel.id} — ${sel.name} [${sel.source}${builtin ? " · 内置保护" : " · 自定义"}]`, style: "head" },
                { text: sel.description || "(no description)" },
                { text: `Model: ${effModel} · Thinking: ${sel.thinking ?? "inherit"}` },
                { text: `Tools: ${sel.permissions.tools ? (sel.permissions.tools.join(", ") || "none") : "unrestricted"}` },
                { text: `Subagents: ${subRule}` },
                { text: `Writable: ${sel.permissions.writable ? (sel.permissions.writable.join(", ") || "read-only []") : "*"} · Protected: ${sel.permissions.protected?.join(", ") || "none"}` },
                { text: `Stance: ${sel.stance.trim().replace(/\s+/g, " ")}` },
                ...sel.method.slice(0, 2).map((m, idx) => ({ text: `${idx + 1}. ${m}` })),
                { text: `操作: Enter 切换 · e/→ 修改 · c 拷贝${builtin ? "" : " · d 删除"} · h 交接`, style: "accent" },
              ];
            } else {
              rightRows = [
                { text: cur.label, style: "head" }, { text: "" }, { text: cur.detail }, { text: "" },
                { text: "按 Enter 执行此操作，或按 Esc 退出。", style: "accent" },
              ];
            }
            const rowCount = Math.max(entries.length, rightRows.length);
            const out = [fg("border", `╭─ ${padCell(`OMP Enhance · Roles  [当前: ${activeId ?? "off"}]`, inner - 2)} ─╮`)];
            for (let i = 0; i < rowCount; i++) {
              const item = entries[i], rRow = rightRows[i];
              const leftRaw = item ? `${i === cursor ? "▸" : " "}${item.label}` : "";
              const leftCell = i === cursor ? fg("accent", bold(padCell(leftRaw, leftW)))
                : (item?.kind === "role" && activeId === item.role.id ? fg("success", padCell(leftRaw, leftW)) : padCell(leftRaw, leftW));
              const rPadded = padCell(rRow?.text ?? "", rightW);
              const rightCell = rRow?.style === "head" ? fg("accent", bold(rPadded))
                : (rRow?.style === "accent" ? fg("accent", rPadded) : rPadded);
              out.push(`${fg("border", "│")} ${leftCell} ${fg("border", "│")} ${rightCell} ${fg("border", "│")}`);
            }
            out.push(fg("border", `├─${"─".repeat(inner)}─┤`));
            out.push(`${fg("border", "│")} ${fg("dim", padCell("↑/↓ 选择 · Enter 确认 · e 修改 · c 拷贝 · d 删除 · n 新建 · Esc 退出", inner))} ${fg("border", "│")}`);
            out.push(fg("border", `╰─${"─".repeat(inner)}─╯`));
            return out;
          },
        };
      }, { overlay: true });

      if (!action) return;
      if (action.act === "activate") {
        await deps.activateRole(action.roleId); ui.notify?.(`Session role: ${action.roleId}`, "info"); return;
      }
      if (action.act === "off") {
        await deps.activateRole(null); ui.notify?.("Role conditioning disabled", "info"); return;
      }
      if (action.act === "handoff") { await deps.runHandoff?.(action.roleId); return; }
      if (action.act === "edit") await openRoleEditor(action.roleId, deps);
      else if (action.act === "copy") {
        const src = deps.getRoles().get(action.roleId);
        const clonedId = src ? await openCloneRoleWizard(src, deps) : null;
        if (clonedId) {
          await openRoleEditor(clonedId, deps);
          cursor = Math.max(0, [...deps.getRoles().keys()].sort().indexOf(clonedId));
        }
      } else if (action.act === "delete") {
        await confirmAndDeleteRole(action.roleId, deps);
      } else if (action.act === "copy-pick") {
        const picked: string | undefined = await ui.select(
          "选择作为拷贝模板的角色 (Select source role to copy)",
          roles.map((r) => `${r.id} [${r.source}] — ${r.description || r.name}`), { outline: true },
        );
        const src = picked ? deps.getRoles().get(picked.split(" [", 1)[0]?.trim() ?? "") : undefined;
        const clonedId = src ? await openCloneRoleWizard(src, deps) : null;
        if (clonedId) {
          await openRoleEditor(clonedId, deps);
          cursor = Math.max(0, [...deps.getRoles().keys()].sort().indexOf(clonedId));
        }
      } else if (action.act === "edit-pick") {
        const picked: string | undefined = await ui.select(
          "选择要修改的角色 (Select role to edit)",
          roles.map((r) => `${r.id} [${r.source}] — ${r.description || r.name}`), { outline: true },
        );
        const id = picked?.split(" [", 1)[0]?.trim();
        if (id && deps.getRoles().has(id)) await openRoleEditor(id, deps);
      } else if (action.act === "delete-pick") {
        const picked: string | undefined = await ui.select(
          "选择要删除的自定义角色 (Select custom role to delete)",
          customRoles.map((r) => `${r.id} [${r.source}] — ${r.description || r.name}`), { outline: true },
        );
        const id = picked?.split(" [", 1)[0]?.trim();
        if (id) await confirmAndDeleteRole(id, deps);
      } else if (action.act === "new") {
        const createdId = await openCreateRoleWizard(deps);
        if (createdId) {
          await openRoleEditor(createdId, deps);
          cursor = Math.max(0, [...deps.getRoles().keys()].sort().indexOf(createdId));
        }
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
    if (picked === "+ Create new role...") {
      const createdId = await openCreateRoleWizard(deps);
      if (createdId) await openRoleEditor(createdId, deps);
    } else if (picked.startsWith("Disable active role")) {
      await deps.activateRole(null); ui.notify?.("Role conditioning disabled", "info");
    } else {
      const targetId = roleMap.get(picked);
      if (targetId) await openRoleEditor(targetId, deps);
    }
  }
}
