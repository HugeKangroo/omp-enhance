import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const defaultOmp = path.join(homedir(), ".local", "bin", "omp");
const ompBin = process.env.OMP_COMMAND ?? (existsSync(defaultOmp) ? defaultOmp : "omp");
const projectRoot = path.resolve(import.meta.dir, "..");
const extPath = path.join(projectRoot, "scripts", "phase0-probe-ext.ts");
const tempDir = mkdtempSync(path.join(tmpdir(), "omp-enhance-p0-"));
const outPath = path.join(tempDir, "probe-report.json");

try {
  const ver = spawnSync(ompBin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (ver.status !== 0) {
    throw new Error(`Failed to run ${ompBin} --version: ${ver.stderr || ver.error?.message}`);
  }

  const run = spawnSync(
    ompBin,
    [
      "--cwd",
      tempDir,
      "--no-extensions",
      "--extension",
      extPath,
      "--no-session",
      "--print",
      "/phase0-verify",
    ],
    {
      env: { ...process.env, OMP_ENHANCE_PROBE_OUT: outPath },
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  if (run.status !== 0) {
    throw new Error(`OMP probe exited with ${run.status}:\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  }
  if (!existsSync(outPath)) {
    throw new Error(`Probe report was not written at ${outPath}.\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  }

  const report = JSON.parse(readFileSync(outPath, "utf8"));
  console.log(
    JSON.stringify(
      {
        ompVersion: ver.stdout.trim(),
        probe: report,
      },
      null,
      2,
    ),
  );

  if (!report.ok) {
    process.exit(1);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
