import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { EnhanceSettings, RoleSpec, RoleThinkingLevel } from "../core/types.ts";
import { splitBraceSafeGlobs } from "../core/fs.ts";
import {
  canRoleDispatch, COMPANION_TOOL_NAMES, DEFAULT_READONLY_TOOLS, isInternalRole, isRoleReadOnly, READONLY_SUBAGENTS,
} from "../core/policy.ts";
import { DEFAULT_ENHANCE_SETTINGS } from "../core/settings.ts";
import {
  cloneRoleSpec, deleteCustomRole, hasBuiltinRole, listUserVisibleRoles, parseRoleYaml, resetRoleOverride,
  ROLE_THINKING_LEVELS, saveRoleSpec, scaffoldRoleFile, serializeRoleYaml,
} from "../roles/loader.ts";
import { computeScrollWindow, padLeftCell as padCell, parseOverlayKey } from "./kit.ts";

export { parseOverlayKey };

export interface RoleStudioDeps {
  cwd: string; globalRolesDir: string; builtinRolesDir?: string; pi: any; ctx: any;
  getRoles: () => Map<string, RoleSpec>; refreshRoles: () => Map<string, RoleSpec>;
  getSettings?: () => EnhanceSettings;
  getActiveRoleId: () => string | null; activateRole: (roleId: string | null) => Promise<void>;
}

const PINNED_MODELS = ["inherit", "@vision", "@advisor", "@default", "@smol", "@slow", "@plan", "@task"];
const FALLBACK_TOOLS = ["read", "grep", "glob", "find", "ls", "lsp", "edit", "write", "apply_patch", "bash", "task", "wait"];
const PRESET_CHOICES = ["writable (允许修改工作区文件)", "readonly (纯只读验证，受保护路径 **)"];
const roleGroupBadge = (role: RoleSpec): string => (canRoleDispatch(role) ? "[总控入口]" : "[后台专员]");
const targetDirFor = (deps: RoleStudioDeps, scope: "global" | "project"): string =>
  scope === "project" ? path.join(deps.cwd, ".omp", "roles") : deps.globalRolesDir;

function stripRoleDraft(role: RoleSpec): Omit<RoleSpec, "source" | "filePath" | "contentSha256"> {
  return {
    id: role.id, name: role.name, description: role.description,
    ...(role.model !== undefined ? { model: role.model } : {}),
    ...(role.thinking !== undefined ? { thinking: role.thinking } : {}),
    ...(role.internal !== undefined ? { internal: role.internal } : {}),
    stance: role.stance, method: [...role.method],
    permissions: {
      ...(role.permissions.tools ? { tools: [...role.permissions.tools] } : {}),
      ...(role.permissions.writable ? { writable: [...role.permissions.writable] } : {}),
      ...(role.permissions.protected ? { protected: [...role.permissions.protected] } : {}),
      ...(role.permissions.dispatch !== undefined ? { dispatch: role.permissions.dispatch } : {}),
    },
    exit: {
      requireToolEvidence: role.exit.requireToolEvidence,
      ...(role.exit.requiredTools ? { requiredTools: [...role.exit.requiredTools] } : {}),
      ...(role.exit.requiredArtifacts ? { requiredArtifacts: [...role.exit.requiredArtifacts] } : {}),
      ...(role.exit.requireTestExecution !== undefined ? { requireTestExecution: role.exit.requireTestExecution } : {}),
      ...(role.exit.requireAlgoDeliverables !== undefined ? { requireAlgoDeliverables: role.exit.requireAlgoDeliverables } : {}),
      criteria: [...role.exit.criteria],
    },
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
  const choice = await ui.select("保存位置", opts, { outline: true });
  return choice ? (choice.startsWith("project") ? "project" : "global") : null;
}

async function pickRoleModel(current: string | undefined, deps: RoleStudioDeps): Promise<string | null> {
  const ui = deps.ctx?.ui, customOpt = "自定义模型 ID 或 @role 别名...";
  const discovered: string[] = (Array.isArray(deps.ctx?.models?.list?.()) ? deps.ctx.models.list() : []).flatMap((m: any) => (m?.provider && m?.id ? [`${m.provider}/${m.id}`] : []));
  const choices = [...new Set([...PINNED_MODELS, ...discovered]), customOpt];
  const picked: string | undefined = await ui.select("选择角色绑定模型", choices, { outline: true, initialIndex: Math.max(0, choices.indexOf(current ?? "inherit")) });
  if (!picked) return null;
  if (picked !== customOpt) return picked;
  const custom = await ui.input("输入模型 ID 或 @role 别名 (如 @advisor、provider/model)", current ?? "");
  return custom === undefined ? null : (String(custom).trim() || "inherit");
}

async function pickRoleTools(role: RoleSpec, deps: RoleStudioDeps): Promise<string[] | undefined | null> {
  const ui = deps.ctx?.ui, companion = new Set<string>(COMPANION_TOOL_NAMES);
  const discovered = (deps.pi?.getAllTools?.() ?? []).map((t: any) => String(t?.name ?? "")).filter((n: string) => Boolean(n) && !companion.has(n));
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
            lines.push(`${fg("border", "│")} ${cur ? fg("accent", padCell(row, inner)) : on ? fg("success", padCell(row, inner)) : padCell(row, inner)} ${fg("border", "│")}`);
          }
          if (win.hasBelow) lines.push(`${fg("border", "│")} ${fg("dim", padCell(`↓ 下方还有 ${hostTools.length - win.end} 项`, inner))} ${fg("border", "│")}`);
          lines.push(fg("border", `├─${"─".repeat(inner)}─┤`), `${fg("border", "│")} ${fg("dim", padCell("Space 勾选/取消 · Enter 保存 · a 不限制 · z 全禁 · Esc 返回", inner))} ${fg("border", "│")}`, fg("border", `╰─${"─".repeat(inner)}─╯`));
          return lines;
        },
      };
    }, { overlay: true });
  }

  const saveLabel = "✓ 保存工具勾选", allLabel = "[不限制：允许全部宿主工具]", noneLabel = "[禁用全部宿主工具]";
  while (true) {
    const checkedIndices = hostTools.flatMap((name, idx) => (selected.has(name) ? [idx] : []));
    const choice: string | undefined = await ui.select(`工具权限 · ${role.id}`, [...hostTools, saveLabel, allLabel, noneLabel], { outline: true, selectionMarker: "checkbox", checkedIndices, markableCount: hostTools.length, initialIndex: cursor });
    if (!choice) return null;
    if (choice === saveLabel) return hostTools.filter((name) => selected.has(name));
    if (choice === allLabel) return undefined;
    if (choice === noneLabel) return [];
    const idx = hostTools.indexOf(choice);
    if (idx >= 0) { cursor = idx; if (selected.has(choice)) selected.delete(choice); else selected.add(choice); }
  }
}

export async function openCreateRoleWizard(deps: RoleStudioDeps, defaultScope: "global" | "project" = "global"): Promise<string | null> {
  const ui = deps.ctx?.ui, id = String((await ui.input("新建专员 ID (字母、数字、_ 或 -)", "")) ?? "").trim();
  if (!id) return null;
  if (id === "supervisor") { ui.notify?.('内置监控角色 "supervisor" 受系统保留，不可覆盖创建', "warning"); return null; }
  const rawDesc = await ui.input(`"${id}" 的一句话描述`, id);
  if (rawDesc === undefined) return null;
  const scope = await pickScope(ui, defaultScope);
  if (!scope) return null;
  const modeChoice = await ui.select("权限边界预设", PRESET_CHOICES, { outline: true });
  if (!modeChoice) return null;
  const pickedModel = await pickRoleModel("inherit", deps);
  if (pickedModel === null) return null;
  try {
    const created = scaffoldRoleFile({
      id, description: String(rawDesc).trim() || id, targetDir: targetDirFor(deps, scope),
      globalRolesDir: deps.globalRolesDir, readOnly: modeChoice.startsWith("readonly"), model: pickedModel === "inherit" ? undefined : pickedModel,
    });
    deps.refreshRoles(); ui.notify?.(`已创建专员角色 "${created.role.id}" [${created.source}]`, "info");
    return created.role.id;
  } catch (err) { ui.notify?.(err instanceof Error ? err.message : String(err), "warning"); return null; }
}

export async function openCloneRoleWizard(sourceRole: RoleSpec, deps: RoleStudioDeps, defaultScope: "global" | "project" = "global"): Promise<string | null> {
  const ui = deps.ctx?.ui, newId = String((await ui.input(`基于 "${sourceRole.id}" 拷贝的新角色 ID`, `${sourceRole.id}-copy`)) ?? "").trim();
  if (!newId) return null;
  if (newId === "supervisor") { ui.notify?.('内置监控角色 "supervisor" 受系统保留', "warning"); return null; }
  const rawDesc = await ui.input(`"${newId}" 的一句话描述`, sourceRole.description || sourceRole.name);
  if (rawDesc === undefined) return null;
  const scope = await pickScope(ui, defaultScope);
  if (!scope) return null;
  try {
    const cloned = cloneRoleSpec({ sourceRole, newId, description: String(rawDesc).trim(), targetDir: targetDirFor(deps, scope), globalRolesDir: deps.globalRolesDir });
    deps.refreshRoles(); ui.notify?.(`已拷贝 "${sourceRole.id}" → "${cloned.role.id}" [${cloned.source}]`, "info");
    return cloned.role.id;
  } catch (err) { ui.notify?.(err instanceof Error ? err.message : String(err), "warning"); return null; }
}

async function confirmAndDeleteRole(roleId: string, deps: RoleStudioDeps): Promise<boolean> {
  const ui = deps.ctx?.ui;
  if (hasBuiltinRole(roleId, deps.builtinRolesDir)) {
    ui.notify?.(`内置默认角色 "${roleId}" 不可删除（若修改过可在配置页选择「恢复内置默认」）`, "warning");
    return false;
  }
  if ((await ui.confirm?.("删除自定义角色", `确定永久删除自定义角色 "${roleId}" 吗？`)) !== true) return false;
  deleteCustomRole({ id: roleId, cwd: deps.cwd, globalRolesDir: deps.globalRolesDir, builtinRolesDir: deps.builtinRolesDir });
  const roles = deps.refreshRoles();
  if (deps.getActiveRoleId() === roleId) {
    const pref = (deps.getSettings?.() ?? DEFAULT_ENHANCE_SETTINGS).defaultRole;
    await deps.activateRole(pref && roles.has(pref) && !isInternalRole(roles.get(pref)) ? pref : null);
  }
  ui.notify?.(`已删除自定义角色 "${roleId}"`, "info");
  return true;
}

async function openAdvancedRoleSettings(
  roleId: string, deps: RoleStudioDeps, persist: (role: RoleSpec, fn: (draft: ReturnType<typeof stripRoleDraft>) => void) => void,
): Promise<void> {
  const ui = deps.ctx?.ui;
  while (true) {
    const role = deps.refreshRoles().get(roleId);
    if (!role) return;
    const advItems = [
      `可用工具列表: ${role.permissions.tools ? `[${role.permissions.tools.join(", ") || "none"}]` : "不限制"}`,
      `可写路径 Globs: ${role.permissions.writable ? `[${role.permissions.writable.join(", ") || "readonly"}]` : "*"}`,
      `受保护路径 Globs: ${role.permissions.protected?.length ? `[${role.permissions.protected.join(", ")}]` : "none"}`,
      `要求工具执行证据: ${role.exit.requireToolEvidence ? "开启" : "关闭"}`, "返回",
    ];
    const choice: string | undefined = await ui.select(`高级路径与工具设置 · ${role.id}`, advItems, { outline: true });
    if (!choice || choice === "返回") return;
    if (choice.startsWith("可用工具列表:")) {
      const tools = await pickRoleTools(role, deps);
      if (tools !== null) {
        persist(role, (d) => { if (tools === undefined) delete d.permissions.tools; else d.permissions.tools = tools; });
        if (deps.getActiveRoleId() === role.id) await deps.activateRole(role.id);
      }
    } else if (choice.startsWith("可写路径 Globs:")) {
      const cur = role.permissions.writable === undefined ? "*" : (role.permissions.writable.join(", ") || "none");
      const raw = await ui.input("可写路径 Globs ('*' = 全部可写, 'none' = 纯只读, 或逗号分隔)", cur);
      if (raw !== undefined) {
        const parsed = parseWritableGlobInput(String(raw));
        persist(role, (d) => { if (parsed === undefined) delete d.permissions.writable; else d.permissions.writable = parsed; });
      }
    } else if (choice.startsWith("受保护路径 Globs:")) {
      const raw = await ui.input("受保护路径 Globs ('*' = 全部保护, 'none' = 无保护, 或逗号分隔)", role.permissions.protected?.join(", ") || "none");
      if (raw !== undefined) {
        const parsed = parseProtectedGlobInput(String(raw));
        persist(role, (d) => { if (!parsed?.length) delete d.permissions.protected; else d.permissions.protected = parsed; });
      }
    } else if (choice.startsWith("要求工具执行证据:")) {
      persist(role, (d) => { d.exit.requireToolEvidence = !role.exit.requireToolEvidence; });
    }
  }
}

export async function openRoleEditor(roleId: string, deps: RoleStudioDeps, initialScope?: "global" | "project"): Promise<void> {
  const ui = deps.ctx?.ui;
  let currentId = roleId;
  let scope: "global" | "project" = initialScope ?? (deps.getRoles().get(currentId)?.source === "project" ? "project" : "global");
  while (true) {
    const role = deps.refreshRoles().get(currentId);
    if (!role) return;
    if (isInternalRole(role)) {
      ui?.notify?.(`内部监控角色 "${role.id}" 不在 Role Studio 中编辑；请在 /settings → Plugins → omp-enhance 配置。`, "info");
      return;
    }
    const builtin = hasBuiltinRole(role.id, deps.builtinRolesDir), isCoord = canRoleDispatch(role);
    const permLabel = isRoleReadOnly(role) ? "纯只读 (readonly)" : (role.permissions.writable ? `受限可写 [${role.permissions.writable.join(", ")}]` : "可读写 (writable)");
    const items = [
      ...(isCoord ? [deps.getActiveRoleId() === role.id ? `当前会话已启用 (${role.id}) — 点击退回标准 OMP` : `在当前会话启用 "${role.id}"`] : []),
      `模型绑定: ${role.model ?? "inherit"}`, `推理档位: ${role.thinking ?? "inherit"}`, `权限边界预设: ${permLabel}`,
      "高级路径与工具设置", "编辑完整 YAML...", "拷贝为新角色...",
      `保存位置: ${scope === "project" ? "项目 (.omp/roles)" : "全局 (~/.omp/enhance/roles)"}`,
      ...(builtin && role.source !== "builtin" ? ["恢复内置默认"] : []),
      ...(!builtin ? ["删除自定义角色"] : []), "返回",
    ];
    const choice: string | undefined = await ui.select(
      `Role Studio · ${roleGroupBadge(role)} ${role.id} [${role.source}] — ${role.description || role.name}`, items, { outline: true },
    );
    if (!choice || choice === "返回") return;
    const persist = (r: RoleSpec, fn: (draft: ReturnType<typeof stripRoleDraft>) => void): void => {
      const draft = stripRoleDraft(r); fn(draft);
      saveRoleSpec(draft, targetDirFor(deps, scope), { globalRolesDir: deps.globalRolesDir });
      deps.refreshRoles();
      if (r.source === "project" && scope === "global") ui.notify?.(`已写入全局目录，但当前项目的 .omp/roles/${r.id}.yaml 优先级更高。`, "warning");
    };
    if (choice.startsWith("在当前会话启用 ")) { await deps.activateRole(role.id); ui.notify?.(`已启用总控角色 "${role.id}"`, "info"); }
    else if (choice.startsWith("当前会话已启用 ")) { await deps.activateRole(null); ui.notify?.("已退回标准原生 OMP", "info"); }
    else if (choice.startsWith("模型绑定:")) {
      const picked = await pickRoleModel(role.model, deps);
      if (picked !== null) {
        persist(role, (d) => { if (picked === "inherit") delete d.model; else d.model = picked; });
        if (deps.getActiveRoleId() === role.id) await deps.activateRole(role.id);
      }
    } else if (choice.startsWith("推理档位:")) {
      const curThink = role.thinking ?? "inherit";
      const picked: string | undefined = await ui.select("选择推理档位", [...ROLE_THINKING_LEVELS], { outline: true, initialIndex: Math.max(0, ROLE_THINKING_LEVELS.indexOf(curThink)) });
      if (picked) {
        persist(role, (d) => { if (picked === "inherit") delete d.thinking; else d.thinking = picked as RoleThinkingLevel; });
        if (deps.getActiveRoleId() === role.id) await deps.activateRole(role.id);
      }
    } else if (choice.startsWith("权限边界预设:")) {
      const preset = await ui.select("权限边界预设", PRESET_CHOICES, { outline: true });
      if (preset) {
        const ro = preset.startsWith("readonly");
        persist(role, (d) => {
          if (ro) { d.permissions.writable = []; d.permissions.protected = ["**"]; if (!d.permissions.tools) d.permissions.tools = [...DEFAULT_READONLY_TOOLS]; }
          else { delete d.permissions.writable; delete d.permissions.protected; }
        });
        if (deps.getActiveRoleId() === role.id) await deps.activateRole(role.id);
      }
    } else if (choice === "高级路径与工具设置") await openAdvancedRoleSettings(role.id, deps, persist);
    else if (choice === "编辑完整 YAML...") {
      let draftYaml = role.source === scope && existsSync(role.filePath) ? readFileSync(role.filePath, "utf8") : serializeRoleYaml(stripRoleDraft(role));
      while (true) {
        const edited = await ui.editor(`YAML · ${role.id}.yaml (${scope})`, draftYaml);
        if (edited === undefined) break;
        draftYaml = String(edited);
        try {
          const outDir = targetDirFor(deps, scope), outPath = path.join(outDir, `${role.id}.yaml`);
          const validated = parseRoleYaml(draftYaml, scope, outPath);
          if (isInternalRole(validated)) throw new Error("Role Studio cannot mark user-visible roles as internal: true.");
          mkdirSync(outDir, { recursive: true }); resetRoleOverride({ id: role.id, targetDir: outDir });
          writeFileSync(outPath, draftYaml.endsWith("\n") ? draftYaml : `${draftYaml}\n`, "utf8");
          deps.refreshRoles();
          if (deps.getActiveRoleId() === role.id) await deps.activateRole(role.id);
          break;
        } catch (err) { ui.notify?.(err instanceof Error ? err.message : String(err), "warning"); }
      }
    } else if (choice === "拷贝为新角色...") {
      const clonedId = await openCloneRoleWizard(role, deps, scope);
      if (clonedId) { currentId = clonedId; scope = deps.getRoles().get(clonedId)?.source === "project" ? "project" : "global"; }
    } else if (choice.startsWith("保存位置:")) scope = scope === "global" ? "project" : "global";
    else if (choice === "恢复内置默认") {
      const resetScope = role.source === "project" ? "project" : "global";
      if ((await ui.confirm?.("恢复内置默认", `确定移除 "${role.id}" 的${resetScope === "project" ? "项目" : "全局"}覆盖并恢复内置默认吗？`)) === true) {
        resetRoleOverride({ id: role.id, targetDir: targetDirFor(deps, resetScope) });
        const refreshed = deps.refreshRoles().get(role.id);
        if (!refreshed) return;
        scope = refreshed.source === "project" ? "project" : "global";
        if (deps.getActiveRoleId() === role.id) await deps.activateRole(role.id);
      }
    } else if (choice === "删除自定义角色" && (await confirmAndDeleteRole(role.id, deps))) return;
  }
}

type OverlayAction =
  | { act: "activate" | "edit" | "copy" | "delete"; roleId: string }
  | { act: "new" | "off" } | undefined;

function buildStudioDetailRows(sel: RoleSpec | undefined, builtinDir?: string): Array<{ text: string; style?: "head" | "accent" }> {
  if (!sel) return [{ text: "(无可用角色)", style: "head" }];
  const builtin = hasBuiltinRole(sel.id, builtinDir), isCoord = canRoleDispatch(sel);
  const subRule = isCoord ? "跨项目异步调度专员链 (/coord 总秘书)"
    : (sel.permissions.writable !== undefined || (sel.permissions.protected?.length ?? 0) > 0 ? `只读子代理 (${READONLY_SUBAGENTS.join(", ")})` : "全部 OMP 子代理");
  return [
    { text: `${roleGroupBadge(sel)} ${sel.id} — ${sel.name} [${sel.source}${builtin ? " · 内置保护" : " · 自定义"}]`, style: "head" },
    { text: sel.description || "(无描述)" },
    { text: `模型绑定: ${sel.model ?? "inherit (跟随会话)"} · 推理档位: ${sel.thinking ?? "inherit"}` },
    { text: `工具范围: ${sel.permissions.tools ? (sel.permissions.tools.join(", ") || "none") : "不限制"}${isCoord ? " · 总控调度: 开启" : ""}` },
    { text: `委派规则: ${subRule}` },
    { text: `可写路径: ${sel.permissions.writable ? (sel.permissions.writable.join(", ") || "只读 []") : "*"} · 受保护: ${sel.permissions.protected?.join(", ") || "无"}` },
    { text: `角色准则: ${sel.stance.trim().replace(/\s+/g, " ")}` },
    ...sel.method.slice(0, 2).map((m, idx) => ({ text: `${idx + 1}. ${m}` })),
    { text: `操作: Enter ${isCoord ? "切换总控开关" : "配置模型与权限"} · e/→ 配置 · n 新建 · c 拷贝${builtin ? "" : " · d 删除"} · x 退回标准OMP`, style: "accent" },
  ];
}

export async function openRoleStudioHome(deps: RoleStudioDeps): Promise<void> {
  const ui = deps.ctx?.ui;
  let cursor = -1;

  if (typeof ui.custom === "function") {
    while (true) {
      const roles = listUserVisibleRoles(deps.refreshRoles());
      if (roles.length === 0) return;
      const activeId = deps.getActiveRoleId();
      if (cursor < 0) cursor = Math.max(0, roles.findIndex((r) => r.id === activeId));
      cursor = Math.min(cursor, roles.length - 1);

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
            const cur = roles[cursor]!;
            if (key === "escape" || key === "q" || key === "Q") return done(undefined);
            if (key === "up" || key === "k") { cursor = (cursor - 1 + roles.length) % roles.length; tui?.requestRender?.(); return; }
            if (key === "down" || key === "j") { cursor = (cursor + 1) % roles.length; tui?.requestRender?.(); return; }
            if (key === "n" || key === "N") return done({ act: "new" });
            if (key === "x" || key === "X" || key === "o" || key === "O") return done({ act: "off" });
            if (key === "enter") return done(canRoleDispatch(cur) ? (activeId === cur.id ? { act: "off" } : { act: "activate", roleId: cur.id }) : { act: "edit", roleId: cur.id });
            if (key === "e" || key === "E" || key === "right" || key === "tab") return done({ act: "edit", roleId: cur.id });
            if (key === "c" || key === "C") return done({ act: "copy", roleId: cur.id });
            if (key === "d" || key === "D" || key === "backspace") return done({ act: "delete", roleId: cur.id });
          },
          render(width: number): string[] {
            const inner = Math.max(48, width - 4), leftW = Math.min(32, Math.max(26, Math.floor(inner * 0.36))), rightW = Math.max(18, inner - leftW - 3);
            const rightRows = buildStudioDetailRows(roles[cursor], deps.builtinRolesDir);
            const win = computeScrollWindow(roles.length, cursor, Math.max(10, (process.stdout?.rows ?? 30) - 8));
            const visibleRoles = roles.slice(win.start, win.end), rowCount = Math.max(visibleRoles.length, rightRows.length);
            const out = [fg("border", `╭─ ${padCell(`OMP Enhance · 专员工作台 (/role)  [当前会话: ${activeId ?? "标准 OMP"}]`, inner - 2)} ─╮`)];
            for (let r = 0; r < rowCount; r++) {
              const absIdx = win.start + r, role = r < visibleRoles.length ? visibleRoles[r] : undefined, rRow = rightRows[r];
              const leftRaw = role ? `${absIdx === cursor ? "▸" : " "}${activeId === role.id ? "●" : " "} ${roleGroupBadge(role)} ${role.id}` : "";
              const leftCell = role && absIdx === cursor ? fg("accent", bold(padCell(leftRaw, leftW))) : (role && activeId === role.id ? fg("success", padCell(leftRaw, leftW)) : padCell(leftRaw, leftW));
              const rPadded = padCell(rRow?.text ?? "", rightW);
              const rightCell = rRow?.style === "head" ? fg("accent", bold(rPadded)) : (rRow?.style === "accent" ? fg("accent", rPadded) : rPadded);
              out.push(`${fg("border", "│")} ${leftCell} ${fg("border", "│")} ${rightCell} ${fg("border", "│")}`);
            }
            out.push(
              fg("border", `├─${"─".repeat(inner)}─┤`),
              `${fg("border", "│")} ${fg("dim", padCell("↑↓ 选择 · Enter 配置/切换 · n 新建 · c 拷贝 · x 退回标准OMP · Esc/q 关闭面板", inner))} ${fg("border", "│")}`,
              fg("border", `╰─${"─".repeat(inner)}─╯`),
            );
            return out;
          },
        };
      }, { overlay: true });

      if (!action) return;
      if (action.act === "activate") { await deps.activateRole(action.roleId); ui.notify?.(`已开启总秘书模式 (${action.roleId})`, "info"); return; }
      if (action.act === "off") { await deps.activateRole(null); ui.notify?.("已退回标准原生 OMP", "info"); return; }
      if (action.act === "edit") await openRoleEditor(action.roleId, deps);
      else if (action.act === "copy") {
        const src = deps.getRoles().get(action.roleId);
        const clonedId = src ? await openCloneRoleWizard(src, deps) : null;
        if (clonedId) { await openRoleEditor(clonedId, deps); cursor = Math.max(0, listUserVisibleRoles(deps.getRoles()).findIndex((r) => r.id === clonedId)); }
      } else if (action.act === "delete") await confirmAndDeleteRole(action.roleId, deps);
      else if (action.act === "new") {
        const createdId = await openCreateRoleWizard(deps);
        if (createdId) { await openRoleEditor(createdId, deps); cursor = Math.max(0, listUserVisibleRoles(deps.getRoles()).findIndex((r) => r.id === createdId)); }
      }
    }
  }

  const newLabel = "+ 新建自定义专员...", offLabel = "退回标准 OMP (/coord off)";
  while (true) {
    const roles = listUserVisibleRoles(deps.refreshRoles());
    const activeId = deps.getActiveRoleId(), roleMap = new Map<string, string>(), options: string[] = [];
    for (const role of roles) {
      const label = `${activeId === role.id ? "*" : " "} ${roleGroupBadge(role)} ${role.id} [${role.source}] (模型: ${role.model ?? "inherit"}) — ${role.description || role.name}`;
      roleMap.set(label, role.id); options.push(label);
    }
    options.push(newLabel, ...(activeId ? [offLabel] : []));
    const picked: string | undefined = await ui.select(`OMP Enhance · 专员工作台 (当前会话: ${activeId ?? "标准 OMP"})`, options, { outline: true });
    if (!picked) return;
    if (picked === newLabel) { const id = await openCreateRoleWizard(deps); if (id) await openRoleEditor(id, deps); }
    else if (picked === offLabel) { await deps.activateRole(null); ui.notify?.("已退回标准原生 OMP", "info"); }
    else { const id = roleMap.get(picked); if (id) await openRoleEditor(id, deps); }
  }
}
