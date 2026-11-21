import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { snapshotWorkspace } from "../src/core/fs.ts";
import { EnhanceStore } from "../src/core/store.ts";
import type { HandoffEnvelope } from "../src/core/types.ts";

const repoRoot = path.resolve(import.meta.dir, "..");
const defaultOmp = path.join(homedir(), ".local", "bin", "omp");
const ompBin = process.env.OMP_BIN ?? process.env.OMP_COMMAND ?? (existsSync(defaultOmp) ? defaultOmp : "omp");
const workspace = mkdtempSync(path.join(tmpdir(), "omp-enhance-e2e-"));
const controlDir = mkdtempSync(path.join(tmpdir(), "omp-enhance-e2e-out-"));
const globalRolesDir = path.join(workspace, "global-roles");
const extensionArgs = [
  "--extension", repoRoot,
  "--cwd", workspace,
  "--no-session", "--no-skills", "--no-rules", "--no-context-files",
  "--no-lsp", "--no-extensions", "--no-title", "--auto-approve",
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function outputPath(name: string): string {
  return path.join(controlDir, `${name}.out`);
}

function env(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    OMP_ENHANCE_CMD_OUT: outputPath("current"),
    OMP_ENHANCE_GLOBAL_ROLES_DIR: globalRolesDir,
    OMP_ENHANCE_PLUGIN_LOCK_PATH: path.join(workspace, "omp-plugins.lock.json"),
  };
}

function runPrintCommand(command: string, label: string): string {
  const outPath = outputPath(label);
  rmSync(outPath, { force: true });
  const result = spawnSync(ompBin, ["-p", command, ...extensionArgs], {
    cwd: workspace,
    env: { ...env(), OMP_ENHANCE_CMD_OUT: outPath },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stderr = result.stderr ?? "";
  assert(result.status === 0, `omp ${command} exited ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${stderr}`);
  assert(existsSync(outPath), `omp ${command} produced no command output.\nstdout:\n${result.stdout}\nstderr:\n${stderr}`);
  return readFileSync(outPath, "utf8");
}

interface StatusPayload {
  activeRoleId: string | null;
  roleCount: number;
  settings: {
    defaultRole: string | null;
    supervisorModel: string;
    flowMaxRepairRounds: number;
  };
  activeMandate: { id: string } | null;
}

interface HandoffReport {
  ok: boolean;
  targetRole: string;
  upstreamHandoffId?: string;
  envelope?: HandoffEnvelope;
  status?: string;
  reason?: string;
  error?: string;
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function terminateProcessCleanly(
  proc: ReturnType<typeof Bun.spawn>,
  graceMs = 5_000,
  killGraceMs = 2_000,
): Promise<{ exitCode: number | null; forcedTermination: boolean }> {
  if (proc.exitCode !== null) return { exitCode: proc.exitCode, forcedTermination: false };

  const natural = await waitWithTimeout(proc.exited, graceMs);
  if (!natural.timedOut) return { exitCode: natural.value, forcedTermination: false };

  try { proc.kill("SIGTERM"); } catch {}
  const afterTerm = await waitWithTimeout(proc.exited, killGraceMs);
  if (!afterTerm.timedOut) return { exitCode: afterTerm.value, forcedTermination: true };

  try { proc.kill("SIGKILL"); } catch {}
  const afterKill = await waitWithTimeout(proc.exited, killGraceMs);
  return { exitCode: afterKill.timedOut ? proc.exitCode : afterKill.value, forcedTermination: true };
}

async function runHandoff(): Promise<HandoffReport> {
  const outPath = outputPath("handoff");
  rmSync(outPath, { force: true });
  const proc = Bun.spawn({
    cmd: [ompBin, "--mode", "rpc", "--no-ui", ...extensionArgs],
    cwd: workspace,
    env: { ...env(), OMP_ENHANCE_CMD_OUT: outPath },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  try {
    proc.stdin.write(`${JSON.stringify({ id: "handoff", type: "prompt", message: "/enhance-handoff reviewer" })}\n`);
    await proc.stdin.flush();

    const deadline = Date.now() + 300_000;
    while (!existsSync(outPath) && Date.now() < deadline && proc.exitCode === null) {
      await Bun.sleep(200);
    }
    const timedOut = !existsSync(outPath);
    try { proc.stdin.end(); } catch {}
    if (timedOut) {
      try { proc.kill("SIGTERM"); } catch {}
    }

    const { exitCode, forcedTermination } = await terminateProcessCleanly(proc, timedOut ? 2_000 : 10_000, 2_000);
    const [stdoutRes, stderrRes] = await Promise.all([
      waitWithTimeout(stdoutPromise, 1_500),
      waitWithTimeout(stderrPromise, 1_500),
    ]);
    const stdout = stdoutRes.timedOut ? "" : stdoutRes.value;
    const stderr = stderrRes.timedOut ? "" : stderrRes.value;

    assert(!timedOut, `Live /enhance-handoff reviewer timed out.\nstdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`);
    assert(
      exitCode === 0 || forcedTermination,
      `RPC /enhance-handoff exited ${exitCode}.\nstdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`,
    );
    return JSON.parse(readFileSync(outPath, "utf8")) as HandoffReport;
  } finally {
    if (proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch {}
    }
  }
}

async function main(): Promise<void> {
  assert(existsSync(ompBin), `omp binary not found at ${ompBin}`);
  console.log(`workspace: ${workspace}`);
  mkdirSync(globalRolesDir, { recursive: true });
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  writeFileSync(
    path.join(workspace, "src", "math.ts"),
    "export const add = (a: number, b: number): number => a + b;\n",
    "utf8",
  );

  const createOutput = runPrintCommand("/role create custom-auditor --project Check edge cases", "role-create");
  const rolePath = path.join(workspace, ".omp", "roles", "custom-auditor.yaml");
  assert(existsSync(rolePath), `Expected ${rolePath} to exist.\nOutput:\n${createOutput}`);
  assert(readFileSync(rolePath, "utf8").includes("id: custom-auditor"), "Created role YAML is missing its id.");
  assert(createOutput.includes('Created role "custom-auditor" [project]'), `Unexpected /role create output:\n${createOutput}`);
  console.log("ok: /role create wrote .omp/roles/custom-auditor.yaml");

  const status = JSON.parse(runPrintCommand("/enhance-status", "status")) as StatusPayload;
  assert(status.activeRoleId === "general", `Expected activeRoleId general, got ${status.activeRoleId}`);
  assert(status.roleCount === 9, `Expected roleCount 9, got ${status.roleCount}`);
  assert(status.settings.supervisorModel === "@advisor", `Expected default supervisorModel @advisor, got ${status.settings.supervisorModel}`);
  console.log("ok: /enhance-status reports activeRoleId=general roleCount=9 supervisorModel=@advisor");

  const overridePath = path.join(workspace, ".omp", "plugin-overrides.json");
  writeFileSync(
    overridePath,
    JSON.stringify({ settings: { "omp-enhance": { flowMaxRepairRounds: 4, supervisorModel: "@smol" } } }),
    "utf8",
  );
  const overriddenStatus = JSON.parse(runPrintCommand("/enhance-status", "status-override")) as StatusPayload;
  assert(overriddenStatus.settings.flowMaxRepairRounds === 4, "Expected overridden flowMaxRepairRounds=4");
  assert(overriddenStatus.settings.supervisorModel === "@smol", "Expected overridden supervisorModel=@smol");
  rmSync(overridePath, { force: true });
  console.log("ok: native plugin settings override (.omp/plugin-overrides.json) dynamically applied");

  const store = new EnhanceStore(path.join(workspace, ".omp-enhance", "state.sqlite"));
  try {
    const mandate = store.upsertMandate({
      goal: "Verify src/math.ts add()",
      constraints: ["Reviewer must not modify project files"],
      acceptance: ["Reviewer reads src/math.ts and submits a verified handoff"],
    });
    store.addEpistemicItem({
      mandateId: mandate.id,
      kind: "fact",
      statement: "src/math.ts defines add(a, b) as a + b",
      evidenceRef: "src/math.ts",
    });
  } finally {
    store.close();
  }
  console.log("seeded: active mandate + epistemic fact");

  const before = snapshotWorkspace(workspace);
  const beforeMathHash = createHash("sha256")
    .update(readFileSync(path.join(workspace, "src", "math.ts")))
    .digest("hex");
  const report = await runHandoff();
  assert(report.ok, `Live /enhance-handoff reviewer failed: ${report.error ?? report.reason ?? "unknown"}\nReport: ${JSON.stringify(report, null, 2)}`);
  assert(report.targetRole === "reviewer", `Expected reviewer target, got ${report.targetRole}`);
  console.log(`ok: live /enhance-handoff reviewer submitted envelope ${report.envelope?.id ?? "(missing id)"} verdict=${report.envelope?.verdict}`);

  const after = snapshotWorkspace(workspace);
  assert(
    createHash("sha256").update(readFileSync(path.join(workspace, "src", "math.ts"))).digest("hex") === beforeMathHash,
    "Reviewer modified src/math.ts.",
  );
  const beforePaths = [...before.keys()].sort();
  const afterPaths = [...after.keys()].sort();
  assert(JSON.stringify(beforePaths) === JSON.stringify(afterPaths), `Reviewer changed workspace files:\n${beforePaths.join("\n")}\n---\n${afterPaths.join("\n")}`);
  for (const relPath of beforePaths) {
    assert(before.get(relPath)?.sha256 === after.get(relPath)?.sha256, `Reviewer modified ${relPath}.`);
  }
  console.log("ok: reviewer modified no workspace files");

  const verifyStore = new EnhanceStore(path.join(workspace, ".omp-enhance", "state.sqlite"));
  try {
    const reviewerHandoff = verifyStore.listHandoffs().find((handoff) => handoff.fromRole === "reviewer");
    assert(reviewerHandoff, "No reviewer HandoffEnvelope was persisted.");
    assert(reviewerHandoff!.mandateId === verifyStore.getActiveMandate()?.id, "Reviewer handoff is not bound to the active mandate.");
    console.log(`ok: reviewer envelope persisted (verdict=${reviewerHandoff!.verdict}, artifacts=${reviewerHandoff!.artifacts.length})`);
  } finally {
    verifyStore.close();
  }

  console.log("PASS: live OMP extension E2E");
}

try {
  await main();
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (process.env.OMP_ENHANCE_KEEP_E2E === "1") {
    console.log(`kept workspace: ${workspace}`);
  } else {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
}
