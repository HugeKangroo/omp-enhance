import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { EnhanceSettings, RoleSpec, RoleThinkingLevel } from "./types.ts";
import { ROLE_THINKING_LEVELS } from "./role-loader.ts";

export const PLUGIN_NAME = "omp-enhance";
export const OMP_MODEL_ROLE_IDS = [
  "default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory",
  "task", "advisor", "widget", "image", "web", "speech", "dictation", "judge",
] as const;

const MODEL_ROLE_SET = new Set<string>(OMP_MODEL_ROLE_IDS);
const THINKING_SET = new Set<string>(ROLE_THINKING_LEVELS);
const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

export const DEFAULT_ENHANCE_SETTINGS: EnhanceSettings = {
  defaultRole: "general", showStatusBar: true, supervisorEnabled: true,
  supervisorModel: "@advisor", supervisorThinking: "off",
  supervisorInitialDelaySec: 30, flowMaxRepairRounds: 2,
};

function readRecord(filePath: string, yaml = false): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed: unknown = yaml ? Bun.YAML.parse(raw) : JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>) : null;
  } catch { return null; }
}

function applyRawPatch(target: EnhanceSettings, raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const r = raw as Record<string, unknown>;
  if (r.defaultRole === null) target.defaultRole = null;
  else if (typeof r.defaultRole === "string") {
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
}

export function loadEnhanceSettings(options: { cwd: string; pluginLockPath?: string }): EnhanceSettings {
  const effective: EnhanceSettings = { ...DEFAULT_ENHANCE_SETTINGS };
  const lockPath = options.pluginLockPath ?? process.env.OMP_ENHANCE_PLUGIN_LOCK_PATH ??
    path.join(homedir(), ".omp", "plugins", "omp-plugins.lock.json");
  const lock = readRecord(lockPath);
  applyRawPatch(effective, (lock?.settings as Record<string, unknown> | undefined)?.[PLUGIN_NAME]);
  const proj = readRecord(path.join(options.cwd, ".omp", "plugin-overrides.json"));
  applyRawPatch(effective, (proj?.settings as Record<string, unknown> | undefined)?.[PLUGIN_NAME]);
  applyRawPatch(effective, readRecord(path.join(options.cwd, ".omp", "enhance.yaml"), true));
  return effective;
}

export function normalizeModelSpec(spec: string | undefined): string | undefined {
  const trimmed = spec?.trim();
  if (!trimmed || trimmed === "inherit") return undefined;
  return trimmed.startsWith("@") || !MODEL_ROLE_SET.has(trimmed) ? trimmed : `@${trimmed}`;
}

export function resolveModelSpec(spec: string | undefined, hostCtx: any): unknown {
  const normalized = normalizeModelSpec(spec);
  if (!normalized) return hostCtx?.model;
  const resolved = hostCtx?.models?.resolve?.(normalized) ??
    (normalized.startsWith("@") ? hostCtx?.models?.resolve?.(normalized.slice(1)) : undefined);
  if (resolved !== undefined && resolved !== null) return resolved;
  const list: any[] = Array.isArray(hostCtx?.models?.list?.()) ? hostCtx.models.list() : [];
  return list.find((m) => m && (`${m.provider}/${m.id}` === normalized || m.id === normalized)) ?? hostCtx?.model;
}

export function resolveRoleRuntimeConfig(
  role: RoleSpec, pi: any, hostCtx: any, settings: EnhanceSettings = DEFAULT_ENHANCE_SETTINGS,
): { model: unknown; thinkingLevel: string | undefined } {
  const isSup = role.id === "supervisor";
  const modelSpec = isSup ? (role.source !== "builtin" && role.model ? role.model : settings.supervisorModel) : role.model;
  const thinkSpec = isSup ? (role.source !== "builtin" && role.thinking ? role.thinking : settings.supervisorThinking) : role.thinking;
  return {
    model: resolveModelSpec(modelSpec, hostCtx),
    thinkingLevel: thinkSpec && thinkSpec !== "inherit" ? thinkSpec : pi?.getThinkingLevel?.(),
  };
}
