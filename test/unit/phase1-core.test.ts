import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  diffSnapshots, EnhanceStore, findProtectedViolations, matchesGlobList, snapshotWorkspace,
} from "../../src/store.ts";
import {
  discoverRoles, parseRoleYaml, renderConditioningBlock, scaffoldRoleFile,
} from "../../src/role-loader.ts";
import {
  COMPANION_TOOL_NAMES, extractWriteTargetPaths, resolveRoleActiveTools, TurnTracker,
} from "../../src/session-tracker.ts";
import { createAndVerifyHandoff } from "../../src/handoff.ts";
import type {
  BackgroundJob, EpistemicItem, HandoffEnvelope, Mandate, ObservedToolCall,
} from "../../src/types.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-enhance-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relPath: string, content: string): void {
  const fullPath = path.join(root, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function roleYaml(name: string, stance: string): string {
  return `id: qa\nname: ${JSON.stringify(name)}\nstance: ${JSON.stringify(stance)}\nmethod:\n  - follow evidence\n`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace snapshots and globs", () => {
  test("matches nested and root-level globs", () => {
    expect(matchesGlobList("src/app.ts", ["src/**"])).toBe(true);
    expect(matchesGlobList("./src/sub/app.ts", ["src/**"])).toBe(true);
    expect(matchesGlobList("test/app.test.ts", ["**/*.test.*"])).toBe(true);
    expect(matchesGlobList("README.md", ["**"])).toBe(true);
    expect(matchesGlobList("src/app.ts", ["**"])).toBe(true);
    expect(matchesGlobList("README.md", ["src/**"])).toBe(false);
  });

  test("hashes files, skips ignored dirs, and finds protected violations", () => {
    const cwd = tempDir();
    writeFile(cwd, "src/a.ts", "export const a = 1;\n");
    writeFile(cwd, "src/b.ts", "export const b = 2;\n");
    writeFile(cwd, "README.md", "# Before\n");
    writeFile(cwd, "node_modules/pkg/index.js", "ignored\n");
    writeFile(cwd, ".git/config", "ignored\n");
    writeFile(cwd, ".omp/state.json", "ignored\n");
    writeFile(cwd, ".omp-enhance/state.sqlite", "ignored\n");

    const before = snapshotWorkspace(cwd);
    expect([...before.keys()].sort()).toEqual(["README.md", "src/a.ts", "src/b.ts"]);
    expect(before.get("src/a.ts")?.sha256).toBe(createHash("sha256").update("export const a = 1;\n").digest("hex"));
    expect(before.get("src/a.ts")?.byteSize).toBe(20);

    writeFile(cwd, "src/a.ts", "export const a = 10;\n");
    writeFile(cwd, "src/c.ts", "export const c = 3;\n");
    writeFile(cwd, "README.md", "# After\n");
    rmSync(path.join(cwd, "src/b.ts"));

    const after = snapshotWorkspace(cwd);
    expect(diffSnapshots(before, after)).toEqual({
      added: ["src/c.ts"],
      modified: ["README.md", "src/a.ts"],
      deleted: ["src/b.ts"],
    });
    expect(findProtectedViolations(cwd, before, ["src/**"])).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(findProtectedViolations(cwd, before, ["**"])).toEqual([
      "README.md", "src/a.ts", "src/b.ts", "src/c.ts",
    ]);
    expect(findProtectedViolations(cwd, before, [])).toEqual([]);

    const onlySource = snapshotWorkspace(cwd, ["src/**"]);
    expect([...onlySource.keys()].sort()).toEqual(["src/a.ts", "src/c.ts"]);
  });
});

describe("EnhanceStore", () => {
  test("tracks mandate revisions, archiving, and active mandate selection", () => {
    const store = new EnhanceStore(path.join(tempDir(), "nested", "state.sqlite"));
    try {
      const first = store.upsertMandate({ goal: "Harden auth", constraints: ["no new deps"], acceptance: ["tests pass"] });
      expect(first.rev).toBe(1);
      expect(first.status).toBe("active");
      expect(first.createdAt).toBe(first.updatedAt);
      expect(store.getActiveMandate()?.id).toBe(first.id);

      const revised = store.upsertMandate({ id: first.id, goal: "Harden auth v2" });
      expect(revised.rev).toBe(2);
      expect(revised.constraints).toEqual(["no new deps"]);
      expect(revised.acceptance).toEqual(["tests pass"]);

      const completed = store.upsertMandate({ id: first.id, goal: "Harden auth v2", status: "completed" });
      expect(completed.rev).toBe(2);
      expect(completed.status).toBe("completed");
      expect(store.getActiveMandate()).toBeNull();

      const second = store.upsertMandate({ goal: "Ship metrics" });
      const third = store.upsertMandate({ goal: "Ship alerts" });
      expect(store.getMandate(second.id)?.status).toBe("archived");
      expect(store.getMandate(first.id)?.status).toBe("completed");
      expect(store.getActiveMandate()?.id).toBe(third.id);
      expect(store.getMandate("missing")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("enforces fact evidence and updates epistemic status", () => {
    const store = new EnhanceStore(path.join(tempDir(), "state.sqlite"));
    try {
      const mandate = store.upsertMandate({ goal: "Investigate regression" });
      expect(() => store.addEpistemicItem({
        mandateId: mandate.id, kind: "fact", statement: "Build is broken",
      })).toThrow(/evidenceRef/);
      expect(() => store.addEpistemicItem({
        mandateId: mandate.id, kind: "fact", statement: "Build is broken", evidenceRef: "   ",
      })).toThrow(/evidenceRef/);

      const hypothesis = store.addEpistemicItem({
        mandateId: mandate.id, kind: "hypothesis", statement: "Cache invalidation is stale",
      });
      expect(hypothesis.status).toBe("open");
      expect(hypothesis.evidenceRef).toBeNull();

      const fact = store.addEpistemicItem({
        mandateId: mandate.id, kind: "fact", statement: "Test run failed", evidenceRef: "call-123",
        verificationPlan: "rerun after fix",
      });
      expect(fact.evidenceRef).toBe("call-123");
      expect(fact.verificationPlan).toBe("rerun after fix");

      const verified = store.updateEpistemicStatus(fact.id, "verified", " call-456 ");
      expect(verified.status).toBe("verified");
      expect(verified.evidenceRef).toBe("call-456");
      expect(() => store.updateEpistemicStatus(fact.id, "verified", null)).toThrow(/evidenceRef/);
      expect(() => store.updateEpistemicStatus("missing", "verified")).toThrow(/not found/);

      const items = store.listEpistemicItems(mandate.id);
      expect(items.map((item) => item.id)).toEqual([hypothesis.id, fact.id]);
      expect(store.listEpistemicItems("missing")).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("persists artifacts, handoffs, and jobs", () => {
    const store = new EnhanceStore(path.join(tempDir(), "state.sqlite"));
    try {
      const mandate = store.upsertMandate({ goal: "Persistence" });
      store.recordArtifacts(mandate.id, [
        { path: "src/app.ts", sha256: "aaa", byteSize: 12, role: "changed" },
        { path: "test/app.test.ts", sha256: "bbb", byteSize: 34, role: "test" },
      ]);
      store.recordArtifacts(mandate.id, [
        { path: "src/app.ts", sha256: "aaa", byteSize: 12, role: "changed" },
      ]);
      expect(store.listArtifacts(mandate.id)).toEqual([
        { path: "src/app.ts", sha256: "aaa", byteSize: 12, role: "changed" },
        { path: "test/app.test.ts", sha256: "bbb", byteSize: 34, role: "test" },
      ]);

      const first: HandoffEnvelope = {
        id: "handoff-1",
        mandateId: mandate.id,
        mandateRev: mandate.rev,
        parentHandoffId: null,
        fromRole: "dev",
        toTarget: "user",
        verdict: "ready",
        summary: "First delivery",
        artifacts: [],
        verifiedFacts: [],
        openRisks: [],
        feedbackForUpstream: null,
        observedUsage: { inputTokens: 10, outputTokens: 20, costUsd: 0.001 },
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const second: HandoffEnvelope = {
        ...first,
        id: "handoff-2",
        parentHandoffId: first.id,
        summary: "Second delivery",
        createdAt: "2026-01-02T00:00:00.000Z",
      };
      store.saveHandoff(first);
      store.saveHandoff(second);
      expect(store.getHandoff(first.id)).toEqual(first);
      expect(store.getLatestHandoff()).toEqual(second);
      expect(store.getLatestHandoff(mandate.id)?.id).toBe(second.id);
      expect(store.getLatestHandoff("missing")).toBeNull();
      expect(store.listHandoffs(mandate.id).map((handoff) => handoff.id)).toEqual([second.id, first.id]);
      expect(store.listHandoffs(mandate.id, 1).map((handoff) => handoff.id)).toEqual([second.id]);
      expect(store.listHandoffs("missing")).toEqual([]);

      const job: BackgroundJob = {
        jobId: "job-1",
        mandateId: mandate.id,
        hypothesisId: null,
        command: "bun test",
        cwd: "/workspace",
        pid: 123,
        pgid: 123,
        logPath: "/tmp/job.log",
        exitFilePath: "/tmp/job.exit",
        status: "running",
        exitCode: null,
        startedAt: "2026-01-03T00:00:00.000Z",
        endedAt: null,
      };
      store.saveJob(job);
      expect(store.getJob(job.jobId)).toEqual(job);
      expect(store.listJobs("running")).toEqual([job]);
      expect(store.listJobs("completed")).toEqual([]);
      const finished = { ...job, status: "completed" as const, exitCode: 0, endedAt: "2026-01-03T01:00:00.000Z" };
      store.saveJob(finished);
      expect(store.getJob(job.jobId)).toEqual(finished);
      expect(store.listJobs()).toEqual([finished]);
    } finally {
      store.close();
    }
  });
});

describe("role-loader", () => {
  test("loads all six built-in roles with general as universal base", () => {
    const isolated = tempDir();
    const roles = discoverRoles({ cwd: isolated, globalRolesDir: path.join(isolated, "missing-global") });
    expect([...roles.keys()].sort()).toEqual(["dev", "general", "ml-engineer", "qa", "reviewer", "supervisor"]);
    for (const role of roles.values()) {
      expect(role.source).toBe("builtin");
      expect(role.stance.length).toBeGreaterThan(0);
      expect(role.method.length).toBeGreaterThan(0);
      expect(role.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(roles.get("qa")?.permissions.writable).toEqual(["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"]);
    expect(roles.get("qa")?.exit.requireToolEvidence).toBe(true);
    expect(roles.get("reviewer")?.permissions.writable).toEqual([]);
    expect(roles.get("reviewer")?.permissions.protected).toEqual(["**"]);
  });

  test("applies project > global > builtin override priority", () => {
    const root = tempDir();
    const cwd = path.join(root, "work");
    const globalDir = path.join(root, "global");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    const builtin = discoverRoles({ cwd, globalRolesDir: globalDir }).get("qa");
    expect(builtin?.source).toBe("builtin");
    expect(builtin?.name).toBe("独立测试与证伪工程师");

    writeFile(globalDir, "qa.yaml", roleYaml("Global QA", "Global stance"));
    const global = discoverRoles({ cwd, globalRolesDir: globalDir }).get("qa");
    expect(global?.source).toBe("global");
    expect(global?.name).toBe("Global QA");

    writeFile(cwd, ".omp/roles/qa.yaml", roleYaml("Project QA", "Project stance"));
    const project = discoverRoles({ cwd, globalRolesDir: globalDir }).get("qa");
    expect(project?.source).toBe("project");
    expect(project?.name).toBe("Project QA");
    expect(project?.contentSha256).not.toBe(global?.contentSha256);
  });

  test("rejects typo fields, bad ids, and filename mismatches", () => {
    const root = tempDir();
    const filePath = path.join(root, "typo.yaml");
    const base = "id: typo\nstance: Evidence first\nmethod:\n  - step\n";
    expect(() => parseRoleYaml(`${base}permissons:\n  tools: [read]\n`, "project", filePath))
      .toThrow(/Unknown role field "permissons"/);
    expect(() => parseRoleYaml(`${base}permissions:\n  readonly: []\n`, "project", filePath))
      .toThrow(/Unknown permissions field "readonly"/);
    expect(() => parseRoleYaml(`${base}exit:\n  require_tool_evidnce: true\n`, "project", filePath))
      .toThrow(/Unknown exit field "require_tool_evidnce"/);
    expect(() => parseRoleYaml(`${base}exit:\n  require_tool_evidence: null\n`, "project", filePath))
      .toThrow(/must be a boolean/);
    expect(() => parseRoleYaml(base, "project", path.join(root, "other.yaml")))
      .toThrow(/does not match filename/);
    expect(() => parseRoleYaml("id: bad id\nstance: x\nmethod:\n  - y\n", "project", filePath))
      .toThrow(/Invalid role id/);
    expect(() => parseRoleYaml("id: typo\nstance: '  '\nmethod:\n  - y\n", "project", filePath))
      .toThrow(/stance/);
    expect(() => parseRoleYaml("id: typo\nstance: x\nmethod: []\n", "project", filePath))
      .toThrow(/method/);
  });

  test("scaffolds valid YAML, enforces overwrite, and infers source", () => {
    const root = tempDir();
    const cwd = path.join(root, "work");
    const globalTarget = path.join(root, "global-roles");
    mkdirSync(cwd, { recursive: true });

    const readOnly = scaffoldRoleFile({
      id: "api-designer", description: "API contract designer", targetDir: globalTarget, readOnly: true,
    });
    expect(readOnly.source).toBe("global");
    expect(existsSync(readOnly.filePath)).toBe(true);
    expect(readOnly.role.name).toBe("API contract designer");
    expect(readOnly.role.permissions).toEqual({ writable: [], protected: ["**"] });
    expect(readOnly.role.exit).toEqual({ requireToolEvidence: false, criteria: [] });
    expect(readFileSync(readOnly.filePath, "utf8")).toContain("id: api-designer");

    expect(() => scaffoldRoleFile({
      id: "api-designer", description: "Again", targetDir: globalTarget, readOnly: true,
    })).toThrow(/already exists/);

    const writable = scaffoldRoleFile({
      id: "api-designer", description: "API contract designer", targetDir: globalTarget, overwrite: true,
    });
    expect(writable.role.permissions.writable).toBeUndefined();
    expect(writable.role.permissions.protected).toBeUndefined();

    const project = scaffoldRoleFile({
      id: "project-role", description: "Project role", targetDir: path.join(cwd, ".omp", "roles"),
    });
    expect(project.source).toBe("project");
  });

  test("renders the conditioning block with mandate, board, and handoff", () => {
    const isolated = tempDir();
    const role = discoverRoles({ cwd: isolated, globalRolesDir: path.join(isolated, "missing") }).get("qa")!;
    const mandate: Mandate = {
      id: "mandate-1", rev: 3, goal: "Harden authentication", constraints: ["No new dependencies"],
      acceptance: ["All tests pass"], status: "active",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const item: EpistemicItem = {
      id: "item-1", mandateId: mandate.id, kind: "fact", statement: "Token expiry is 15 minutes",
      evidenceRef: "call-1", verificationPlan: null, status: "verified",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const falsified: EpistemicItem = {
      ...item, id: "item-2", statement: "FALSE_CLAIM", status: "falsified",
    };
    const handoff: HandoffEnvelope = {
      id: "handoff-1", mandateId: mandate.id, mandateRev: mandate.rev, parentHandoffId: null,
      fromRole: "dev", toTarget: "qa", verdict: "ready", summary: "Implemented auth guard",
      artifacts: [{ path: "src/auth.ts", sha256: "abc123", byteSize: 42, role: "changed" }],
      verifiedFacts: [], openRisks: ["No rate-limit test"], feedbackForUpstream: null,
      observedUsage: null, createdAt: "2026-01-02T00:00:00.000Z",
    };

    const block = renderConditioningBlock({
      role, mandate, epistemicItems: [item, falsified], upstreamHandoff: handoff,
    });
    expect(block.startsWith("<omp-enhance-conditioning>")).toBe(true);
    expect(block.endsWith("</omp-enhance-conditioning>")).toBe(true);
    for (const expected of [
      "Active Role: qa", "独立测试与证伪工程师", "Harden authentication", "No new dependencies",
      "All tests pass", "Token expiry is 15 minutes", "call-1", "fromRole: dev", "verdict: ready",
      "Implemented auth guard", "src/auth.ts", "abc123", "No rate-limit test",
    ]) {
      expect(block).toContain(expected);
    }
    expect(block).not.toContain("FALSE_CLAIM");
  });
});

describe("TurnTracker", () => {
  test("qa may write tests but not source; reviewer cannot write", () => {
    const root = tempDir();
    const cwd = path.join(root, "work");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "src/app.ts", "export const value = 1;\n");
    writeFile(cwd, "test/app.test.ts", "test('app', () => {});\n");
    const roles = discoverRoles({ cwd, globalRolesDir: path.join(root, "missing") });
    const qa = roles.get("qa")!;
    // Built-in qa omits apply_patch from tools; add it to exercise path boundaries for that tool too.
    const qaWithPatch = {
      ...qa,
      permissions: { ...qa.permissions, tools: [...(qa.permissions.tools ?? []), "apply_patch"] },
    };
    const reviewer = roles.get("reviewer")!;
    const tracker = new TurnTracker();
    tracker.resetTurn(cwd);

    for (const toolName of ["edit", "write"] as const) {
      expect(tracker.checkToolCallAllowed(cwd, qa, { toolName, input: { path: "src/app.ts" } }))
        .toMatchObject({ block: true });
    }
    expect(tracker.checkToolCallAllowed(cwd, qaWithPatch, {
      toolName: "apply_patch", input: { patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-1\n+2\n*** End Patch\n" },
    })).toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(cwd, qa, { toolName: "edit", input: { path: "test/app.test.ts" } }))
      .toEqual({ block: false });
    expect(tracker.checkToolCallAllowed(cwd, qaWithPatch, {
      toolName: "apply_patch", input: { input: "*** Add File: test/new.test.ts\n" },
    })).toEqual({ block: false });
    expect(tracker.checkToolCallAllowed(cwd, qa, { toolName: "write", input: { path: "README.md" } }))
      .toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(cwd, qa, { toolName: "edit", input: { path: "../outside.ts" } }))
      .toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(cwd, qa, { toolName: "web_search", input: {} }))
      .toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(cwd, qa, { toolName: "enhance_mandate", input: {} }))
      .toEqual({ block: false });
    expect(tracker.checkToolCallAllowed(cwd, qa, { toolName: "bash", input: { command: "bun test" } }))
      .toEqual({ block: false });
    expect(tracker.checkToolCallAllowed(cwd, null, { toolName: "write", input: { path: "src/app.ts" } }))
      .toEqual({ block: false });

    expect(tracker.checkToolCallAllowed(cwd, reviewer, { toolName: "write", input: { path: "test/app.test.ts" } }))
      .toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(cwd, reviewer, { toolName: "edit", input: { path: "README.md" } }))
      .toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(cwd, reviewer, { toolName: "read", input: { path: "src/app.ts" } }))
      .toEqual({ block: false });
  });

  test("records calls, extracted paths, and baselines", () => {
    const root = tempDir();
    const cwd = path.join(root, "work");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "test/app.test.ts", "test('app', () => {});\n");
    expect(extractWriteTargetPaths(cwd, "edit", {
      path: "./test/app.test.ts",
      edits: [{ path: "test/other.test.ts" }],
    })).toEqual(["test/app.test.ts", "test/other.test.ts"]);
    expect(extractWriteTargetPaths(cwd, "write", { paths: ["a.txt", "a.txt", "../b.txt"] }))
      .toEqual(["a.txt", "../b.txt"]);
    expect(extractWriteTargetPaths(cwd, "read", { path: "ignored.ts" })).toEqual([]);

    const tracker = new TurnTracker();
    tracker.resetTurn(cwd);
    const call = tracker.recordToolExecutionEnd(cwd, {
      toolCallId: "call-1", toolName: "apply_patch",
      args: { patch: "*** Update File: test/app.test.ts\n@@\n" },
    });
    expect(call.toolCallId).toBe("call-1");
    expect(call.isError).toBe(false);
    expect(call.touchedPaths).toEqual(["test/app.test.ts"]);
    const failed = tracker.recordToolExecutionEnd(cwd, {
      toolCallId: "call-2", toolName: "bash", isError: true,
    });
    expect(failed.touchedPaths).toEqual([]);
    expect(tracker.getObservedCalls()).toEqual([call, failed]);
    expect(tracker.getBaselineSnapshot()?.has("test/app.test.ts")).toBe(true);

    tracker.resetTurn(cwd);
    expect(tracker.getObservedCalls()).toEqual([]);
    expect(tracker.getBaselineSnapshot()?.size).toBe(1);
  });

  test("resolves role-active tools with companion tools preserved", () => {
    const isolated = tempDir();
    const roles = discoverRoles({ cwd: isolated, globalRolesDir: path.join(isolated, "missing") });
    const allAvailable = [
      "read", "grep", "lsp", "bash", "web_search", "edit", "write",
      ...COMPANION_TOOL_NAMES,
    ];
    const active = resolveRoleActiveTools(roles.get("qa")!, allAvailable);
    for (const toolName of ["read", "grep", "lsp", "bash", "edit", "write", ...COMPANION_TOOL_NAMES]) {
      expect(active).toContain(toolName);
    }
    expect(active).not.toContain("web_search");
    expect(resolveRoleActiveTools(roles.get("dev")!, ["read", "web_search"])).toEqual([
      "read", "web_search", ...COMPANION_TOOL_NAMES,
    ]);
  });
});

describe("createAndVerifyHandoff", () => {
  function setup() {
    const root = tempDir();
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "src/app.ts", "export const value = 1;\n");
    writeFile(cwd, "test/app.test.ts", "test('old', () => {});\n");
    const roles = discoverRoles({ cwd, globalRolesDir: path.join(root, "missing-global") });
    const store = new EnhanceStore(path.join(root, "state.sqlite"));
    return { root, cwd, qa: roles.get("qa")!, store };
  }

  test("auto-detects changed files, hashes them, and persists the envelope", () => {
    const { cwd, qa, store } = setup();
    try {
      const baseline = snapshotWorkspace(cwd);
      const changedTest = "test('old', () => { expect(1).toBe(1); });\n";
      const newTest = "test('new', () => { expect(2).toBe(2); });\n";
      writeFile(cwd, "test/app.test.ts", changedTest);
      writeFile(cwd, "test/new.test.ts", newTest);
      const call: ObservedToolCall = {
        toolCallId: "call-edit", toolName: "edit", isError: false,
        touchedPaths: ["test/app.test.ts"], timestamp: "2026-01-01T00:00:00.000Z",
      };

      const envelope = createAndVerifyHandoff({
        store, role: qa, cwd, summary: "  Added independent tests  ", verdict: "ready",
        defaultGoal: "Add tests", baselineSnapshot: baseline, observedCalls: [call],
        verifiedFacts: [{ claim: "Tests were edited", evidenceRef: "call-edit" }],
        openRisks: ["No edge-case coverage yet"],
      });

      expect(envelope.summary).toBe("Added independent tests");
      expect(envelope.toTarget).toBe("user");
      expect(envelope.parentHandoffId).toBeNull();
      expect(envelope.artifacts.map((artifact) => artifact.path)).toEqual(["test/app.test.ts", "test/new.test.ts"]);
      expect(envelope.artifacts.every((artifact) => artifact.role === "test")).toBe(true);
      const newArtifact = envelope.artifacts.find((artifact) => artifact.path === "test/new.test.ts");
      expect(newArtifact?.sha256).toBe(createHash("sha256").update(newTest).digest("hex"));
      expect(newArtifact?.byteSize).toBe(Buffer.byteLength(newTest));
      expect(store.getActiveMandate()?.goal).toBe("Add tests");
      expect(envelope.mandateRev).toBe(1);
      expect(store.getHandoff(envelope.id)).toEqual(envelope);
      expect(store.listArtifacts(envelope.mandateId)).toEqual(envelope.artifacts);
      expect(store.getLatestHandoff(envelope.mandateId)?.id).toBe(envelope.id);
    } finally {
      store.close();
    }
  });

  test("requires successful non-companion tool evidence for qa ready verdicts", () => {
    const { cwd, qa, store } = setup();
    try {
      const base = { store, role: qa, cwd, summary: "Ready", verdict: "ready" as const, defaultGoal: "Finish work" };
      expect(() => createAndVerifyHandoff({ ...base, observedCalls: [] }))
        .toThrow(/requires at least one successful non-companion tool execution/);
      expect(() => createAndVerifyHandoff({
        ...base, observedCalls: [{ toolCallId: "call-err", toolName: "bash", isError: true, touchedPaths: [], timestamp: "now" }],
      })).toThrow(/requires at least one successful/);
      expect(() => createAndVerifyHandoff({
        ...base,
        observedCalls: [{ toolCallId: "call-companion", toolName: "enhance_mandate", isError: false, touchedPaths: [], timestamp: "now" }],
      })).toThrow(/requires at least one successful/);
      const accepted = createAndVerifyHandoff({
        ...base,
        observedCalls: [{ toolCallId: "call-bash", toolName: "bash", isError: false, touchedPaths: [], timestamp: "now" }],
      });
      expect(accepted.verdict).toBe("ready");
    } finally {
      store.close();
    }
  });

  test("requires feedback for rejected verdicts and trims it", () => {
    const { cwd, qa, store } = setup();
    try {
      expect(() => createAndVerifyHandoff({ store, role: qa, cwd, summary: "Rejected", verdict: "rejected" }))
        .toThrow(/feedbackForUpstream/);
      expect(() => createAndVerifyHandoff({
        store, role: qa, cwd, summary: "Rejected", verdict: "rejected", feedbackForUpstream: "   ",
      })).toThrow(/feedbackForUpstream/);
      const envelope = createAndVerifyHandoff({
        store, role: qa, cwd, summary: "Rejected", verdict: "rejected", defaultGoal: "Fix bug",
        feedbackForUpstream: "  Reproduce: bun test test/app.test.ts; expected 1, received 2  ",
      });
      expect(envelope.feedbackForUpstream).toBe("Reproduce: bun test test/app.test.ts; expected 1, received 2");
    } finally {
      store.close();
    }
  });

  test("rejects fabricated evidence and accepts recorded artifact evidence", () => {
    const { cwd, qa, store } = setup();
    try {
      expect(() => createAndVerifyHandoff({
        store, role: qa, cwd, summary: "Blocked", verdict: "blocked", defaultGoal: "Blocked task",
        verifiedFacts: [{ claim: "Everything passes", evidenceRef: "deadbeef" }],
      })).toThrow(/deadbeef/);

      const baseline = snapshotWorkspace(cwd);
      writeFile(cwd, "test/extra.test.ts", "test('extra', () => {});\n");
      const first = createAndVerifyHandoff({
        store, role: qa, cwd, summary: "Artifact evidence", verdict: "blocked",
        defaultGoal: "Record artifact", baselineSnapshot: baseline,
      });
      const artifact = first.artifacts[0]!;
      const mandate = store.getMandate(first.mandateId)!;
      const second = createAndVerifyHandoff({
        store, role: qa, cwd, summary: "Uses prior artifact", verdict: "blocked", mandate,
        artifactPaths: ["./src/app.ts", "missing.ts"],
        verifiedFacts: [
          { claim: "Artifact hash matched", evidenceRef: artifact.sha256 },
          { claim: "Artifact path matched", evidenceRef: artifact.path },
        ],
      });
      expect(second.artifacts).toEqual([
        { path: "src/app.ts", sha256: createHash("sha256").update("export const value = 1;\n").digest("hex"), byteSize: 24, role: "changed" },
      ]);
      expect(second.verifiedFacts).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});
