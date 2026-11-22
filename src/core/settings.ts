import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  ROLE_THINKING_LEVELS,
  type EnhanceSettings,
  type FlowRoutingMode,
  type RoleSpec,
  type RoleThinkingLevel,
  type UsageSummary,
} from "./types.ts";

export const PLUGIN_NAME = "omp-enhance";

export const OMP_MODEL_ROLE_IDS = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "commit",
  "tiny",
  "memory",
  "task",
  "advisor",
  "widget",
  "image",
  "web",
  "speech",
  "dictation",
  "judge",
] as const;

const MODEL_ROLE_SET = new Set<string>(OMP_MODEL_ROLE_IDS);
const THINKING_SET = new Set<string>(ROLE_THINKING_LEVELS);
const EXPLICIT_THINKING_SET = new Set<string>(
  ROLE_THINKING_LEVELS.filter((level) => level !== "inherit"),
);
const ROUTING_MODES = new Set<string>(["ask", "auto", "manual"]);

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

export const DEFAULT_ENHANCE_SETTINGS: EnhanceSettings = {
  defaultRole: null,
  showStatusBar: true,
  supervisorEnabled: true,
  supervisorModel: "@advisor",
  supervisorThinking: "inherit",
  supervisorInitialDelaySec: 30,
  flowMaxRepairRounds: 2,
  flowRoutingMode: "auto",
};

export interface LoadEnhanceSettingsOptions {
  cwd: string;
  pluginLockPath?: string;
  profile?: string;
  isProjectTrusted?: boolean;
  onWarning?: (warning: string) => void;
}

export function resolveActiveOmpProfile(explicitProfile?: string): string | undefined {
  const raw = explicitProfile ?? process.env.OMP_PROFILE ?? process.env.PI_PROFILE;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveDefaultPluginLockPath(explicitProfile?: string): string {
  if (process.env.OMP_ENHANCE_PLUGIN_LOCK_PATH?.trim()) {
    return process.env.OMP_ENHANCE_PLUGIN_LOCK_PATH.trim();
  }
  const profile = resolveActiveOmpProfile(explicitProfile);
  if (profile) {
    return path.join(homedir(), ".omp", "profiles", profile, "plugins", "omp-plugins.lock.json");
  }
  const agentDir = process.env.OMP_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
  if (agentDir?.trim()) {
    const candidate = path.join(path.resolve(agentDir.trim(), ".."), "plugins", "omp-plugins.lock.json");
    if (existsSync(candidate)) return candidate;
  }
  return path.join(homedir(), ".omp", "plugins", "omp-plugins.lock.json");
}

export function resolveDefaultGlobalRolesDir(explicitProfile?: string): string {
  if (process.env.OMP_ENHANCE_GLOBAL_ROLES_DIR?.trim()) {
    return process.env.OMP_ENHANCE_GLOBAL_ROLES_DIR.trim();
  }
  const profile = resolveActiveOmpProfile(explicitProfile);
  if (profile) {
    const profileDir = path.join(homedir(), ".omp", "profiles", profile, "enhance", "roles");
    if (existsSync(profileDir)) return profileDir;
  }
  return path.join(homedir(), ".omp", "enhance", "roles");
}

function readRecord(
  filePath: string,
  yaml = false,
  onWarning?: (warning: string) => void,
): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed: unknown = yaml ? Bun.YAML.parse(raw) : JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onWarning?.(`Ignored malformed settings file ${filePath}: ${detail}`);
    return null;
  }
}

function collectProjectOverrideFiles(cwd: string): string[] {
  const start = path.resolve(cwd);
  const stopRoots = new Set<string>([path.resolve(homedir()), path.resolve(tmpdir()), path.parse(start).root]);
  const dirs: string[] = [];
  let current = start;
  while (true) {
    dirs.unshift(current);
    if (existsSync(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current || stopRoots.has(parent)) break;
    current = parent;
  }
  return dirs.map((dir) => path.join(dir, ".omp", "plugin-overrides.json"));
}

function applyRawPatch(target: EnhanceSettings, raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const r = raw as Record<string, unknown>;
  if (r.defaultRole === null || r.defaultRole === false) {
    target.defaultRole = null;
  } else if (typeof r.defaultRole === "string") {
    const trimmed = r.defaultRole.trim();
    target.defaultRole = !trimmed || trimmed.toLowerCase() === "off" ? null : trimmed;
  }
  if (typeof r.showStatusBar === "boolean") target.showStatusBar = r.showStatusBar;
  if (typeof r.supervisorEnabled === "boolean") target.supervisorEnabled = r.supervisorEnabled;
  if (typeof r.supervisorModel === "string" && r.supervisorModel.trim()) {
    target.supervisorModel = r.supervisorModel.trim();
  }
  if (typeof r.supervisorThinking === "string" && THINKING_SET.has(r.supervisorThinking.trim())) {
    target.supervisorThinking = r.supervisorThinking.trim() as RoleThinkingLevel;
  }
  if (typeof r.supervisorInitialDelaySec === "number" && Number.isFinite(r.supervisorInitialDelaySec)) {
    target.supervisorInitialDelaySec = clampInt(r.supervisorInitialDelaySec, 5, 600);
  }
  if (typeof r.flowMaxRepairRounds === "number" && Number.isFinite(r.flowMaxRepairRounds)) {
    target.flowMaxRepairRounds = clampInt(r.flowMaxRepairRounds, 0, 10);
  }
  if (typeof r.flowRoutingMode === "string" && ROUTING_MODES.has(r.flowRoutingMode.trim())) {
    target.flowRoutingMode = r.flowRoutingMode.trim() as FlowRoutingMode;
  }
}

export function loadEnhanceSettings(options: LoadEnhanceSettingsOptions): EnhanceSettings {
  const effective: EnhanceSettings = { ...DEFAULT_ENHANCE_SETTINGS };
  const lockPath = options.pluginLockPath ?? resolveDefaultPluginLockPath(options.profile);
  const lock = readRecord(lockPath, false, options.onWarning);
  applyRawPatch(effective, (lock?.settings as Record<string, unknown> | undefined)?.[PLUGIN_NAME]);

  if (options.isProjectTrusted === false) {
    const enhanceYaml = path.join(options.cwd, ".omp", "enhance.yaml");
    const localOverrides = path.join(options.cwd, ".omp", "plugin-overrides.json");
    if (existsSync(enhanceYaml) || existsSync(localOverrides)) {
      options.onWarning?.(
        `Skipped untrusted project settings in ${path.join(options.cwd, ".omp")} (workspace is not trusted).`,
      );
    }
    return effective;
  }

  for (const overrideFile of collectProjectOverrideFiles(options.cwd)) {
    const proj = readRecord(overrideFile, false, options.onWarning);
    applyRawPatch(effective, (proj?.settings as Record<string, unknown> | undefined)?.[PLUGIN_NAME]);
  }
  applyRawPatch(
    effective,
    readRecord(path.join(options.cwd, ".omp", "enhance.yaml"), true, options.onWarning),
  );
  return effective;
}

export function splitModelThinkingSuffix(spec: string): {
  base: string;
  thinking?: Exclude<RoleThinkingLevel, "inherit">;
} {
  const trimmed = spec.trim();
  const idx = trimmed.lastIndexOf(":");
  if (idx <= 0) return { base: trimmed };
  const suffix = trimmed.slice(idx + 1).trim().toLowerCase();
  if (!EXPLICIT_THINKING_SET.has(suffix)) return { base: trimmed };
  const base = trimmed.slice(0, idx).trim();
  return base
    ? { base, thinking: suffix as Exclude<RoleThinkingLevel, "inherit"> }
    : { base: trimmed };
}

export function normalizeModelSpec(spec: string | undefined): string | undefined {
  const trimmed = spec?.trim();
  if (!trimmed || trimmed === "inherit") return undefined;
  const { base, thinking } = splitModelThinkingSuffix(trimmed);
  if (!base || base === "inherit") return undefined;
  const normBase = base.startsWith("@") || !MODEL_ROLE_SET.has(base) ? base : `@${base}`;
  return thinking ? `${normBase}:${thinking}` : normBase;
}

export function modelSupportsVision(model: unknown): boolean | null {
  if (!model || typeof model !== "object" || !Array.isArray((model as { input?: unknown }).input)) {
    return null;
  }
  return ((model as { input: unknown[] }).input).includes("image");
}

function readConfiguredModelRole(roleTag: string, pi?: any, hostCtx?: any): string | undefined {
  for (const s of [hostCtx?.settings, pi?.pi?.settings, pi?.settings]) {
    if (!s) continue;
    if (typeof s.getModelRole === "function") {
      const v = s.getModelRole(roleTag);
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    if (typeof s.getModelRoles === "function") {
      const v = s.getModelRoles()?.[roleTag];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    if (typeof s.modelRoles === "object" && s.modelRoles !== null) {
      const v = (s.modelRoles as Record<string, unknown>)[roleTag];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return undefined;
}

function resolveModelSpecInner(
  spec: string | undefined,
  hostCtx: any,
  pi: any,
  visitedRoles: Set<string>,
): unknown {
  const normalized = normalizeModelSpec(spec);
  if (!normalized) return hostCtx?.model;
  const list: any[] = Array.isArray(hostCtx?.models?.list?.()) ? hostCtx.models.list() : [];
  if (!normalized.startsWith("@")) {
    const literalMatch = list.find(
      (m) => m && (`${m.provider}/${m.id}` === normalized || m.id === normalized),
    );
    if (literalMatch !== undefined) return literalMatch;
  }

  const { base } = splitModelThinkingSuffix(normalized);
  if (base.startsWith("@")) {
    const roleTag = base.slice(1);
    let resolved = hostCtx?.models?.resolve?.(base);
    if ((resolved === undefined || resolved === null) && !visitedRoles.has(roleTag)) {
      const configured = readConfiguredModelRole(roleTag, pi, hostCtx)?.split(",")[0]?.trim();
      if (configured) {
        const nextVisited = new Set(visitedRoles);
        nextVisited.add(roleTag);
        resolved = resolveModelSpecInner(configured, hostCtx, pi, nextVisited);
      }
    }
    if (base === "@vision") {
      if (resolved !== undefined && resolved !== null && modelSupportsVision(resolved) !== false) {
        return resolved;
      }
      if (modelSupportsVision(hostCtx?.model) === true) return hostCtx.model;
      return (
        list.find((m) => modelSupportsVision(m) === true) ??
        (resolved !== undefined && resolved !== null ? resolved : hostCtx?.model)
      );
    }
    return resolved !== undefined && resolved !== null ? resolved : hostCtx?.model;
  }

  const resolved =
    (normalized !== base ? hostCtx?.models?.resolve?.(normalized) : undefined) ??
    hostCtx?.models?.resolve?.(base);
  if (resolved !== undefined && resolved !== null) return resolved;
  return (
    list.find((m) => m && (`${m.provider}/${m.id}` === base || m.id === base)) ??
    hostCtx?.model
  );
}

export function resolveModelSpec(spec: string | undefined, hostCtx: any, pi?: any): unknown {
  return resolveModelSpecInner(spec, hostCtx, pi, new Set<string>());
}

export function extractModelSpecThinking(
  spec: string | undefined,
  pi: any,
  hostCtx: any,
  resolvedModel?: unknown,
): Exclude<RoleThinkingLevel, "inherit"> | undefined {
  const normalized = normalizeModelSpec(spec);
  if (!normalized) return undefined;
  const list: any[] = Array.isArray(hostCtx?.models?.list?.()) ? hostCtx.models.list() : [];
  if (
    !normalized.startsWith("@") &&
    list.some((m) => m && (`${m.provider}/${m.id}` === normalized || m.id === normalized))
  ) {
    return undefined;
  }
  const { base, thinking } = splitModelThinkingSuffix(normalized);
  if (thinking) return thinking;
  if (!base.startsWith("@")) return undefined;

  if (base === "@vision") {
    const directVision = hostCtx?.models?.resolve?.("@vision");
    if (
      directVision !== undefined &&
      directVision !== null &&
      modelSupportsVision(directVision) === false &&
      resolvedModel !== directVision
    ) {
      return undefined;
    }
  }

  const visited = new Set<string>();
  let roleTag = base.slice(1);
  while (roleTag && !visited.has(roleTag) && visited.size < 8) {
    visited.add(roleTag);
    const raw = readConfiguredModelRole(roleTag, pi, hostCtx)?.split(",")[0]?.trim();
    const nextNorm = normalizeModelSpec(raw);
    if (!nextNorm) return undefined;
    if (
      !nextNorm.startsWith("@") &&
      list.some((m) => m && (`${m.provider}/${m.id}` === nextNorm || m.id === nextNorm))
    ) {
      return undefined;
    }
    const parsed = splitModelThinkingSuffix(nextNorm);
    if (parsed.thinking) return parsed.thinking;
    if (!parsed.base.startsWith("@")) return undefined;
    roleTag = parsed.base.slice(1);
  }
  return undefined;
}

export function resolveRoleRuntimeConfig(
  role: RoleSpec,
  pi: any,
  hostCtx: any,
  settings: EnhanceSettings = DEFAULT_ENHANCE_SETTINGS,
): { model: unknown; thinkingLevel: string | undefined } {
  const isSup = role.id === "supervisor";
  const modelSpec = isSup
    ? role.source !== "builtin" && role.model !== undefined
      ? role.model
      : settings.supervisorModel
    : role.model;
  const thinkSpec = isSup
    ? role.source !== "builtin" && role.thinking !== undefined
      ? role.thinking
      : settings.supervisorThinking
    : role.thinking;
  const model = resolveModelSpec(modelSpec, hostCtx, pi);
  const explicitThinking = thinkSpec && thinkSpec !== "inherit" ? thinkSpec : undefined;
  const roleSuffixThinking = explicitThinking
    ? undefined
    : extractModelSpecThinking(modelSpec, pi, hostCtx, model);
  return {
    model,
    thinkingLevel: explicitThinking ?? roleSuffixThinking ?? pi?.getThinkingLevel?.(),
  };
}

/** Normalize OMP runtime usage (`{ input, output, cost: { total } }`) or `UsageSummary`. */
export function normalizeUsageSummary(raw: unknown): UsageSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  const inputTokens =
    typeof u.inputTokens === "number"
      ? u.inputTokens
      : typeof u.input === "number"
        ? u.input
        : undefined;
  const outputTokens =
    typeof u.outputTokens === "number"
      ? u.outputTokens
      : typeof u.output === "number"
        ? u.output
        : undefined;
  const costObj =
    typeof u.cost === "object" && u.cost !== null ? (u.cost as Record<string, unknown>) : null;
  const costUsd =
    typeof u.costUsd === "number"
      ? u.costUsd
      : typeof costObj?.total === "number"
        ? costObj.total
        : typeof u.cost === "number"
          ? u.cost
          : 0;
  if (inputTokens === undefined && outputTokens === undefined) return null;
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens! : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens! : 0,
    costUsd: Number.isFinite(costUsd) ? costUsd : 0,
  };
}
