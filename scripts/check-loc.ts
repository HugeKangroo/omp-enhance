import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MAX_TOTAL_SRC_LINES = 2700;
const PRIVATE_OMP_IMPORT = /from\s+["']@oh-my-pi\/[^"']+\/[^"']+["']|import\s*\(\s*["']@oh-my-pi\/[^"']+\/[^"']+["']\s*\)/;

const srcDir = path.resolve(import.meta.dir, "..", "src");
const files = existsSync(srcDir)
  ? readdirSync(srcDir)
      .filter((f) => f.endsWith(".ts"))
      .sort()
  : [];

let totalLines = 0;
const violations: string[] = [];

for (const file of files) {
  const fullPath = path.join(srcDir, file);
  const text = readFileSync(fullPath, "utf8");
  const lines = text.split("\n").length;
  totalLines += lines;
  if (PRIVATE_OMP_IMPORT.test(text)) {
    violations.push(`${file}: contains forbidden private @oh-my-pi/* subpath import`);
  }
  console.log(`  ${file.padEnd(24)} ${String(lines).padStart(4)} lines`);
}

console.log(`Total src/ lines: ${totalLines} / ${MAX_TOTAL_SRC_LINES}`);

if (totalLines > MAX_TOTAL_SRC_LINES) {
  violations.push(`Total src/ line count (${totalLines}) exceeds budget (${MAX_TOTAL_SRC_LINES})`);
}

if (violations.length > 0) {
  for (const v of violations) console.error(`ERROR: ${v}`);
  process.exit(1);
}
