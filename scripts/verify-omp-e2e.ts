import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { snapshotWorkspace } from "../src/core/fs.ts";
import { EnhanceStore, type ProjectFlowLease } from "../src/core/store.ts";
import type { FlowStageTrace, HandoffEnvelope, PersistedFlowCheckpoint } from "../src/core/types.ts";

const repoRoot = path.resolve(import.meta.dir, "..");
const defaultOmp = path.join(homedir(), ".local", "bin", "omp");
const ompBin = process.env.OMP_BIN ?? process.env.OMP_COMMAND ?? (existsSync(defaultOmp) ? defaultOmp : "omp");
const workspace = mkdtempSync(path.join(tmpdir(), "omp-enhance-e2e-"));
const proj1 = mkdtempSync(path.join(tmpdir(), "omp-enhance-e2e-p1-"));
const proj2 = mkdtempSync(path.join(tmpdir(), "omp-enhance-e2e-p2-"));
const controlDir = mkdtempSync(path.join(tmpdir(), "omp-enhance-e2e-out-"));
const e2eConfigPath = path.join(controlDir, "e2e-config.yml");
writeFileSync(e2eConfigPath, "advisor:\n  enabled: false\n", "utf8");
const globalRolesDir = path.join(workspace, "global-roles");
const dbPath = path.join(workspace, ".omp-enhance", "state.sqlite");

const e2eModel = process.env.OMP_E2E_MODEL ?? "@task";

function baseExtensionArgs(cwd: string): string[] {
  return [
    "--config", e2eConfigPath,
    "--model", e2eModel,
    "--thinking", "low",
    "--extension", repoRoot,
    "--cwd", cwd,
    "--no-session", "--no-skills", "--no-rules", "--no-context-files",
    "--no-lsp", "--no-extensions", "--no-title", "--auto-approve",
  ];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function outputPath(name: string): string {
  return path.join(controlDir, `${name}.out`);
}

function envFor(options: { outName: string; homeDir: string; rolesDir: string; lockPath: string }): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    OMP_ENHANCE_CMD_OUT: outputPath(options.outName),
    OMP_ENHANCE_HOME: options.homeDir,
    OMP_ENHANCE_GLOBAL_ROLES_DIR: options.rolesDir,
    OMP_ENHANCE_PLUGIN_LOCK_PATH: options.lockPath,
  };
}

function phase1Env(outName = "current"): Record<string, string> {
  return envFor({
    outName,
    homeDir: path.join(workspace, "enhance-home"),
    rolesDir: globalRolesDir,
    lockPath: path.join(workspace, "omp-plugins.lock.json"),
  });
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
  const result = spawnSync(ompBin, ["-p", command, ...baseExtensionArgs(workspace)], {
    cwd: workspace,
    env: { ...phase1Env(label), OMP_ENHANCE_CMD_OUT: outPath },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stderr = result.stderr ?? "";
  assert(result.status === 0, `omp ${command} exited ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${stderr}`);
  assert(existsSync(outPath), `omp ${command} produced no command output.\nstdout:\n${result.stdout}\nstderr:\n${stderr}`);
  return readFileSync(outPath, "utf8");
}

function withReadStore<T>(targetCwd: string, fn: (store: EnhanceStore) => T): T | null {
  const p = path.join(targetCwd, ".omp-enhance", "state.sqlite");
  if (!existsSync(p)) return null;
  const store = new EnhanceStore(p);
  try {
    return fn(store);
  } catch {
    return null;
  } finally {
    store.close();
  }
}

function findPersistedReviewerHandoff(targetCwd = workspace): HandoffEnvelope | null {
  return withReadStore(targetCwd, (store) => store.listHandoffs().find((h) => h.fromRole === "reviewer") ?? null) ?? null;
}

function readCheckpoints(targetCwd: string): PersistedFlowCheckpoint[] {
  return withReadStore(targetCwd, (store) => store.listFlowCheckpoints(50)) ?? [];
}

function readCheckpoint(targetCwd: string, flowId: string): PersistedFlowCheckpoint | null {
  return withReadStore(targetCwd, (store) => store.getFlowCheckpoint(flowId)) ?? null;
}

function readLease(targetCwd: string): ProjectFlowLease | null {
  return withReadStore(targetCwd, (store) => store.getProjectFlowLease()) ?? null;
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

type PipedSubprocess = Bun.Subprocess<"pipe", "pipe", "pipe">;

async function terminateProcessCleanly(
  proc: PipedSubprocess,
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

interface FlowToolCapture {
  payload: Record<string, unknown>;
  isError: boolean;
}

interface CustomMessageCapture {
  customType: string;
  content: string;
  display?: boolean;
  excludeFromContext?: boolean;
  agentEndsAtEmit: number;
}

class RpcWindow {
  readonly proc: PipedSubprocess;
  readonly outPath: string;
  readonly stdoutLines: string[] = [];
  readonly responseIds = new Set<string>();
  readonly flowToolResults: FlowToolCapture[] = [];
  readonly customMessages: CustomMessageCapture[] = [];
  readonly assistantMessages: string[] = [];
  extensionCommands: string[] = [];
  agentStarts = 0;
  agentEnds = 0;
  isProcessing = false;
  private readonly stdoutDone: Promise<void>;
  private readonly stderrPromise: Promise<string>;
  private seq = 0;

  constructor(options: { label: string; cwd: string; env: Record<string, string>; noUi?: boolean }) {
    this.outPath = outputPath(options.label);
    rmSync(this.outPath, { force: true });
    const args = options.noUi
      ? [ompBin, "--mode", "rpc", "--no-ui", ...baseExtensionArgs(options.cwd)]
      : [ompBin, "--mode", "rpc", ...baseExtensionArgs(options.cwd)];
    const spawned = Bun.spawn(args, {
      cwd: options.cwd,
      env: { ...options.env, OMP_ENHANCE_CMD_OUT: this.outPath },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = spawned;
    this.stderrPromise = new Response(spawned.stderr).text().catch(() => "");
    this.stdoutDone = (async () => {
      const reader = spawned.stdout.getReader();
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
            if (line) this.handleLine(line);
            nl = buffer.indexOf("\n");
          }
        }
      } catch {}
    })();
  }

  private handleLine(line: string): void {
    this.stdoutLines.push(line);
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (ev.type === "agent_start") {
        this.agentStarts += 1;
        this.isProcessing = true;
      } else if (ev.type === "agent_end") {
        this.agentEnds += 1;
        this.isProcessing = false;
      } else if (ev.type === "response" && typeof ev.id === "string") {
        this.responseIds.add(ev.id);
      } else if (ev.type === "available_commands_update" && Array.isArray(ev.commands)) {
        this.extensionCommands = (ev.commands as Array<{ name?: string; source?: string }>)
          .filter((c) => c.source === "extension" && typeof c.name === "string" && c.name !== "autoresearch")
          .map((c) => c.name!)
          .sort();
      } else if (ev.type === "tool_execution_end") {
        const toolName = (ev.toolName ?? ev.name) as string | undefined;
        if (toolName === "enhance_flow") {
          const res = ev.result as { content?: Array<{ text?: string }> } | undefined;
          const rawText = res?.content?.[0]?.text ?? "";
          if (rawText) {
            try {
              this.flowToolResults.push({
                payload: JSON.parse(rawText) as Record<string, unknown>,
                isError: Boolean(ev.isError),
              });
            } catch {}
          }
        }
      } else if (ev.type === "message_end" && ev.message && typeof ev.message === "object") {
        const msg = ev.message as Record<string, unknown>;
        if (msg.role === "custom" && typeof msg.customType === "string") {
          this.customMessages.push({
            customType: msg.customType,
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
            display: typeof msg.display === "boolean" ? msg.display : undefined,
            excludeFromContext: typeof msg.excludeFromContext === "boolean" ? msg.excludeFromContext : undefined,
            agentEndsAtEmit: this.agentEnds,
          });
        } else if (msg.role === "assistant") {
          const content = msg.content;
          const text = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n").trim()
              : "";
          if (text) this.assistantMessages.push(text);
        }
      }
    } catch {}
  }

  cmdOutText(): string {
    return existsSync(this.outPath) ? readFileSync(this.outPath, "utf8") : "";
  }

  async waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!pred() && Date.now() < deadline && this.proc.exitCode === null) {
      await Bun.sleep(150);
    }
    return pred();
  }

  async waitIdle(timeoutMs = 60_000): Promise<void> {
    const ok = await this.waitUntil(() => !this.isProcessing, timeoutMs);
    assert(ok, `RPC window did not become idle within ${timeoutMs}ms.\n${this.debugDump()}`);
  }

  async sendSlash(command: string, checkOut?: (out: string) => boolean, timeoutMs = 30_000): Promise<void> {
    await this.waitIdle(30_000);
    const id = `slash-${++this.seq}`;
    this.proc.stdin.write(`${JSON.stringify({ id, type: "prompt", message: command })}\n`);
    await this.proc.stdin.flush();
    const ok = await this.waitUntil(
      () => this.responseIds.has(id) && (!checkOut || checkOut(this.cmdOutText())),
      timeoutMs,
    );
    assert(ok, `Slash command ${command} failed or timed out.\ncmdOut:\n${this.cmdOutText()}\n${this.debugDump()}`);
  }

  async sendAgentPrompt(message: string, timeoutMs = 180_000): Promise<void> {
    await this.waitIdle(60_000);
    const beforeEnds = this.agentEnds;
    const id = `turn-${++this.seq}`;
    this.proc.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    await this.proc.stdin.flush();
    const ok = await this.waitUntil(() => this.agentEnds > beforeEnds && !this.isProcessing, timeoutMs);
    assert(ok, `Agent prompt timed out: ${message}\n${this.debugDump()}`);
  }

  debugDump(): string {
    return `pid=${this.proc.pid} exit=${this.proc.exitCode} starts=${this.agentStarts} ends=${this.agentEnds}\nrecent stdout:\n${this.stdoutLines.slice(-25).join("\n")}`;
  }

  async close(): Promise<{ exitCode: number | null; forcedTermination: boolean; stderr: string }> {
    try { this.proc.stdin.end(); } catch {}
    const { exitCode, forcedTermination } = await terminateProcessCleanly(this.proc, 6_000, 2_000);
    await waitWithTimeout(this.stdoutDone, 1_500);
    const stderrRes = await waitWithTimeout(this.stderrPromise, 1_500);
    return { exitCode, forcedTermination, stderr: stderrRes.timedOut ? "" : stderrRes.value };
  }
}

async function runPhase1SuperAgentRpcFlow(): Promise<{
  reviewerHandoff: HandoffEnvelope;
  extensionCommands: string[];
}> {
  const win = new RpcWindow({ label: "rpc-phase1", cwd: workspace, env: phase1Env("rpc-phase1"), noUi: true });
  try {
    await win.sendSlash("/coord", isCoordActiveText);
    await win.sendAgentPrompt(
      '无需询问确认，我已批准立即开干：请现在直接调用 enhance_flow 工具（action="start", roles=["reviewer"], goal="核查 src/math.ts 的 add(a, b) 实现是否正确且工作区保持零修改", wait=true）启动 reviewer 检查 src/math.ts，拿到结果后用一句话向我汇报。',
    );
    let reviewerHandoff = findPersistedReviewerHandoff();
    if (!reviewerHandoff && win.proc.exitCode === null) {
      await win.sendAgentPrompt(
        '好，开干！请立即调用 enhance_flow(action="start", roles=["reviewer"], goal="核查 src/math.ts 的 add(a, b) 实现是否正确", wait=true)。',
      );
      reviewerHandoff = findPersistedReviewerHandoff();
    }
    await win.sendSlash("/coord off", isCoordOffText);
    const closed = await win.close();
    assert(reviewerHandoff !== null, `Phase 1 reviewer HandoffEnvelope missing.\n${win.debugDump()}\nstderr:\n${closed.stderr}`);
    assert(closed.exitCode === 0 || closed.forcedTermination, `Phase 1 RPC exited ${closed.exitCode}`);
    return { reviewerHandoff, extensionCommands: win.extensionCommands };
  } finally {
    if (win.proc.exitCode === null) {
      try { win.proc.kill("SIGKILL"); } catch {}
    }
  }
}

function scaffoldMultiWindowRoles(rolesDir: string, releaseBFlag: string): void {
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(
    path.join(rolesDir, "a-gate.yaml"),
    [
      "id: a-gate",
      "name: Flow A 交互门禁专员",
      "description: 首轮挂起询问零值规则，收到 ZERO_REJECT 答复后写入 a-result.txt",
      `model: ${JSON.stringify(e2eModel)}`,
      "thinking: low",
      "stance: |",
      "  严格按两步状态机执行，绝不多做无关操作：",
      "  1. 先调用 read 读取 src/config.ts；",
      '  2. 检查提示词中是否已包含用户答复 "ZERO_REJECT"：',
      '     - 若未包含 "ZERO_REJECT"：禁止写任何文件，立即调用 enhance_handoff(verdict="needs_input", summary="等待确认退款金额等于 0 时的处理策略", questionsForUser=["退款金额等于 0 时应直接拒绝(ZERO_REJECT)还是放行？"], verifiedFacts=[{claim:"src/config.ts 已读取", evidenceRef:"src/config.ts:1"}])；',
      '     - 若已包含 "ZERO_REJECT"：调用 write 创建 a-result.txt（内容精确为 "ZERO_REJECT\\n"），随后立即调用 enhance_handoff(verdict="ready", summary="已按用户答复写入 ZERO_REJECT", artifactPaths=["a-result.txt"], verifiedFacts=[{claim:"已写入 ZERO_REJECT", evidenceRef:"a-result.txt:1"}])。',
      "method:",
      "  - 调用 read 读取 src/config.ts",
      '  - 无 ZERO_REJECT 答复时提交 verdict="needs_input" 挂起提问；有 ZERO_REJECT 答复时写入 a-result.txt 并提交 verdict="ready"',
      "permissions:",
      "  tools: [read, write]",
      '  writable: ["a-result.txt"]',
      '  protected: ["src/**", "b-result.txt"]',
      "exit:",
      "  require_tool_evidence: true",
    ].join("\n") + "\n",
    "utf8",
  );

  writeFileSync(
    path.join(rolesDir, "a-auditor.yaml"),
    [
      "id: a-auditor",
      "name: Flow A 二阶段复核专员",
      "description: 只读复核 a-result.txt 内容无误",
      `model: ${JSON.stringify(e2eModel)}`,
      "thinking: low",
      "stance: |",
      '  调用 read 读取 a-result.txt，核实包含 ZERO_REJECT 后立即调用 enhance_handoff(verdict="ready", summary="已复核 a-result.txt", artifactPaths=["a-result.txt"], verifiedFacts=[{claim:"a-result.txt 复核通过", evidenceRef:"a-result.txt:1"}])。',
      "method:",
      "  - 调用 read 读取 a-result.txt 并提交 enhance_handoff(verdict=ready)",
      "permissions:",
      "  tools: [read]",
      "  writable: []",
      '  protected: ["**"]',
      "exit:",
      "  require_tool_evidence: true",
    ].join("\n") + "\n",
    "utf8",
  );

  writeFileSync(
    path.join(rolesDir, "b-gated-dev.yaml"),
    [
      "id: b-gated-dev",
      "name: Flow B 租约驻留开发专员",
      "description: 等待释放信号文件后写入 b-result.txt，用于验证同项目执行权互斥",
      `model: ${JSON.stringify(e2eModel)}`,
      "thinking: low",
      "stance: |",
      `  1. 调用 bash 同步阻塞执行（严禁传 async=true，必须同步等待返回，可设 timeout=180）：while [ ! -f "${releaseBFlag}" ]; do sleep 0.2; done && printf 'FLOW_B_OK\\n' > b-result.txt`,
      '  2. 上述 bash 命令返回后，立即调用 enhance_handoff(verdict="ready", summary="Flow B 已写入 b-result.txt", artifactPaths=["b-result.txt"], verifiedFacts=[{claim:"已写入 b-result.txt", evidenceRef:"b-result.txt:1"}])。',
      "method:",
      `  - 同步调用 bash 执行 while [ ! -f "${releaseBFlag}" ]; do sleep 0.2; done && printf 'FLOW_B_OK\\n' > b-result.txt`,
      '  - 调用 enhance_handoff(verdict="ready") 提交产物 b-result.txt',
      "permissions:",
      "  tools: [read, write, bash]",
      '  writable: ["b-result.txt"]',
      '  protected: ["src/**", "a-result.txt"]',
      "exit:",
      "  require_tool_evidence: true",
    ].join("\n") + "\n",
    "utf8",
  );

  writeFileSync(
    path.join(rolesDir, "c-fast-dev.yaml"),
    [
      "id: c-fast-dev",
      "name: Flow C 跨项目并行专员",
      "description: 在项目二独立写入 c-result.txt",
      `model: ${JSON.stringify(e2eModel)}`,
      "thinking: low",
      "stance: |",
      '  先调用 read 读取 src/service.ts，再调用 write 将 "FLOW_C_OK\\n" 写入 c-result.txt，最后立即调用 enhance_handoff(verdict="ready", summary="Flow C 已写入 c-result.txt", artifactPaths=["c-result.txt"], verifiedFacts=[{claim:"已写入 c-result.txt", evidenceRef:"c-result.txt:1"}])。',
      "method:",
      "  - 调用 read 读取 src/service.ts",
      '  - 调用 write 写入 c-result.txt ("FLOW_C_OK\\n") 并调用 enhance_handoff(verdict="ready")',
      "permissions:",
      "  tools: [read, write]",
      '  writable: ["c-result.txt"]',
      '  protected: ["src/**"]',
      "exit:",
      "  require_tool_evidence: true",
    ].join("\n") + "\n",
    "utf8",
  );
}

async function runMultiWindowMultiProjectE2E(): Promise<void> {
  const multiHome = path.join(controlDir, "multi-home");
  const multiRoles = path.join(controlDir, "multi-roles");
  const multiLock = path.join(controlDir, "multi-lock.json");
  writeFileSync(
    multiLock,
    JSON.stringify({ settings: { "omp-enhance": { supervisorInitialDelaySec: 300 } } }),
    "utf8",
  );
  const releaseBFlag = path.join(controlDir, "release-flow-b.flag");
  scaffoldMultiWindowRoles(multiRoles, releaseBFlag);

  mkdirSync(path.join(proj1, "src"), { recursive: true });
  mkdirSync(path.join(proj2, "src"), { recursive: true });
  writeFileSync(path.join(proj1, "src", "config.ts"), "export const MIN_REFUND = 1;\n", "utf8");
  writeFileSync(path.join(proj2, "src", "service.ts"), 'export const SERVICE = "proj2";\n', "utf8");
  const p1ConfigHash = createHash("sha256").update(readFileSync(path.join(proj1, "src", "config.ts"))).digest("hex");
  const p2ServiceHash = createHash("sha256").update(readFileSync(path.join(proj2, "src", "service.ts"))).digest("hex");

  const sharedEnv = envFor({ outName: "multi", homeDir: multiHome, rolesDir: multiRoles, lockPath: multiLock });
  const win1 = new RpcWindow({ label: "rpc-win1", cwd: proj1, env: sharedEnv, noUi: false });
  const win2 = new RpcWindow({ label: "rpc-win2", cwd: proj1, env: sharedEnv, noUi: false });

  try {
    assert(win1.proc.pid !== win2.proc.pid, "Window 1 and Window 2 must be distinct OS processes.");
    await win1.sendSlash("/coord", isCoordActiveText);
    await win2.sendSlash("/coord", isCoordActiveText);
    await win1.sendSlash(`/coord trust ${proj2}`, (out) => out.includes("Trusted project:") || out.includes(path.resolve(proj2)));
    console.log(`ok: [multi-window] booted Window 1 (pid=${win1.proc.pid}) & Window 2 (pid=${win2.proc.pid}) and trusted proj2`);

    // 1. Start Flow A in proj1 -> A suspends at stage 0 (waiting_input) & wakes Window 1 frontend.
    const assistantBeforeA = win1.assistantMessages.length;
    await win1.sendAgentPrompt(
      '无需询问确认，请立即调用 enhance_flow(action="start", roles=["a-gate", "a-auditor"], goal="核对退款金额等于 0 时的处理策略并生成 a-result.txt", wait=false) 在后台异步启动（严禁设置 wait=true）。',
    );
    const aPaused = await win1.waitUntil(() => {
      const cps = readCheckpoints(proj1);
      return cps.some((cp) => cp.status === "waiting_input");
    }, 180_000);
    assert(aPaused, `Flow A did not suspend in waiting_input.\n${win1.debugDump()}`);

    const cpAPaused = readCheckpoints(proj1).find((cp) => cp.status === "waiting_input")!;
    const flowAId = cpAPaused.flowId;
    assert(cpAPaused.currentIndex === 0, `Expected Flow A paused at currentIndex=0, got ${cpAPaused.currentIndex}`);
    assert(readLease(proj1) === null, "Suspended Flow A must release proj1 execution lease.");

    // Wait for Window 1's automatic wakeup turn delivering A's question to frontend.
    const aWakeDelivered = await win1.waitUntil(() => {
      const ev = win1.customMessages.find((m) => m.customType === "omp-enhance-flow-event" && m.content.includes(flowAId));
      return Boolean(ev && win1.agentEnds > ev.agentEndsAtEmit && win1.assistantMessages.length > assistantBeforeA && !win1.isProcessing);
    }, 90_000);
    assert(aWakeDelivered, `Window 1 frontend did not receive Flow A waiting_input wakeup.\n${win1.debugDump()}`);
    const aFlowEvent = win1.customMessages.find((m) => m.customType === "omp-enhance-flow-event" && m.content.includes(flowAId))!;
    assert(aFlowEvent.display === false && aFlowEvent.excludeFromContext !== true, "Flow event must be silent (display=false) and included in LLM context.");
    console.log(`ok: [multi-window] Flow A (${flowAId}) suspended at stage 0 (waiting_input), released lease, and delivered question wakeup to Window 1`);

    // 2. Start Flow B in proj1 (gated by releaseBFlag) AND Flow C in proj2 concurrently from Window 1.
    await win1.sendAgentPrompt(
      `无需询问确认，请在同一轮连续调用两次 enhance_flow 后台异步启动（两次都必须传 wait=false，严禁传 wait=true）：1) enhance_flow(action="start", cwd=${JSON.stringify(proj1)}, roles=["b-gated-dev"], goal="等待释放信号文件后在项目一生成 b-result.txt", wait=false)；2) enhance_flow(action="start", cwd=${JSON.stringify(proj2)}, roles=["c-fast-dev"], goal="在项目二生成 c-result.txt", wait=false)。`,
    );

    // Ensure both B and C were started even if the model only dispatched one in the first turn.
    if (!readCheckpoints(proj1).some((cp) => cp.flowId !== flowAId)) {
      await win1.sendAgentPrompt(
        `无需询问确认，立即调用 enhance_flow(action="start", cwd=${JSON.stringify(proj1)}, roles=["b-gated-dev"], goal="等待释放信号文件后在项目一生成 b-result.txt", wait=false)。`,
      );
    }
    if (readCheckpoints(proj2).length === 0) {
      await win1.sendAgentPrompt(
        `无需询问确认，立即调用 enhance_flow(action="start", cwd=${JSON.stringify(proj2)}, roles=["c-fast-dev"], goal="在项目二生成 c-result.txt", wait=false)。`,
      );
    }

    const bRunningAndCDone = await win1.waitUntil(() => {
      const b = readCheckpoints(proj1).find((cp) => cp.flowId !== flowAId);
      const c = readCheckpoints(proj2)[0];
      return Boolean(b && b.status === "running" && readLease(proj1)?.flowId === b.flowId && c && c.status === "completed");
    }, 180_000);
    assert(bRunningAndCDone, `Expected Flow B running in proj1 while Flow C completed in proj2.\n${win1.debugDump()}`);

    const flowBId = readCheckpoints(proj1).find((cp) => cp.flowId !== flowAId)!.flowId;
    const flowCId = readCheckpoints(proj2)[0]!.flowId;
    const activeLease = readLease(proj1)!;
    assert(activeLease.flowId === flowBId && activeLease.ownerPid === win1.proc.pid, `Expected proj1 lease held by B (${flowBId}, pid=${win1.proc.pid}), got ${JSON.stringify(activeLease)}`);
    assert(existsSync(path.join(proj2, "c-result.txt")), "Expected proj2/c-result.txt while B is still running in proj1.");
    console.log(`ok: [multi-window] Flow B (${flowBId}) holds proj1 lease while Flow C (${flowCId}) completed in parallel in proj2`);

    // 3. From Window 2, query A by ID, reply to A, and attempt resume(A) while B holds proj1 lease!
    const w2ToolsBefore = win2.flowToolResults.length;
    await win2.sendAgentPrompt(
      `无需询问确认，请严格按顺序依次调用以下 3 次 enhance_flow 工具（每次都必须传入 flowId="${flowAId}"）：` +
        `1) enhance_flow(action="status", flowId="${flowAId}")；` +
        `2) enhance_flow(action="steer", flowId="${flowAId}", message="用户正式答复A：退款金额等于0一律拒绝 ZERO_REJECT")；` +
        `3) enhance_flow(action="resume", flowId="${flowAId}")，并向我说明当前哪个任务占用了项目执行权。`,
    );

    let w2Batch = win2.flowToolResults.slice(w2ToolsBefore);
    if (!w2Batch.some((r) => r.payload.flowId === flowAId && r.payload.status === "waiting_input" && Array.isArray(r.payload.roleChain))) {
      await win2.sendAgentPrompt(`请立即调用 enhance_flow(action="status", flowId="${flowAId}")。`);
    }
    if (!win2.flowToolResults.slice(w2ToolsBefore).some((r) => r.payload.savedToCheckpoint === true && r.payload.flowId === flowAId)) {
      await win2.sendAgentPrompt(`请立即调用 enhance_flow(action="steer", flowId="${flowAId}", message="用户正式答复A：退款金额等于0一律拒绝 ZERO_REJECT")。`);
    }
    if (!win2.flowToolResults.slice(w2ToolsBefore).some((r) => r.payload.busy === true && r.payload.flowId === flowAId)) {
      await win2.sendAgentPrompt(`请立即调用 enhance_flow(action="resume", flowId="${flowAId}")。`);
    }
    w2Batch = win2.flowToolResults.slice(w2ToolsBefore);

    const statusARes = w2Batch.find((r) => r.payload.flowId === flowAId && Array.isArray(r.payload.roleChain));
    assert(statusARes !== undefined, `Window 2 status(flowId=A) missing.\nresults=${JSON.stringify(w2Batch)}`);
    assert(statusARes!.payload.flowId === flowAId && statusARes!.payload.status === "waiting_input", `status(A) returned wrong flow: ${JSON.stringify(statusARes!.payload)}`);

    const steerARes = w2Batch.find((r) => r.payload.flowId === flowAId && r.payload.savedToCheckpoint === true);
    assert(steerARes !== undefined, `Window 2 steer(flowId=A) did not save to A's checkpoint.\nresults=${JSON.stringify(w2Batch)}`);

    const busyResumeRes = w2Batch.find((r) => r.payload.flowId === flowAId && r.payload.busy === true);
    assert(busyResumeRes !== undefined, `Window 2 resume(flowId=A) while B holds lease did not report busy=true.\nresults=${JSON.stringify(w2Batch)}`);
    assert(
      busyResumeRes!.payload.activeFlowId === flowBId && busyResumeRes!.payload.started === false,
      `Expected busy resume to report activeFlowId=${flowBId} and started=false, got ${JSON.stringify(busyResumeRes!.payload)}`,
    );

    // Verify B was 100% undisturbed while Window 2 operated on A.
    const cpBMid = readCheckpoint(proj1, flowBId)!;
    const cpAMid = readCheckpoint(proj1, flowAId)!;
    assert(cpBMid.status === "running", `Flow B status was disturbed: ${cpBMid.status}`);
    assert((cpBMid.userSteers ?? []).length === 0, `Flow A reply leaked into Flow B userSteers: ${JSON.stringify(cpBMid.userSteers)}`);
    assert(cpAMid.status === "waiting_input", `Flow A must remain waiting_input while B holds lease, got ${cpAMid.status}`);
    assert((cpAMid.userSteers ?? []).some((s) => s.text.includes("ZERO_REJECT")), "Flow A checkpoint missing ZERO_REJECT reply.");
    console.log(`ok: [multi-window] Window 2 status/steer/resume(A) returned A, saved reply ONLY to A, and blocked resume with busy=true (activeFlowId=${flowBId})`);

    // 4. Release Flow B -> wait for B completion + lease release -> Window 2 resumes A from stage 0 to completed!
    writeFileSync(releaseBFlag, "go\n", "utf8");
    const bFinished = await win1.waitUntil(
      () => readCheckpoint(proj1, flowBId)?.status === "completed" && readLease(proj1) === null,
      120_000,
    );
    assert(bFinished, `Flow B did not finish and release lease after signal.\n${win1.debugDump()}`);

    await win2.sendAgentPrompt(
      `现在项目一的执行权已释放，无需询问确认，请立即调用 enhance_flow(action="resume", flowId="${flowAId}", wait=true) 从原挂起阶段恢复并跑完 Flow A，完成后简短汇报。`,
    );
    const aCompleted = await win2.waitUntil(() => readCheckpoint(proj1, flowAId)?.status === "completed", 180_000);
    assert(aCompleted, `Flow A did not complete after resume in Window 2.\n${win2.debugDump()}`);

    // Wait for Window 1 & Window 2 completion notifications to settle.
    const w1CompletionsDelivered = await win1.waitUntil(
      () =>
        win1.customMessages.some((m) => m.customType === "omp-enhance-flow-event" && m.content.includes(flowBId)) &&
        win1.customMessages.some(
          (m) =>
            (m.customType === "omp-enhance-flow-event" && m.content.includes(flowCId)) ||
            (m.customType === "omp-enhance-room" && (m.content.includes(flowCId) || m.content.includes("c-fast-dev"))),
        ) &&
        !win1.isProcessing,
      90_000,
    );
    assert(w1CompletionsDelivered, `Window 1 missing Flow B/C completion notifications.\n${win1.debugDump()}`);
    await win2.waitIdle(30_000);

    // 5. Final audit of A, B, and C: user replies, stage records, SQLite terminal states, file changes, & frontend notifications.
    const finalA = readCheckpoint(proj1, flowAId)!;
    const finalB = readCheckpoint(proj1, flowBId)!;
    const finalC = readCheckpoint(proj2, flowCId)!;
    assert(finalA.status === "completed" && finalB.status === "completed" && finalC.status === "completed", "Expected A, B, and C all completed.");
    assert(readLease(proj1) === null && readLease(proj2) === null, "Expected both project_leases tables clean after completion.");

    assert((finalA.userSteers ?? []).some((s) => s.text.includes("ZERO_REJECT")), "Final A missing ZERO_REJECT userSteer.");
    assert((finalB.userSteers ?? []).length === 0, `Final B has unexpected userSteers: ${JSON.stringify(finalB.userSteers)}`);
    assert((finalC.userSteers ?? []).length === 0, `Final C has unexpected userSteers: ${JSON.stringify(finalC.userSteers)}`);

    const snapA = JSON.parse(finalA.snapshotJson) as { stages: FlowStageTrace[] };
    const snapB = JSON.parse(finalB.snapshotJson) as { stages: FlowStageTrace[] };
    const snapC = JSON.parse(finalC.snapshotJson) as { stages: FlowStageTrace[] };
    assert(snapA.stages.some((s) => s.roleId === "a-gate" && s.status === "needs_input"), "Flow A stages missing initial a-gate needs_input trace.");
    assert(snapA.stages.some((s) => s.roleId === "a-gate" && s.status === "ready"), "Flow A stages missing resumed a-gate ready trace.");
    assert(snapA.stages.some((s) => s.roleId === "a-auditor" && s.status === "ready"), "Flow A stages missing Stage 2 a-auditor ready trace.");
    assert(snapB.stages.length === 1 && snapB.stages[0]!.roleId === "b-gated-dev" && snapB.stages[0]!.status === "ready", "Unexpected Flow B stages.");
    assert(snapC.stages.length === 1 && snapC.stages[0]!.roleId === "c-fast-dev" && snapC.stages[0]!.status === "ready", "Unexpected Flow C stages.");

    assert(readFileSync(path.join(proj1, "a-result.txt"), "utf8").trim() === "ZERO_REJECT", "proj1/a-result.txt mismatch.");
    assert(readFileSync(path.join(proj1, "b-result.txt"), "utf8").trim() === "FLOW_B_OK", "proj1/b-result.txt mismatch.");
    assert(readFileSync(path.join(proj2, "c-result.txt"), "utf8").trim() === "FLOW_C_OK", "proj2/c-result.txt mismatch.");
    assert(createHash("sha256").update(readFileSync(path.join(proj1, "src", "config.ts"))).digest("hex") === p1ConfigHash, "proj1/src/config.ts was mutated.");
    assert(createHash("sha256").update(readFileSync(path.join(proj2, "src", "service.ts"))).digest("hex") === p2ServiceHash, "proj2/src/service.ts was mutated.");

    assert(win1.customMessages.some((m) => m.customType === "omp-enhance-room" && m.display === true), "Window 1 missing visible omp-enhance-room summary cards.");
    console.log("ok: [multi-window] verified isolated replies, stage traces, SQLite final states, file outputs, and frontend notifications across A, B, and C");
  } finally {
    await Promise.allSettled([win1.close(), win2.close()]);
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

  // Phase 1: Single-window baseline SuperAgent E2E
  const initialStatus = runPrintCommand("/coord status", "status-initial");
  assert(isCoordOffText(initialStatus), `Expected default standard OMP off mode, got:\n${initialStatus}`);
  assert(hasVisibleRoleCount(initialStatus, 7), `Expected 7 visible builtin roles, got:\n${initialStatus}`);
  assert(!/(?:Visible roles|可见角色|可用角色).*?\bsupervisor\b/.test(initialStatus), `Internal supervisor leaked into visible roles:\n${initialStatus}`);
  assert(initialStatus.includes("defaultRole=off"), `Expected defaultRole=off, got:\n${initialStatus}`);
  assert(initialStatus.includes("supervisorModel=@advisor"), `Expected supervisorModel=@advisor, got:\n${initialStatus}`);
  assert(initialStatus.includes("flowRoutingMode=auto"), `Expected flowRoutingMode=auto, got:\n${initialStatus}`);
  assert(!existsSync(dbPath), "Read-only /coord status should not eagerly create .omp-enhance/state.sqlite");
  console.log("ok: default session starts in off mode (7 visible roles, internal supervisor hidden, lazy SQLite)");

  const createOutput = runPrintCommand("/role create custom-auditor --project --readonly Custom auditor", "role-create");
  const rolePath = path.join(workspace, ".omp", "roles", "custom-auditor.yaml");
  assert(existsSync(rolePath), `Expected ${rolePath} to exist.\nOutput:\n${createOutput}`);
  const roleYaml = readFileSync(rolePath, "utf8");
  assert(roleYaml.includes("id: custom-auditor") && roleYaml.includes("writable: []"), "Custom role YAML invalid.");
  const afterCreateStatus = runPrintCommand("/coord status", "status-after-create");
  assert(hasVisibleRoleCount(afterCreateStatus, 8) && afterCreateStatus.includes("custom-auditor"), "Expected 8 visible roles after create.");
  console.log("ok: /role create wrote .omp/roles/custom-auditor.yaml (--readonly)");

  const overridePath = path.join(workspace, ".omp", "plugin-overrides.json");
  writeFileSync(
    overridePath,
    JSON.stringify({ settings: { "omp-enhance": { flowMaxRepairRounds: 4, supervisorModel: "@smol" } } }),
    "utf8",
  );
  const overriddenStatus = runPrintCommand("/coord status", "status-override");
  assert(overriddenStatus.includes("flowMaxRepairRounds=4") && overriddenStatus.includes("supervisorModel=@smol"), "Plugin overrides failed.");
  rmSync(overridePath, { force: true });
  console.log("ok: native plugin settings override (.omp/plugin-overrides.json) dynamically applied");

  const before = snapshotWorkspace(workspace);
  const beforeMathHash = createHash("sha256").update(readFileSync(path.join(workspace, "src", "math.ts"))).digest("hex");
  const { reviewerHandoff, extensionCommands } = await runPhase1SuperAgentRpcFlow();
  assert(
    JSON.stringify(extensionCommands) === JSON.stringify(["coord", "flow", "role"]),
    `Expected converged 3 commands [coord, flow, role], got: ${JSON.stringify(extensionCommands)}`,
  );
  assert(reviewerHandoff.verdict === "ready", `Expected reviewer verdict=ready, got ${reviewerHandoff.verdict}`);
  console.log(`ok: /coord dispatched isolated reviewer (envelope=${reviewerHandoff.id}, verdict=${reviewerHandoff.verdict}) and /coord off restored standard OMP`);

  const after = snapshotWorkspace(workspace);
  assert(
    createHash("sha256").update(readFileSync(path.join(workspace, "src", "math.ts"))).digest("hex") === beforeMathHash,
    "Coordinator or reviewer modified src/math.ts.",
  );
  const beforePaths = [...before.keys()].sort();
  const afterPaths = [...after.keys()].sort();
  assert(JSON.stringify(beforePaths) === JSON.stringify(afterPaths), "Workspace files changed unexpectedly.");
  for (const relPath of beforePaths) {
    assert(before.get(relPath)?.sha256 === after.get(relPath)?.sha256, `Workspace file ${relPath} was modified.`);
  }
  console.log("ok: coordinator and reviewer modified zero workspace files");

  const gitignorePath = path.join(workspace, ".omp-enhance", ".gitignore");
  assert(existsSync(gitignorePath) && readFileSync(gitignorePath, "utf8").trim().startsWith("*"), "Expected .omp-enhance/.gitignore (*)");

  // Phase 2: Two-Window + Two-Project Live Acceptance Test (docs/review-2026-11-23.md)
  await runMultiWindowMultiProjectE2E();

  console.log("PASS: live OMP SuperAgent single-window + multi-window/multi-project E2E");
}

try {
  await main();
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (process.env.OMP_ENHANCE_KEEP_E2E === "1") {
    console.log(`kept workspaces: ${workspace}, ${proj1}, ${proj2}`);
  } else {
    for (const dir of [workspace, proj1, proj2, controlDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
