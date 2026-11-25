import {
  closeSync, existsSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync,
} from "node:fs";
import path from "node:path";
import type { RolePermissions } from "./types.ts";

export type SnapshotDigestKind = "sha256" | "stat_fingerprint" | "symlink";
export interface SnapshotEntry { sha256: string; byteSize: number; digestKind?: SnapshotDigestKind }

export interface SnapshotWorkspaceOptions {
  includeGlobs?: readonly string[];
  respectGitignore?: boolean;
  extraSkipDirs?: readonly string[];
  maxStreamHashBytes?: number;
  maxFullHashBytes?: number;
}

export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git", "node_modules", ".omp-enhance", ".omp", ".venv", "venv",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  "target", "dist", "build", ".next", ".turbo",
]);

export const MAX_STREAM_HASH_BYTES = 512 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;
const sharedChunkBuf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
const RACILY_CLEAN_WINDOW_MS = 2_000;
const MAX_HASH_CACHE_SIZE = 50_000;
const MAX_GLOB_CACHE_SIZE = 2_048;

interface CachedFileHash {
  dev: number; ino: number; mtimeMs: number; ctimeMs: number; size: number; sha256: string;
}

interface ParsedGitignore {
  mtimeMs: number; size: number;
  ignoreGlobs: string[]; dirOnlyGlobs: string[]; negateGlobs: string[];
}

const fileHashCache = new Map<string, CachedFileHash>();
const compiledGlobCache = new Map<string, Bun.Glob | null>();
const gitignoreCache = new Map<string, ParsedGitignore>();

export function normalizeRelPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
}

/** Split comma-separated glob strings only at commas outside `{...}` brace groups. */
export function splitBraceSafeGlobs(raw: string): string[] {
  const results: string[] = [];
  let current = "";
  let braceDepth = 0;
  for (const ch of raw) {
    if (ch === "{") { braceDepth += 1; current += ch; }
    else if (ch === "}") { braceDepth = Math.max(0, braceDepth - 1); current += ch; }
    else if (ch === "," && braceDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) results.push(trimmed);
      current = "";
    } else current += ch;
  }
  const tail = current.trim();
  if (tail) results.push(tail);
  return results;
}

function getCompiledGlob(pattern: string): Bun.Glob | null {
  const existing = compiledGlobCache.get(pattern);
  if (existing !== undefined) return existing;
  if (compiledGlobCache.size >= MAX_GLOB_CACHE_SIZE) {
    const oldest = compiledGlobCache.keys().next().value;
    if (oldest !== undefined) compiledGlobCache.delete(oldest);
  }
  try {
    const compiled = new Bun.Glob(pattern);
    compiledGlobCache.set(pattern, compiled);
    return compiled;
  } catch {
    compiledGlobCache.set(pattern, null);
    return null;
  }
}

export function matchesGlobList(relPath: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return false;
  const normalized = normalizeRelPath(relPath);
  for (const rawPattern of globs) {
    if (getCompiledGlob(rawPattern)?.match(normalized)) return true;
  }
  return false;
}

function expandGitignoreRule(rawRule: string): { globs: string[]; dirGlobs: string[] } {
  let rule = rawRule;
  const dirOnly = rule.endsWith("/");
  if (dirOnly) rule = rule.replace(/\/+$/, "");
  const anchored = rule.startsWith("/");
  if (anchored) rule = rule.replace(/^\/+/, "");
  if (!rule) return { globs: [], dirGlobs: [] };

  const bases = anchored || rule.includes("/") ? [rule] : [rule, `**/${rule}`];
  const globs: string[] = [];
  const dirGlobs: string[] = [];
  for (const base of bases) {
    if (dirOnly) { dirGlobs.push(base); globs.push(`${base}/**`); }
    else globs.push(base, `${base}/**`);
  }
  return { globs, dirGlobs };
}

function loadRootGitignore(cwd: string): ParsedGitignore | null {
  const gitignorePath = path.join(cwd, ".gitignore");
  if (!existsSync(gitignorePath)) return null;
  try {
    const st = statSync(gitignorePath);
    const cached = gitignoreCache.get(gitignorePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;

    const raw = readFileSync(gitignorePath, "utf8");
    const ignoreGlobs: string[] = [];
    const dirOnlyGlobs: string[] = [];
    const negateGlobs: string[] = [];
    for (const rawLine of raw.replace(/\r\n/g, "\n").split("\n")) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const isNegated = trimmed.startsWith("!");
      const body = isNegated ? trimmed.slice(1).trim() : trimmed;
      if (!body) continue;
      const expanded = expandGitignoreRule(body);
      if (isNegated) negateGlobs.push(...expanded.globs, ...expanded.dirGlobs);
      else { ignoreGlobs.push(...expanded.globs); dirOnlyGlobs.push(...expanded.dirGlobs); }
    }
    const parsed: ParsedGitignore = { mtimeMs: st.mtimeMs, size: st.size, ignoreGlobs, dirOnlyGlobs, negateGlobs };
    gitignoreCache.set(gitignorePath, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function isIgnoredByGitignore(relPath: string, isDir: boolean, gi: ParsedGitignore | null): boolean {
  if (!gi) return false;
  const matched = matchesGlobList(relPath, gi.ignoreGlobs) || (isDir && matchesGlobList(relPath, gi.dirOnlyGlobs));
  if (!matched) return false;
  return !(gi.negateGlobs.length > 0 && matchesGlobList(relPath, gi.negateGlobs));
}

export function hashFileSync(
  fullPath: string,
  maxStreamHashBytes = MAX_STREAM_HASH_BYTES,
  nowMs = Date.now(),
): SnapshotEntry | null {
  let st;
  try {
    st = statSync(fullPath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (st.size > maxStreamHashBytes) {
    return { sha256: `stat:${st.size}:${Math.trunc(st.mtimeMs)}`, byteSize: st.size, digestKind: "stat_fingerprint" };
  }
  const cached = fileHashCache.get(fullPath);
  const racilyCleanSafe =
    nowMs - st.mtimeMs >= RACILY_CLEAN_WINDOW_MS && nowMs - st.ctimeMs >= RACILY_CLEAN_WINDOW_MS;
  if (
    racilyCleanSafe && cached && cached.dev === st.dev && cached.ino === st.ino &&
    cached.mtimeMs === st.mtimeMs && cached.ctimeMs === st.ctimeMs && cached.size === st.size
  ) {
    return { sha256: cached.sha256, byteSize: st.size, digestKind: "sha256" };
  }

  let fd: number | null = null;
  try {
    fd = openSync(fullPath, "r");
    const hasher = new Bun.CryptoHasher("sha256");
    let totalRead = 0;
    while (true) {
      const bytesRead = readSync(fd, sharedChunkBuf, 0, STREAM_CHUNK_BYTES, totalRead);
      if (bytesRead <= 0) break;
      hasher.update(sharedChunkBuf.subarray(0, bytesRead));
      totalRead += bytesRead;
      if (totalRead > maxStreamHashBytes) {
        return { sha256: `stat:${totalRead}:${Math.trunc(st.mtimeMs)}`, byteSize: totalRead, digestKind: "stat_fingerprint" };
      }
    }
    const sha256 = hasher.digest("hex");
    if (fileHashCache.size >= MAX_HASH_CACHE_SIZE) {
      const oldest = fileHashCache.keys().next().value;
      if (oldest !== undefined) fileHashCache.delete(oldest);
    }
    fileHashCache.set(fullPath, {
      dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: totalRead, sha256,
    });
    return { sha256, byteSize: totalRead, digestKind: "sha256" };
  } catch {
    if (!existsSync(fullPath)) return null;
    return { sha256: `stat:${st.size}:${Math.trunc(st.mtimeMs)}`, byteSize: st.size, digestKind: "stat_fingerprint" };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function snapshotWorkspace(
  cwd: string,
  includeOrOptions?: readonly string[] | SnapshotWorkspaceOptions,
): Map<string, SnapshotEntry> {
  const opts: SnapshotWorkspaceOptions = Array.isArray(includeOrOptions)
    ? { includeGlobs: includeOrOptions }
    : ((includeOrOptions as SnapshotWorkspaceOptions | undefined) ?? {});
  const includeGlobs = opts.includeGlobs;
  const maxStreamHashBytes = opts.maxStreamHashBytes ?? opts.maxFullHashBytes ?? MAX_STREAM_HASH_BYTES;
  const extraSkips = opts.extraSkipDirs?.length ? new Set(opts.extraSkipDirs) : null;
  const gitignore = opts.respectGitignore !== false ? loadRootGitignore(cwd) : null;
  const nowMs = Date.now();
  const snapshot = new Map<string, SnapshotEntry>();

  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const relPath = normalizeRelPath(path.relative(cwd, fullPath));
        if (isIgnoredByGitignore(relPath, false, gitignore)) continue;
        if (includeGlobs && !matchesGlobList(relPath, includeGlobs)) continue;
        try {
          const target = readlinkSync(fullPath);
          snapshot.set(relPath, { sha256: `symlink:${target}`, byteSize: Buffer.byteLength(target), digestKind: "symlink" });
        } catch {}
      } else if (entry.isDirectory()) {
        if (DEFAULT_SKIP_DIRS.has(entry.name) || extraSkips?.has(entry.name)) continue;
        const relDir = normalizeRelPath(path.relative(cwd, fullPath));
        if (gitignore && gitignore.negateGlobs.length === 0 && isIgnoredByGitignore(relDir, true, gitignore)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const relPath = normalizeRelPath(path.relative(cwd, fullPath));
        if (isIgnoredByGitignore(relPath, false, gitignore)) continue;
        if (includeGlobs && !matchesGlobList(relPath, includeGlobs)) continue;
        const hashed = hashFileSync(fullPath, maxStreamHashBytes, nowMs);
        if (hashed) snapshot.set(relPath, hashed);
      }
    }
  };

  walk(cwd);
  return snapshot;
}

/** Compute a deterministic 64-hex SHA-256 fingerprint over a workspace snapshot. */
export function computeSnapshotFingerprint(snapshot: ReadonlyMap<string, SnapshotEntry>): string {
  const hasher = new Bun.CryptoHasher("sha256");
  const sortedPaths = [...snapshot.keys()].sort();
  for (const relPath of sortedPaths) {
    const entry = snapshot.get(relPath)!;
    hasher.update(`${relPath}\0${entry.sha256}\n`);
  }
  return hasher.digest("hex");
}

export function computeWorkspaceFingerprint(cwd: string, options?: SnapshotWorkspaceOptions): string {
  return computeSnapshotFingerprint(snapshotWorkspace(cwd, options));
}

/** Hash `.omp/plugin-overrides.json`, `.omp/roles/**`, and legacy `.omp/enhance.y*ml` for tamper detection. */
export function snapshotConfigIntegrity(cwd: string): Map<string, SnapshotEntry> {
  const integrity = new Map<string, SnapshotEntry>();
  const nowMs = Date.now();
  for (const relFile of [".omp/plugin-overrides.json", ".omp/enhance.yaml", ".omp/enhance.yml"]) {
    const full = path.join(cwd, relFile);
    if (!existsSync(full)) continue;
    try {
      const target = readlinkSync(full);
      integrity.set(relFile, { sha256: `symlink:${target}`, byteSize: Buffer.byteLength(target), digestKind: "symlink" });
      continue;
    } catch {}
    const hashed = hashFileSync(full, MAX_STREAM_HASH_BYTES, nowMs);
    if (hashed) integrity.set(relFile, hashed);
  }

  const rolesDir = path.join(cwd, ".omp", "roles");
  const walkRoles = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = normalizeRelPath(path.relative(cwd, full));
      if (entry.isSymbolicLink()) {
        try {
          const target = readlinkSync(full);
          integrity.set(rel, { sha256: `symlink:${target}`, byteSize: Buffer.byteLength(target), digestKind: "symlink" });
        } catch {}
      } else if (entry.isDirectory()) walkRoles(full);
      else if (entry.isFile()) {
        const hashed = hashFileSync(full, MAX_STREAM_HASH_BYTES, nowMs);
        if (hashed) integrity.set(rel, hashed);
      }
    }
  };
  if (existsSync(rolesDir)) walkRoles(rolesDir);
  return integrity;
}

export function diffSnapshots(
  before: ReadonlyMap<string, SnapshotEntry>,
  after: ReadonlyMap<string, SnapshotEntry>,
): { added: string[]; modified: string[]; deleted: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [relPath, entry] of after) {
    const previous = before.get(relPath);
    if (!previous) added.push(relPath);
    else if (previous.sha256 !== entry.sha256) modified.push(relPath);
  }
  for (const relPath of before.keys()) {
    if (!after.has(relPath)) deleted.push(relPath);
  }
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

function tryRealpath(target: string): string {
  try { return realpathSync(target); } catch { return path.resolve(target); }
}

/** Resolve symlinks on existing target or its nearest existing ancestor directory. */
export function resolveSafeTargetRealpath(
  cwd: string,
  targetPath: string,
): { resolvedPath: string; relPath: string; escapesWorkspace: boolean } {
  const realCwd = tryRealpath(path.resolve(cwd));
  const lexicalTarget = path.resolve(realCwd, targetPath);

  const missingSegments: string[] = [];
  let probe = lexicalTarget;
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    missingSegments.unshift(path.basename(probe));
    probe = parent;
  }

  const realAnchor = existsSync(probe) ? tryRealpath(probe) : probe;
  const resolvedPath = missingSegments.length > 0 ? path.join(realAnchor, ...missingSegments) : realAnchor;
  const rawRel = path.relative(realCwd, resolvedPath).replaceAll("\\", "/");
  const escapesWorkspace = rawRel === ".." || rawRel.startsWith("../") || path.isAbsolute(rawRel);
  return { resolvedPath, relPath: normalizeRelPath(rawRel), escapesWorkspace };
}

export interface FindBoundaryViolationsInput {
  cwd: string;
  before: ReadonlyMap<string, SnapshotEntry>;
  after?: ReadonlyMap<string, SnapshotEntry>;
  permissions: RolePermissions;
  beforeIntegrity?: ReadonlyMap<string, SnapshotEntry> | null;
  afterIntegrity?: ReadonlyMap<string, SnapshotEntry> | null;
}

export function findBoundaryViolations(input: FindBoundaryViolationsInput): string[] {
  const violations = new Set<string>();
  if (input.beforeIntegrity) {
    const afterInt = input.afterIntegrity ?? snapshotConfigIntegrity(input.cwd);
    const intDiff = diffSnapshots(input.beforeIntegrity, afterInt);
    for (const p of [...intDiff.added, ...intDiff.modified, ...intDiff.deleted]) violations.add(p);
  }

  const protectedGlobs = input.permissions.protected ?? [];
  const writableGlobs = input.permissions.writable;
  if (protectedGlobs.length === 0 && writableGlobs === undefined) return [...violations].sort();

  const after = input.after ?? snapshotWorkspace(input.cwd);
  const diff = diffSnapshots(input.before, after);
  for (const relPath of [...diff.added, ...diff.modified, ...diff.deleted]) {
    if (protectedGlobs.length > 0 && matchesGlobList(relPath, protectedGlobs)) {
      violations.add(relPath);
      continue;
    }
    if (writableGlobs !== undefined && (writableGlobs.length === 0 || !matchesGlobList(relPath, writableGlobs))) {
      violations.add(relPath);
    }
  }
  return [...violations].sort();
}

export function findProtectedViolations(
  cwd: string,
  before: ReadonlyMap<string, SnapshotEntry>,
  protectedGlobs: readonly string[],
  after?: ReadonlyMap<string, SnapshotEntry>,
): string[] {
  if (protectedGlobs.length === 0) return [];
  const diff = diffSnapshots(before, after ?? snapshotWorkspace(cwd));
  return [...diff.added, ...diff.modified, ...diff.deleted]
    .filter((relPath) => matchesGlobList(relPath, protectedGlobs))
    .sort();
}
