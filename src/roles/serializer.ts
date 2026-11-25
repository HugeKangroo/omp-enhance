import { createHash } from "node:crypto";
import path from "node:path";
import {
  ROLE_THINKING_LEVELS,
  type RoleExitSpec,
  type RolePermissions,
  type RoleSource,
  type RoleSpec,
  type RoleThinkingLevel,
} from "../core/types.ts";

export { ROLE_THINKING_LEVELS };

export const ROLE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const TOP_KEYS: Record<string, true> = {
  id: true,
  name: true,
  description: true,
  model: true,
  thinking: true,
  internal: true,
  stance: true,
  method: true,
  permissions: true,
  exit: true,
};

const PERMISSION_KEYS: Record<string, true> = {
  tools: true,
  writable: true,
  protected: true,
  dispatch: true,
};

const EXIT_KEYS: Record<string, true> = {
  require_tool_evidence: true,
  required_tools: true,
  required_artifacts: true,
  require_test_execution: true,
  require_algo_deliverables: true,
  criteria: true,
};

function assertKeys(
  value: Record<string, unknown>,
  allowed: Record<string, true>,
  scope: string,
  filePath: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed[key]) throw new Error(`Unknown ${scope} field "${key}" in ${filePath}`);
  }
}

function stringValue(
  value: unknown,
  field: string,
  filePath: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string in ${filePath}`);
  if (!allowEmpty && !value.trim()) {
    throw new Error(`${field} must be a non-empty string in ${filePath}`);
  }
  return value;
}

function stringList(
  value: unknown,
  field: string,
  filePath: string,
  allowEmpty = true,
): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`${field} must be an array of non-empty strings in ${filePath}`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new Error(`${field} must not be empty in ${filePath}`);
  }
  return value as string[];
}

/** Quote a scalar only when bare YAML parsing would coerce or alter its string value. */
export function formatYamlScalar(value: string): string {
  if (!value || /[\r\n:#{}[\],&*?|<>=!%@`"'\\]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  try {
    const probe = Bun.YAML.parse(`k: ${value}`) as { k?: unknown } | null;
    if (probe && typeof probe === "object" && probe.k === value) {
      return value;
    }
  } catch {
    // Fall through to JSON.stringify quoting.
  }
  return JSON.stringify(value);
}

export function computeRoleContentSha256(
  role: Omit<RoleSpec, "source" | "filePath" | "contentSha256">,
): string {
  const canonical = {
    id: role.id,
    name: role.name,
    description: role.description,
    model: role.model ?? null,
    thinking: role.thinking ?? null,
    internal: role.internal ?? false,
    stance: role.stance,
    method: role.method,
    permissions: {
      tools: role.permissions.tools,
      writable: role.permissions.writable,
      protected: role.permissions.protected,
      dispatch: role.permissions.dispatch ?? false,
    },
    exit: {
      requireToolEvidence: role.exit.requireToolEvidence,
      requiredTools: role.exit.requiredTools ?? null,
      requiredArtifacts: role.exit.requiredArtifacts ?? null,
      requireTestExecution: role.exit.requireTestExecution ?? false,
      requireAlgoDeliverables: role.exit.requireAlgoDeliverables ?? false,
      criteria: role.exit.criteria,
    },
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function parseRoleYaml(
  yamlText: string,
  source: RoleSource,
  filePath: string,
): RoleSpec {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(yamlText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse YAML role ${filePath}: ${detail}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Role YAML in ${filePath} must be a plain object`);
  }
  const roleYaml = raw as Record<string, unknown>;
  assertKeys(roleYaml, TOP_KEYS, "role", filePath);

  const id = stringValue(roleYaml.id, "id", filePath);
  if (!ROLE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid role id "${id}" in ${filePath}`);
  }
  const stem = path.basename(filePath).replace(/\.ya?ml$/i, "");
  if (/\.ya?ml$/i.test(filePath) && stem !== id) {
    throw new Error(`Role id "${id}" does not match filename "${stem}" in ${filePath}`);
  }

  const name = roleYaml.name === undefined ? id : stringValue(roleYaml.name, "name", filePath);
  const description =
    roleYaml.description === undefined
      ? ""
      : stringValue(roleYaml.description, "description", filePath, true);
  const model =
    roleYaml.model === undefined
      ? undefined
      : stringValue(roleYaml.model, "model", filePath).trim();

  let thinking: RoleThinkingLevel | undefined;
  if (roleYaml.thinking !== undefined) {
    const rawThinking = stringValue(roleYaml.thinking, "thinking", filePath).trim();
    if (!ROLE_THINKING_LEVELS.includes(rawThinking as RoleThinkingLevel)) {
      throw new Error(
        `thinking must be one of ${ROLE_THINKING_LEVELS.join(", ")} in ${filePath}`,
      );
    }
    thinking = rawThinking as RoleThinkingLevel;
  }

  let internal: boolean | undefined;
  if (roleYaml.internal !== undefined) {
    if (typeof roleYaml.internal !== "boolean") {
      throw new Error(`internal must be a boolean in ${filePath}`);
    }
    internal = roleYaml.internal;
  }

  const stance = stringValue(roleYaml.stance, "stance", filePath).replace(/\r\n/g, "\n");
  const method = stringList(roleYaml.method, "method", filePath, false);

  let permissions: RolePermissions = {};
  if (roleYaml.permissions !== undefined) {
    if (
      typeof roleYaml.permissions !== "object" ||
      roleYaml.permissions === null ||
      Array.isArray(roleYaml.permissions)
    ) {
      throw new Error(`permissions must be an object in ${filePath}`);
    }
    const permissionYaml = roleYaml.permissions as Record<string, unknown>;
    assertKeys(permissionYaml, PERMISSION_KEYS, "permissions", filePath);
    if (permissionYaml.dispatch !== undefined && typeof permissionYaml.dispatch !== "boolean") {
      throw new Error(`permissions.dispatch must be a boolean in ${filePath}`);
    }
    permissions = {
      ...(permissionYaml.tools === undefined
        ? {}
        : { tools: stringList(permissionYaml.tools, "permissions.tools", filePath) }),
      ...(permissionYaml.writable === undefined
        ? {}
        : { writable: stringList(permissionYaml.writable, "permissions.writable", filePath) }),
      ...(permissionYaml.protected === undefined
        ? {}
        : { protected: stringList(permissionYaml.protected, "permissions.protected", filePath) }),
      ...(permissionYaml.dispatch === undefined ? {} : { dispatch: permissionYaml.dispatch }),
    };
  }

  let exitSpec: RoleExitSpec = { requireToolEvidence: false, criteria: [] };
  if (roleYaml.exit !== undefined) {
    if (
      typeof roleYaml.exit !== "object" ||
      roleYaml.exit === null ||
      Array.isArray(roleYaml.exit)
    ) {
      throw new Error(`exit must be an object in ${filePath}`);
    }
    const exitYaml = roleYaml.exit as Record<string, unknown>;
    assertKeys(exitYaml, EXIT_KEYS, "exit", filePath);
    const requireToolEvidence =
      exitYaml.require_tool_evidence === undefined ? false : exitYaml.require_tool_evidence;
    if (typeof requireToolEvidence !== "boolean") {
      throw new Error(`exit.require_tool_evidence must be a boolean in ${filePath}`);
    }
    const requiredTools =
      exitYaml.required_tools === undefined
        ? undefined
        : stringList(exitYaml.required_tools, "exit.required_tools", filePath);
    const requiredArtifacts =
      exitYaml.required_artifacts === undefined
        ? undefined
        : stringList(exitYaml.required_artifacts, "exit.required_artifacts", filePath);
    if (exitYaml.require_test_execution !== undefined && typeof exitYaml.require_test_execution !== "boolean") {
      throw new Error(`exit.require_test_execution must be a boolean in ${filePath}`);
    }
    if (exitYaml.require_algo_deliverables !== undefined && typeof exitYaml.require_algo_deliverables !== "boolean") {
      throw new Error(`exit.require_algo_deliverables must be a boolean in ${filePath}`);
    }
    const criteria =
      exitYaml.criteria === undefined
        ? []
        : stringList(exitYaml.criteria, "exit.criteria", filePath);
    exitSpec = {
      requireToolEvidence,
      ...(requiredTools !== undefined ? { requiredTools } : {}),
      ...(requiredArtifacts !== undefined ? { requiredArtifacts } : {}),
      ...(exitYaml.require_test_execution !== undefined ? { requireTestExecution: exitYaml.require_test_execution } : {}),
      ...(exitYaml.require_algo_deliverables !== undefined ? { requireAlgoDeliverables: exitYaml.require_algo_deliverables } : {}),
      criteria,
    };
  }

  const draft = {
    id,
    name,
    description,
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(internal !== undefined ? { internal } : {}),
    stance,
    method,
    permissions,
    exit: exitSpec,
  };
  return {
    ...draft,
    source,
    filePath,
    contentSha256: computeRoleContentSha256(draft),
  };
}

export function serializeRoleYaml(
  role: Omit<RoleSpec, "source" | "filePath" | "contentSha256">,
): string {
  const normalizedStance = role.stance.replace(/\r\n/g, "\n");
  const stanceHeader = !normalizedStance.endsWith("\n")
    ? "stance: |2-"
    : normalizedStance.endsWith("\n\n")
      ? "stance: |2+"
      : "stance: |2";
  const stanceBody = normalizedStance.endsWith("\n")
    ? normalizedStance.slice(0, -1)
    : normalizedStance;
  const stanceLines = stanceBody.split("\n").map((line) => (line ? `  ${line}` : ""));

  const lines = [
    `id: ${formatYamlScalar(role.id)}`,
    `name: ${JSON.stringify(role.name)}`,
    `description: ${JSON.stringify(role.description)}`,
    ...(role.model !== undefined ? [`model: ${JSON.stringify(role.model)}`] : []),
    ...(role.thinking !== undefined ? [`thinking: ${formatYamlScalar(role.thinking)}`] : []),
    ...(role.internal !== undefined ? [`internal: ${role.internal}`] : []),
    stanceHeader,
    ...stanceLines,
    "method:",
    ...role.method.map((step) => `  - ${JSON.stringify(step)}`),
  ];

  const { tools, writable, protected: prot, dispatch } = role.permissions;
  if (tools !== undefined || writable !== undefined || prot !== undefined || dispatch !== undefined) {
    lines.push("permissions:");
    if (tools !== undefined) {
      lines.push(`  tools: [${tools.map((item) => JSON.stringify(item)).join(", ")}]`);
    }
    if (writable !== undefined) {
      lines.push(`  writable: [${writable.map((item) => JSON.stringify(item)).join(", ")}]`);
    }
    if (prot !== undefined) {
      lines.push(`  protected: [${prot.map((item) => JSON.stringify(item)).join(", ")}]`);
    }
    if (dispatch !== undefined) {
      lines.push(`  dispatch: ${dispatch}`);
    }
  }

  const {
    requireToolEvidence, requiredTools, requiredArtifacts,
    requireTestExecution, requireAlgoDeliverables, criteria,
  } = role.exit;
  if (
    requireToolEvidence ||
    requiredTools !== undefined ||
    requiredArtifacts !== undefined ||
    requireTestExecution !== undefined ||
    requireAlgoDeliverables !== undefined ||
    criteria.length > 0
  ) {
    lines.push("exit:", `  require_tool_evidence: ${requireToolEvidence}`);
    if (requiredTools !== undefined) {
      lines.push(`  required_tools: [${requiredTools.map((item) => JSON.stringify(item)).join(", ")}]`);
    }
    if (requiredArtifacts !== undefined) {
      lines.push(`  required_artifacts: [${requiredArtifacts.map((item) => JSON.stringify(item)).join(", ")}]`);
    }
    if (requireTestExecution !== undefined) {
      lines.push(`  require_test_execution: ${requireTestExecution}`);
    }
    if (requireAlgoDeliverables !== undefined) {
      lines.push(`  require_algo_deliverables: ${requireAlgoDeliverables}`);
    }
    if (criteria.length > 0) {
      lines.push("  criteria:", ...criteria.map((item) => `    - ${JSON.stringify(item)}`));
    }
  }
  return `${lines.join("\n")}\n`;
}
