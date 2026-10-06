import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { combinedTitle } from "../backend/refine.ts";
import type { Db } from "../db.ts";
import type { Bundle, Config, Task } from "../types.ts";

export interface OpenBundleOptions {
  repoRoot: string;
  config: Config;
  project: string;
  /** Staged tasks, in staging order. */
  tasks: Task[];
  title?: string;
  /** Titles of a task's findings, for the PR body. */
  findingTitles(task: Task): string[];
}

/** A cherry-pick of `task`'s commits failed; nothing was left behind. */
export class BundleConflict extends Error {}

const PR_TEMPLATES = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "PULL_REQUEST_TEMPLATE.md", "pull_request_template.md"];

/**
 * Cherry-pick the tasks' commits onto a fresh branch from the latest base, push it and open one
 * PR with gh. See docs/DESIGN.md "Staging and combined PRs".
 */
export async function openBundle(opts: OpenBundleOptions): Promise<Bundle> {
  const { repoRoot, config, tasks } = opts;
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const branch = `techtree/bundle-${id}`;
  const worktree = config.worktreeTemplate
    .replaceAll("{home}", homedir())
    .replaceAll("{repo}", basename(repoRoot))
    .replaceAll("{task}", `bundle-${id}`);
  const remote = await upstreamRemote(repoRoot);
  const baseBranch = await run(repoRoot, "git", "rev-parse", "--abbrev-ref", config.baseRef).then((out) => out.trim(), () => "");
  const fromRemote = remote !== undefined && baseBranch !== "" && baseBranch !== "HEAD";
  if (fromRemote) await run(repoRoot, "git", "fetch", remote, baseBranch);
  mkdirSync(dirname(worktree), { recursive: true });
  await run(repoRoot, "git", "worktree", "add", "-b", branch, worktree, fromRemote ? `${remote}/${baseBranch}` : config.baseRef);
  const cleanUp = async () => {
    await run(repoRoot, "git", "worktree", "remove", "--force", worktree).catch(() => {});
    await run(repoRoot, "git", "branch", "-D", branch).catch(() => {});
  };
  try {
    for (const task of tasks) await cherryPick(repoRoot, worktree, config.baseRef, task);
    if (!remote) throw new Error("the repository has no remote to push the combined branch to");
    await run(worktree, "git", "push", "-u", remote, branch);
  } catch (err) {
    await cleanUp();
    throw err;
  }
  const title =
    opts.title ??
    (tasks.length === 1
      ? tasks[0].title
      : ((await combinedTitle(tasks.map((t) => `${t.title} (${t.node || "repo root"})`), config, repoRoot)) ?? `${tasks[0].title} (+${tasks.length - 1} more)`));
  const body = await prBody(opts, worktree);
  const created = await run(worktree, "gh", "pr", "create", "--head", branch, "--title", title, "--body", body, ...(fromRemote ? ["--base", baseBranch] : []));
  const url = /https:\/\/\S+\/pull\/\d+/.exec(created)?.[0];
  if (!url) throw new Error(`gh pr create printed no PR URL: ${created.trim()}`);
  return {
    id,
    project: opts.project,
    title,
    branch,
    worktree,
    taskIds: tasks.map((t) => t.id),
    pr: Number(/\/pull\/(\d+)/.exec(url)![1]),
    url,
    createdAt: new Date().toISOString(),
  };
}

async function cherryPick(repoRoot: string, worktree: string, baseRef: string, task: Task): Promise<void> {
  const base = (await run(repoRoot, "git", "merge-base", baseRef, task.branch!)).trim();
  const commits = (await run(repoRoot, "git", "rev-list", "--reverse", "--no-merges", `${base}..${task.branch}`)).split("\n").filter(Boolean);
  for (const sha of commits) {
    const changesNothing = await run(repoRoot, "git", "diff-tree", "--quiet", `${sha}^`, sha).then(() => true, () => false);
    if (changesNothing) continue;
    try {
      await run(worktree, "git", "cherry-pick", "--empty=drop", sha);
    } catch {
      await run(worktree, "git", "cherry-pick", "--abort").catch(() => {});
      throw new BundleConflict(`cherry-pick conflict in task ${task.id} (${task.title})`);
    }
  }
}

async function prBody(opts: OpenBundleOptions, worktree: string): Promise<string> {
  const lines = await Promise.all(
    opts.tasks.map(async (task) => {
      const findings = opts.findingTitles(task);
      const subject = (await run(opts.repoRoot, "git", "log", "-1", "--format=%s", task.branch!)).trim();
      return `- **${task.title}** (${task.node || "repository root"}): ${findings.length ? findings.join("; ") : "no findings"} — ${subject}`;
    }),
  );
  const template = prTemplate(worktree);
  return [`Combined techtree changes:\n\n${lines.join("\n")}`, template].filter(Boolean).join("\n\n");
}

function prTemplate(worktree: string): string | undefined {
  for (const wanted of PR_TEMPLATES) {
    const dir = join(worktree, dirname(wanted));
    if (!existsSync(dir)) continue;
    const name = readdirSync(dir).find((f) => f.toLowerCase() === basename(wanted).toLowerCase());
    if (name) return readFileSync(join(dir, name), "utf8").trim();
  }
  return undefined;
}

async function upstreamRemote(repoRoot: string): Promise<string | undefined> {
  const remotes = (await run(repoRoot, "git", "remote")).split("\n").filter(Boolean);
  return remotes.includes("origin") ? "origin" : remotes[0];
}

async function run(cwd: string, command: string, ...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export function saveBundle(db: Db, bundle: Bundle): void {
  db.prepare("INSERT INTO bundles (id, project, data) VALUES (?, ?, ?)").run(bundle.id, bundle.project, JSON.stringify(bundle));
}

/** Bundles of `project` (every project when undefined), oldest first. */
export function listBundles(db: Db, project?: string): Bundle[] {
  const rows = db.prepare("SELECT data FROM bundles").all() as { data: string }[];
  return rows
    .map((r) => JSON.parse(r.data) as Bundle)
    .filter((b) => project === undefined || b.project === project)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
