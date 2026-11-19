import path from "node:path";
import { writeFileSync } from "node:fs";
import type { RoleSpec, RoleThinkingLevel } from "./types.ts";
import {
  parseRoleYaml, resetRoleOverride, ROLE_THINKING_LEVELS, saveRoleSpec, scaffoldRoleFile,
  serializeRoleYaml,
} from "./role-loader.ts";
import { COMPANION_TOOL_NAMES } from "./session-tracker.ts";

export interface RoleStudioDeps {
  cwd: string; globalRolesDir: string; pi: any; ctx: any;
  getRoles: () => Map<string, RoleSpec>; refreshRoles: () => Map<string, RoleSpec>;
  getActiveRoleId: () => string | null; activateRole: (roleId: string | null) => Promise<void>;
}

const PINNED_MODELS = ["inherit", "@advisor", "@default", "@smol", "@slow", "@plan", "@task"];
const targetDirFor = (deps: RoleStudioDeps, scope: "global" | "project"): string =>
  scope === "project" ? path.join(deps.cwd, ".omp", "roles") : deps.globalRolesDir;

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

async function pickRoleModel(current: string | undefined, deps: RoleStudioDeps): Promise<string | undefined | null> {
  const ui = deps.ctx?.ui;
  const discovered: string[] = (Array.isArray(deps.ctx?.models?.list?.()) ? deps.ctx.models.list() : [])
    .flatMap((m: any) => (m?.provider && m?.id ? [`${m.provider}/${m.id}`] : []));
  const choices = [...new Set([...PINNED_MODELS, ...discovered]), "Custom model / role alias..."];
  const initialIndex = Math.max(0, choices.indexOf(current ?? "inherit"));
  const picked: string | undefined = await ui.select("Select Role Model", choices, { outline: true, initialIndex });
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
  if (hostTools.length === 0) hostTools.push("read", "grep", "glob", "find", "lsp", "edit", "write", "bash");
  const selected = new Set<string>(role.permissions.tools ?? hostTools);
  const saveLabel = "✓ Save tool selection", allLabel = "[Unrestricted: allow all host tools]", noneLabel = "[No host tools]";
  let cursor = 0;
  while (true) {
    const checkedIndices = hostTools.flatMap((name, idx) => (selected.has(name) ? [idx] : []));
    const choice: string | undefined = await ui.select(
      `Allowed Tools · ${role.id} (Enter toggles tool, pick Save when done)`,
      [...hostTools, saveLabel, allLabel, noneLabel],
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
  const id = String((await ui.input("New Role ID (letters, digits, _ or -)", "")) ?? "").trim();
  if (!id) return null;
  const rawDesc = await ui.input(`Short description for "${id}"`, id);
  if (rawDesc === undefined) return null;
  const scopeChoice = await ui.select("Where should this role YAML be saved?", [
    defaultScope === "project" ? "project (.omp/roles)" : "global (~/.omp/enhance/roles)",
    defaultScope === "project" ? "global (~/.omp/enhance/roles)" : "project (.omp/roles)",
  ], { outline: true });
  if (!scopeChoice) return null;
  const modeChoice = await ui.select("Permission preset", [
    "writable (can edit workspace files)", "readonly (read/verify only, protects **)",
  ], { outline: true });
  if (!modeChoice) return null;
  const model = await pickRoleModel("inherit", deps);
  if (model === null) return null;
  const scope: "global" | "project" = scopeChoice.startsWith("project") ? "project" : "global";
  const created = scaffoldRoleFile({
    id, description: String(rawDesc).trim() || id, targetDir: targetDirFor(deps, scope),
    readOnly: modeChoice.startsWith("readonly"), model,
  });
  deps.refreshRoles();
  ui.notify?.(`Created role "${created.role.id}" [${created.source}]`, "info");
  return created.role.id;
}

export async function openRoleEditor(roleId: string, deps: RoleStudioDeps, initialScope?: "global" | "project"): Promise<void> {
  const ui = deps.ctx?.ui;
  let scope: "global" | "project" = initialScope ?? (deps.getRoles().get(roleId)?.source === "project" ? "project" : "global");
  while (true) {
    const role = deps.refreshRoles().get(roleId);
    if (!role) return;
    const items = [
      deps.getActiveRoleId() === role.id ? `Active in session (${role.id})` : `Activate "${role.id}" in current session`,
      `Model: ${role.model ?? "inherit"}`,
      `Thinking: ${role.thinking ?? "inherit"}`,
      `Allowed tools: ${role.permissions.tools ? `[${role.permissions.tools.join(", ") || "none"}]` : "unrestricted"}`,
      `Writable globs: ${role.permissions.writable ? `[${role.permissions.writable.join(", ") || "readonly"}]` : "unrestricted"}`,
      `Protected globs: ${role.permissions.protected?.length ? `[${role.permissions.protected.join(", ")}]` : "none"}`,
      `Require tool evidence: ${role.exit.requireToolEvidence}`,
      "Edit full role YAML...",
      `Save scope (Copy-on-Write): ${scope}`,
      ...(role.source !== "builtin" ? [`Reset ${role.source} override`] : []),
    ];
    const choice: string | undefined = await ui.select(
      `Role Studio · ${role.id} [${role.source}] — ${role.description || role.name}`, items, { outline: true },
    );
    if (!choice) return;
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
    } else if (choice.startsWith("Save scope")) {
      scope = scope === "global" ? "project" : "global";
    } else if (choice.startsWith("Reset ")) {
      const resetScope = role.source === "project" ? "project" : "global";
      if ((await ui.confirm?.("Reset Role Override", `Delete ${resetScope} override for "${role.id}"?`)) ?? true) {
        resetRoleOverride({ id: role.id, targetDir: targetDirFor(deps, resetScope) });
        if (!deps.refreshRoles().has(role.id)) return;
      }
    }
  }
}

export async function openRoleStudioHome(deps: RoleStudioDeps): Promise<void> {
  const ui = deps.ctx?.ui;
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
