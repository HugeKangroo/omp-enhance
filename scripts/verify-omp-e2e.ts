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
const dbPath = path.join(workspace, ".omp-enhance", "state.sqlite");
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
    OMP_ENHANCE_HOME: path.join(workspace, "enhance-home"),
    OMP_ENHANCE_GLOBAL_ROLES_DIR: globalRolesDir,
    OMP_ENHANCE_PLUGIN_LOCK_PATH: path.join(workspace, "omp-plugins.lock.json"),
  };
}

function isCoordActiveText(text: string): boolean {
  return /Active role:\s*coordinator\b/.test(text) || /总秘书模式已开启|总秘书模式已在运行中|已在总秘书模式|当前模式:\s*coordinator/.test(text);
}

function isCoordOffText(text: string): boolean {
  return /Active role:\s*off\b/.test(text) || /退回标准|已关闭总秘书|当前模式:\s*off\b/.test(text);
}

function hasVisibleRoleCount(text: string, count: number): boolean {
  return (
    text.includes(`Visible roles: ${count} (`) ||
    new RegExp(`(?:Visible roles|可见角色|可用角色|专员编制)[:：]\\s*${count}\\b`).test(text)
  );
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

function findPersistedReviewerHandoff(): HandoffEnvelope | null {
  if (!existsSync(dbPath)) return null;
  const store = new EnhanceStore(dbPath);
  try {
    return store.listHandoffs().find((h) => h.fromRole === "reviewer") ?? null;
  } catch {
    return null;
  } finally {
    store.close();
  }
}

async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
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

async function runSuperAgentRpcFlow(): Promise<{
  reviewerHandoff: HandoffEnvelope;
  extensionCommands: string[];
}> {
  const outPath = outputPath("rpc-coord");
  rmSync(outPath, { force: true });
  const proc = Bun.spawn({
    cmd: [ompBin, "--mode", "rpc", "--no-ui", ...extensionArgs],
    cwd: workspace,
    env: { ...env(), OMP_ENHANCE_CMD_OUT: outPath },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutLines: string[] = [];
  let agentEnds = 0;
  const responseIds = new Set<string>();
  let extensionCommands: string[] = [];

  const stdoutDone = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            stdoutLines.push(line);
            try {
              const ev = JSON.parse(line) as Record<string, unknown>;
              if (ev.type === "agent_end") agentEnds += 1;
              if (ev.type === "response" && typeof ev.id === "string") responseIds.add(ev.id);
              if (ev.type === "available_commands_update" && Array.isArray(ev.commands)) {
                extensionCommands = (ev.commands as Array<{ name?: string; source?: string }>)
                  .filter((c) => c.source === "extension" && typeof c.name === "string" && c.name !== "autoresearch")
                  .map((c) => c.name!)
                  .sort();
              }
            } catch {}
          }
          nl = buffer.indexOf("\n");
        }
      }
    } catch {}
  })();
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  const waitUntil = async (pred: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (!pred() && Date.now() < deadline && proc.exitCode === null) {
      await Bun.sleep(200);
    }
    return pred();
  };

  try {
    // 1. Activate /coord inside live RPC session.
    proc.stdin.write(`${JSON.stringify({ id: "coord-on", type: "prompt", message: "/coord" })}\n`);
    await proc.stdin.flush();
    const activated = await waitUntil(
      () => responseIds.has("coord-on") && existsSync(outPath) && isCoordActiveText(readFileSync(outPath, "utf8")),
      30_000,
    );
    assert(activated, `Failed to activate /coord in RPC session.\nout:\n${existsSync(outPath) ? readFileSync(outPath, "utf8") : "(none)"}`);

    // 2. Ask coordinator to immediately dispatch isolated ["reviewer"] flow via enhance_flow.
    const beforeEnds = agentEnds;
    proc.stdin.write(
      `${JSON.stringify({
        id: "dispatch-1",
        type: "prompt",
        message:
          '无需询问确认，我已批准立即开干：请现在直接调用 enhance_flow 工具（action="start", roles=["reviewer"], goal="核查 src/math.ts 的 add(a, b) 实现是否正确且工作区保持零修改", wait=true）启动 reviewer 检查 src/math.ts，拿到结果后用一句话向我汇报。',
      })}\n`,
    );
    await proc.stdin.flush();

    let reviewerHandoff: HandoffEnvelope | null = null;
    const firstTurnDone = await waitUntil(() => {
      reviewerHandoff = findPersistedReviewerHandoff();
      return agentEnds > beforeEnds && reviewerHandoff !== null;
    }, 180_000);

    // Fallback in case an extra-cautious model still asked for a human nod on Turn 1 before calling enhance_flow.
    if (!firstTurnDone && agentEnds > beforeEnds && !reviewerHandoff && proc.exitCode === null) {
      const secondBeforeEnds = agentEnds;
      proc.stdin.write(
        `${JSON.stringify({
          id: "dispatch-2",
          type: "prompt",
          message: '好，开干！请立即调用 enhance_flow(action="start", roles=["reviewer"], goal="核查 src/math.ts 的 add(a, b) 实现是否正确", wait=true)。',
        })}\n`,
      );
      await proc.stdin.flush();
      await waitUntil(() => {
        reviewerHandoff = findPersistedReviewerHandoff();
        return agentEnds > secondBeforeEnds && reviewerHandoff !== null;
      }, 180_000);
    }

    if (!reviewerHandoff) reviewerHandoff = findPersistedReviewerHandoff();

    // 3. Return to standard OMP via /coord off once coordinator is idle.
    if (reviewerHandoff && proc.exitCode === null) {
      await waitUntil(() => agentEnds > beforeEnds, 15_000);
      proc.stdin.write(`${JSON.stringify({ id: "coord-off", type: "prompt", message: "/coord off" })}\n`);
      await proc.stdin.flush();
      await waitUntil(
        () => responseIds.has("coord-off") && existsSync(outPath) && isCoordOffText(readFileSync(outPath, "utf8")),
        15_000,
      );
    }

    try { proc.stdin.end(); } catch {}
    const { exitCode, forcedTermination } = await terminateProcessCleanly(proc, reviewerHandoff ? 8_000 : 2_000, 2_000);
    await waitWithTimeout(stdoutDone, 1_500);
    const stderrRes = await waitWithTimeout(stderrPromise, 1_500);
    const stderr = stderrRes.timedOut ? "" : stderrRes.value;
    const recentStdout = stdoutLines.slice(-30).join("\n");

    assert(
      reviewerHandoff !== null,
      `Live /coord -> enhance_flow(["reviewer"]) produced no reviewer HandoffEnvelope.\nstdout:\n${recentStdout}\nstderr:\n${stderr.slice(-4000)}`,
    );
    assert(
      exitCode === 0 || forcedTermination,
      `RPC session exited ${exitCode}.\nstdout:\n${recentStdout}\nstderr:\n${stderr.slice(-4000)}`,
    );
    assert(
      isCoordOffText(readFileSync(outPath, "utf8")),
      `Expected /coord off to restore standard OMP mode.\ncmdOut:\n${readFileSync(outPath, "utf8")}`,
    );

    return { reviewerHandoff, extensionCommands };
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

  // 1. Default session starts in pure standard "off" mode with 7 visible roles (supervisor hidden) and lazy SQLite.
  const initialStatus = runPrintCommand("/coord status", "status-initial");
  assert(isCoordOffText(initialStatus), `Expected default standard OMP off mode, got:\n${initialStatus}`);
  assert(hasVisibleRoleCount(initialStatus, 7), `Expected 7 visible builtin roles, got:\n${initialStatus}`);
  assert(!/(?:Visible roles|可见角色|可用角色).*?\bsupervisor\b/.test(initialStatus), `Internal supervisor leaked into visible roles:\n${initialStatus}`);
  assert(initialStatus.includes("defaultRole=off"), `Expected defaultRole=off, got:\n${initialStatus}`);
  assert(initialStatus.includes("supervisorModel=@advisor"), `Expected supervisorModel=@advisor, got:\n${initialStatus}`);
  assert(initialStatus.includes("flowRoutingMode=auto"), `Expected flowRoutingMode=auto, got:\n${initialStatus}`);
  assert(!existsSync(dbPath), "Read-only /coord status should not eagerly create .omp-enhance/state.sqlite");
  console.log("ok: default session starts in off mode (7 visible roles, internal supervisor hidden, lazy SQLite)");

  // 2. /role create scaffolds a read-only custom project role YAML cleanly.
  const createOutput = runPrintCommand(
    "/role create custom-auditor --project --readonly Custom auditor",
    "role-create",
  );
  const rolePath = path.join(workspace, ".omp", "roles", "custom-auditor.yaml");
  assert(existsSync(rolePath), `Expected ${rolePath} to exist.\nOutput:\n${createOutput}`);
  const roleYaml = readFileSync(rolePath, "utf8");
  assert(roleYaml.includes("id: custom-auditor"), "Created role YAML is missing its id.");
  assert(roleYaml.includes("writable: []"), "Read-only custom role YAML should declare writable: [].");
  assert(
    createOutput.includes('Created role "custom-auditor" [project]') || createOutput.includes("custom-auditor"),
    `Unexpected /role create output:\n${createOutput}`,
  );
  const afterCreateStatus = runPrintCommand("/coord status", "status-after-create");
  assert(hasVisibleRoleCount(afterCreateStatus, 8), `Expected 8 visible roles after create, got:\n${afterCreateStatus}`);
  assert(afterCreateStatus.includes("custom-auditor"), `Expected custom-auditor in visible roles:\n${afterCreateStatus}`);
  console.log("ok: /role create wrote .omp/roles/custom-auditor.yaml (--readonly)");

  // 3. .omp/plugin-overrides.json dynamically overrides plugin settings.
  const overridePath = path.join(workspace, ".omp", "plugin-overrides.json");
  writeFileSync(
    overridePath,
    JSON.stringify({ settings: { "omp-enhance": { flowMaxRepairRounds: 4, supervisorModel: "@smol" } } }),
    "utf8",
  );
  const overriddenStatus = runPrintCommand("/coord status", "status-override");
  assert(overriddenStatus.includes("flowMaxRepairRounds=4"), `Expected overridden flowMaxRepairRounds=4:\n${overriddenStatus}`);
  assert(overriddenStatus.includes("supervisorModel=@smol"), `Expected overridden supervisorModel=@smol:\n${overriddenStatus}`);
  rmSync(overridePath, { force: true });
  console.log("ok: native plugin settings override (.omp/plugin-overrides.json) dynamically applied");

  // 4. Live SuperAgent RPC flow: /coord -> coordinator dispatches ["reviewer"] via enhance_flow -> 0 file mutations -> persisted ready HandoffEnvelope -> /coord off.
  const before = snapshotWorkspace(workspace);
  const beforeMathHash = createHash("sha256")
    .update(readFileSync(path.join(workspace, "src", "math.ts")))
    .digest("hex");

  const { reviewerHandoff, extensionCommands } = await runSuperAgentRpcFlow();
  assert(
    JSON.stringify(extensionCommands) === JSON.stringify(["coord", "flow", "role"]),
    `Expected converged 3 commands [coord, flow, role], got: ${JSON.stringify(extensionCommands)}`,
  );
  assert(
    reviewerHandoff.verdict === "ready",
    `Expected reviewer verdict=ready, got ${reviewerHandoff.verdict}: ${reviewerHandoff.summary}`,
  );
  console.log(`ok: /coord dispatched isolated reviewer (envelope=${reviewerHandoff.id}, verdict=${reviewerHandoff.verdict}) and /coord off restored standard OMP`);

  const after = snapshotWorkspace(workspace);
  assert(
    createHash("sha256").update(readFileSync(path.join(workspace, "src", "math.ts"))).digest("hex") === beforeMathHash,
    "Coordinator or reviewer modified src/math.ts.",
  );
  const beforePaths = [...before.keys()].sort();
  const afterPaths = [...after.keys()].sort();
  assert(
    JSON.stringify(beforePaths) === JSON.stringify(afterPaths),
    `Workspace files changed unexpectedly:\n${beforePaths.join("\n")}\n---\n${afterPaths.join("\n")}`,
  );
  for (const relPath of beforePaths) {
    assert(before.get(relPath)?.sha256 === after.get(relPath)?.sha256, `Workspace file ${relPath} was modified.`);
  }
  console.log("ok: coordinator and reviewer modified zero workspace files");

  const gitignorePath = path.join(workspace, ".omp-enhance", ".gitignore");
  assert(existsSync(gitignorePath), "Expected .omp-enhance/.gitignore to be auto-created with state.sqlite");
  assert(readFileSync(gitignorePath, "utf8").trim().startsWith("*"), "Expected .omp-enhance/.gitignore to ignore *");

  const verifyStore = new EnhanceStore(dbPath);
  try {
    const persisted = verifyStore.getHandoff(reviewerHandoff.id);
    assert(persisted !== null, "Reviewer HandoffEnvelope missing on reopen.");
    const mandate = verifyStore.getMandate(persisted!.mandateId);
    assert(mandate !== null, "Reviewer handoff mandate missing in state.sqlite.");
    console.log(`ok: state.sqlite persisted mandate (${mandate!.id}) + reviewer ready envelope (facts=${persisted!.verifiedFacts.length})`);
  } finally {
    verifyStore.close();
  }

  console.log("PASS: live OMP SuperAgent extension E2E");
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
