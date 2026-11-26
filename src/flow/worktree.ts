import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { WorktreeManagerLike } from "./executor.ts";

function runGit(
  cwd: string,
  args: readonly string[],
  extraEnv?: Record<string, string>,
): { ok: boolean; stdout: string; stderr: string; status: number } {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
    status: res.status ?? 1,
  };
}

export function isGitRepo(cwd: string): boolean {
  const res = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return res.ok && res.stdout === "true";
}

function worktreeRoot(cwd: string, flowId: string): string {
  const safeFlow = flowId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(cwd, ".omp-enhance", "worktrees", safeFlow);
}

function flowRefPrefix(flowId: string): string {
  const safeFlow = flowId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `refs/omp-enhance/${safeFlow}`;
}

function captureOrGetBaseRef(cwd: string, flowId: string): string {
  const baseRef = `${flowRefPrefix(flowId)}/base`;
  const existing = runGit(cwd, ["rev-parse", "--verify", baseRef]);
  if (existing.ok && existing.stdout) return existing.stdout;

  const head = runGit(cwd, ["rev-parse", "HEAD"]);
  if (!head.ok || !head.stdout) {
    throw new Error(`Git repository at ${cwd} has no HEAD commit (make an initial commit before using worktrees).`);
  }
  const headSha = head.stdout;
  const status = runGit(cwd, ["status", "--porcelain"]);
  if (!status.ok || !status.stdout) {
    runGit(cwd, ["update-ref", baseRef, headSha]);
    return headSha;
  }

  // Dirty working tree: build a non-invasive snapshot commit using an isolated temporary index file
  const root = worktreeRoot(cwd, flowId);
  mkdirSync(root, { recursive: true });
  const tmpIndex = path.join(root, `.tmp-index-${process.pid}-${Date.now().toString(36)}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    const rt = runGit(cwd, ["read-tree", headSha], env);
    if (!rt.ok) throw new Error(`git read-tree failed: ${rt.stderr}`);
    const add = runGit(cwd, ["add", "-A", "--", ".", ":(exclude).omp-enhance"], env);
    if (!add.ok) throw new Error(`git add snapshot failed: ${add.stderr}`);
    const wt = runGit(cwd, ["write-tree"], env);
    if (!wt.ok || !wt.stdout) throw new Error(`git write-tree failed: ${wt.stderr}`);
    const ct = runGit(cwd, ["commit-tree", wt.stdout, "-p", headSha, "-m", `omp-enhance base snapshot (${flowId})`], {
      GIT_AUTHOR_NAME: "omp-enhance",
      GIT_AUTHOR_EMAIL: "omp-enhance@local",
      GIT_COMMITTER_NAME: "omp-enhance",
      GIT_COMMITTER_EMAIL: "omp-enhance@local",
    });
    if (!ct.ok || !ct.stdout) throw new Error(`git commit-tree failed: ${ct.stderr}`);
    runGit(cwd, ["update-ref", baseRef, ct.stdout]);
    return ct.stdout;
  } finally {
    try { rmSync(tmpIndex, { force: true }); } catch {}
  }
}

function removeWorktreeSafe(cwd: string, wtPath: string): void {
  if (!existsSync(wtPath)) return;
  runGit(cwd, ["worktree", "remove", "--force", wtPath]);
  try { rmSync(wtPath, { recursive: true, force: true }); } catch {}
}

export function createGitWorktreeManager(): WorktreeManagerLike {
  return {
    isGitRepo,

    async prepareNodeWorktree({ cwd, flowId, nodeId }) {
      if (!isGitRepo(cwd)) throw new Error(`Target directory is not a Git repository: ${cwd}`);
      const baseRef = captureOrGetBaseRef(cwd, flowId);
      const root = worktreeRoot(cwd, flowId);
      mkdirSync(root, { recursive: true });
      const safeNode = nodeId.replace(/[^a-zA-Z0-9._-]/g, "_");
      const wtPath = path.join(root, safeNode);
      if (existsSync(wtPath)) removeWorktreeSafe(cwd, wtPath);
      runGit(cwd, ["worktree", "prune"]);
      const added = runGit(cwd, ["worktree", "add", "--detach", wtPath, baseRef]);
      if (!added.ok) throw new Error(`git worktree add failed for "${nodeId}": ${added.stderr}`);
      return { worktreePath: wtPath, baseRef };
    },

    async commitNodeWorktree({ worktreePath, flowId, nodeId, summary }) {
      const add = runGit(worktreePath, ["add", "-A", "--", ".", ":(exclude).omp-enhance"]);
      if (!add.ok) throw new Error(`git add failed in worktree "${nodeId}": ${add.stderr}`);
      const diffCheck = runGit(worktreePath, ["diff", "--cached", "--quiet"]);
      if (diffCheck.ok) return null; // No changes
      const commit = runGit(
        worktreePath,
        ["-c", "user.name=omp-enhance", "-c", "user.email=omp-enhance@local", "commit", "-m", `[${nodeId}] ${summary.slice(0, 120)}`],
      );
      if (!commit.ok) throw new Error(`git commit failed in worktree "${nodeId}": ${commit.stderr}`);
      const sha = runGit(worktreePath, ["rev-parse", "HEAD"]);
      if (!sha.ok || !sha.stdout) throw new Error(`git rev-parse HEAD failed in worktree "${nodeId}"`);
      const refName = `${flowRefPrefix(flowId)}/${nodeId.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      runGit(worktreePath, ["update-ref", refName, sha.stdout]);
      return refName;
    },

    async mergeWorktrees({ cwd, flowId, nodeId, sourceRefs, landingMode }) {
      const entries = Object.entries(sourceRefs).filter(([, ref]) => Boolean(ref));
      if (entries.length === 0) {
        return { ok: true, mergedRef: null, summary: "No changes to merge across parallel worktrees." };
      }
      const baseRef = captureOrGetBaseRef(cwd, flowId);
      const root = worktreeRoot(cwd, flowId);
      mkdirSync(root, { recursive: true });
      const mergeWt = path.join(root, `_merge-${nodeId.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
      if (existsSync(mergeWt)) removeWorktreeSafe(cwd, mergeWt);
      runGit(cwd, ["worktree", "prune"]);
      const addWt = runGit(cwd, ["worktree", "add", "--detach", mergeWt, baseRef]);
      if (!addWt.ok) return { ok: false, summary: `Failed to create merge worktree: ${addWt.stderr}` };

      try {
        for (const [srcNode, ref] of entries) {
          const m = runGit(
            mergeWt,
            ["-c", "user.name=omp-enhance", "-c", "user.email=omp-enhance@local", "merge", "--no-ff", "--no-edit", ref],
          );
          if (!m.ok) {
            const conf = runGit(mergeWt, ["diff", "--name-only", "--diff-filter=U"]);
            const conflicts = conf.stdout ? conf.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
            runGit(mergeWt, ["merge", "--abort"]);
            return {
              ok: false,
              conflicts,
              summary: `Merge conflict while integrating "${srcNode}" (${conflicts.join(", ") || m.stderr || "conflict"}).`,
            };
          }
        }
        const mergedSha = runGit(mergeWt, ["rev-parse", "HEAD"]).stdout;
        const mergedRef = `${flowRefPrefix(flowId)}/merged`;
        runGit(cwd, ["update-ref", mergedRef, mergedSha]);

        const stat = runGit(cwd, ["diff", "--stat", baseRef, mergedSha]).stdout;
        if (landingMode === "branch_preview") {
          const previewBranch = `omp-enhance/${flowId.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
          runGit(cwd, ["branch", "-f", previewBranch, mergedSha]);
          return {
            ok: true,
            mergedRef: previewBranch,
            summary: `Merged ${entries.length} branch(es) into preview branch "${previewBranch}".${stat ? `\n${stat}` : ""}`,
          };
        }

        const patchRes = spawnSync("git", ["diff", "--binary", baseRef, mergedSha], {
          cwd,
          maxBuffer: 64 * 1024 * 1024,
        });
        if (patchRes.status !== 0) {
          return { ok: false, summary: `Failed to compute merged diff: ${String(patchRes.stderr ?? "")}` };
        }
        const patchBuf = patchRes.stdout;
        if (patchBuf && patchBuf.length > 0) {
          const apply = spawnSync("git", ["apply", "--3way", "--whitespace=nowarn"], { cwd, input: patchBuf });
          if (apply.status !== 0) {
            const previewBranch = `omp-enhance/${flowId.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
            runGit(cwd, ["branch", "-f", previewBranch, mergedSha]);
            return {
              ok: false,
              conflicts: ["working-tree-drift"],
              summary: `Merged ref "${previewBranch}" created, but applying to main workspace failed (concurrent edits?): ${String(apply.stderr ?? "").trim()}`,
            };
          }
        }
        return {
          ok: true,
          mergedRef,
          summary: `Merged and landed ${entries.length} parallel worktree(s) cleanly.${stat ? ` (${stat.split("\n").at(-1)?.trim() ?? ""})` : ""}`,
        };
      } finally {
        removeWorktreeSafe(cwd, mergeWt);
      }
    },

    async cleanupFlowWorktrees(cwd, flowId) {
      if (!isGitRepo(cwd)) return;
      const root = worktreeRoot(cwd, flowId);
      const list = runGit(cwd, ["worktree", "list", "--porcelain"]);
      if (list.ok && list.stdout) {
        const resolvedRoot = path.resolve(root);
        for (const line of list.stdout.split("\n")) {
          if (!line.startsWith("worktree ")) continue;
          const wtPath = path.resolve(line.slice("worktree ".length).trim());
          if (wtPath === resolvedRoot || wtPath.startsWith(`${resolvedRoot}${path.sep}`)) {
            removeWorktreeSafe(cwd, wtPath);
          }
        }
      }
      try { rmSync(root, { recursive: true, force: true }); } catch {}
      runGit(cwd, ["worktree", "prune"]);
      const prefix = flowRefPrefix(flowId);
      const refs = runGit(cwd, ["for-each-ref", "--format=%(refname)", prefix]);
      if (refs.ok && refs.stdout) {
        for (const r of refs.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
          runGit(cwd, ["update-ref", "-d", r]);
        }
      }
    },
  };
}
