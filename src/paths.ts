import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Repo root for any path inside a git checkout or worktree. */
export function repoRootOf(path: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: path, encoding: "utf8" }).trim();
}

/**
 * Stable id shared by a repo and all its worktrees: `<name>-<hash of the git common dir>`.
 */
export function repoId(repoRoot: string): string {
  const common = resolve(
    repoRoot,
    execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8" }).trim(),
  );
  const name = basename(common === join(repoRoot, ".git") ? repoRoot : common.replace(/\/\.git$/, ""));
  return `${name}-${createHash("sha256").update(common).digest("hex").slice(0, 8)}`;
}

/** `$XDG_CACHE_HOME/techtree/<repo-id>` (default `~/.cache/techtree/<repo-id>`), created on demand. */
export function cacheDir(id: string): string {
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "techtree", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
