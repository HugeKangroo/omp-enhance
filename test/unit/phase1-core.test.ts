import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  diffSnapshots, findBoundaryViolations, findProtectedViolations, matchesGlobList,
  resolveSafeTargetRealpath, snapshotConfigIntegrity, snapshotWorkspace, splitBraceSafeGlobs,
} from "../../src/core/fs.ts";
import {
  COMPANION_TOOL_NAMES, DEFAULT_READONLY_TOOLS, checkToolCallAllowed, extractWriteTargetPaths,
  isValidExecutionEvidence, resolveRoleActiveTools, TurnTracker,
} from "../../src/core/policy.ts";
import { EnhanceStore, captureProcessStartToken, isProcessAliveWithToken } from "../../src/core/store.ts";
import type {
  BackgroundJob, EpistemicItem, HandoffEnvelope, Mandate, ObservedToolCall,
} from "../../src/core/types.ts";
import { BoundaryViolationError, createAndVerifyHandoff } from "../../src/flow/handoff.ts";
import { formatRuntimeVisionHint, renderConditioningBlock } from "../../src/roles/conditioning.ts";
import {
  cloneRoleSpec, discoverRoles, discoverRolesWithDiagnostics, hasBuiltinRole,
  parseRoleYaml, saveRoleSpec, scaffoldRoleFile, serializeRoleYaml,
} from "../../src/roles/loader.ts";

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

describe("workspace snapshots, gitignore, symlinks, and boundary violations", () => {
  test("matches nested, root-level, and brace-expansion globs", () => {
    expect(matchesGlobList("src/app.ts", ["src/**"])).toBe(true);
    expect(matchesGlobList("./src/sub/app.ts", ["src/**"])).toBe(true);
    expect(matchesGlobList("test/app.test.ts", ["**/*.test.*"])).toBe(true);
    expect(matchesGlobList("src/ui/view.tsx", ["src/**/*.{ts,tsx}"])).toBe(true);
    expect(matchesGlobList("src/ui/view.css", ["src/**/*.{ts,tsx}"])).toBe(false);
    expect(splitBraceSafeGlobs("src/**/*.{ts,tsx}, test/**")).toEqual([
      "src/**/*.{ts,tsx}", "test/**",
    ]);
    expect(matchesGlobList("README.md", ["**"])).toBe(true);
    expect(matchesGlobList("src/app.ts", ["**"])).toBe(true);
    expect(matchesGlobList("README.md", ["src/**"])).toBe(false);
  });

  test("hashes files, respects .gitignore & default skip dirs, tracks symlinks, and detects writable/protected/.omp tamper", () => {
    const cwd = tempDir();
    writeFile(cwd, "src/a.ts", "export const a = 1;\n");
    writeFile(cwd, "src/b.ts", "export const b = 2;\n");
    writeFile(cwd, "README.md", "# Before\n");
    writeFile(cwd, "node_modules/pkg/index.js", "ignored\n");
    writeFile(cwd, ".venv/lib/torch.py", "ignored\n");
    writeFile(cwd, "__pycache__/mod.pyc", "ignored\n");
    writeFile(cwd, ".git/config", "ignored\n");
    writeFile(cwd, ".omp/state.json", "ignored\n");
    writeFile(cwd, ".omp-enhance/state.sqlite", "ignored\n");
    writeFile(cwd, ".gitignore", "datasets/\n*.ckpt\n");
    writeFile(cwd, "datasets/train.bin", "huge\n");
    writeFile(cwd, "algo_work/model.ckpt", "weights\n");
    symlinkSync("src/a.ts", path.join(cwd, "link-a.ts"));

    const before = snapshotWorkspace(cwd);
    const beforeIntegrity = snapshotConfigIntegrity(cwd);
    expect([...before.keys()].sort()).toEqual([".gitignore", "README.md", "link-a.ts", "src/a.ts", "src/b.ts"]);
    expect(before.get("src/a.ts")?.sha256).toBe(createHash("sha256").update("export const a = 1;\n").digest("hex"));
    expect(before.get("src/a.ts")?.byteSize).toBe(20);
    expect(before.get("link-a.ts")?.sha256).toBe("symlink:src/a.ts");

    // Oversize file (> maxFullHashBytes) avoids full Buffer allocation cleanly
    const oversizeSnap = snapshotWorkspace(cwd, { maxFullHashBytes: 5 });
    expect(oversizeSnap.get("src/a.ts")?.sha256.startsWith("oversize:20:")).toBe(true);

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

    // Tamper with .omp/roles/evil.yaml (skipped by SKIP_DIRS) and README.md (outside writable: ["test/**"])
    writeFile(cwd, ".omp/roles/evil.yaml", "id: evil\nstance: x\nmethod:\n  - y\n");
    expect(findBoundaryViolations({
      cwd,
      before,
      permissions: { writable: ["test/**"], protected: ["src/**"] },
      beforeIntegrity,
    })).toEqual([
      ".omp/roles/evil.yaml", "README.md", "src/a.ts", "src/b.ts", "src/c.ts",
    ]);

    const onlySource = snapshotWorkspace(cwd, ["src/**"]);
    expect([...onlySource.keys()].sort()).toEqual(["src/a.ts", "src/c.ts"]);
  });
});

describe("EnhanceStore", () => {
  test("tracks mandate revisions, session/flow scoping, completion, and archiving", () => {
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

      const completed = store.completeMandate(first.id);
      expect(completed?.rev).toBe(2);
      expect(completed?.status).toBe("completed");
      expect(store.getActiveMandate()).toBeNull();

      const second = store.upsertMandate({ goal: "Ship metrics" });
      const third = store.upsertMandate({ goal: "Ship alerts" });
      expect(store.getMandate(second.id)?.status).toBe("archived");
      expect(store.getMandate(first.id)?.status).toBe("completed");
      expect(store.getActiveMandate()?.id).toBe(third.id);
      expect(store.getMandate("missing")).toBeNull();

      // Foreground sessionId mandate and background flowId mandate do NOT clobber each other!
      const fg = store.upsertMandate({ goal: "Foreground chat", sessionId: "sess-1" });
      const bg = store.upsertMandate({ goal: "Background flow", flowId: "flow-1" });
      expect(store.getActiveMandate({ sessionId: "sess-1" })?.id).toBe(fg.id);
      expect(store.getActiveMandate({ flowId: "flow-1" })?.id).toBe(bg.id);
    } finally {
      store.close();
    }
  });

  test("handles two-connection concurrent writes via busy_timeout, enforces FK & CAS job updates, and guards close()", () => {
    const dbPath = path.join(tempDir(), "concurrent.sqlite");
    const storeA = new EnhanceStore(dbPath);
    const storeB = new EnhanceStore(dbPath);
    try {
      const mA = storeA.upsertMandate({ goal: "Concurrent A", sessionId: "sA" });
      const mB = storeB.upsertMandate({ goal: "Concurrent B", flowId: "fB" });
      expect(storeA.getMandate(mA.id)?.status).toBe("active");
      expect(storeB.getMandate(mB.id)?.status).toBe("active");

      // Foreign key constraint rejects orphan epistemic_items for non-existent mandate
      expect(() => storeA.addEpistemicItem({
        mandateId: "non-existent-mandate", kind: "hypothesis", statement: "Orphan",
      })).toThrow();

      // Conditional CAS job status update prevents reconcile clobbering cancelled jobs
      const token = captureProcessStartToken(process.pid);
      expect(isProcessAliveWithToken(process.pid, token)).toBe(true);
      expect(isProcessAliveWithToken(process.pid, "ps:mismatched-epoch")).toBe(false);

      storeA.saveJob({
        jobId: "j-cas", mandateId: mA.id, hypothesisId: null, command: "sleep 5", cwd: "/tmp",
        pid: 999, pgid: 999, ownerPid: process.pid, processStartToken: token,
        logPath: "/tmp/j.log", exitFilePath: "/tmp/j.exit", status: "cancelled",
        exitCode: null, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:05.000Z",
      });
      const staleReconcile = storeB.transitionJobStatus("j-cas", ["running"], {
        status: "completed", exitCode: 0, endedAt: "2026-01-01T00:00:06.000Z",
      });
      expect(staleReconcile?.status).toBe("cancelled");

      // Post-close saveFlowCheckpoint does NOT reopen SQLite or overwrite "running"
      storeA.saveFlowCheckpoint({
        flowId: "fB", mandateId: mB.id, goal: "Concurrent B", roleChain: ["dev", "qa"],
        status: "running", currentIndex: 0, repairRound: 0, lastHandoffId: null,
        maxRepairRounds: 2, snapshotJson: "{}", updatedAt: "2026-01-01T00:00:00.000Z",
        ownerPid: process.pid, ownerStartToken: token,
      });
      storeA.close();
      expect(storeA.isClosed()).toBe(true);
      storeA.saveFlowCheckpoint({
        flowId: "fB", mandateId: mB.id, goal: "Concurrent B", roleChain: ["dev", "qa"],
        status: "cancelled", currentIndex: 0, repairRound: 0, lastHandoffId: null,
        maxRepairRounds: 2, snapshotJson: "{}", updatedAt: "2026-01-01T00:00:01.000Z",
      });
      expect(storeB.getFlowCheckpoint("fB")?.status).toBe("running");
    } finally {
      storeA.close();
      storeB.close();
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

  test("persists deduplicated artifacts, handoffs, and jobs lazily", () => {
    const storePath = path.join(tempDir(), ".omp-enhance", "state.sqlite");
    const store = new EnhanceStore(storePath);
    try {
      expect(store.getActiveMandate()).toBeNull();
      expect(store.listJobs()).toEqual([]);
      expect(store.getLatestHandoff()).toBeNull();
      expect(Bun.file(storePath).size).toBe(0);

      const mandate = store.upsertMandate({ goal: "Persistence" });
      expect(Bun.file(storePath).size).toBeGreaterThan(0);
      store.recordArtifacts(mandate.id, [
        { path: "src/app.ts", sha256: "aaa", byteSize: 12, role: "changed" },
        { path: "test/app.test.ts", sha256: "bbb", byteSize: 34, role: "test" },
      ]);
      // Updating src/app.ts to a new sha256 deduplicates listArtifacts to latest per path
      store.recordArtifacts(mandate.id, [
        { path: "src/app.ts", sha256: "ccc", byteSize: 16, role: "changed" },
      ]);
      expect(store.listArtifacts(mandate.id)).toEqual([
        { path: "src/app.ts", sha256: "ccc", byteSize: 16, role: "changed" },
        { path: "test/app.test.ts", sha256: "bbb", byteSize: 34, role: "test" },
      ]);

      const first: HandoffEnvelope = {
        id: "handoff-1", mandateId: mandate.id, mandateRev: mandate.rev, parentHandoffId: null,
        fromRole: "dev", toTarget: "user", verdict: "ready", summary: "First delivery",
        artifacts: [], verifiedFacts: [], openRisks: [], feedbackForUpstream: null,
        observedUsage: { inputTokens: 10, outputTokens: 20, costUsd: 0.001 },
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const second: HandoffEnvelope = {
        ...first, id: "handoff-2", parentHandoffId: first.id, summary: "Second delivery",
        deletedFiles: ["src/obsolete.ts"], createdAt: "2026-01-02T00:00:00.000Z",
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
        jobId: "job-1", mandateId: mandate.id, hypothesisId: null, command: "bun test", cwd: "/workspace",
        pid: 123, pgid: 123, logPath: "/tmp/job.log", exitFilePath: "/tmp/job.exit",
        status: "running", exitCode: null, startedAt: "2026-01-03T00:00:00.000Z", endedAt: null,
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

  test("reads legacy 5-table state.sqlite read-only without dirtying WAL, and migrates columns before creating indexes on write", () => {
    const legacyDir = tempDir();
    const dbPath = path.join(legacyDir, "legacy-state.sqlite");
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE mandates (id TEXT PRIMARY KEY, rev INTEGER NOT NULL, goal TEXT NOT NULL, constraints TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE epistemic_items (id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL, kind TEXT NOT NULL, statement TEXT NOT NULL, evidence_ref TEXT, verification_plan TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE artifacts (artifact_id INTEGER PRIMARY KEY AUTOINCREMENT, mandate_id TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE handoffs (id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL, mandate_rev INTEGER NOT NULL, parent_handoff_id TEXT, from_role TEXT NOT NULL, to_target TEXT NOT NULL, verdict TEXT NOT NULL, summary TEXT NOT NULL, artifacts TEXT NOT NULL, verified_facts TEXT NOT NULL, open_risks TEXT NOT NULL, feedback_for_upstream TEXT, observed_usage TEXT, created_at TEXT NOT NULL);
      CREATE TABLE jobs (job_id TEXT PRIMARY KEY, mandate_id TEXT, hypothesis_id TEXT, command TEXT NOT NULL, cwd TEXT NOT NULL, pid INTEGER NOT NULL, pgid INTEGER NOT NULL, log_path TEXT NOT NULL, exit_file_path TEXT NOT NULL, status TEXT NOT NULL, exit_code INTEGER, started_at TEXT NOT NULL, ended_at TEXT);
      INSERT INTO mandates VALUES ('m-legacy', 1, 'Legacy goal', '[]', '[]', 'active', '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z');
    `);
    raw.close();

    const store = new EnhanceStore(dbPath);
    try {
      // Read-only startup queries on legacy schema (no flow_runs table, no session_id/flow_id columns) succeed with 0 WAL writes
      expect(store.getLatestFlowCheckpoint()).toBeNull();
      expect(store.getFlowCheckpoint("f-none")).toBeNull();
      expect(store.getActiveMandate({ sessionId: "sess-x" })?.id).toBe("m-legacy");
      expect(store.getActiveMandate({ flowId: "flow-x" })).toBeNull();
      expect(existsSync(`${dbPath}-wal`)).toBe(false);

      // First write upgrades schema: SCHEMA_TABLES -> migrateSchema -> SCHEMA_INDEXES (idx_mandates_session, idx_mandates_flow)
      const created = store.upsertMandate({ goal: "Post-migration mandate", sessionId: "sess-x" });
      expect(created.sessionId).toBe("sess-x");
      expect(store.getActiveMandate({ sessionId: "sess-x" })?.id).toBe(created.id);
    } finally {
      store.close();
    }
  });
});

describe("roles loader, serializer, and conditioning", () => {
  test("loads all eight built-in roles including general, algo, and vision (@vision)", () => {
    const isolated = tempDir();
    const roles = discoverRoles({ cwd: isolated, globalRolesDir: path.join(isolated, "missing-global") });
    expect([...roles.keys()].sort()).toEqual([
      "algo", "dev", "general", "ml-engineer", "qa", "reviewer", "supervisor", "vision",
    ]);
    for (const role of roles.values()) {
      expect(role.source).toBe("builtin");
      expect(role.stance.length).toBeGreaterThan(0);
      expect(role.method.length).toBeGreaterThan(0);
      expect(role.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(hasBuiltinRole("qa")).toBe(true);
    expect(hasBuiltinRole("QA")).toBe(false);
    expect(roles.get("algo")?.exit.requireToolEvidence).toBe(true);
    expect(roles.get("vision")?.model).toBe("@vision");
    expect(roles.get("vision")?.permissions.tools).toEqual(["read", "glob", "find"]);
    expect(roles.get("vision")?.permissions.writable).toEqual([]);
    expect(roles.get("vision")?.permissions.protected).toEqual(["**"]);
    expect(roles.get("vision")?.exit.requireToolEvidence).toBe(true);
    expect(roles.get("qa")?.permissions.tools).toContain("apply_patch");
    expect(roles.get("qa")?.permissions.writable).toEqual(["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"]);
    expect(roles.get("qa")?.exit.requireToolEvidence).toBe(true);
    expect(roles.get("reviewer")?.permissions.writable).toEqual([]);
    expect(roles.get("reviewer")?.permissions.protected).toEqual(["**"]);
  });

  test("applies project > global > builtin priority, gates untrusted project roles, and isolates bad YAML", () => {
    const root = tempDir();
    const cwd = path.join(root, "work");
    const globalDir = path.join(root, "global");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    writeFile(globalDir, "qa.yaml", roleYaml("Global QA", "Global stance"));
    writeFile(globalDir, "broken.yaml", "id: broken\nunknown_key: [unclosed");
    writeFile(cwd, ".omp/roles/qa.yaml", roleYaml("Project QA", "Project stance"));

    // Trusted workspace loads project override while isolating broken.yaml into diagnostics
    const trusted = discoverRolesWithDiagnostics({ cwd, globalRolesDir: globalDir, isProjectTrusted: true });
    expect(trusted.roles.get("qa")?.source).toBe("project");
    expect(trusted.roles.get("qa")?.name).toBe("Project QA");
    expect(trusted.diagnostics.some((d) => d.filePath.endsWith("broken.yaml"))).toBe(true);

    // Untrusted workspace blocks .omp/roles/* and falls back to global/builtin
    const untrusted = discoverRolesWithDiagnostics({ cwd, globalRolesDir: globalDir, isProjectTrusted: false });
    expect(untrusted.roles.get("qa")?.source).toBe("global");
    expect(untrusted.roles.get("qa")?.name).toBe("Global QA");
    expect(untrusted.diagnostics.some((d) => d.source === "project")).toBe(true);

    // Symlinked .yaml role file loads cleanly while directory/broken symlinks are safely ignored
    const externalDir = path.join(root, "external-roles");
    mkdirSync(externalDir, { recursive: true });
    writeFile(externalDir, "linked-auditor.yaml", "id: linked-auditor\nname: Linked Auditor\nthinking: max\nstance: Follow proof\nmethod:\n  - inspect\n");
    mkdirSync(path.join(externalDir, "subdir.yaml"), { recursive: true });
    symlinkSync(path.join(externalDir, "linked-auditor.yaml"), path.join(globalDir, "linked-auditor.yaml"));
    symlinkSync(path.join(externalDir, "subdir.yaml"), path.join(globalDir, "subdir.yaml"));
    symlinkSync(path.join(externalDir, "missing.yaml"), path.join(globalDir, "dangling.yaml"));

    const withSymlinks = discoverRolesWithDiagnostics({ cwd, globalRolesDir: globalDir, isProjectTrusted: true });
    expect(withSymlinks.roles.get("linked-auditor")?.name).toBe("Linked Auditor");
    expect(withSymlinks.roles.get("linked-auditor")?.thinking).toBe("max");
    expect(withSymlinks.roles.has("subdir")).toBe(false);
    expect(withSymlinks.roles.has("dangling")).toBe(false);
  });

  test("round-trips numeric/boolean IDs, leading-indent stance, and removes shadowed .yml files", () => {
    const root = tempDir();
    const dir = path.join(root, "roles");
    mkdirSync(dir, { recursive: true });

    // Stale .yml file must be removed when saveRoleSpec saves .yaml
    writeFile(dir, "custom.yml", "id: custom\nname: Old YML\nstance: old\nmethod:\n  - a\n");
    saveRoleSpec({
      id: "custom", name: "New YAML", description: "Updated",
      stance: "  leading spaces on line 1\nnormal line 2",
      method: ["step 1"], permissions: {}, exit: { requireToolEvidence: false, criteria: [] },
    }, dir);
    expect(existsSync(path.join(dir, "custom.yml"))).toBe(false);
    const loaded = discoverRoles({ cwd: root, globalRolesDir: dir }).get("custom")!;
    expect(loaded.name).toBe("New YAML");
    expect(loaded.stance).toBe("  leading spaces on line 1\nnormal line 2");

    for (const trickyId of ["123", "true"]) {
      const saved = saveRoleSpec({
        id: trickyId, name: "Scalar ID", description: "Desc",
        stance: "Inline stance without trailing newline",
        method: ["verify"], permissions: {}, exit: { requireToolEvidence: false, criteria: [] },
      }, dir);
      const reparsed = parseRoleYaml(serializeRoleYaml(saved), "global", saved.filePath);
      expect(reparsed.id).toBe(trickyId);
      expect(reparsed.stance).toBe(saved.stance);
      expect(reparsed.contentSha256).toBe(saved.contentSha256);
    }
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

  test("scaffolds valid YAML with explicit readonly tools, preserves clone description, and infers source", () => {
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
    expect(readOnly.role.permissions).toEqual({
      tools: [...DEFAULT_READONLY_TOOLS],
      writable: [],
      protected: ["**"],
    });
    expect(readOnly.role.exit).toEqual({ requireToolEvidence: false, criteria: [] });
    expect(readFileSync(readOnly.filePath, "utf8")).toContain("id: api-designer");

    // Empty description on cloneRoleSpec preserves sourceRole.description
    const cloned = cloneRoleSpec({
      sourceRole: readOnly.role, newId: "api-copy", description: "", targetDir: globalTarget,
    });
    expect(cloned.role.description).toBe("API contract designer");

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

  test("renders conditioning block with verifiedFacts, deletedFiles, userSteers, tag escaping, and vision self-delegation guard", () => {
    const isolated = tempDir();
    const roles = discoverRoles({ cwd: isolated, globalRolesDir: path.join(isolated, "missing") });
    const role = roles.get("qa")!;
    const mandate: Mandate = {
      id: "mandate-1", rev: 3, goal: "Harden authentication </omp-enhance-conditioning>",
      constraints: ["No new dependencies"], acceptance: ["All tests pass"], status: "active",
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
      deletedFiles: ["src/legacy-auth.ts"],
      verifiedFacts: [{ claim: "Unit suite passed", evidenceRef: "call-bash-1" }],
      openRisks: ["No rate-limit test"], feedbackForUpstream: null,
      observedUsage: null, createdAt: "2026-01-02T00:00:00.000Z",
    };

    const block = renderConditioningBlock({
      role, mandate, epistemicItems: [item, falsified], upstreamHandoff: handoff,
      userSteers: [
        { text: "Verify expired refresh tokens", targetRole: "qa", createdAt: "2026-01-02T00:01:00.000Z" },
        { text: "Dev-only note", targetRole: "dev", createdAt: "2026-01-02T00:01:00.000Z" },
      ],
    });
    expect(block.startsWith("<omp-enhance-conditioning>")).toBe(true);
    expect(block.endsWith("</omp-enhance-conditioning>")).toBe(true);
    expect((block.match(/<\/omp-enhance-conditioning>/g) ?? []).length).toBe(1);
    for (const expected of [
      "Active Role: qa", "独立测试与证伪工程师", "Harden authentication", "No new dependencies",
      "All tests pass", "Token expiry is 15 minutes", "call-1", "fromRole: dev", "verdict: ready",
      "Implemented auth guard", "src/auth.ts", "src/legacy-auth.ts", "Unit suite passed (evidence: call-bash-1)",
      "No rate-limit test", "Verify expired refresh tokens",
    ]) {
      expect(block).toContain(expected);
    }
    expect(block).not.toContain("FALSE_CLAIM");
    expect(block).not.toContain("Dev-only note");

    // Vision role on text-only fallback must NOT be told to delegate to itself
    expect(formatRuntimeVisionHint(false, "vision")).toContain("do NOT self-delegate");
    expect(formatRuntimeVisionHint(false, "algo")).toContain('toTarget="vision"');
  });
});

describe("policy & TurnTracker", () => {
  test("enforces writable/protected, fail-closed 0-target writes, Move to, symlink escapes, and companion gating", () => {
    const root = tempDir();
    const cwd = path.join(root, "work");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "src/app.ts", "export const value = 1;\n");
    writeFile(cwd, "test/app.test.ts", "test('app', () => {});\n");
    symlinkSync("../src", path.join(cwd, "test/sneaky-src"));

    const roles = discoverRoles({ cwd, globalRolesDir: path.join(root, "missing") });
    const qa = roles.get("qa")!;
    const general = roles.get("general")!;
    const reviewer = roles.get("reviewer")!;
    const tracker = new TurnTracker();
    tracker.resetTurn(cwd);

    expect(tracker.checkToolCallAllowed(cwd, general, {
      toolName: "edit", input: { path: "../../../.omp/agent/managed-skills/colab-dev/SKILL.md" },
    })).toEqual({ block: false });

    for (const toolName of ["edit", "write"] as const) {
      expect(tracker.checkToolCallAllowed(cwd, qa, { toolName, input: { path: "src/app.ts" } }))
        .toMatchObject({ block: true });
    }
    // Fail-closed when WRITE_TOOLS receives unrecognized/empty target keys
    expect(tracker.checkToolCallAllowed(cwd, qa, { toolName: "write", input: { unknownKey: "test/a.test.ts" } }))
      .toMatchObject({ block: true });
    // `filePath` is recognized
    expect(tracker.checkToolCallAllowed(cwd, qa, { toolName: "write", input: { filePath: "test/a.test.ts" } }))
      .toEqual({ block: false });
    // Symlink inside test/ pointing to ../src is resolved via realpathSync and blocked!
    expect(resolveSafeTargetRealpath(cwd, "test/sneaky-src/app.ts").relPath).toBe("src/app.ts");
    expect(tracker.checkToolCallAllowed(cwd, qa, { toolName: "write", input: { path: "test/sneaky-src/new.ts" } }))
      .toMatchObject({ block: true });

    // apply_patch blocks both Update File: src/* AND Move to: src/*
    expect(tracker.checkToolCallAllowed(cwd, qa, {
      toolName: "apply_patch", input: { patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-1\n+2\n*** End Patch\n" },
    })).toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(cwd, qa, {
      toolName: "apply_patch", input: { patch: "*** Begin Patch\n*** Update File: test/app.test.ts\n*** Move to: src/hijack.ts\n*** End Patch\n" },
    })).toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(cwd, qa, {
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

    // Read-only reviewer cannot start background shell jobs or write-escalate via enhance_flow / delegateNow
    expect(checkToolCallAllowed(cwd, reviewer, { toolName: "enhance_job", input: { action: "start", command: "rm -rf ." } }, roles))
      .toMatchObject({ block: true });
    expect(checkToolCallAllowed(cwd, reviewer, { toolName: "enhance_job", input: { action: "list" } }, roles))
      .toEqual({ block: false });
    expect(checkToolCallAllowed(cwd, reviewer, { toolName: "enhance_flow", input: { action: "start", roles: ["dev"] } }, roles))
      .toMatchObject({ block: true });
    expect(checkToolCallAllowed(cwd, reviewer, {
      toolName: "enhance_handoff", input: { delegateNow: true, toTarget: "dev" },
    }, roles)).toMatchObject({ block: true });
    expect(checkToolCallAllowed(cwd, roles.get("vision")!, {
      toolName: "enhance_handoff", input: { delegateNow: true, toTarget: "vision" },
    }, roles)).toMatchObject({ block: true });

    expect(tracker.checkToolCallAllowed(cwd, reviewer, { toolName: "write", input: { path: "test/app.test.ts" } }))
      .toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(cwd, reviewer, { toolName: "read", input: { path: "src/app.ts" } }))
      .toEqual({ block: false });

    // ast_edit, learn, memory_edit, retain, manage_skill, context_notes, new_context blocked on read-only roles
    const customReadonly = parseRoleYaml(
      "id: ro-open\nname: RO Open\nstance: Read only\nmethod:\n  - read\npermissions:\n  writable: []\n  protected: [\"**\"]\n",
      "project", path.join(cwd, "ro-open.yaml"),
    );
    for (const mutTool of ["ast_edit", "learn", "memory_edit", "retain", "manage_skill", "context_notes", "new_context"]) {
      expect(resolveRoleActiveTools(customReadonly, ["read", mutTool], "stage")).toEqual(["read", "enhance_handoff", "enhance_mandate"]);
      expect(tracker.checkToolCallAllowed(cwd, customReadonly, { toolName: mutTool, input: { paths: ["test/app.test.ts"] } }))
        .toMatchObject({ block: true });
    }

    // Bounded write role with ast_edit permitted: validates path/paths/files/glob & blocks root/protected/symlink escapes
    const qaAst = { ...qa, permissions: { ...qa.permissions, tools: [...(qa.permissions.tools ?? []), "ast_edit"] } };
    mkdirSync(path.join(cwd, "tests"), { recursive: true });
    writeFile(cwd, "tests/clean.test.ts", "expect(1).toBe(1);\n");
    expect(tracker.checkToolCallAllowed(cwd, qaAst, { toolName: "ast_edit", input: { ops: [] } })).toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(cwd, qaAst, { toolName: "ast_edit", input: { path: "." } })).toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(cwd, qaAst, { toolName: "ast_edit", input: { glob: "**/*.test.ts" } })).toMatchObject({ block: true });
    expect(tracker.checkToolCallAllowed(cwd, qaAst, { toolName: "ast_edit", input: { paths: ["src/**/*.ts"] } })).toMatchObject({ block: true });
    // test/ contains symlink sneaky-src -> ../src, so globbing test/** must fail closed!
    expect(tracker.checkToolCallAllowed(cwd, qaAst, { toolName: "ast_edit", input: { paths: ["test/**/*.ts"] } })).toMatchObject({ block: true });
    // Clean tests/** directory and direct test file path succeed
    expect(tracker.checkToolCallAllowed(cwd, qaAst, { toolName: "ast_edit", input: { paths: ["tests/**/*.ts"] } })).toEqual({ block: false });
    expect(tracker.checkToolCallAllowed(cwd, qaAst, { toolName: "ast_edit", input: { path: "tests", glob: "*.test.ts" } })).toEqual({ block: false });
    expect(tracker.checkToolCallAllowed(cwd, qaAst, { toolName: "ast_edit", input: { files: ["test/app.test.ts"] } })).toEqual({ block: false });
  });

  test("TurnTracker.resetTurn is lazy (zero pre-turn snapshot freezing) while computing on demand and snapshotting at beginTurn", () => {
    const cwd = tempDir();
    writeFile(cwd, "src/main.ts", "export const v = 1;\n");

    const tracker = new TurnTracker();
    tracker.resetTurn(cwd);
    // User edits file AFTER session_start resetTurn() and BEFORE Turn 1 beginTurn()
    writeFile(cwd, "src/main.ts", "export const v = 2;\n");
    tracker.beginTurn(cwd, true);

    // Baseline reflects v = 2 (Turn 1 start), NOT stale v = 1 from boot!
    const snap = tracker.getBaselineSnapshot();
    expect(snap?.get("src/main.ts")?.sha256).toBe(createHash("sha256").update("export const v = 2;\n").digest("hex"));

    // On-demand fallback when getBaselineSnapshot() is called directly after resetTurn() without beginTurn()
    const lazyTracker = new TurnTracker();
    lazyTracker.resetTurn(cwd);
    expect(lazyTracker.getBaselineSnapshot()?.has("src/main.ts")).toBe(true);
    expect(lazyTracker.getBaselineConfigSnapshot()).not.toBeNull();
  });

  test("records calls, active in-flight tool, extracted paths, and stage/foreground active tools", () => {
    const root = tempDir();
    const cwd = path.join(root, "work");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "test/app.test.ts", "test('app', () => {});\n");
    expect(extractWriteTargetPaths(cwd, "edit", {
      path: "./test/app.test.ts",
      edits: [{ filePath: "test/other.test.ts" }],
    })).toEqual(["test/app.test.ts", "test/other.test.ts"]);
    expect(extractWriteTargetPaths(cwd, "read", { path: "ignored.ts" })).toEqual([]);

    const tracker = new TurnTracker();
    tracker.resetTurn(cwd);
    tracker.recordToolExecutionStart("bash", { command: "bun test" });
    expect(tracker.getActiveTool()?.name).toBe("bash");

    const call = tracker.recordToolExecutionEnd(cwd, {
      toolCallId: "call-1", toolName: "apply_patch",
      args: { patch: "*** Update File: test/app.test.ts\n@@\n" },
    });
    expect(tracker.getActiveTool()).toBeNull();
    expect(call.touchedPaths).toEqual(["test/app.test.ts"]);

    const roles = discoverRoles({ cwd, globalRolesDir: path.join(root, "missing") });
    const allAvailable = ["read", "grep", "lsp", "bash", "eval", "web_search", "edit", "write", ...COMPANION_TOOL_NAMES];
    const qaActive = resolveRoleActiveTools(roles.get("qa")!, allAvailable, "foreground");
    for (const toolName of ["read", "grep", "lsp", "bash", "edit", "write", ...COMPANION_TOOL_NAMES]) {
      expect(qaActive).toContain(toolName);
    }
    expect(qaActive).not.toContain("web_search");

    // Stage mode exposes enhance_handoff + enhance_mandate + permission-gated enhance_job
    expect(resolveRoleActiveTools(roles.get("algo")!, ["read", "bash"], "stage")).toEqual([
      "read", "bash", "enhance_handoff", "enhance_mandate", "enhance_job",
    ]);
    expect(resolveRoleActiveTools(roles.get("reviewer")!, ["read", "bash", "eval"], "stage")).toEqual([
      "read", "enhance_handoff", "enhance_mandate",
    ]);
    expect(isValidExecutionEvidence("enhance_job", false)).toBe(true);
    expect(isValidExecutionEvidence("bash", true)).toBe(false);
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
    return { root, cwd, qa: roles.get("qa")!, dev: roles.get("dev")!, store };
  }

  test("auto-detects changed & deleted files, enforces boundary violations before DB persistence, and accepts enhance_job evidence", () => {
    const { cwd, qa, dev, store } = setup();
    try {
      const baseline = snapshotWorkspace(cwd);
      const changedTest = "test('old', () => { expect(1).toBe(1); });\n";
      writeFile(cwd, "test/app.test.ts", changedTest);
      rmSync(path.join(cwd, "src/app.ts"));
      const jobCall: ObservedToolCall = {
        toolCallId: "call-job", toolName: "enhance_job", isError: false,
        touchedPaths: [], timestamp: "2026-01-01T00:00:00.000Z",
      };

      // qa violated protected src/** by deleting src/app.ts -> throws BoundaryViolationError BEFORE saving to store!
      expect(() => createAndVerifyHandoff({
        store, role: qa, cwd, summary: "Tampered src", verdict: "ready",
        defaultGoal: "Add tests", baselineSnapshot: baseline, observedCalls: [jobCall],
      })).toThrow(BoundaryViolationError);
      expect(store.listHandoffs()).toEqual([]);

      // dev is unrestricted -> records both changed test/app.test.ts and deletedFiles: ["src/app.ts"]
      const devRoleWithEvidence = { ...dev, exit: { requireToolEvidence: true, criteria: [] } };
      const envelope = createAndVerifyHandoff({
        store, role: devRoleWithEvidence, cwd, summary: "  Refactored and ran job  ", verdict: "ready",
        defaultGoal: "Refactor app", baselineSnapshot: baseline, observedCalls: [jobCall],
        verifiedFacts: [{ claim: "Background job succeeded", evidenceRef: "call-job" }],
      });
      expect(envelope.summary).toBe("Refactored and ran job");
      expect(envelope.artifacts.map((a) => a.path)).toEqual(["test/app.test.ts"]);
      expect(envelope.deletedFiles).toEqual(["src/app.ts"]);
    } finally {
      store.close();
    }
  });

  test("rejects errored tool calls as evidence and requires feedbackForUpstream on rejected verdicts", () => {
    const { cwd, qa, store } = setup();
    try {
      const base = { store, role: qa, cwd, summary: "Ready", verdict: "ready" as const, defaultGoal: "Finish work" };
      expect(() => createAndVerifyHandoff({ ...base, observedCalls: [] }))
        .toThrow(/requires at least one successful non-companion tool execution/);
      expect(() => createAndVerifyHandoff({
        ...base, observedCalls: [{ toolCallId: "call-err", toolName: "bash", isError: true, touchedPaths: [], timestamp: "now" }],
      })).toThrow(/requires at least one successful/);

      // Errored tool call ID cannot be cited in verifiedFacts even on blocked verdict!
      expect(() => createAndVerifyHandoff({
        store, role: qa, cwd, summary: "Blocked", verdict: "blocked", defaultGoal: "Blocked",
        observedCalls: [{ toolCallId: "call-err", toolName: "bash", isError: true, touchedPaths: [], timestamp: "now" }],
        verifiedFacts: [{ claim: "Claimed from failed tool", evidenceRef: "call-err" }],
      })).toThrow(/call-err/);

      expect(() => createAndVerifyHandoff({ store, role: qa, cwd, summary: "Rejected", verdict: "rejected" }))
        .toThrow(/feedbackForUpstream/);
      const rejected = createAndVerifyHandoff({
        store, role: qa, cwd, summary: "Rejected", verdict: "rejected", defaultGoal: "Fix bug",
        feedbackForUpstream: "  Reproduce: bun test  ",
      });
      expect(rejected.feedbackForUpstream).toBe("Reproduce: bun test");
    } finally {
      store.close();
    }
  });
});
