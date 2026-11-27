import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import type { WorktreeManagerLike } from "./executor.ts";

function runGit(
  cwd: string,
  args: readonly string[],
  extraEnv?: Record<string, string>,
): { ok: boolean; stdout: string; stderr: string; status: number } {
  const res = spawnSync("git", args, {
    cwd, encoding: "utf8", timeout: 30_000,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return { ok: res.status === 0, stdout: (res.stdout ?? "").trim(), stderr: (res.stderr ?? "").trim(), status: res.status ?? 1 };
}

function runGitBuf(cwd: string, args: readonly string[]): { ok: boolean; stdout: Buffer; stderr: string; status: number } {
  const res = spawnSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
  return { ok: res.status === 0, stdout: res.stdout ?? Buffer.alloc(0), stderr: String(res.stderr ?? "").trim(), status: res.status ?? 1 };
}

export function isGitRepo(cwd: string): boolean {
  const res = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return res.ok && res.stdout === "true";
}

function resolveGitLayout(cwd: string): { gitRoot: string; relSubdir: string } {
  const top = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.stdout) throw new Error(`Target directory is not a Git repository: ${cwd}`);
  const gitRoot = realpathSync(top.stdout);
  const resolvedCwd = realpathSync(cwd);
  const relSubdir = path.relative(gitRoot, resolvedCwd);
  return { gitRoot, relSubdir: relSubdir && relSubdir !== "." && !relSubdir.startsWith("..") ? relSubdir : "" };
}

const safeToken = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, "_");
const worktreeRoot = (gitRoot: string, flowId: string): string => path.join(gitRoot, ".omp-enhance", "worktrees", safeToken(flowId));
const flowRefPrefix = (flowId: string): string => `refs/omp-enhance/${safeToken(flowId)}`;
const isEnhanceInternalPath = (rel: string): boolean => rel === ".omp-enhance" || rel.startsWith(".omp-enhance/") || rel.includes("/.omp-enhance/");

function stageAllExcludingEnhance(gitRoot: string, extraEnv?: Record<string, string>): { ok: boolean; stderr: string } {
  const upd = runGit(gitRoot, ["add", "-u"], extraEnv);
  if (!upd.ok) return { ok: false, stderr: upd.stderr };
  const others = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: gitRoot, encoding: "utf8", timeout: 30_000,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (others.status !== 0) return { ok: false, stderr: (others.stderr ?? "").trim() };
  const files = (others.stdout ?? "").split("\0").filter((p) => p.length > 0 && !isEnhanceInternalPath(p));
  if (files.length === 0) return { ok: true, stderr: "" };
  const idx = spawnSync("git", ["update-index", "--add", "-z", "--stdin"], {
    cwd: gitRoot, input: `${files.join("\0")}\0`, encoding: "utf8", timeout: 30_000,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return { ok: idx.status === 0, stderr: (idx.stderr ?? "").trim() };
}

function createOrUpdatePreviewBranch(
  gitRoot: string,
  flowId: string,
  commitSha: string,
  preferredBranch?: string,
): { ok: true; branch: string } | { ok: false; error: string } {
  const slug = flowId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const candidates = preferredBranch
    ? [preferredBranch, `omp-enhance/${slug}`, `omp-enhance-${slug}`]
    : [`omp-enhance/${slug}`, `omp-enhance-${slug}`];
  let lastErr = "";
  for (const branch of [...new Set(candidates)]) {
    const res = runGit(gitRoot, ["branch", "-f", branch, commitSha]);
    if (res.ok) {
      const verified = runGit(gitRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
      if (verified.ok && verified.stdout === commitSha) return { ok: true, branch };
    }
    lastErr = res.stderr || `git branch -f "${branch}" failed`;
  }
  return { ok: false, error: `Failed to create preview branch for ${flowId}: ${lastErr}` };
}

function captureOrGetBaseRef(gitRoot: string, flowId: string): string {
  const baseRef = `${flowRefPrefix(flowId)}/base`;
  const baseIndexRef = `${flowRefPrefix(flowId)}/base-index`;
  const existing = runGit(gitRoot, ["rev-parse", "--verify", baseRef]);
  if (existing.ok && existing.stdout) return existing.stdout;

  const head = runGit(gitRoot, ["rev-parse", "HEAD"]);
  if (!head.ok || !head.stdout) {
    throw new Error(`Git repository at ${gitRoot} has no HEAD commit (make an initial commit before using worktrees).`);
  }
  const headSha = head.stdout;
  const idxTree = runGit(gitRoot, ["write-tree"]);
  if (idxTree.ok && idxTree.stdout) runGit(gitRoot, ["update-ref", baseIndexRef, idxTree.stdout]);

  const status = runGit(gitRoot, ["status", "--porcelain"]);
  if (!status.ok || !status.stdout) {
    runGit(gitRoot, ["update-ref", baseRef, headSha]);
    return headSha;
  }

  const root = worktreeRoot(gitRoot, flowId);
  mkdirSync(root, { recursive: true });
  const tmpIndex = path.join(root, `.tmp-index-${process.pid}-${Date.now().toString(36)}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    const rt = runGit(gitRoot, ["read-tree", headSha], env);
    if (!rt.ok) throw new Error(`git read-tree failed: ${rt.stderr}`);
    const staged = stageAllExcludingEnhance(gitRoot, env);
    if (!staged.ok) throw new Error(`git snapshot stage failed: ${staged.stderr}`);
    const wt = runGit(gitRoot, ["write-tree"], env);
    if (!wt.ok || !wt.stdout) throw new Error(`git write-tree failed: ${wt.stderr}`);
    const ct = runGit(gitRoot, ["commit-tree", wt.stdout, "-p", headSha, "-m", `omp-enhance base snapshot (${flowId})`], {
      GIT_AUTHOR_NAME: "omp-enhance", GIT_AUTHOR_EMAIL: "omp-enhance@local",
      GIT_COMMITTER_NAME: "omp-enhance", GIT_COMMITTER_EMAIL: "omp-enhance@local",
    });
    if (!ct.ok || !ct.stdout) throw new Error(`git commit-tree failed: ${ct.stderr}`);
    runGit(gitRoot, ["update-ref", baseRef, ct.stdout]);
    return ct.stdout;
  } finally {
    try { rmSync(tmpIndex, { force: true }); } catch {}
  }
}

function sha256Buf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function checkTouchedFilesDrift(gitRoot: string, flowId: string, baseRef: string, touchedFiles: readonly string[]): string[] {
  const reasons: string[] = [];
  for (const rel of touchedFiles) {
    const absPath = path.join(gitRoot, rel);
    const inBase = runGit(gitRoot, ["cat-file", "-e", `${baseRef}:${rel}`]).ok;
    const onDisk = existsSync(absPath);
    if (inBase) {
      if (!onDisk) { reasons.push(`file "${rel}" removed locally`); continue; }
      const baseBlob = runGitBuf(gitRoot, ["show", `${baseRef}:${rel}`]);
      const diskBytes = readFileSync(absPath);
      if (!baseBlob.ok || sha256Buf(baseBlob.stdout) !== sha256Buf(diskBytes)) {
        reasons.push(`working tree modified "${rel}"`);
      }
    } else if (onDisk) {
      reasons.push(`untracked file "${rel}" added locally`);
    }
  }
  const curIdxTree = runGit(gitRoot, ["write-tree"]);
  const baseIdxRef = runGit(gitRoot, ["rev-parse", "--verify", `${flowRefPrefix(flowId)}/base-index`]);
  if (!curIdxTree.ok) {
    reasons.push("staging index has unmerged entries");
  } else if (baseIdxRef.ok && baseIdxRef.stdout && touchedFiles.length > 0) {
    const idxDrift = runGit(gitRoot, ["diff-tree", "--quiet", baseIdxRef.stdout, curIdxTree.stdout, "--", ...touchedFiles]);
    if (!idxDrift.ok) reasons.push("staging index modified");
  }
  return reasons;
}

function removeWorktreeSafe(gitRoot: string, wtPath: string): void {
  if (!existsSync(wtPath)) return;
  runGit(gitRoot, ["worktree", "remove", "--force", wtPath]);
  try { rmSync(wtPath, { recursive: true, force: true }); } catch {}
}

export function createGitWorktreeManager(): WorktreeManagerLike {
  return {
    isGitRepo,

    async prepareNodeWorktree({ cwd, flowId, nodeId, baseCommitSha }) {
      const { gitRoot, relSubdir } = resolveGitLayout(cwd);
      const baseRef = baseCommitSha ?? captureOrGetBaseRef(gitRoot, flowId);
      const root = worktreeRoot(gitRoot, flowId);
      mkdirSync(root, { recursive: true });
      const wtPath = path.join(root, safeToken(nodeId));
      if (existsSync(wtPath)) removeWorktreeSafe(gitRoot, wtPath);
      runGit(gitRoot, ["worktree", "prune"]);
      const added = runGit(gitRoot, ["worktree", "add", "--detach", wtPath, baseRef]);
      if (!added.ok) throw new Error(`git worktree add failed for "${nodeId}": ${added.stderr}`);
      const scopedPath = relSubdir ? path.join(wtPath, relSubdir) : wtPath;
      if (relSubdir && !existsSync(scopedPath)) mkdirSync(scopedPath, { recursive: true });
      return { worktreePath: scopedPath, baseRef };
    },

    async commitNodeWorktree({ worktreePath, flowId, nodeId, summary }) {
      const { gitRoot } = resolveGitLayout(worktreePath);
      const staged = stageAllExcludingEnhance(gitRoot);
      if (!staged.ok) throw new Error(`git stage failed in worktree "${nodeId}": ${staged.stderr}`);
      const diffCheck = runGit(gitRoot, ["diff", "--cached", "--quiet"]);
      if (diffCheck.ok) return null;
      const commit = runGit(gitRoot, ["-c", "user.name=omp-enhance", "-c", "user.email=omp-enhance@local", "commit", "-m", `[${nodeId}] ${summary.slice(0, 120)}`]);
      if (!commit.ok) throw new Error(`git commit failed in worktree "${nodeId}": ${commit.stderr}`);
      const sha = runGit(gitRoot, ["rev-parse", "HEAD"]);
      if (!sha.ok || !sha.stdout) throw new Error(`git rev-parse HEAD failed in worktree "${nodeId}"`);
      const refName = `${flowRefPrefix(flowId)}/${safeToken(nodeId)}`;
      runGit(gitRoot, ["update-ref", refName, sha.stdout]);
      return refName;
    },

    async commitAndUpdatePreviewRef({ cwd, worktreePath, flowId, nodeId, targetRef, expectedParentSha, summary }) {
      const { gitRoot: mainRoot } = resolveGitLayout(cwd);
      const { gitRoot: wtRoot } = resolveGitLayout(worktreePath);
      const staged = stageAllExcludingEnhance(wtRoot);
      if (!staged.ok) throw new Error(`git stage failed in preview worktree "${nodeId}": ${staged.stderr}`);
      const diffCheck = runGit(wtRoot, ["diff", "--cached", "--quiet"]);
      if (diffCheck.ok) return null;
      const commit = runGit(wtRoot, ["-c", "user.name=omp-enhance", "-c", "user.email=omp-enhance@local", "commit", "-m", `[${nodeId}] ${summary.slice(0, 120)}`]);
      if (!commit.ok) throw new Error(`git commit failed in preview worktree "${nodeId}": ${commit.stderr}`);
      const sha = runGit(wtRoot, ["rev-parse", "HEAD"]);
      if (!sha.ok || !sha.stdout) throw new Error(`git rev-parse HEAD failed in preview worktree "${nodeId}"`);
      const preferred = targetRef.startsWith("omp-enhance") ? targetRef : undefined;
      if (preferred && expectedParentSha) {
        const curTip = runGit(mainRoot, ["rev-parse", "--verify", `refs/heads/${preferred}`]);
        if (curTip.ok && curTip.stdout && curTip.stdout !== expectedParentSha) {
          throw new Error(`Concurrent update detected on preview branch "${preferred}" (expected ${expectedParentSha.slice(0, 12)}, found ${curTip.stdout.slice(0, 12)}); refusing to overwrite.`);
        }
      }
      const br = createOrUpdatePreviewBranch(mainRoot, flowId, sha.stdout, preferred);
      if (!br.ok) throw new Error(br.error);
      return { commitRef: br.branch, commitSha: sha.stdout };
    },

    async mergeWorktrees({ cwd, flowId, nodeId, sourceRefs, landingMode, baseCommitSha }) {
      const entries = Object.entries(sourceRefs).filter(([, ref]) => Boolean(ref));
      if (entries.length === 0) return { ok: true, mergedRef: null, mergedCommitSha: null, summary: "No changes to merge across parallel worktrees." };
      const { gitRoot } = resolveGitLayout(cwd);
      const baseRef = baseCommitSha ?? captureOrGetBaseRef(gitRoot, flowId);
      const root = worktreeRoot(gitRoot, flowId);
      mkdirSync(root, { recursive: true });
      const mergeWt = path.join(root, `_merge-${safeToken(nodeId)}`);
      if (existsSync(mergeWt)) removeWorktreeSafe(gitRoot, mergeWt);
      runGit(gitRoot, ["worktree", "prune"]);
      const addWt = runGit(gitRoot, ["worktree", "add", "--detach", mergeWt, baseRef]);
      if (!addWt.ok) return { ok: false, summary: `Failed to create merge worktree: ${addWt.stderr}` };

      try {
        for (const [srcNode, ref] of entries) {
          const m = runGit(mergeWt, ["-c", "user.name=omp-enhance", "-c", "user.email=omp-enhance@local", "merge", "--no-ff", "--no-edit", ref]);
          if (!m.ok) {
            const conf = runGit(mergeWt, ["diff", "--name-only", "--diff-filter=U"]);
            const conflicts = conf.stdout ? conf.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
            runGit(mergeWt, ["merge", "--abort"]);
            return { ok: false, conflicts, summary: `Merge conflict while integrating "${srcNode}" (${conflicts.join(", ") || m.stderr || "conflict"}).` };
          }
        }
        const mergedSha = runGit(mergeWt, ["rev-parse", "HEAD"]).stdout;
        const mergedRef = `${flowRefPrefix(flowId)}/merged`;
        runGit(gitRoot, ["update-ref", mergedRef, mergedSha]);

        const stat = runGit(gitRoot, ["diff", "--stat", baseRef, mergedSha]).stdout;
        if (landingMode === "branch_preview") {
          const br = createOrUpdatePreviewBranch(gitRoot, flowId, mergedSha);
          if (!br.ok) return { ok: false, mergedCommitSha: mergedSha, summary: br.error };
          return {
            ok: true, mergedRef: br.branch, mergedCommitSha: mergedSha,
            summary: `Merged ${entries.length} branch(es) into preview branch "${br.branch}" (${mergedSha.slice(0, 12)}).${stat ? `\n${stat}` : ""}`,
          };
        }

        const touchedRes = runGit(gitRoot, ["diff", "--name-only", baseRef, mergedSha]);
        const touchedFiles = touchedRes.ok && touchedRes.stdout ? touchedRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
        const patchRes = runGitBuf(gitRoot, ["diff", "--binary", baseRef, mergedSha]);
        if (!patchRes.ok) return { ok: false, summary: `Failed to compute merged diff: ${patchRes.stderr}` };
        const patchBuf = patchRes.stdout;
        if (patchBuf.length > 0) {
          const driftReasons = checkTouchedFilesDrift(gitRoot, flowId, baseRef, touchedFiles);
          const dryRun = driftReasons.length === 0
            ? spawnSync("git", ["apply", "--check", "--whitespace=nowarn"], { cwd: gitRoot, input: patchBuf })
            : { status: 1, stderr: "" };
          if (driftReasons.length > 0 || dryRun.status !== 0) {
            const br = createOrUpdatePreviewBranch(gitRoot, flowId, mergedSha);
            const detail = driftReasons.length > 0 ? driftReasons.join("; ") : String(dryRun.stderr ?? "").trim();
            return {
              ok: false, ...(br.ok ? { mergedRef: br.branch } : {}), mergedCommitSha: mergedSha, conflicts: ["working-tree-drift"],
              summary: br.ok
                ? `Merged ref "${br.branch}" (${mergedSha.slice(0, 12)}) created, but main workspace/index drifted (${detail}); left your working tree and staging index untouched.`
                : `Main workspace/index drifted (${detail}) and preview branch failed (${br.error}); left your files untouched.`,
            };
          }
          const apply = spawnSync("git", ["apply", "--whitespace=nowarn"], { cwd: gitRoot, input: patchBuf });
          if (apply.status !== 0) {
            const br = createOrUpdatePreviewBranch(gitRoot, flowId, mergedSha);
            return {
              ok: false, ...(br.ok ? { mergedRef: br.branch } : {}), mergedCommitSha: mergedSha, conflicts: ["working-tree-drift"],
              summary: `Applying merged patch to main workspace failed: ${String(apply.stderr ?? "").trim()}${br.ok ? ` (preview branch "${br.branch}" preserved)` : ""}`,
            };
          }
        }
        return {
          ok: true, mergedRef, mergedCommitSha: mergedSha,
          summary: `Merged and landed ${entries.length} parallel worktree(s) cleanly.${stat ? ` (${stat.split("\n").at(-1)?.trim() ?? ""})` : ""}`,
        };
      } finally {
        removeWorktreeSafe(gitRoot, mergeWt);
      }
    },

    async withCommitWorktree<T>(
      { cwd, flowId, nodeId, commitRef }: { cwd: string; flowId: string; nodeId: string; commitRef: string },
      fn: (ctx: { worktreePath: string; commitSha: string }) => Promise<T>,
    ): Promise<T> {
      const { gitRoot, relSubdir } = resolveGitLayout(cwd);
      const rev = runGit(gitRoot, ["rev-parse", "--verify", commitRef]);
      if (!rev.ok || !rev.stdout) throw new Error(`Cannot resolve commit ref "${commitRef}" for node "${nodeId}": ${rev.stderr}`);
      const commitSha = rev.stdout;
      const root = worktreeRoot(gitRoot, flowId);
      mkdirSync(root, { recursive: true });
      const wtPath = path.join(root, `_eval-${safeToken(nodeId)}-${Date.now().toString(36)}`);
      if (existsSync(wtPath)) removeWorktreeSafe(gitRoot, wtPath);
      runGit(gitRoot, ["worktree", "prune"]);
      const added = runGit(gitRoot, ["worktree", "add", "--detach", wtPath, commitSha]);
      if (!added.ok) throw new Error(`git worktree add failed for "${nodeId}" at "${commitRef}": ${added.stderr}`);
      const scopedPath = relSubdir ? path.join(wtPath, relSubdir) : wtPath;
      try {
        return await fn({ worktreePath: scopedPath, commitSha });
      } finally {
        removeWorktreeSafe(gitRoot, wtPath);
      }
    },

    async cleanupFlowWorktrees(cwd, flowId) {
      if (!isGitRepo(cwd)) return;
      const { gitRoot } = resolveGitLayout(cwd);
      const root = worktreeRoot(gitRoot, flowId);
      const list = runGit(gitRoot, ["worktree", "list", "--porcelain"]);
      if (list.ok && list.stdout) {
        const resolvedRoot = path.resolve(root);
        for (const line of list.stdout.split("\n")) {
          if (!line.startsWith("worktree ")) continue;
          const wtPath = path.resolve(line.slice("worktree ".length).trim());
          if (wtPath === resolvedRoot || wtPath.startsWith(`${resolvedRoot}${path.sep}`)) removeWorktreeSafe(gitRoot, wtPath);
        }
      }
      try { rmSync(root, { recursive: true, force: true }); } catch {}
      runGit(gitRoot, ["worktree", "prune"]);
      const prefix = flowRefPrefix(flowId);
      const refs = runGit(gitRoot, ["for-each-ref", "--format=%(refname)", prefix]);
      if (refs.ok && refs.stdout) {
        for (const r of refs.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) runGit(gitRoot, ["update-ref", "-d", r]);
      }
    },
  };
}
