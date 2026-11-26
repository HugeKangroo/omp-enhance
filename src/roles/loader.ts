import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { canRoleDispatch, DEFAULT_READONLY_TOOLS, isInternalRole } from "../core/policy.ts";
import { resolveDefaultGlobalRolesDir } from "../core/settings.ts";
import type { RoleLoadDiagnostic, RoleSource, RoleSpec } from "../core/types.ts";
import {
  formatYamlScalar,
  parseRoleYaml,
  ROLE_ID_PATTERN,
  ROLE_THINKING_LEVELS,
  serializeRoleYaml,
} from "./serializer.ts";

export {
  canRoleDispatch,
  formatYamlScalar,
  isInternalRole,
  parseRoleYaml,
  ROLE_ID_PATTERN,
  ROLE_THINKING_LEVELS,
  serializeRoleYaml,
};

const DEFAULT_BUILTIN_ROLES_DIR = path.resolve(import.meta.dir, "..", "..", "roles");

export interface DiscoverRolesOptions {
  cwd: string;
  globalRolesDir?: string;
  builtinRolesDir?: string;
  profile?: string;
  isProjectTrusted?: boolean;
  strict?: boolean;
}

function safeStatIsFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function listYamlEntries(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          /\.ya?ml$/i.test(entry.name) &&
          (entry.isFile() || (entry.isSymbolicLink() && safeStatIsFile(path.join(dir, entry.name)))),
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function findExactRoleFiles(dir: string, id: string): string[] {
  return listYamlEntries(dir)
    .filter((name) => name === `${id}.yaml` || name === `${id}.yml`)
    .map((name) => path.join(dir, name));
}

function findCaseCollidingFiles(dir: string, id: string): string[] {
  const lowerYaml = `${id.toLowerCase()}.yaml`;
  const lowerYml = `${id.toLowerCase()}.yml`;
  return listYamlEntries(dir)
    .filter((name) => {
      const lower = name.toLowerCase();
      return (lower === lowerYaml || lower === lowerYml) && name !== `${id}.yaml` && name !== `${id}.yml`;
    })
    .map((name) => path.join(dir, name));
}

function sortRoleFilesYamlPreferred(files: readonly string[]): string[] {
  return [...files].sort((left, right) => {
    const leftStem = left.replace(/\.ya?ml$/i, "");
    const rightStem = right.replace(/\.ya?ml$/i, "");
    if (leftStem !== rightStem) return leftStem.localeCompare(rightStem);
    const leftIsYaml = /\.yaml$/i.test(left) ? 1 : 0;
    const rightIsYaml = /\.yaml$/i.test(right) ? 1 : 0;
    return leftIsYaml - rightIsYaml;
  });
}

function writeAtomicUtf8(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, filePath);
}

export function inferRoleSource(targetDir: string, globalRolesDir?: string): RoleSource {
  const resolvedTarget = path.resolve(targetDir);
  if (globalRolesDir && resolvedTarget === path.resolve(globalRolesDir)) {
    return "global";
  }
  return resolvedTarget.replaceAll(path.sep, "/").endsWith("/.omp/roles") ? "project" : "global";
}

export function discoverRolesWithDiagnostics(options: DiscoverRolesOptions): {
  roles: Map<string, RoleSpec>;
  diagnostics: RoleLoadDiagnostic[];
} {
  const builtinDir = options.builtinRolesDir ?? DEFAULT_BUILTIN_ROLES_DIR;
  const globalDir = options.globalRolesDir ?? resolveDefaultGlobalRolesDir(options.profile);
  const projectDir = path.join(options.cwd, ".omp", "roles");

  const roles = new Map<string, RoleSpec>();
  const diagnostics: RoleLoadDiagnostic[] = [];
  const tiers: Array<[string, RoleSource]> = [
    [builtinDir, "builtin"],
    [globalDir, "global"],
  ];

  if (options.isProjectTrusted === false) {
    const untrustedFiles = listYamlEntries(projectDir);
    if (untrustedFiles.length > 0) {
      diagnostics.push({
        filePath: projectDir,
        source: "project",
        error: `Skipped ${untrustedFiles.length} project role file(s) in ${projectDir} because workspace is not trusted.`,
      });
    }
  } else {
    tiers.push([projectDir, "project"]);
  }

  for (const [dir, source] of tiers) {
    const files = sortRoleFilesYamlPreferred(listYamlEntries(dir));
    const seenStems = new Set<string>();
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stem = file.replace(/\.ya?ml$/i, "");
      if (seenStems.has(stem)) {
        diagnostics.push({
          filePath,
          source,
          error: `Duplicate role definition for "${stem}" (.yaml and .yml both exist in ${dir}); ".yaml" takes precedence.`,
        });
      }
      seenStems.add(stem);
      try {
        const role = parseRoleYaml(readFileSync(filePath, "utf8"), source, filePath);
        roles.set(role.id, role);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (options.strict || source === "builtin") {
          throw new Error(`Failed to load role ${filePath}: ${detail}`);
        }
        diagnostics.push({ filePath, source, error: detail });
      }
    }
  }
  return { roles, diagnostics };
}

export function discoverRoles(options: DiscoverRolesOptions): Map<string, RoleSpec> {
  return discoverRolesWithDiagnostics(options).roles;
}

export function listUserVisibleRoles(roles: ReadonlyMap<string, RoleSpec>): RoleSpec[] {
  return [...roles.values()]
    .filter((role) => !isInternalRole(role))
    .sort((left, right) => {
      const leftCoord = canRoleDispatch(left) ? 0 : 1;
      const rightCoord = canRoleDispatch(right) ? 0 : 1;
      return leftCoord !== rightCoord ? leftCoord - rightCoord : left.id.localeCompare(right.id);
    });
}

export function saveRoleSpec(
  role: Omit<RoleSpec, "source" | "filePath" | "contentSha256">,
  targetDir: string,
  options?: { globalRolesDir?: string },
): RoleSpec {
  const filePath = path.join(targetDir, `${role.id}.yaml`);
  const source = inferRoleSource(targetDir, options?.globalRolesDir);
  const yamlText = serializeRoleYaml(role);
  const validated = parseRoleYaml(yamlText, source, filePath);

  mkdirSync(targetDir, { recursive: true });
  for (const colliding of findCaseCollidingFiles(targetDir, role.id)) {
    rmSync(colliding, { force: true });
  }
  const siblingYml = path.join(targetDir, `${role.id}.yml`);
  for (const exact of findExactRoleFiles(targetDir, role.id)) {
    if (exact === siblingYml) rmSync(exact, { force: true });
  }
  writeAtomicUtf8(filePath, yamlText);
  return validated;
}

export function hasBuiltinRole(id: string, builtinRolesDir?: string): boolean {
  const dir = builtinRolesDir ?? DEFAULT_BUILTIN_ROLES_DIR;
  return findExactRoleFiles(dir, id).length > 0;
}

export function resetRoleOverride(input: { id: string; targetDir: string }): boolean {
  let removed = false;
  for (const candidate of findExactRoleFiles(input.targetDir, input.id)) {
    rmSync(candidate, { force: true });
    removed = true;
  }
  return removed;
}

export function cloneRoleSpec(input: {
  sourceRole: RoleSpec;
  newId: string;
  description?: string;
  targetDir: string;
  globalRolesDir?: string;
  overwrite?: boolean;
}): { filePath: string; role: RoleSpec; source: RoleSource } {
  if (!ROLE_ID_PATTERN.test(input.newId)) {
    throw new Error(`Invalid role id "${input.newId}"`);
  }
  const existingExact = findExactRoleFiles(input.targetDir, input.newId);
  const existingCase = findCaseCollidingFiles(input.targetDir, input.newId);
  if ((existingExact.length > 0 || existingCase.length > 0) && !input.overwrite) {
    throw new Error(
      `Role file already exists: ${existingExact[0] ?? existingCase[0] ?? path.join(input.targetDir, `${input.newId}.yaml`)}`,
    );
  }
  const trimmedDesc = input.description?.trim() ?? "";
  const desc = trimmedDesc || input.sourceRole.description;
  const saved = saveRoleSpec(
    {
      id: input.newId,
      name: trimmedDesc || `${input.sourceRole.name} (copy)`,
      description: desc,
      ...(input.sourceRole.model !== undefined ? { model: input.sourceRole.model } : {}),
      ...(input.sourceRole.thinking !== undefined ? { thinking: input.sourceRole.thinking } : {}),
      stance: input.sourceRole.stance,
      method: [...input.sourceRole.method],
      permissions: {
        ...(input.sourceRole.permissions.tools
          ? { tools: [...input.sourceRole.permissions.tools] }
          : {}),
        ...(input.sourceRole.permissions.writable
          ? { writable: [...input.sourceRole.permissions.writable] }
          : {}),
        ...(input.sourceRole.permissions.protected
          ? { protected: [...input.sourceRole.permissions.protected] }
          : {}),
        ...(input.sourceRole.permissions.dispatch !== undefined
          ? { dispatch: input.sourceRole.permissions.dispatch }
          : {}),
      },
      exit: {
        requireToolEvidence: input.sourceRole.exit.requireToolEvidence,
        ...(input.sourceRole.exit.requiredTools
          ? { requiredTools: [...input.sourceRole.exit.requiredTools] }
          : {}),
        ...(input.sourceRole.exit.requiredArtifacts
          ? { requiredArtifacts: [...input.sourceRole.exit.requiredArtifacts] }
          : {}),
        ...(input.sourceRole.exit.requireTestExecution !== undefined
          ? { requireTestExecution: input.sourceRole.exit.requireTestExecution }
          : {}),
        ...(input.sourceRole.exit.requireAlgoDeliverables !== undefined
          ? { requireAlgoDeliverables: input.sourceRole.exit.requireAlgoDeliverables }
          : {}),
        criteria: [...input.sourceRole.exit.criteria],
      },
      ...(input.sourceRole.workflow ? { workflow: structuredClone(input.sourceRole.workflow) } : {}),
    },
    input.targetDir,
    { globalRolesDir: input.globalRolesDir },
  );
  return { filePath: saved.filePath, role: saved, source: saved.source };
}

export function deleteCustomRole(input: {
  id: string;
  cwd: string;
  globalRolesDir?: string;
  builtinRolesDir?: string;
  profile?: string;
}): string[] {
  if (hasBuiltinRole(input.id, input.builtinRolesDir)) {
    throw new Error(`Built-in role "${input.id}" cannot be deleted.`);
  }
  const globalDir = input.globalRolesDir ?? resolveDefaultGlobalRolesDir(input.profile);
  const projectDir = path.join(input.cwd, ".omp", "roles");
  const deleted: string[] = [];
  for (const dir of [projectDir, globalDir]) {
    for (const candidate of findExactRoleFiles(dir, input.id)) {
      rmSync(candidate, { force: true });
      deleted.push(candidate);
    }
  }
  if (deleted.length === 0) throw new Error(`Custom role "${input.id}" not found.`);
  return deleted;
}

export function scaffoldRoleFile(input: {
  id: string;
  description: string;
  targetDir: string;
  globalRolesDir?: string;
  readOnly?: boolean;
  overwrite?: boolean;
  model?: string;
}): { filePath: string; role: RoleSpec; source: RoleSource } {
  if (!ROLE_ID_PATTERN.test(input.id)) {
    throw new Error(`Invalid role id "${input.id}"`);
  }
  const filePath = path.join(input.targetDir, `${input.id}.yaml`);
  const existingExact = findExactRoleFiles(input.targetDir, input.id);
  const existingCase = findCaseCollidingFiles(input.targetDir, input.id);
  if ((existingExact.length > 0 || existingCase.length > 0) && !input.overwrite) {
    throw new Error(
      `Role file already exists: ${existingExact[0] ?? existingCase[0] ?? filePath} (pass overwrite: true to replace it)`,
    );
  }

  const purpose = input.description.trim().replace(/\s+/g, " ") || input.id;
  const trimmedModel = input.model?.trim();
  const lines = [
    "# Generated by omp-enhance. Refine stance, method, permissions and exit criteria.",
    `id: ${formatYamlScalar(input.id)}`,
    `name: ${JSON.stringify(purpose)}`,
    `description: ${JSON.stringify(purpose)}`,
    ...(trimmedModel && trimmedModel !== "inherit"
      ? [`model: ${JSON.stringify(trimmedModel)}`]
      : []),
    "stance: |2",
    "  以真实证据与最小可验证变更为先：先核对真实上下文与输入，再实施最小变更；",
    "  不把“已编写”等同于“已验证”，不擅自放宽原始验收标准。",
    "method:",
    "  - 对齐目标、硬约束与验收标准",
    "  - 阅读真实代码与数据，实施最小且可验证的变更",
    "  - 运行对应验证命令并如实汇总产物与未测边界",
    ...(input.readOnly
      ? [
          "permissions:",
          `  tools: [${DEFAULT_READONLY_TOOLS.map((t) => JSON.stringify(t)).join(", ")}]`,
          "  writable: []",
          '  protected: ["**"]',
        ]
      : []),
    "# exit:",
    "#   require_tool_evidence: true",
    "#   criteria:",
    "#     - 核心验收条件均有真实执行记录支撑",
  ];
  const yamlText = `${lines.join("\n")}\n`;
  const source = inferRoleSource(input.targetDir, input.globalRolesDir);
  const validated = parseRoleYaml(yamlText, source, filePath);

  mkdirSync(input.targetDir, { recursive: true });
  for (const colliding of existingCase) {
    rmSync(colliding, { force: true });
  }
  for (const exact of existingExact) {
    if (exact !== filePath) rmSync(exact, { force: true });
  }
  writeAtomicUtf8(filePath, yamlText);
  return { filePath, role: validated, source };
}
