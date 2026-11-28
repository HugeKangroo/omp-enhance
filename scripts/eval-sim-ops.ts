import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { EnhanceStore } from "../src/core/store.ts";

const repoRoot = path.resolve(import.meta.dir, "..");
const defaultOmp = path.join(homedir(), ".local", "bin", "omp");
const ompBin = process.env.OMP_BIN ?? process.env.OMP_COMMAND ?? (existsSync(defaultOmp) ? defaultOmp : "omp");

export type SimEvalArm = "vanilla-omp" | "coord-autonomous" | "fixed-flow";

export interface SimCaseSpec {
  id: string;
  taskKind: "param-sweep" | "metric-change" | "model-upgrade";
  title: string;
  userPrompt: string;
  setup(caseDir: string): void;
}

export interface SimRubricScore {
  passed: boolean;
  verifierOk: boolean;
  metadataAndUnitsOk: boolean;
  notes: string[];
}

export interface SimTrialRecord {
  trialId: string;
  caseId: string;
  arm: SimEvalArm;
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  failed: boolean;
  error?: string;
  responseText: string;
  internalTraceSummary?: string;
  executedRoles?: string[];
  score: SimRubricScore;
}

export interface SimBlindItem {
  candidateId: string;
  caseId: string;
  caseTitle: string;
  responseText: string;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

const SOLVER_PY = `import json, math, sys

def simulate(c: float, beta: float = 0.0, dt: float = 0.005, t_end: float = 8.0):
    """RK4 integrator for m*x'' + c*x' + beta*x'*|x'| + k*x = F0 (m=1 kg, k=16 N/m, F0=16 N)."""
    m, k, f0 = 1.0, 16.0, 16.0
    x, v, t = 0.0, 0.0, 0.0
    x_eq = f0 / k
    steps = int(round(t_end / dt))
    xs = [x]
    ts = [t]
    energy = 0.0

    def acc(pos, vel):
        return (f0 - c * vel - beta * vel * abs(vel) - k * pos) / m

    for _ in range(steps):
        k1x, k1v = v, acc(x, v)
        k2x, k2v = v + 0.5 * dt * k1v, acc(x + 0.5 * dt * k1x, v + 0.5 * dt * k1v)
        k3x, k3v = v + 0.5 * dt * k2v, acc(x + 0.5 * dt * k2x, v + 0.5 * dt * k2v)
        k4x, k4v = v + dt * k3v, acc(x + dt * k3x, v + dt * k3v)
        v_mid = v + 0.5 * dt * k1v
        energy += (c * v_mid * v_mid + beta * abs(v_mid) ** 3) * dt
        x += (dt / 6.0) * (k1x + 2 * k2x + 2 * k3x + k4x)
        v += (dt / 6.0) * (k1v + 2 * k2v + 2 * k3v + k4v)
        t += dt
        xs.append(x)
        ts.append(t)

    peak = max(xs)
    overshoot_pct = max(0.0, (peak - x_eq) / x_eq * 100.0)
    settling_time = t_end
    for idx in range(len(xs) - 1, -1, -1):
        if abs(xs[idx] - x_eq) > 0.02 * x_eq:
            settling_time = ts[min(idx + 1, len(ts) - 1)]
            break
    return {
        "c_Ns_per_m": round(c, 4),
        "beta_Ns2_per_m2": round(beta, 4),
        "dt_s": dt,
        "final_x_m": round(x, 6),
        "overshoot_pct": round(overshoot_pct, 4),
        "settling_time_s": round(settling_time, 4),
        "control_energy_j": round(energy, 4),
    }

if __name__ == "__main__":
    c = float(sys.argv[1]) if len(sys.argv) > 1 else 4.0
    beta = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
    dt = float(sys.argv[3]) if len(sys.argv) > 3 else 0.005
    print(json.dumps(simulate(c=c, beta=beta, dt=dt), indent=2))
`;

const VERIFY_SOLUTION_PY = `import json, sys
from solver import simulate

task = sys.argv[1]
target = sys.argv[2]
data = json.load(open(target, "r", encoding="utf-8"))
errors = []

if not isinstance(data.get("model_version"), str) or not data["model_version"].strip():
    errors.append("missing_model_version")
if not isinstance(data.get("units"), dict) or not data["units"]:
    errors.append("missing_units")

if task == "param-sweep":
    expected_cs = [1.0, 2.0, 4.0, 6.0, 8.0]
    rows = {round(float(r["c_Ns_per_m"]), 4): r for r in data.get("cases", []) if "c_Ns_per_m" in r}
    for c in expected_cs:
        if c not in rows:
            errors.append(f"missing_c_{c}")
            continue
        ref = simulate(c=c, beta=0.0, dt=0.005)
        for key in ("overshoot_pct", "settling_time_s", "control_energy_j"):
            if abs(float(rows[c].get(key, -999)) - ref[key]) > 0.05:
                errors.append(f"mismatch_c{c}_{key}")
    if data.get("critically_damped_c") != 8.0:
        errors.append("wrong_critically_damped_c")

elif task == "metric-change":
    candidates = [simulate(c=1.0 + 0.25 * i, beta=0.0, dt=0.005) for i in range(45)]
    feasible = [r for r in candidates if r["overshoot_pct"] <= 5.0 and r["settling_time_s"] <= 2.5]
    best = min(feasible, key=lambda r: r["control_energy_j"])
    chosen_c = float(data.get("optimal_c_Ns_per_m", -1))
    ref = simulate(c=chosen_c, beta=0.0, dt=0.005)
    if ref["overshoot_pct"] > 5.0 or ref["settling_time_s"] > 2.5:
        errors.append("constraints_violated")
    if abs(ref["control_energy_j"] - best["control_energy_j"]) > 0.05:
        errors.append(f"suboptimal_energy_got_{ref['control_energy_j']}_expected_{best['control_energy_j']}_at_c_{best['c_Ns_per_m']}")

elif task == "model-upgrade":
    if data.get("model_version") != "v2-nonlinear-drag":
        errors.append("wrong_model_version")
    if abs(float(data.get("beta_Ns2_per_m2", -1)) - 0.5) > 1e-6:
        errors.append("wrong_beta")
    tol = float(data.get("tolerance_m", 1.0))
    if tol > 1e-4:
        errors.append("tolerance_too_loose")
    ref_coarse = simulate(c=4.0, beta=0.5, dt=0.005)
    ref_fine = simulate(c=4.0, beta=0.5, dt=0.0025)
    if abs(float(data.get("final_x_m", -1)) - ref_fine["final_x_m"]) > 1e-4:
        errors.append("final_x_mismatch_nonlinear_model")
    if abs(float(data.get("overshoot_pct", -1)) - ref_fine["overshoot_pct"]) > 0.1:
        errors.append("overshoot_mismatch_nonlinear_model")
    if abs(ref_coarse["final_x_m"] - ref_fine["final_x_m"]) > tol:
        errors.append("convergence_exceeds_tolerance")

print(json.dumps({"ok": len(errors) == 0, "task": task, "errors": errors}, indent=2))
sys.exit(0 if len(errors) == 0 else 1)
`;

export const SIM_CASES: readonly SimCaseSpec[] = [
  {
    id: "sim-1-param-sweep",
    taskKind: "param-sweep",
    title: "Routine parameter sweep over baseline linear oscillator (c = 1, 2, 4, 6, 8 N·s/m)",
    userPrompt:
      "使用现有 `sim/solver.py`（线性模型 `v1-linear`，`beta=0`，`dt=0.005`）扫描阻尼系数 `c = [1.0, 2.0, 4.0, 6.0, 8.0]` N·s/m，将各工况结果（含 `model_version`、`units`、`cases`、`critically_damped_c`）写入 `results/sweep.json`，并用 `python3 sim/verify_solution.py param-sweep results/sweep.json` 独立复核后汇报结论。",
    setup(caseDir) {
      writeFiles(caseDir, {
        "sim/solver.py": SOLVER_PY,
        "sim/verify_solution.py": VERIFY_SOLUTION_PY,
      });
    },
  },
  {
    id: "sim-2-metric-change",
    taskKind: "metric-change",
    title: "Objective shift: minimize control energy under overshoot <= 5% and settling <= 2.5s",
    userPrompt:
      "业务指标调整：在既有线性模型 `v1-linear`（`beta=0`，`dt=0.005`）下，于 `c ∈ [1.0, 12.0]`（步长 `0.25`）寻找满足硬约束 `overshoot_pct <= 5.0` 且 `settling_time_s <= 2.5`、同时最小化 `control_energy_j` 的最优阻尼系数，输出 `results/optimal_design.json`（含 `model_version`、`units`、`optimal_c_Ns_per_m` 与指标）并通过 `python3 sim/verify_solution.py metric-change results/optimal_design.json` 验收。",
    setup(caseDir) {
      writeFiles(caseDir, {
        "sim/solver.py": SOLVER_PY,
        "sim/verify_solution.py": VERIFY_SOLUTION_PY,
      });
    },
  },
  {
    id: "sim-3-model-upgrade",
    taskKind: "model-upgrade",
    title: "Physical model upgrade: nonlinear quadratic drag (beta=0.5) with RK4 step-size convergence verification",
    userPrompt:
      "升级物理模型至 `v2-nonlinear-drag`（非线性二次阻尼 `beta=0.5` N·s²/m²，`c=4.0` N·s/m），对比 `dt=0.005` 与 `dt=0.0025` 验证数值收敛误差 `<= 1e-4` m，交接 `model_version`、`units`、`beta_Ns2_per_m2`、`tolerance_m`、`final_x_m`、`overshoot_pct` 至 `results/model_upgrade.json`，并通过 `python3 sim/verify_solution.py model-upgrade results/model_upgrade.json` 验收。",
    setup(caseDir) {
      writeFiles(caseDir, {
        "sim/solver.py": SOLVER_PY,
        "sim/verify_solution.py": VERIFY_SOLUTION_PY,
      });
    },
  },
];

const OUTPUT_BY_TASK: Record<SimCaseSpec["taskKind"], string> = {
  "param-sweep": "results/sweep.json",
  "metric-change": "results/optimal_design.json",
  "model-upgrade": "results/model_upgrade.json",
};

const SIM_BLIND_LEAK_PATTERNS: readonly RegExp[] = [
  /\[(?:planner|reviewer|dev|qa|algo|vision|coordinator)\s+handoff\]/i,
  /\b(?:vanilla-omp|coord-autonomous|fixed-flow)\b/i,
  /\benhance_(?:flow|handoff|mandate|job)\b/i,
];

export function detectSimBlindLeaks(item: SimBlindItem): string[] {
  const leaks: string[] = [];
  if ("arm" in (item as unknown as Record<string, unknown>)) leaks.push("field:arm");
  for (const re of SIM_BLIND_LEAK_PATTERNS) {
    const m = re.exec(item.responseText);
    if (m) leaks.push(m[0]);
  }
  return leaks;
}

export function scoreSimCase(spec: SimCaseSpec, caseDir: string): SimRubricScore {
  const rel = OUTPUT_BY_TASK[spec.taskKind];
  const full = path.join(caseDir, rel);
  const notes: string[] = [];
  if (!existsSync(full)) {
    return { passed: false, verifierOk: false, metadataAndUnitsOk: false, notes: [`Missing deliverable ${rel}.`] };
  }
  let metadataAndUnitsOk = false;
  try {
    const parsed = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
    metadataAndUnitsOk = Boolean(
      typeof parsed.model_version === "string" && parsed.model_version.trim() &&
      parsed.units && typeof parsed.units === "object" && Object.keys(parsed.units as object).length > 0,
    );
    if (!metadataAndUnitsOk) notes.push("Deliverable JSON missing model_version or units.");
  } catch {
    notes.push(`Invalid JSON in ${rel}.`);
  }
  const v = spawnSync("python3", ["sim/verify_solution.py", spec.taskKind, rel], { cwd: caseDir, encoding: "utf8" });
  const verifierOk = v.status === 0;
  if (!verifierOk) notes.push(`Independent physics verifier failed: ${(v.stdout || v.stderr).trim()}`);
  return { passed: verifierOk && metadataAndUnitsOk, verifierOk, metadataAndUnitsOk, notes };
}

export function buildSimBlindBundle(trials: readonly SimTrialRecord[]): {
  blindItems: SimBlindItem[];
  answerKey: Record<string, { trialId: string; caseId: string; arm: SimEvalArm; score: SimRubricScore }>;
} {
  const sorted = [...trials].sort((a, b) =>
    createHash("sha256").update(`${a.caseId}:${a.trialId}`).digest("hex")
      .localeCompare(createHash("sha256").update(`${b.caseId}:${b.trialId}`).digest("hex")),
  );
  const blindItems: SimBlindItem[] = [];
  const answerKey: Record<string, { trialId: string; caseId: string; arm: SimEvalArm; score: SimRubricScore }> = {};
  sorted.forEach((t, i) => {
    const candidateId = `sim-${String(i + 1).padStart(2, "0")}-${t.trialId.slice(0, 6)}`;
    const spec = SIM_CASES.find((c) => c.id === t.caseId)!;
    blindItems.push({ candidateId, caseId: t.caseId, caseTitle: spec.title, responseText: t.responseText });
    answerKey[candidateId] = { trialId: t.trialId, caseId: t.caseId, arm: t.arm, score: t.score };
  });
  return { blindItems, answerKey };
}

function runDryRunSelfCheck(sandboxRoot: string): void {
  const simRun = (dir: string, c: number, beta = 0, dt = 0.005) =>
    JSON.parse(spawnSync("python3", ["sim/solver.py", String(c), String(beta), String(dt)], { cwd: dir, encoding: "utf8" }).stdout);

  // 1) Param sweep positive + wrong-critical negative
  const d1 = path.join(sandboxRoot, "sim-1");
  mkdirSync(d1, { recursive: true });
  SIM_CASES[0]!.setup(d1);
  const sweepCases = [1, 2, 4, 6, 8].map((c) => simRun(d1, c));
  writeFiles(d1, {
    "results/sweep.json": JSON.stringify({ model_version: "v1-linear", units: { c: "N*s/m", x: "m", t: "s", E: "J" }, critically_damped_c: 8.0, cases: sweepCases }, null, 2),
  });
  const s1Ok = scoreSimCase(SIM_CASES[0]!, d1);
  assert(s1Ok.passed, `Sim 1 positive failed: ${JSON.stringify(s1Ok)}`);
  writeFiles(d1, {
    "results/sweep.json": JSON.stringify({ model_version: "v1-linear", units: { c: "N*s/m" }, critically_damped_c: 4.0, cases: sweepCases }, null, 2),
  });
  assert(!scoreSimCase(SIM_CASES[0]!, d1).passed, "Sim 1 wrong critical damping should fail.");

  // 2) Metric change positive + constraint-violating negative
  const d2 = path.join(sandboxRoot, "sim-2");
  mkdirSync(d2, { recursive: true });
  SIM_CASES[1]!.setup(d2);
  const grid = Array.from({ length: 45 }, (_, i) => simRun(d2, 1.0 + 0.25 * i));
  const best = grid.filter((r) => r.overshoot_pct <= 5.0 && r.settling_time_s <= 2.5).sort((a, b) => a.control_energy_j - b.control_energy_j)[0]!;
  writeFiles(d2, {
    "results/optimal_design.json": JSON.stringify({ model_version: "v1-linear", units: { c: "N*s/m", E: "J", t: "s" }, optimal_c_Ns_per_m: best.c_Ns_per_m, metrics: best }, null, 2),
  });
  const s2Ok = scoreSimCase(SIM_CASES[1]!, d2);
  assert(s2Ok.passed, `Sim 2 positive failed: ${JSON.stringify(s2Ok)}`);
  writeFiles(d2, {
    "results/optimal_design.json": JSON.stringify({ model_version: "v1-linear", units: { c: "N*s/m" }, optimal_c_Ns_per_m: 1.0 }, null, 2),
  });
  assert(!scoreSimCase(SIM_CASES[1]!, d2).passed, "Sim 2 constraint-violating design should fail.");

  // 3) Model upgrade positive + un-upgraded linear negative
  const d3 = path.join(sandboxRoot, "sim-3");
  mkdirSync(d3, { recursive: true });
  SIM_CASES[2]!.setup(d3);
  const nlFine = simRun(d3, 4.0, 0.5, 0.0025);
  writeFiles(d3, {
    "results/model_upgrade.json": JSON.stringify({
      model_version: "v2-nonlinear-drag", units: { c: "N*s/m", beta: "N*s^2/m^2", x: "m", t: "s" },
      beta_Ns2_per_m2: 0.5, tolerance_m: 1e-4, final_x_m: nlFine.final_x_m, overshoot_pct: nlFine.overshoot_pct,
    }, null, 2),
  });
  const s3Ok = scoreSimCase(SIM_CASES[2]!, d3);
  assert(s3Ok.passed, `Sim 3 positive failed: ${JSON.stringify(s3Ok)}`);
  const lin = simRun(d3, 4.0, 0.0, 0.0025);
  writeFiles(d3, {
    "results/model_upgrade.json": JSON.stringify({
      model_version: "v2-nonlinear-drag", units: { x: "m" }, beta_Ns2_per_m2: 0.5, tolerance_m: 1e-4,
      final_x_m: lin.final_x_m, overshoot_pct: lin.overshoot_pct,
    }, null, 2),
  });
  assert(!scoreSimCase(SIM_CASES[2]!, d3).passed, "Sim 3 linear-model masquerading as nonlinear should fail.");

  const bundle = buildSimBlindBundle([
    {
      trialId: randomUUID(), caseId: SIM_CASES[0]!.id, arm: "vanilla-omp", model: "dry-run",
      durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failed: false, responseText: "Sweep complete", score: s1Ok,
    },
    {
      trialId: randomUUID(), caseId: SIM_CASES[2]!.id, arm: "fixed-flow", model: "dry-run",
      durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failed: false,
      responseText: "Nonlinear drag verified", internalTraceSummary: "[dev handoff]: hidden", score: s3Ok,
    },
  ]);
  for (const item of bundle.blindItems) {
    assert(detectSimBlindLeaks(item).length === 0, `Sim blind leak detected: ${detectSimBlindLeaks(item).join(", ")}`);
  }

  console.log(JSON.stringify({
    ok: true,
    mode: "dry-run",
    suite: "simulation-ops-cross-domain",
    casesVerified: SIM_CASES.map((c) => c.id),
    rubricChecksPassed: 7,
    blindCandidatesGenerated: bundle.blindItems.length,
  }, null, 2));
}

async function runLiveSimTrial(options: {
  spec: SimCaseSpec; arm: SimEvalArm; model: string; sandboxRoot: string;
}): Promise<SimTrialRecord> {
  const trialId = randomUUID();
  const caseDir = path.join(options.sandboxRoot, `${options.spec.id}-${options.arm}`);
  mkdirSync(caseDir, { recursive: true });
  options.spec.setup(caseDir);

  const ctrlDir = path.join(options.sandboxRoot, `ctrl-${trialId}`);
  mkdirSync(ctrlDir, { recursive: true });
  const cfgPath = path.join(ctrlDir, "pilot-config.yml");
  writeFileSync(cfgPath, "advisor:\n  enabled: false\n", "utf8");
  const lockPath = path.join(ctrlDir, "lock.json");
  writeFileSync(lockPath, JSON.stringify({ settings: { "omp-enhance": { supervisorEnabled: false } } }), "utf8");

  const args = [
    ompBin, "--mode", "rpc", "--no-ui", "--config", cfgPath, "--model", options.model,
    "--thinking", "low", "--cwd", caseDir,
    "--no-session", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-extensions", "--no-title", "--auto-approve",
    ...(options.arm === "vanilla-omp" ? ["--tools", "read,write,edit,grep,glob,find,bash"] : ["--extension", repoRoot]),
  ];

  const startedMs = Date.now();
  const proc = Bun.spawn(args, {
    cwd: caseDir,
    env: {
      ...(process.env as Record<string, string>),
      OMP_ENHANCE_HOME: path.join(ctrlDir, "home"),
      OMP_ENHANCE_GLOBAL_ROLES_DIR: path.join(ctrlDir, "roles"),
      OMP_ENHANCE_PLUGIN_LOCK_PATH: lockPath,
    },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });

  let inputTokens = 0, outputTokens = 0, costUsd = 0, agentEnds = 0;
  const assistantTexts: string[] = [];
  const responseIds = new Set<string>();
  const stdoutTask = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try {
              const ev = JSON.parse(line) as Record<string, unknown>;
              if (ev.type === "agent_end") agentEnds += 1;
              if (ev.type === "response" && typeof ev.id === "string") responseIds.add(ev.id);
              if (ev.type === "message_end" && ev.message && typeof ev.message === "object") {
                const msg = ev.message as Record<string, any>;
                if (msg.role === "assistant") {
                  if (msg.usage) {
                    inputTokens += Number(msg.usage.input ?? 0) + Number(msg.usage.cacheRead ?? 0);
                    outputTokens += Number(msg.usage.output ?? 0);
                    costUsd += Number(msg.usage.cost?.total ?? 0);
                  }
                  const txt = typeof msg.content === "string"
                    ? msg.content
                    : Array.isArray(msg.content) ? msg.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n").trim() : "";
                  if (txt) assistantTexts.push(txt);
                }
              }
            } catch {}
          }
          nl = buf.indexOf("\n");
        }
      }
    } catch {}
  })();

  const waitUntil = async (pred: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end && proc.exitCode === null) await Bun.sleep(150);
    return pred();
  };

  let failed = false, errorMsg: string | undefined;
  try {
    if (options.arm !== "vanilla-omp") {
      proc.stdin.write(`${JSON.stringify({ id: "c1", type: "prompt", message: "/coord" })}\n`);
      await proc.stdin.flush();
      await waitUntil(() => responseIds.has("c1"), 20_000);
    }
    const verifyCmd = `python3 sim/verify_solution.py ${options.spec.taskKind} ${OUTPUT_BY_TASK[options.spec.taskKind]}`;
    const promptMsg = options.arm === "vanilla-omp"
      ? options.spec.userPrompt
      : options.arm === "fixed-flow"
        ? `无需询问确认，我已授权立即执行：请直接调用 enhance_flow(action="start", preset="custom", goal=${JSON.stringify(options.spec.userPrompt)}, nodes=[{"id":"plan","kind":"role","role":"planner","dependsOn":[]},{"id":"impl","kind":"role","role":"dev","dependsOn":["plan"],"requiredChecks":[${JSON.stringify(verifyCmd)}]},{"id":"verify","kind":"gate","dependsOn":["impl"],"gate":{"command":${JSON.stringify(verifyCmd)}}}], wait=true) 并汇报结果。`
        : `无需询问确认，我已授权立即执行：请根据任务复杂度自行选择最合适的专员/流程完成并汇报核实结果：\n\n${options.spec.userPrompt}`;
    const before = agentEnds;
    proc.stdin.write(`${JSON.stringify({ id: "s1", type: "prompt", message: promptMsg })}\n`);
    await proc.stdin.flush();
    if (!(await waitUntil(() => agentEnds > before, 240_000))) {
      failed = true;
      errorMsg = "Timed out waiting for simulation turn.";
    }
  } catch (err) {
    failed = true;
    errorMsg = err instanceof Error ? err.message : String(err);
  } finally {
    try { proc.stdin.end(); } catch {}
    try { proc.kill("SIGTERM"); } catch {}
    await Promise.race([proc.exited, Bun.sleep(3_000)]);
    await Promise.race([stdoutTask, Bun.sleep(1_000)]);
  }

  const userVisible = assistantTexts.at(-1) ?? "";
  const executedRoles = new Set<string>();
  const traceSections: string[] = [];
  const dbPath = path.join(caseDir, ".omp-enhance", "state.sqlite");
  if (existsSync(dbPath)) {
    const store = new EnhanceStore(dbPath);
    try {
      for (const h of store.listHandoffs()) {
        if (h.fromRole !== "user") executedRoles.add(h.fromRole);
        if (h.observedUsage) {
          inputTokens += h.observedUsage.inputTokens;
          outputTokens += h.observedUsage.outputTokens;
          costUsd += h.observedUsage.costUsd;
        }
        if (h.fromRole !== "user") traceSections.push(`[${h.fromRole} handoff]: ${h.summary}`);
      }
    } finally { store.close(); }
  }

  const score = scoreSimCase(options.spec, caseDir);
  return {
    trialId, caseId: options.spec.id, arm: options.arm, model: options.model,
    durationMs: Date.now() - startedMs, inputTokens, outputTokens,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    failed, ...(errorMsg ? { error: errorMsg } : {}),
    responseText: userVisible,
    ...(traceSections.length ? { internalTraceSummary: traceSections.join("\n") } : {}),
    ...(executedRoles.size ? { executedRoles: [...executedRoles].sort() } : {}),
    score,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const isLive = argv.includes("--live");
  const model = (argv.indexOf("--model") >= 0 ? argv[argv.indexOf("--model") + 1] : undefined) ?? process.env.OMP_PILOT_MODEL ?? "@task";
  const outPath = argv.indexOf("--out") >= 0 ? argv[argv.indexOf("--out") + 1] : undefined;
  const sandboxRoot = mkdtempSync(path.join(tmpdir(), "omp-sim-pilot-"));
  try {
    if (!isLive) { runDryRunSelfCheck(sandboxRoot); return; }
    assert(existsSync(ompBin), `omp binary not found at ${ompBin}`);
    const arms: SimEvalArm[] = ["vanilla-omp", "coord-autonomous", "fixed-flow"];
    const trials: SimTrialRecord[] = [];
    for (const spec of SIM_CASES) {
      for (const arm of arms) {
        console.log(`running [${spec.id}] arm=${arm} model=${model}...`);
        const rec = await runLiveSimTrial({ spec, arm, model, sandboxRoot });
        trials.push(rec);
        console.log(`  -> passed=${rec.score.passed && !rec.failed} duration=${rec.durationMs}ms tokens=${rec.inputTokens + rec.outputTokens}`);
      }
    }
    const bundle = buildSimBlindBundle(trials);
    const byArm = Object.fromEntries(arms.map((arm) => {
      const sub = trials.filter((t) => t.arm === arm);
      return [arm, {
        passedCount: sub.filter((t) => t.score.passed && !t.failed).length,
        totalCases: sub.length,
        totalDurationMs: sub.reduce((s, t) => s + t.durationMs, 0),
        totalTokens: sub.reduce((s, t) => s + t.inputTokens + t.outputTokens, 0),
        totalCostUsd: Math.round(sub.reduce((s, t) => s + t.costUsd, 0) * 1_000_000) / 1_000_000,
      }];
    }));
    const target = outPath ? path.resolve(outPath) : path.join(tmpdir(), `omp-sim-pilot-${Date.now()}.json`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ generatedAt: new Date().toISOString(), model, summaryByArm: byArm, blindBundle: bundle.blindItems, answerKey: bundle.answerKey, trials }, null, 2) + "\n", "utf8");
    console.log(`saved sim pilot report: ${target}`);
    console.log(JSON.stringify(byArm, null, 2));
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
