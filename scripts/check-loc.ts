import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MAX_TOTAL_SRC_LINES = 14000;
const MAX_FILE_LINES = 450;
const PRIVATE_OMP_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@oh-my-pi\/[^"']+\/[^"']+["']/;
const RELATIVE_SPECIFIER =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.[^"']+)["']/g;

const ALLOWED_LAYERS: Record<string, ReadonlySet<string>> = {
  core: new Set(["core"]),
  roles: new Set(["core", "roles"]),
  jobs: new Set(["core", "jobs"]),
  flow: new Set(["core", "roles", "jobs", "flow"]),
  ui: new Set(["core", "roles", "flow", "ui"]),
  omp: new Set(["core", "roles", "jobs", "flow", "ui", "omp"]),
};

const srcDir = path.resolve(import.meta.dir, "..", "src");
const allowLegacyFlat = process.env.ALLOW_LEGACY_FLAT === "1";

function collectTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        results.push(path.relative(srcDir, fullPath).replaceAll(path.sep, "/"));
      }
    }
  };
  walk(dir);
  return results.sort();
}

const files = collectTsFiles(srcDir);
let totalLines = 0;
const violations: string[] = [];

for (const relFile of files) {
  const fullPath = path.join(srcDir, relFile);
  const text = readFileSync(fullPath, "utf8");
  const lines = text.split("\n").length;
  const isRootFile = !relFile.includes("/");
  const isLegacyFlat = isRootFile && relFile !== "entry.ts";

  if (!allowLegacyFlat || !isLegacyFlat) {
    totalLines += lines;
  }

  if (PRIVATE_OMP_IMPORT.test(text)) {
    violations.push(`${relFile}: contains forbidden private @oh-my-pi/* subpath import`);
  }

  if (isRootFile) {
    if (relFile !== "entry.ts") {
      if (!allowLegacyFlat) {
        violations.push(`${relFile}: stray root file in src/ (only src/entry.ts is allowed)`);
      }
    } else if (!allowLegacyFlat && lines > MAX_FILE_LINES) {
      violations.push(`${relFile}: ${lines} lines exceeds per-file limit (${MAX_FILE_LINES})`);
    }
  } else {
    const layer = relFile.split("/", 1)[0]!;
    const allowedTargets = ALLOWED_LAYERS[layer];
    if (!allowedTargets) {
      violations.push(`${relFile}: unknown architecture layer "${layer}"`);
    } else {
      if (lines > MAX_FILE_LINES) {
        violations.push(`${relFile}: ${lines} lines exceeds per-file limit (${MAX_FILE_LINES})`);
      }
      for (const match of text.matchAll(RELATIVE_SPECIFIER)) {
        const spec = match[1]!;
        const resolved = path.resolve(path.dirname(fullPath), spec);
        const targetRel = path.relative(srcDir, resolved).replaceAll(path.sep, "/");
        if (targetRel.startsWith("..")) {
          violations.push(`${relFile}: relative import escapes src/ (${spec})`);
          continue;
        }
        if (!targetRel.includes("/")) {
          violations.push(`${relFile}: layer "${layer}" cannot import root file "${targetRel}"`);
          continue;
        }
        const targetLayer = targetRel.split("/", 1)[0]!;
        if (!allowedTargets.has(targetLayer)) {
          violations.push(`${relFile}: forbidden layer import "${layer}" -> "${targetLayer}" (${spec})`);
        }
      }
    }
  }

  console.log(`  ${relFile.padEnd(32)} ${String(lines).padStart(4)} lines`);
}

console.log(`Total src/ lines: ${totalLines} / ${MAX_TOTAL_SRC_LINES} (max per file: ${MAX_FILE_LINES})`);

if (totalLines > MAX_TOTAL_SRC_LINES) {
  violations.push(`Total src/ line count (${totalLines}) exceeds budget (${MAX_TOTAL_SRC_LINES})`);
}

if (violations.length > 0) {
  for (const v of violations) console.error(`ERROR: ${v}`);
  process.exit(1);
}
