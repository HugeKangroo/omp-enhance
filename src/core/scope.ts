import { matchesGlobList, normalizeRelPath } from "./fs.ts";
import { isRoleReadOnly } from "./policy.ts";
import type { RoleSpec } from "./types.ts";

const GLOB_META = /[*?[\]{}]/;
const ROOT_EXT_GLOB_RE = /^(?:\*\*\/)?\*(\.[a-zA-Z0-9_-]+)$/;

export function staticPrefixOfGlob(raw: string): string {
  const norm = normalizeRelPath(raw.trim()).replace(/\/+$/, "");
  if (!norm || norm === ".") return "";
  const segs: string[] = [];
  for (const seg of norm.split("/")) {
    if (GLOB_META.test(seg)) break;
    segs.push(seg);
  }
  return segs.join("/");
}

function synthesizeProbePaths(rawGlob: string): string[] {
  const norm = normalizeRelPath(rawGlob.trim()).replace(/\/+$/, "");
  if (!norm || norm === ".") return ["__probe__"];
  const segs = norm.split("/").filter(Boolean);
  const concrete = segs
    .map((seg) =>
      seg === "**"
        ? "__sub__"
        : seg
            .replace(/\{([^,}]+)(?:,[^}]*)?\}/g, "$1")
            .replace(/\*\*/g, "__sub__")
            .replace(/[*?]/g, "x")
            .replace(/\[[^\]]*\]/g, "x"),
    )
    .join("/");
  const prefix = staticPrefixOfGlob(norm);
  const probes = new Set<string>([concrete]);
  if (norm.endsWith("/**") || norm.endsWith("/*")) {
    probes.add(prefix ? `${prefix}/__probe__.ts` : "__probe__.ts");
    probes.add(prefix ? `${prefix}/__sub__/__probe__.ts` : "__sub__/__probe__.ts");
  } else if (!GLOB_META.test(norm)) {
    probes.add(norm);
  }
  return [...probes];
}

function isDisjointRootExtension(a: string, b: string): boolean {
  const ma = ROOT_EXT_GLOB_RE.exec(a);
  const mb = ROOT_EXT_GLOB_RE.exec(b);
  return Boolean(ma && mb && ma[1]!.toLowerCase() !== mb[1]!.toLowerCase());
}

export function singleGlobsMayOverlap(rawA: string, rawB: string): boolean {
  const a = normalizeRelPath(rawA.trim()).replace(/\/+$/, "");
  const b = normalizeRelPath(rawB.trim()).replace(/\/+$/, "");
  if (!a || !b) return true;
  if (a === b) return true;
  if (!GLOB_META.test(a) && !GLOB_META.test(b)) {
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  }
  if (!GLOB_META.test(a)) return matchesGlobList(a, [b]) || matchesGlobList(`${a}/__probe__`, [b]);
  if (!GLOB_META.test(b)) return matchesGlobList(b, [a]) || matchesGlobList(`${b}/__probe__`, [a]);

  const preA = staticPrefixOfGlob(a);
  const preB = staticPrefixOfGlob(b);
  if (preA && preB) {
    if (preA !== preB && !preA.startsWith(`${preB}/`) && !preB.startsWith(`${preA}/`)) return false;
  }
  if (!preA && !preB && isDisjointRootExtension(a, b)) return false;
  return true;
}

/**
 * Conservative static overlap check between two writable glob sets.
 * `undefined` denotes unrestricted write access; `[]` denotes read-only.
 */
export function globScopesMayOverlap(
  globsA: readonly string[] | undefined,
  globsB: readonly string[] | undefined,
): boolean {
  if (globsA !== undefined && globsA.length === 0) return false;
  if (globsB !== undefined && globsB.length === 0) return false;
  if (globsA === undefined || globsB === undefined) return true;
  for (const a of globsA) {
    for (const b of globsB) {
      if (singleGlobsMayOverlap(a, b)) return true;
    }
  }
  return false;
}

export function isGlobContainedIn(narrowGlob: string, parentGlobs: readonly string[]): boolean {
  const norm = normalizeRelPath(narrowGlob.trim()).replace(/\/+$/, "");
  if (!norm || norm === ".") return false;
  if (parentGlobs.some((p) => normalizeRelPath(p.trim()) === "**" || normalizeRelPath(p.trim()) === norm)) {
    return true;
  }
  const probes = synthesizeProbePaths(norm);
  if (!probes.every((p) => matchesGlobList(p, parentGlobs))) return false;
  const narrowPre = staticPrefixOfGlob(norm);
  if (!narrowPre) {
    return parentGlobs.some((p) => {
      const pNorm = normalizeRelPath(p.trim());
      return pNorm === "**" || pNorm === norm || (!staticPrefixOfGlob(pNorm) && probes.every((pr) => matchesGlobList(pr, [pNorm])));
    });
  }
  return parentGlobs.some((p) => {
    const pNorm = normalizeRelPath(p.trim());
    const pPre = staticPrefixOfGlob(pNorm);
    const prefixCompatible = !pPre || narrowPre === pPre || narrowPre.startsWith(`${pPre}/`);
    return prefixCompatible && probes.every((pr) => matchesGlobList(pr, [pNorm]));
  });
}

export function validateScopePattern(raw: string): string | null {
  const trimmed = raw.trim().replaceAll("\\", "/");
  if (!trimmed) return "Writable scope pattern must be non-empty.";
  if (trimmed.startsWith("/") || /^[a-zA-Z]:\//.test(trimmed)) {
    return `Writable scope "${raw}" must be a workspace-relative path/glob.`;
  }
  const segs = normalizeRelPath(trimmed).split("/");
  if (segs.includes("..")) {
    return `Writable scope "${raw}" cannot escape workspace via "..".`;
  }
  return null;
}

export function narrowRolePermissions(
  role: RoleSpec,
  writableScope?: readonly string[],
): { ok: true; role: RoleSpec } | { ok: false; reason: string } {
  if (!writableScope || writableScope.length === 0) return { ok: true, role };
  if (isRoleReadOnly(role)) {
    return {
      ok: false,
      reason: `Cannot attach writableScope [${writableScope.join(", ")}] to read-only role "${role.id}".`,
    };
  }
  const normalized: string[] = [];
  const protectedGlobs = role.permissions.protected ?? [];
  const baseWritable = role.permissions.writable;

  for (const raw of writableScope) {
    const err = validateScopePattern(raw);
    if (err) return { ok: false, reason: err };
    const norm = normalizeRelPath(raw.trim()).replace(/\/+$/, "");
    for (const pGlob of protectedGlobs) {
      if (singleGlobsMayOverlap(norm, pGlob)) {
        return {
          ok: false,
          reason: `Writable scope "${norm}" overlaps protected path "${pGlob}" on role "${role.id}".`,
        };
      }
    }
    if (baseWritable !== undefined && !isGlobContainedIn(norm, baseWritable)) {
      return {
        ok: false,
        reason: `Writable scope "${norm}" exceeds base writable permissions [${baseWritable.join(", ")}] of role "${role.id}".`,
      };
    }
    normalized.push(norm);
  }

  return {
    ok: true,
    role: {
      ...role,
      permissions: {
        ...role.permissions,
        writable: normalized,
      },
    },
  };
}

export function resolveEffectiveWritableScope(
  role: RoleSpec,
  writableScope?: readonly string[],
): readonly string[] | undefined {
  if (isRoleReadOnly(role)) return [];
  if (writableScope && writableScope.length > 0) {
    return writableScope.map((g) => normalizeRelPath(g.trim()).replace(/\/+$/, ""));
  }
  return role.permissions.writable;
}
