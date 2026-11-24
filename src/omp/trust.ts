import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface TrustStoreData {
  version: 1;
  trustedProjects: string[];
  untrustedProjects: string[];
}

export interface TrustEvaluation {
  trusted: boolean;
  isOrigin: boolean;
  skippedCustomizations: string[];
  trustNotice?: string;
}

export function resolveTrustedProjectsFilePath(options: { globalRolesDir?: string } = {}): string {
  const envHome = process.env.OMP_ENHANCE_HOME?.trim();
  if (envHome) return path.join(path.resolve(envHome), ".omp", "enhance", "trusted-projects.json");
  if (options.globalRolesDir) {
    const defaultRoles = path.join(homedir(), ".omp", "enhance", "roles");
    const resolvedRoles = path.resolve(options.globalRolesDir);
    if (resolvedRoles !== path.resolve(defaultRoles)) {
      return path.join(path.dirname(resolvedRoles), "trusted-projects.json");
    }
  }
  return path.join(homedir(), ".omp", "enhance", "trusted-projects.json");
}

function canonicalPath(raw: string): string {
  const abs = path.resolve(raw);
  try { return realpathSync(abs); } catch { return abs; }
}

export function sameProjectPath(a: string, b: string): boolean {
  const absA = path.resolve(a), absB = path.resolve(b);
  return absA === absB || canonicalPath(absA) === canonicalPath(absB);
}

export function readTrustStore(filePath: string): TrustStoreData {
  if (!existsSync(filePath)) return { version: 1, trustedProjects: [], untrustedProjects: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (Array.isArray(parsed)) {
      return {
        version: 1,
        trustedProjects: parsed.filter((it): it is string => typeof it === "string" && it.trim().length > 0),
        untrustedProjects: [],
      };
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const toList = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((it): it is string => typeof it === "string" && it.trim().length > 0) : [];
      return { version: 1, trustedProjects: toList(obj.trustedProjects), untrustedProjects: toList(obj.untrustedProjects) };
    }
  } catch {}
  return { version: 1, trustedProjects: [], untrustedProjects: [] };
}

function writeTrustStore(filePath: string, data: TrustStoreData): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

export function grantProjectTrust(filePath: string, targetCwd: string): string {
  const resolved = path.resolve(targetCwd);
  const store = readTrustStore(filePath);
  const trustedProjects = [resolved, ...store.trustedProjects.filter((p) => !sameProjectPath(p, resolved))];
  const untrustedProjects = store.untrustedProjects.filter((p) => !sameProjectPath(p, resolved));
  writeTrustStore(filePath, { version: 1, trustedProjects, untrustedProjects });
  return resolved;
}

export function revokeProjectTrust(filePath: string, targetCwd: string): string {
  const resolved = path.resolve(targetCwd);
  const store = readTrustStore(filePath);
  const trustedProjects = store.trustedProjects.filter((p) => !sameProjectPath(p, resolved));
  const untrustedProjects = [resolved, ...store.untrustedProjects.filter((p) => !sameProjectPath(p, resolved))];
  writeTrustStore(filePath, { version: 1, trustedProjects, untrustedProjects });
  return resolved;
}

export function detectProjectCustomizations(cwd: string): string[] {
  const ompDir = path.join(path.resolve(cwd), ".omp");
  if (!existsSync(ompDir)) return [];
  const found: string[] = [];
  const rolesDir = path.join(ompDir, "roles");
  try {
    if (existsSync(rolesDir) && readdirSync(rolesDir).some((f) => /\.ya?ml$/i.test(f))) found.push(".omp/roles/*.yaml");
  } catch {}
  for (const rel of ["plugin-overrides.json", "settings.json", "config.json", "enhance.yaml", "enhance.yml"]) {
    if (existsSync(path.join(ompDir, rel))) found.push(`.omp/${rel}`);
  }
  return found;
}

export function evaluateWorkspaceTrust(input: {
  targetCwd: string;
  originCwd?: string;
  ctx?: any;
  trustStorePath: string;
}): TrustEvaluation {
  const resolvedTarget = path.resolve(input.targetCwd);
  const isOrigin = !input.originCwd || sameProjectPath(resolvedTarget, input.originCwd);
  const store = readTrustStore(input.trustStorePath);
  const explicitlyTrusted = store.trustedProjects.some((p) => sameProjectPath(p, resolvedTarget));
  const explicitlyUntrusted = store.untrustedProjects.some((p) => sameProjectPath(p, resolvedTarget));

  let trusted: boolean;
  if (explicitlyUntrusted) {
    trusted = false;
  } else if (explicitlyTrusted) {
    trusted = true;
  } else if (isOrigin) {
    trusted = typeof input.ctx?.isProjectTrusted === "function"
      ? (input.ctx.isProjectTrusted.length >= 1
          ? Boolean(input.ctx.isProjectTrusted(resolvedTarget))
          : Boolean(input.ctx.isProjectTrusted()))
      : true;
  } else if (typeof input.ctx?.isProjectTrusted === "function" && input.ctx.isProjectTrusted.length >= 1) {
    trusted = Boolean(input.ctx.isProjectTrusted(resolvedTarget));
  } else {
    trusted = false;
  }

  const skippedCustomizations = trusted ? [] : detectProjectCustomizations(resolvedTarget);
  const trustNotice = !trusted && (!isOrigin || skippedCustomizations.length > 0)
    ? (skippedCustomizations.length > 0
        ? `Untrusted target project ${resolvedTarget}: skipped project-local ${skippedCustomizations.join(", ")} (run /coord trust ${resolvedTarget} to trust).`
        : `Target project ${resolvedTarget} has not been trusted yet; using builtin + global configuration (run /coord trust ${resolvedTarget} to enable project-local overrides).`)
    : undefined;
  return { trusted, isOrigin, skippedCustomizations, ...(trustNotice ? { trustNotice } : {}) };
}
