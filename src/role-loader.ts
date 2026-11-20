import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  EpistemicItem, HandoffEnvelope, Mandate, RoleExitSpec, RolePermissions, RoleSource, RoleSpec,
  RoleThinkingLevel,
} from "./types.ts";

export const ROLE_THINKING_LEVELS: readonly RoleThinkingLevel[] = [
  "inherit", "off", "minimal", "low", "medium", "high", "xhigh",
];
const ROLE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const TOP_KEYS: Record<string, true> = {
  id: true, name: true, description: true, model: true, thinking: true,
  stance: true, method: true, permissions: true, exit: true,
};
const PERMISSION_KEYS: Record<string, true> = { tools: true, writable: true, protected: true };
const EXIT_KEYS: Record<string, true> = { require_tool_evidence: true, criteria: true };

function assertKeys(value: Record<string, unknown>, allowed: Record<string, true>, scope: string, filePath: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed[key]) throw new Error(`Unknown ${scope} field "${key}" in ${filePath}`);
  }
}

function stringValue(value: unknown, field: string, filePath: string, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string in ${filePath}`);
  if (!allowEmpty && !value.trim()) throw new Error(`${field} must be a non-empty string in ${filePath}`);
  return value;
}

function stringList(value: unknown, field: string, filePath: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${field} must be an array of non-empty strings in ${filePath}`);
  }
  if (!allowEmpty && value.length === 0) throw new Error(`${field} must not be empty in ${filePath}`);
  return value as string[];
}

export function parseRoleYaml(yamlText: string, source: RoleSource, filePath: string): RoleSpec {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(yamlText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse YAML role ${filePath}: ${detail}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`Role YAML in ${filePath} must be a plain object`);
  const roleYaml = raw as Record<string, unknown>;
  assertKeys(roleYaml, TOP_KEYS, "role", filePath);

  const id = stringValue(roleYaml.id, "id", filePath);
  if (!ROLE_ID.test(id)) throw new Error(`Invalid role id "${id}" in ${filePath}`);
  const stem = path.basename(filePath).replace(/\.ya?ml$/i, "");
  if (/\.ya?ml$/i.test(filePath) && stem !== id) {
    throw new Error(`Role id "${id}" does not match filename "${stem}" in ${filePath}`);
  }

  const name = roleYaml.name === undefined ? id : stringValue(roleYaml.name, "name", filePath);
  const description = roleYaml.description === undefined ? "" : stringValue(roleYaml.description, "description", filePath, true);
  const model = roleYaml.model === undefined ? undefined : stringValue(roleYaml.model, "model", filePath).trim();
  let thinking: RoleThinkingLevel | undefined;
  if (roleYaml.thinking !== undefined) {
    const rawThinking = stringValue(roleYaml.thinking, "thinking", filePath).trim();
    if (!ROLE_THINKING_LEVELS.includes(rawThinking as RoleThinkingLevel)) {
      throw new Error(`thinking must be one of ${ROLE_THINKING_LEVELS.join(", ")} in ${filePath}`);
    }
    thinking = rawThinking as RoleThinkingLevel;
  }
  const stance = stringValue(roleYaml.stance, "stance", filePath);
  const method = stringList(roleYaml.method, "method", filePath, false);

  let permissions: RolePermissions = {};
  if (roleYaml.permissions !== undefined) {
    if (typeof roleYaml.permissions !== "object" || roleYaml.permissions === null || Array.isArray(roleYaml.permissions)) throw new Error(`permissions must be an object in ${filePath}`);
    const permissionYaml = roleYaml.permissions as Record<string, unknown>;
    assertKeys(permissionYaml, PERMISSION_KEYS, "permissions", filePath);
    permissions = {
      ...(permissionYaml.tools === undefined ? {} : { tools: stringList(permissionYaml.tools, "permissions.tools", filePath) }),
      ...(permissionYaml.writable === undefined ? {} : { writable: stringList(permissionYaml.writable, "permissions.writable", filePath) }),
      ...(permissionYaml.protected === undefined ? {} : { protected: stringList(permissionYaml.protected, "permissions.protected", filePath) }),
    };
  }

  let exitSpec: RoleExitSpec = { requireToolEvidence: false, criteria: [] };
  if (roleYaml.exit !== undefined) {
    if (typeof roleYaml.exit !== "object" || roleYaml.exit === null || Array.isArray(roleYaml.exit)) throw new Error(`exit must be an object in ${filePath}`);
    const exitYaml = roleYaml.exit as Record<string, unknown>;
    assertKeys(exitYaml, EXIT_KEYS, "exit", filePath);
    const requireToolEvidence = exitYaml.require_tool_evidence === undefined ? false : exitYaml.require_tool_evidence;
    if (typeof requireToolEvidence !== "boolean") throw new Error(`exit.require_tool_evidence must be a boolean in ${filePath}`);
    const criteria = exitYaml.criteria === undefined ? [] : stringList(exitYaml.criteria, "exit.criteria", filePath);
    exitSpec = { requireToolEvidence, criteria };
  }

  // Fixed key order makes contentSha256 independent of YAML key ordering.
  const canonical = {
    id, name, description, model: model ?? null, thinking: thinking ?? null, stance, method,
    permissions: { tools: permissions.tools, writable: permissions.writable, protected: permissions.protected },
    exit: exitSpec,
  };
  const contentSha256 = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return {
    id, name, description, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}),
    stance, method, permissions, exit: exitSpec, source, filePath, contentSha256,
  };
}

export function discoverRoles(options: { cwd: string; globalRolesDir?: string; builtinRolesDir?: string }): Map<string, RoleSpec> {
  const builtinDir = options.builtinRolesDir ?? path.resolve(import.meta.dir, "..", "roles");
  const globalDir = options.globalRolesDir ?? path.join(homedir(), ".omp", "enhance", "roles");
  const projectDir = path.join(options.cwd, ".omp", "roles");
  const tiers: Array<[string, RoleSource]> = [
    [builtinDir, "builtin"], [globalDir, "global"], [projectDir, "project"],
  ];
  const roles = new Map<string, RoleSpec>();
  for (const [dir, source] of tiers) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const role = parseRoleYaml(readFileSync(filePath, "utf8"), source, filePath);
        roles.set(role.id, role);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load role ${filePath}: ${detail}`);
      }
    }
  }
  return roles;
}

function inferRoleSource(targetDir: string): RoleSource {
  return path.resolve(targetDir).replaceAll(path.sep, "/").endsWith("/.omp/roles") ? "project" : "global";
}

export function serializeRoleYaml(role: Omit<RoleSpec, "source" | "filePath" | "contentSha256">): string {
  const stanceLines = role.stance.trimEnd().split("\n").map((line) => `  ${line}`);
  const lines = [
    `id: ${role.id}`,
    `name: ${JSON.stringify(role.name)}`,
    `description: ${JSON.stringify(role.description)}`,
    ...(role.model ? [`model: ${JSON.stringify(role.model)}`] : []),
    ...(role.thinking ? [`thinking: ${role.thinking}`] : []),
    "stance: |",
    ...stanceLines,
    "method:",
    ...role.method.map((step) => `  - ${JSON.stringify(step)}`),
  ];
  const { tools, writable, protected: prot } = role.permissions;
  if (tools !== undefined || writable !== undefined || prot !== undefined) {
    lines.push("permissions:");
    if (tools !== undefined) lines.push(`  tools: [${tools.map((item) => JSON.stringify(item)).join(", ")}]`);
    if (writable !== undefined) lines.push(`  writable: [${writable.map((item) => JSON.stringify(item)).join(", ")}]`);
    if (prot !== undefined) lines.push(`  protected: [${prot.map((item) => JSON.stringify(item)).join(", ")}]`);
  }
  if (role.exit.requireToolEvidence || role.exit.criteria.length > 0) {
    lines.push("exit:", `  require_tool_evidence: ${role.exit.requireToolEvidence}`);
    if (role.exit.criteria.length > 0) {
      lines.push("  criteria:", ...role.exit.criteria.map((item) => `    - ${JSON.stringify(item)}`));
    }
  }
  return lines.join("\n") + "\n";
}

export function saveRoleSpec(
  role: Omit<RoleSpec, "source" | "filePath" | "contentSha256">,
  targetDir: string,
): RoleSpec {
  mkdirSync(targetDir, { recursive: true });
  const filePath = path.join(targetDir, `${role.id}.yaml`);
  const source = inferRoleSource(targetDir);
  const yamlText = serializeRoleYaml(role);
  const validated = parseRoleYaml(yamlText, source, filePath);
  writeFileSync(filePath, yamlText, "utf8");
  return validated;
}

export function hasBuiltinRole(id: string, builtinRolesDir?: string): boolean {
  const dir = builtinRolesDir ?? path.resolve(import.meta.dir, "..", "roles");
  return ["yaml", "yml"].some((ext) => existsSync(path.join(dir, `${id}.${ext}`)));
}

export function resetRoleOverride(input: { id: string; targetDir: string }): boolean {
  let removed = false;
  for (const ext of ["yaml", "yml"]) {
    const candidate = path.join(input.targetDir, `${input.id}.${ext}`);
    if (existsSync(candidate)) {
      rmSync(candidate, { force: true });
      removed = true;
    }
  }
  return removed;
}

export function cloneRoleSpec(input: {
  sourceRole: RoleSpec; newId: string; description?: string; targetDir: string; overwrite?: boolean;
}): { filePath: string; role: RoleSpec; source: RoleSource } {
  if (!ROLE_ID.test(input.newId)) throw new Error(`Invalid role id "${input.newId}"`);
  const filePath = path.join(input.targetDir, `${input.newId}.yaml`);
  if ((existsSync(filePath) || existsSync(path.join(input.targetDir, `${input.newId}.yml`))) && !input.overwrite) {
    throw new Error(`Role file already exists: ${filePath}`);
  }
  const desc = input.description?.trim() ?? input.sourceRole.description;
  const saved = saveRoleSpec({
    id: input.newId,
    name: input.description?.trim() || `${input.sourceRole.name} (copy)`,
    description: desc,
    ...(input.sourceRole.model ? { model: input.sourceRole.model } : {}),
    ...(input.sourceRole.thinking ? { thinking: input.sourceRole.thinking } : {}),
    stance: input.sourceRole.stance,
    method: [...input.sourceRole.method],
    permissions: {
      ...(input.sourceRole.permissions.tools ? { tools: [...input.sourceRole.permissions.tools] } : {}),
      ...(input.sourceRole.permissions.writable ? { writable: [...input.sourceRole.permissions.writable] } : {}),
      ...(input.sourceRole.permissions.protected ? { protected: [...input.sourceRole.permissions.protected] } : {}),
    },
    exit: {
      requireToolEvidence: input.sourceRole.exit.requireToolEvidence,
      criteria: [...input.sourceRole.exit.criteria],
    },
  }, input.targetDir);
  return { filePath: saved.filePath, role: saved, source: saved.source };
}

export function deleteCustomRole(input: {
  id: string; cwd: string; globalRolesDir?: string; builtinRolesDir?: string;
}): string[] {
  if (hasBuiltinRole(input.id, input.builtinRolesDir)) {
    throw new Error(`Built-in role "${input.id}" cannot be deleted.`);
  }
  const globalDir = input.globalRolesDir ?? path.join(homedir(), ".omp", "enhance", "roles");
  const projectDir = path.join(input.cwd, ".omp", "roles");
  const deleted: string[] = [];
  for (const dir of [projectDir, globalDir]) {
    for (const ext of ["yaml", "yml"]) {
      const candidate = path.join(dir, `${input.id}.${ext}`);
      if (existsSync(candidate)) {
        rmSync(candidate, { force: true });
        deleted.push(candidate);
      }
    }
  }
  if (deleted.length === 0) throw new Error(`Custom role "${input.id}" not found.`);
  return deleted;
}

export function scaffoldRoleFile(input: {
  id: string; description: string; targetDir: string; readOnly?: boolean; overwrite?: boolean; model?: string;
}): { filePath: string; role: RoleSpec; source: RoleSource } {
  if (!ROLE_ID.test(input.id)) throw new Error(`Invalid role id "${input.id}"`);
  mkdirSync(input.targetDir, { recursive: true });
  const filePath = path.join(input.targetDir, `${input.id}.yaml`);
  if (existsSync(filePath) && !input.overwrite) {
    throw new Error(`Role file already exists: ${filePath} (pass overwrite: true to replace it)`);
  }
  const purpose = input.description.trim().replace(/\s+/g, " ") || input.id;
  const trimmedModel = input.model?.trim();
  const lines = [
    "# Generated by omp-enhance. Refine stance, method, permissions and exit criteria.",
    `id: ${input.id}`,
    `name: ${JSON.stringify(purpose)}`,
    `description: ${JSON.stringify(purpose)}`,
    ...(trimmedModel && trimmedModel !== "inherit" ? [`model: ${JSON.stringify(trimmedModel)}`] : []),
    "stance: |",
    "  以真实证据与最小可验证变更为先：先核对真实上下文与输入，再实施最小变更；",
    "  不把“已编写”等同于“已验证”，不擅自放宽原始验收标准。",
    "method:",
    "  - 对齐目标、硬约束与验收标准",
    "  - 阅读真实代码与数据，实施最小且可验证的变更",
    "  - 运行对应验证命令并如实汇总产物与未测边界",
    ...(input.readOnly ? ["permissions:", "  writable: []", '  protected: ["**"]'] : []),
    "# exit:",
    "#   require_tool_evidence: true",
    "#   criteria:",
    "#     - 核心验收条件均有真实执行记录支撑",
  ];
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  const source = inferRoleSource(input.targetDir);
  return { filePath, role: parseRoleYaml(lines.join("\n"), source, filePath), source };
}

function bullets(title: string, values: readonly string[]): string[] {
  return [title, ...(values.length ? values.map((value) => `- ${value}`) : ["- (none)"])];
}

export function formatRuntimeVisionHint(visionCapable: boolean | null | undefined): string | null {
  if (visionCapable === true) {
    return 'RuntimeVision: native-multimodal (current model sees images directly via read — inspect key plots/images with your own eyes; delegate to role "vision" only for large-batch screening or independent blind review)';
  }
  if (visionCapable === false) {
    return 'RuntimeVision: text-only (current model CANNOT see image pixels — read strips images; you MUST delegate image inspection to role "vision" via enhance_handoff with toTarget="vision", delegateNow=true)';
  }
  return null;
}

export function renderConditioningBlock(input: {
  role: RoleSpec; mandate?: Mandate | null; epistemicItems?: readonly EpistemicItem[];
  upstreamHandoff?: HandoffEnvelope | null; visionCapable?: boolean | null;
}): string {
  const { role, mandate = null, epistemicItems = [], upstreamHandoff = null, visionCapable } = input;
  const permissions = role.permissions, visionHint = formatRuntimeVisionHint(visionCapable);
  const lines = [
    "<omp-enhance-conditioning>",
    `## Active Role: ${role.id}`,
    `Name: ${role.name}`,
    `Source: ${role.source}`,
    ...(role.model || role.thinking
      ? [`ModelPref: model=${role.model ?? "inherit"}; thinking=${role.thinking ?? "inherit"}`] : []),
    ...(visionHint ? [visionHint] : []),
    "Stance:",
    role.stance.trim(),
    "Method:",
    ...role.method.map((step, index) => `${index + 1}. ${step}`),
    `Permissions: tools=${permissions.tools?.join(", ") || (permissions.tools ? "(none)" : "(unrestricted)")}` +
      `; writable=${permissions.writable?.join(", ") || (permissions.writable ? "(none)" : "(unrestricted)")}` +
      `; protected=${permissions.protected?.join(", ") || "(none)"}`,
    `Exit: require_tool_evidence=${role.exit.requireToolEvidence}`,
    ...bullets("Exit criteria:", role.exit.criteria),
    "",
    "## Original Mandate",
  ];
  if (mandate) {
    lines.push(`Goal: ${mandate.goal}`, ...bullets("Constraints:", mandate.constraints), ...bullets("Acceptance:", mandate.acceptance));
  } else {
    lines.push("(none)");
  }
  lines.push("", "## Epistemic Board");
  const activeItems = epistemicItems.filter((item) => item.status !== "falsified" && item.status !== "deferred");
  if (activeItems.length === 0) lines.push("- (none)");
  for (const item of activeItems) {
    lines.push(`- [${item.kind}/${item.status}] ${item.statement}${item.evidenceRef ? ` (evidence: ${item.evidenceRef})` : ""}`);
  }
  lines.push("", "## Upstream Handoff");
  if (upstreamHandoff) {
    lines.push(
      `fromRole: ${upstreamHandoff.fromRole}`,
      `verdict: ${upstreamHandoff.verdict}`,
      `summary: ${upstreamHandoff.summary}`,
      ...bullets("artifacts:", upstreamHandoff.artifacts.map((artifact) => `${artifact.path} [${artifact.role}] sha256=${artifact.sha256}`)),
      ...bullets("openRisks:", upstreamHandoff.openRisks),
      `feedbackForUpstream: ${upstreamHandoff.feedbackForUpstream ?? "(none)"}`,
    );
  } else {
    lines.push("(none)");
  }
  lines.push("</omp-enhance-conditioning>");
  return lines.join("\n");
}
