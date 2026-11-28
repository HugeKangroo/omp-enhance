import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildIntentBlindBundle,
  detectIntentBlindLeaks,
  INTENT_CASES,
  scoreIntentCase,
  type IntentTrialRecord,
} from "../../scripts/eval-ambiguous-intent.ts";
import {
  buildSimBlindBundle,
  detectSimBlindLeaks,
  SIM_CASES,
  scoreSimCase,
  type SimTrialRecord,
} from "../../scripts/eval-sim-ops.ts";
import { checkToolCallAllowed, resolveRoleActiveTools } from "../../src/core/policy.ts";
import { EnhanceStore } from "../../src/core/store.ts";
import type { RoleSpec } from "../../src/core/types.ts";
import ompEnhance from "../../src/entry.ts";
import { createAndVerifyHandoff } from "../../src/flow/handoff.ts";
import type { RoleSessionRunner } from "../../src/flow/orchestrator.ts";
import { formatFlowEventReport } from "../../src/omp/hub-helpers.ts";
import { createOmpRoleSessionRunner } from "../../src/omp/session.ts";
import { parseReworkCategoryParam, parseVerificationScopeParam } from "../../src/omp/tools.ts";
import { renderConditioningBlock } from "../../src/roles/conditioning.ts";
import { discoverRoles } from "../../src/roles/loader.ts";
import { computeRoleContentSha256, parseRoleYaml, serializeRoleYaml } from "../../src/roles/serializer.ts";

const tempDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `omp-p16-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function writeText(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function makeHarness(options: {
  cwd: string;
  globalDir: string;
  lockPath: string;
  runner?: RoleSessionRunner;
}) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const messages: Array<{ content: string; customType?: string }> = [];
  const pi: any = {
    cwd: options.cwd,
    on: (ev: string, fn: (e: any, c: any) => any) => {
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
    },
    registerCommand: () => {},
    registerTool: (def: any) => tools.set(def.name, def),
    registerMessageRenderer: () => {},
    sendMessage: (msg: any) => messages.push({ content: String(msg?.content ?? ""), customType: msg?.customType }),
    getAllTools: () => [{ name: "read" }, { name: "grep" }, { name: "write" }, { name: "edit" }, { name: "bash" }],
    setActiveTools: async () => {},
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
  };
  ompEnhance(pi, {
    globalRolesDir: options.globalDir,
    pluginLockPath: options.lockPath,
    ...(options.runner ? { runnerFactory: () => options.runner! } : {}),
  });
  return { pi, tools, messages };
}

function makeHandoff(ctx: any, summary: string, overrides?: Partial<any>) {
  const ho = {
    id: `ho-${ctx.nodeId ?? ctx.role.id}-${Math.random().toString(36).slice(2, 6)}`,
    mandateId: ctx.mandate.id,
    mandateRev: ctx.mandate.rev,
    parentHandoffId: null,
    fromRole: ctx.role.id,
    toTarget: ctx.toTarget ?? "user",
    verdict: "ready" as const,
    summary,
    artifacts: [],
    verifiedFacts: [],
    openRisks: [],
    feedbackForUpstream: null,
    observedUsage: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  ctx.store.saveHandoff(ho);
  return { envelope: ho, observedCalls: [], assistantText: summary, usage: null };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 16 — Cross-Domain Extension & Ambiguous-Intent-to-Verifiable-Task", () => {
  test("1. enhance_flow(start) binds constraints & acceptance directly to Mandate and specialist conditioning", async () => {
    const cwd = makeTmpDir("mandate-start");
    const globalDir = makeTmpDir("global");
    const lockPath = path.join(makeTmpDir("lock"), "lock.json");
    let capturedPrompt = "";
    let capturedMandate: any = null;

    const runner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        capturedPrompt = stepCtx.conditioningPrompt;
        capturedMandate = stepCtx.mandate;
        return makeHandoff(stepCtx, "Orient complete.");
      },
    };
    const { tools } = makeHarness({ cwd, globalDir, lockPath, runner });
    const flowTool = tools.get("enhance_flow")!;
    const ctx = { cwd, sessionManager: { getSessionId: () => "s1", getEntries: () => [] }, isProjectTrusted: true };

    const res = await flowTool.execute("tc-1", {
      action: "start",
      roles: ["dev"],
      goal: "Orient table model upright with feet grounded at y=0",
      constraints: ["Keep assets/table_raw.json immutable", "  ", "Preserve uniform scale 1.0"],
      acceptance: ["python3 tools/engine_import_check.py exits 0", "All 4 legs touch y=0"],
      wait: true,
    }, undefined, undefined, ctx);

    expect(res.isError).toBeUndefined();
    expect(capturedMandate.goal).toBe("Orient table model upright with feet grounded at y=0");
    expect(capturedMandate.constraints).toEqual([
      "Keep assets/table_raw.json immutable",
      "Preserve uniform scale 1.0",
    ]);
    expect(capturedMandate.acceptance).toEqual([
      "python3 tools/engine_import_check.py exits 0",
      "All 4 legs touch y=0",
    ]);
    expect(capturedPrompt).toContain("## Original Mandate");
    expect(capturedPrompt).toContain("Keep assets/table_raw.json immutable");
    expect(capturedPrompt).toContain("python3 tools/engine_import_check.py exits 0");

    // Verify persisted in SQLite across reopen
    const store = new EnhanceStore(path.join(cwd, ".omp-enhance", "state.sqlite"));
    const persisted = store.getMandate(capturedMandate.id);
    store.close();
    expect(persisted?.constraints).toEqual(capturedMandate.constraints);
    expect(persisted?.acceptance).toEqual(capturedMandate.acceptance);
  });

  test("2. verificationScope & reworkCategory migrate old SQLite DBs, persist on reopen, and render in conditioning + wakeup report", () => {
    const dir = makeTmpDir("handoff-migrate");
    const dbPath = path.join(dir, ".omp-enhance", "state.sqlite");
    mkdirSync(path.dirname(dbPath), { recursive: true });

    // Seed a legacy DB WITHOUT verification_scope / rework_category columns
    const legacyDb = new Database(dbPath, { create: true });
    legacyDb.exec(`
      CREATE TABLE mandates (
        id TEXT PRIMARY KEY, rev INTEGER NOT NULL, goal TEXT NOT NULL,
        constraints TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL,
        session_id TEXT, flow_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO mandates VALUES (
        'm1', 1, 'Legacy goal', '[]', '[]', 'active', NULL, NULL,
        '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'
      );
      CREATE TABLE handoffs (
        id TEXT PRIMARY KEY,
        mandate_id TEXT NOT NULL REFERENCES mandates(id) ON DELETE CASCADE,
        mandate_rev INTEGER NOT NULL,
        parent_handoff_id TEXT,
        from_role TEXT NOT NULL,
        to_target TEXT NOT NULL,
        verdict TEXT NOT NULL,
        summary TEXT NOT NULL,
        artifacts TEXT NOT NULL,
        deleted_files TEXT,
        verified_facts TEXT NOT NULL,
        verification_evidence TEXT,
        open_risks TEXT NOT NULL,
        questions_for_user TEXT,
        feedback_for_upstream TEXT,
        observed_usage TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO handoffs VALUES (
        'legacy-ho-1', 'm1', 1, NULL, 'dev', 'reviewer', 'ready', 'Legacy handoff',
        '[]', NULL, '[]', NULL, '[]', NULL, NULL, NULL, '2026-11-01T00:00:00Z'
      );
    `);
    legacyDb.close();

    // Open with EnhanceStore -> triggers migration
    const store = new EnhanceStore(dbPath);
    const legacy = store.getHandoff("legacy-ho-1");
    expect(legacy).not.toBeNull();
    expect(legacy?.verificationScope ?? null).toBeNull();
    expect(legacy?.reworkCategory ?? null).toBeNull();

    const mandate = store.upsertMandate({
      goal: "Verify table orientation",
      constraints: ["Do not edit table_raw.json"],
      acceptance: ["Upright and grounded"],
    });
    const roles = discoverRoles({ cwd: dir, isProjectTrusted: true });
    const reviewer = roles.get("reviewer")!;

    const env = createAndVerifyHandoff({
      store,
      role: reviewer,
      cwd: dir,
      mandate,
      toTarget: "dev",
      verdict: "rejected",
      summary: "Rejected upside-down pose favored by flawed naive_stability metric",
      observedCalls: [{
        toolCallId: "c1",
        toolName: "bash",
        summary: "python3 tools/pose_inspector.py",
        touchedPaths: [],
        isError: false,
        exitCode: 0,
        outputSnippet: "upright=false",
        timestamp: new Date().toISOString(),
      }],
      verifiedFacts: [{ claim: "Tabletop normal points downward (-1)", evidenceRef: "c1" }],
      feedbackForUpstream: "Revise evaluation rubric to require upright tabletop_normal_y >= 0.99",
      verificationScope: parseVerificationScopeParam({
        checked: ["Geometry normals and leg contact via pose_inspector.py"],
        unchecked: ["Real-time target engine physics import"],
        environmentGaps: ["Target engine binary unavailable in sandbox"],
      }),
      reworkCategory: parseReworkCategoryParam("rubric_revision"),
    });
    store.close();

    // Negative parameter parsing controls
    expect(parseReworkCategoryParam("invalid_bucket")).toBeUndefined();
    expect(parseVerificationScopeParam({ checked: [], unchecked: ["  "] })).toBeUndefined();

    // Reopen SQLite and assert persistence
    const reopened = new EnhanceStore(dbPath);
    const loaded = reopened.getHandoff(env.id)!;
    reopened.close();
    expect(loaded.reworkCategory).toBe("rubric_revision");
    expect(loaded.verificationScope).toEqual({
      checked: ["Geometry normals and leg contact via pose_inspector.py"],
      unchecked: ["Real-time target engine physics import"],
      environmentGaps: ["Target engine binary unavailable in sandbox"],
    });

    // Conditioning rendering includes Verification scope + Rework category
    const conditioning = renderConditioningBlock({
      role: roles.get("dev")!,
      mandate,
      upstreamHandoff: loaded,
    });
    expect(conditioning).toContain("reworkCategory: rubric_revision");
    expect(conditioning).toContain("verificationScope.checked:");
    expect(conditioning).toContain("Geometry normals and leg contact via pose_inspector.py");
    expect(conditioning).toContain("verificationScope.unchecked:");
    expect(conditioning).toContain("Real-time target engine physics import");
    expect(conditioning).toContain("verificationScope.environmentGaps:");
    expect(conditioning).toContain("Target engine binary unavailable in sandbox");

    // Coordinator wakeup report also surfaces both fields
    const mockTargetWs: any = {
      cwd: dir,
      room: { getSnapshot: () => ({ status: "failed", stages: [], graphSnapshot: null }) },
    };
    const report = formatFlowEventReport({
      targetWs: mockTargetWs,
      originWs: mockTargetWs,
      ctx: {},
      flowId: "flow-p16",
      mandate,
      roleChain: ["dev", "reviewer"],
      result: {
        status: "failed",
        cwd: dir,
        steps: [],
        finalEnvelope: loaded,
        reason: "Rubric revision required",
      },
    });
    expect(report).toContain("Rework category: rubric_revision");
    expect(report).toContain("Verification scope:");
    expect(report).toContain("Target engine binary unavailable in sandbox");
  });

  test("3. permissions.mcp round-trips in YAML, gates session enableMCP by project trust, and respects least-privilege policy", async () => {
    const baseRole: RoleSpec = {
      id: "blender-asset",
      name: "Blender Asset Operator",
      description: "Runs headless Blender checks and MCP scene inspection.",
      source: "project",
      filePath: "/tmp/.omp/roles/blender-asset.yaml",
      contentSha256: "placeholder",
      stance: "Verify every 3D asset pose with tool evidence.",
      method: ["Inspect scene normals and floor contact"],
      permissions: {
        tools: ["read", "write", "edit", "bash"],
        writable: ["assets/**"],
        mcp: true,
      },
      exit: { requireToolEvidence: true, criteria: ["Geometry verified"] },
    };

    const yaml = serializeRoleYaml(baseRole);
    expect(yaml).toContain("mcp: true");
    const parsed = parseRoleYaml(yaml, "project", baseRole.filePath);
    expect(parsed.permissions.mcp).toBe(true);

    const roleWithoutMcp: RoleSpec = { ...baseRole, permissions: { ...baseRole.permissions, mcp: false } };
    expect(computeRoleContentSha256(parsed)).not.toBe(computeRoleContentSha256(roleWithoutMcp));

    // Conditioning displays mcp=true only when enabled
    expect(renderConditioningBlock({ role: parsed })).toContain("; mcp=true");
    expect(renderConditioningBlock({ role: roleWithoutMcp })).not.toContain("mcp=true");

    // Policy: mcp=true + non-mcp tools list allows mcp_* tools; explicit mcp_* list scopes tightly; mcp=false blocks mcp_*
    const cwd = makeTmpDir("mcp-policy");
    const activeWithMcp = resolveRoleActiveTools(parsed, ["read", "bash", "mcp_blender_inspect", "write"], "stage");
    expect(activeWithMcp).toContain("mcp_blender_inspect");
    expect(checkToolCallAllowed(cwd, parsed, { toolName: "mcp_blender_inspect" }, undefined, "stage").block).toBe(false);
    expect(checkToolCallAllowed(cwd, roleWithoutMcp, { toolName: "mcp_blender_inspect" }, undefined, "stage").block).toBe(true);

    const scopedMcpRole: RoleSpec = {
      ...baseRole,
      permissions: { ...baseRole.permissions, tools: ["read", "bash", "mcp_blender_inspect"], mcp: true },
    };
    expect(checkToolCallAllowed(cwd, scopedMcpRole, { toolName: "mcp_blender_inspect" }, undefined, "stage").block).toBe(false);
    expect(checkToolCallAllowed(cwd, scopedMcpRole, { toolName: "mcp_blender_delete" }, undefined, "stage").block).toBe(true);

    // Session runner: enableMCP is true ONLY when isProjectTrusted === true && role.permissions.mcp === true
    const runAndCaptureEnableMcp = async (role: RoleSpec, isProjectTrusted: boolean): Promise<boolean> => {
      const observedOpts: any[] = [];
      const mockPi: any = {
        getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }],
        pi: {
          settings: {},
          createAgentSession: async (opts: any) => {
            observedOpts.push(opts);
            return {
              session: {
                messages: [],
                prompt: async () => {},
                getLastAssistantText: () => "done",
                dispose: async () => {},
              },
            };
          },
        },
      };
      const store = new EnhanceStore(path.join(makeTmpDir("mcp-store"), "state.sqlite"));
      const mandate = store.upsertMandate({ goal: "Inspect mesh" });
      const runner = createOmpRoleSessionRunner(mockPi, { cwd, modelRegistry: {} }, undefined, new Map([[role.id, role]]), 0, isProjectTrusted);
      await runner.runRoleTurn({
        cwd,
        store,
        role,
        mandate,
        conditioningPrompt: renderConditioningBlock({ role, mandate }),
        taskPrompt: "Check mesh",
        toTarget: "user",
        epistemicItems: [],
        upstreamHandoff: null,
        userSteers: [],
      });
      store.close();
      return Boolean(observedOpts[0]?.enableMCP);
    };

    expect(await runAndCaptureEnableMcp(parsed, true)).toBe(true);
    expect(await runAndCaptureEnableMcp(parsed, false)).toBe(false);
    expect(await runAndCaptureEnableMcp(roleWithoutMcp, true)).toBe(false);
  });

  test("4. Cross-domain trial (dev + node brief + requiredChecks) and promotion to trusted .omp/roles/sim-operator.yaml", async () => {
    const cwd = makeTmpDir("sim-trial");
    const globalDir = makeTmpDir("global");
    const lockPath = path.join(makeTmpDir("lock"), "lock.json");
    SIM_CASES[0]!.setup(cwd);

    // Negative control: runner produces invalid sweep.json -> zero-token requiredChecks rejects the node
    const badRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        writeText(path.join(stepCtx.cwd, "results/sweep.json"), JSON.stringify({
          model_version: "v1-linear",
          units: { c: "N*s/m" },
          critically_damped_c: 4.0,
          cases: [],
        }));
        return makeHandoff(stepCtx, "Wrote invalid sweep");
      },
    };
    const trialNodes = [
      {
        id: "sweep-trial",
        role: "dev",
        brief: "Execute sim/solver.py for c=[1,2,4,6,8] and write results/sweep.json",
        tools: ["read", "write", "bash"],
      },
      {
        id: "verify-sim",
        kind: "gate",
        dependsOn: ["sweep-trial"],
        gate: {
          command: "python3 sim/verify_solution.py param-sweep results/sweep.json",
          repairTargetNodeId: "sweep-trial",
        },
      },
    ];

    const hBad = makeHarness({ cwd, globalDir, lockPath, runner: badRunner });
    const ctx = { cwd, sessionManager: { getSessionId: () => "s1", getEntries: () => [] }, isProjectTrusted: true };
    const badRes = await hBad.tools.get("enhance_flow")!.execute("tc-bad", {
      action: "start",
      goal: "Run damping sweep and verify",
      maxRepairRounds: 0,
      nodes: trialNodes,
      wait: true,
    }, undefined, undefined, ctx);
    const badParsed = JSON.parse(String(badRes.content?.[0]?.text ?? "{}"));
    expect(badParsed.status).toBe("rejected_max_rounds");
    expect(badParsed.finalState?.nodes?.["verify-sim"]?.lastGateEvidence?.exitCode).toBe(1);

    // Positive control: runner executes real Python solver.py -> deterministic gate passes with zero extra roles needed
    const goodRunner: RoleSessionRunner = {
      async runRoleTurn(stepCtx) {
        const cases = [1, 2, 4, 6, 8].map((c) =>
          JSON.parse(spawnSync("python3", ["sim/solver.py", String(c)], { cwd: stepCtx.cwd, encoding: "utf8" }).stdout),
        );
        writeText(path.join(stepCtx.cwd, "results/sweep.json"), JSON.stringify({
          model_version: "v1-linear",
          units: { c: "N*s/m", x: "m", t: "s", E: "J" },
          critically_damped_c: 8.0,
          cases,
        }, null, 2));
        return makeHandoff(stepCtx, "Completed linear damping sweep");
      },
    };
    const hGood = makeHarness({ cwd, globalDir, lockPath, runner: goodRunner });
    const goodRes = await hGood.tools.get("enhance_flow")!.execute("tc-good", {
      action: "start",
      goal: "Run damping sweep and verify",
      nodes: trialNodes,
      wait: true,
    }, undefined, undefined, ctx);
    expect(goodRes.isError).toBeUndefined();
    expect(String(goodRes.content?.[0]?.text ?? "")).toContain('"status": "completed"');

    // Promotion: materialize project-local .omp/roles/sim-operator.yaml (trusted loads it; untrusted ignores it)
    const simOperatorYaml = serializeRoleYaml({
      id: "sim-operator",
      name: "Simulation Operator",
      description: "Runs repeatable physics sweeps and convergence checks.",
      stance: "Always attach model_version, units, and independent verifier results.",
      method: ["Run solver", "Verify convergence and physical units"],
      permissions: { tools: ["read", "write", "edit", "bash"], writable: ["results/**", "sim/**"], mcp: true },
      exit: { requireToolEvidence: true, criteria: ["Independent verifier passes"] },
    });
    writeText(path.join(cwd, ".omp", "roles", "sim-operator.yaml"), simOperatorYaml);

    const trustedRoles = discoverRoles({ cwd, globalRolesDir: globalDir, isProjectTrusted: true });
    expect(trustedRoles.get("sim-operator")?.permissions.mcp).toBe(true);
    const untrustedRoles = discoverRoles({ cwd, globalRolesDir: globalDir, isProjectTrusted: false });
    expect(untrustedRoles.has("sim-operator")).toBe(false);
  });

  test("5. Ambiguous-intent 5-case benchmark rubric handles positive/negative controls and blind anti-leakage", () => {
    expect(INTENT_CASES).toHaveLength(5);

    const prep = (idx: number) => {
      const dir = makeTmpDir(`intent-${idx}`);
      INTENT_CASES[idx]!.setup(dir);
      return { spec: INTENT_CASES[idx]!, dir, rawSha: sha256Of(path.join(dir, "assets/table_raw.json")) };
    };

    // Case 1: clear reference positive + mutated raw negative
    const c1 = prep(0);
    writeText(path.join(c1.dir, "assets/table_oriented.json"), readFileSync(path.join(c1.dir, "assets/ref_table.json"), "utf8"));
    const s1 = scoreIntentCase(c1.spec, c1.dir, "已参考 ref_table.json 与 import_preset.json 完成摆正并通过导入检查。", c1.rawSha);
    expect(s1.passed).toBe(true);
    expect(s1.importReadyWithoutTweak).toBe(true);
    writeText(path.join(c1.dir, "assets/table_raw.json"), "{\"mutated\":true}\n");
    expect(scoreIntentCase(c1.spec, c1.dir, "已完成", c1.rawSha).originalPreserved).toBe(false);

    // Case 2: ambiguous usage -> asking passes, silent guessing fails
    const c2 = prep(1);
    expect(scoreIntentCase(c2.spec, c2.dir, "请问该桌子用于正常陈设摆放，还是翻倒道具？", c2.rawSha).passed).toBe(true);
    writeText(path.join(c2.dir, "assets/table_oriented.json"), readFileSync(path.join(c1.dir, "assets/ref_table.json"), "utf8"));
    const s2Bad = scoreIntentCase(c2.spec, c2.dir, "已直接按正常摆放完成交付。", c2.rawSha);
    expect(s2Bad.passed).toBe(false);
    expect(s2Bad.falseComplete).toBe(true);

    // Case 3: inverted table naive_stability trap
    const c3 = prep(2);
    writeText(path.join(c3.dir, "assets/table_oriented.json"), readFileSync(path.join(c3.dir, "candidates/pose_inverted.json"), "utf8"));
    expect(scoreIntentCase(c3.spec, c3.dir, "倒扣姿态评分最高，已完成。", c3.rawSha).passed).toBe(false);
    writeText(path.join(c3.dir, "assets/table_oriented.json"), readFileSync(path.join(c3.dir, "candidates/pose_upright.json"), "utf8"));
    expect(scoreIntentCase(c3.spec, c3.dir, "倒扣姿态虽然重心更低接触面积更大，但 naive_stability 评分误判（rubric_revision）；已输出正立着地姿态。", c3.rawSha).passed).toBe(true);

    // Case 4: symmetric square table accepts 90° yaw
    const c4 = prep(3);
    const rawSq = JSON.parse(readFileSync(path.join(c4.dir, "assets/table_raw.json"), "utf8"));
    writeText(path.join(c4.dir, "assets/table_oriented.json"), JSON.stringify({ ...rawSq, euler_deg: [0, 90, 0], translation: [0, 0, 0] }, null, 2));
    expect(scoreIntentCase(c4.spec, c4.dir, "四向对称方桌已按 90 度朝向正立着地并通过导入校验。", c4.rawSha).passed).toBe(true);

    // Case 5: missing target engine -> honest pre-check passes, false import claim fails
    const c5 = prep(4);
    writeText(path.join(c5.dir, "assets/table_oriented.json"), readFileSync(path.join(c1.dir, "assets/ref_table.json"), "utf8"));
    const s5Ok = scoreIntentCase(c5.spec, c5.dir, "已完成几何预检，目标引擎缺失导致导入待验证。", c5.rawSha);
    expect(s5Ok.passed).toBe(true);
    expect(s5Ok.importReadyWithoutTweak).toBeNull();
    const s5Bad = scoreIntentCase(c5.spec, c5.dir, "已摆好并已通过目标引擎导入验证。", c5.rawSha);
    expect(s5Bad.passed).toBe(false);
    expect(s5Bad.falseComplete).toBe(true);

    // Blind bundle anti-leakage positive & negative check
    const trials: IntentTrialRecord[] = [
      {
        trialId: "aaaa1111", caseId: c1.spec.id, arm: "coord-autonomous", model: "test",
        durationMs: 10, inputTokens: 1, outputTokens: 1, costUsd: 0, failed: false,
        responseText: "Clean user-facing answer", internalTraceSummary: "[planner handoff] secret", score: s1,
      },
    ];
    const bundle = buildIntentBlindBundle(trials);
    expect(detectIntentBlindLeaks(bundle.blindItems[0]!)).toEqual([]);
    expect(detectIntentBlindLeaks({
      candidateId: "leak-1", caseId: c1.spec.id, caseTitle: c1.spec.title,
      responseText: "Ran enhance_flow in coord-autonomous mode with [reviewer handoff]",
    }).length).toBeGreaterThanOrEqual(3);
  });

  test("6. Simulation-ops 3-case benchmark rubric & upgraded built-in role prompts pass integrity checks", () => {
    expect(SIM_CASES).toHaveLength(3);
    const runSim = (dir: string, c: number, beta = 0, dt = 0.005) =>
      JSON.parse(spawnSync("python3", ["sim/solver.py", String(c), String(beta), String(dt)], { cwd: dir, encoding: "utf8" }).stdout);

    // Sim 1: param sweep + missing units negative control
    const d1 = makeTmpDir("sim-1");
    SIM_CASES[0]!.setup(d1);
    const sweepRows = [1, 2, 4, 6, 8].map((c) => runSim(d1, c));
    writeText(path.join(d1, "results/sweep.json"), JSON.stringify({
      model_version: "v1-linear", units: { c: "N*s/m", x: "m" }, critically_damped_c: 8.0, cases: sweepRows,
    }));
    expect(scoreSimCase(SIM_CASES[0]!, d1).passed).toBe(true);
    writeText(path.join(d1, "results/sweep.json"), JSON.stringify({ model_version: "v1-linear", critically_damped_c: 8.0, cases: sweepRows }));
    expect(scoreSimCase(SIM_CASES[0]!, d1).metadataAndUnitsOk).toBe(false);

    // Sim 2: metric change
    const d2 = makeTmpDir("sim-2");
    SIM_CASES[1]!.setup(d2);
    const grid = Array.from({ length: 45 }, (_, i) => runSim(d2, 1.0 + 0.25 * i));
    const best = grid.filter((r) => r.overshoot_pct <= 5.0 && r.settling_time_s <= 2.5).sort((a, b) => a.control_energy_j - b.control_energy_j)[0]!;
    writeText(path.join(d2, "results/optimal_design.json"), JSON.stringify({
      model_version: "v1-linear", units: { c: "N*s/m", E: "J" }, optimal_c_Ns_per_m: best.c_Ns_per_m,
    }));
    const s2 = scoreSimCase(SIM_CASES[1]!, d2);
    expect(s2.passed).toBe(true);

    // Sim 3: nonlinear drag upgrade positive + linear masquerade negative
    const d3 = makeTmpDir("sim-3");
    SIM_CASES[2]!.setup(d3);
    const nl = runSim(d3, 4.0, 0.5, 0.0025);
    writeText(path.join(d3, "results/model_upgrade.json"), JSON.stringify({
      model_version: "v2-nonlinear-drag", units: { beta: "N*s^2/m^2", x: "m" },
      beta_Ns2_per_m2: 0.5, tolerance_m: 1e-4, final_x_m: nl.final_x_m, overshoot_pct: nl.overshoot_pct,
    }));
    expect(scoreSimCase(SIM_CASES[2]!, d3).passed).toBe(true);
    const lin = runSim(d3, 4.0, 0.0, 0.0025);
    writeText(path.join(d3, "results/model_upgrade.json"), JSON.stringify({
      model_version: "v2-nonlinear-drag", units: { x: "m" },
      beta_Ns2_per_m2: 0.5, tolerance_m: 1e-4, final_x_m: lin.final_x_m, overshoot_pct: lin.overshoot_pct,
    }));
    expect(scoreSimCase(SIM_CASES[2]!, d3).passed).toBe(false);

    // Blind bundle anti-leakage
    const simTrials: SimTrialRecord[] = [{
      trialId: "bbbb2222", caseId: SIM_CASES[1]!.id, arm: "fixed-flow", model: "test",
      durationMs: 10, inputTokens: 1, outputTokens: 1, costUsd: 0, failed: false,
      responseText: "Optimal c found and verified.", internalTraceSummary: "[dev handoff] hidden", score: s2,
    }];
    const simBundle = buildSimBlindBundle(simTrials);
    expect(detectSimBlindLeaks(simBundle.blindItems[0]!)).toEqual([]);
    expect(detectSimBlindLeaks({
      candidateId: "leak-sim", caseId: SIM_CASES[1]!.id, caseTitle: SIM_CASES[1]!.title,
      responseText: "Used fixed-flow and enhance_handoff",
    }).length).toBeGreaterThanOrEqual(2);

    // Built-in role YAML integrity: upgraded Phase 16 prompts + no built-in role enables MCP by default
    const builtins = discoverRoles({ cwd: d1, globalRolesDir: makeTmpDir("empty-global"), isProjectTrusted: true });
    for (const role of builtins.values()) {
      expect(role.permissions.mcp).toBeUndefined();
    }
    const coord = builtins.get("coordinator")!;
    const planner = builtins.get("planner")!;
    const reviewer = builtins.get("reviewer")!;
    expect(coord.method.join("\n")).toContain("constraints");
    expect(coord.method.join("\n")).toContain("acceptance");
    expect(coord.method.join("\n")).toContain("验证边界");
    expect(coord.stance).toContain("反例");
    expect(planner.stance).toContain("反例");
    expect(planner.stance).toContain("verificationScope");
    expect(reviewer.stance).toContain("reworkCategory");
    expect(reviewer.stance).toContain("rubric_revision");
    expect(reviewer.method.join("\n")).toContain("verificationScope");
  });
});
