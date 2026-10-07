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

/** Written before a smart bundle's push, so a retry can find what an ambiguous push or PR create left behind (DESIGN "Smart PR composition"). */
export interface PublishIntent {
  bundle: Omit<Bundle, "pr" | "url">;
  body: string;
}

/** An intent's PR was closed or merged: drop the intent, the task needs a fresh publication. */
export class StaleIntent extends Error {}

export interface StackedBundleOptions {
  repoRoot: string;
  config: Config;
  project: string;
  task: Task;
  /** The task head pinned when the tasks were grouped; its commits are what gets replayed. */
  sourceHead: string;
  /** The open bundle to stack on; without one the PR targets the resolved base branch. */
  parent?: Bundle;
  findingTitles(task: Task): string[];
  /** Persist the intent; called right before the push. */
  journal(intent: PublishIntent): void;
}

const PR_TEMPLATES = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "PULL_REQUEST_TEMPLATE.md", "pull_request_template.md"];

/**
 * Cherry-pick the tasks' commits onto a fresh branch from the latest base, push it and open one
 * PR with gh. See docs/DESIGN.md "Staging and combined PRs".
 */
export async function openBundle(opts: OpenBundleOptions): Promise<Bundle> {
  const { repoRoot, config, tasks } = opts;
  const { id, branch, worktree } = bundlePlace(repoRoot, config);
  const remote = await upstreamRemote(repoRoot);
  const baseBranch = await run(repoRoot, "git", "rev-parse", "--abbrev-ref", config.baseRef).then((out) => out.trim(), () => "");
  const fromRemote = remote !== undefined && baseBranch !== "" && baseBranch !== "HEAD";
  if (fromRemote) await run(repoRoot, "git", "fetch", remote, baseBranch);
  mkdirSync(dirname(worktree), { recursive: true });
  await run(repoRoot, "git", "worktree", "add", "-b", branch, worktree, fromRemote ? `${remote}/${baseBranch}` : config.baseRef);
  try {
    for (const task of tasks) await cherryPick(repoRoot, worktree, config.baseRef, task, task.branch!);
    if (!remote) throw new Error("the repository has no remote to push the combined branch to");
    await run(worktree, "git", "push", "-u", remote, branch);
  } catch (err) {
    await removeBundleWorktree(repoRoot, worktree, branch);
    throw err;
  }
  const title =
    opts.title ??
    (tasks.length === 1
      ? tasks[0].title
      : ((await combinedTitle(tasks.map((t) => `${t.title} (${t.node || "repo root"})`), config, repoRoot)) ?? `${tasks[0].title} (+${tasks.length - 1} more)`));
  const body = await prBody(opts, tasks.map((task) => [task, task.branch!]), worktree);
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

/**
 * Replay one task onto a fresh branch from the base branch or from `parent`'s head, push it and open its own PR
 * targeting that base or the parent's branch. Original task branches are never touched. See docs/DESIGN.md "Smart PR composition".
 */
export async function openStackedBundle(opts: StackedBundleOptions): Promise<Bundle> {
  const { repoRoot, config, task, parent } = opts;
  const remote = await upstreamRemote(repoRoot);
  if (!remote) throw new Error("the repository has no remote to push stacked PRs to");
  let base: string;
  let start: string;
  if (parent) {
    await run(repoRoot, "git", "fetch", remote, parent.branch);
    [base, start] = [parent.branch, parent.head!];
  } else {
    base = await run(repoRoot, "git", "rev-parse", "--abbrev-ref", config.baseRef).then((out) => out.trim(), () => "");
    if (base === "" || base === "HEAD") throw new Error(`baseRef ${config.baseRef} names no branch to target`);
    await run(repoRoot, "git", "fetch", remote, base);
    start = `${remote}/${base}`;
  }
  const { id, branch, worktree } = bundlePlace(repoRoot, config);
  mkdirSync(dirname(worktree), { recursive: true });
  await run(repoRoot, "git", "worktree", "add", "-b", branch, worktree, start);
  let head: string;
  try {
    await cherryPick(repoRoot, worktree, config.baseRef, task, opts.sourceHead);
    head = (await run(worktree, "git", "rev-parse", "HEAD")).trim();
    const unchanged = await run(worktree, "git", "diff", "--quiet", start, "HEAD").then(() => true, (err) => {
      if (err.code === 1) return false;
      throw err;
    });
    if (unchanged) throw new Error(`task ${task.id} (${task.title}) changes nothing on top of ${base}`);
  } catch (err) {
    await removeBundleWorktree(repoRoot, worktree, branch);
    throw err;
  }
  const stacked = parent ? `Stacked on #${parent.pr}.\n\n` : "";
  const body = stacked + (await prBody(opts, [[task, opts.sourceHead]], worktree));
  const bundle = {
    id,
    project: opts.project,
    title: task.title,
    branch,
    worktree,
    taskIds: [task.id],
    createdAt: new Date().toISOString(),
    base,
    head,
    sourceHead: opts.sourceHead,
    stack: parent?.stack ?? id,
    ...(parent && { parent: parent.id }),
  };
  opts.journal({ bundle, body });
  await run(worktree, "git", "push", "-u", remote, branch);
  return { ...bundle, ...(await createPr(worktree, branch, base, task.title, body)) };
}

/**
 * Finish or adopt what an earlier attempt of `intent` left behind: its open PR (matching base and head), else a PR for its
 * pushed branch. Undefined when nothing was pushed. Throws `StaleIntent` when its PR was closed or merged.
 */
export async function recoverIntent(repoRoot: string, { bundle, body }: PublishIntent, createMissingPr = true): Promise<Bundle | undefined> {
  let prs: { number: number; url: string; state: string; baseRefName: string; headRefOid: string }[];
  try {
    prs = JSON.parse(await run(repoRoot, "gh", "pr", "list", "--head", bundle.branch, "--state", "all", "--json", "number,url,state,baseRefName,headRefOid"));
  } catch (err) {
    throw new Error(`looking up the PR of ${bundle.branch} failed; retry later: ${errorText(err)}`);
  }
  const open = prs.find((pr) => pr.state === "OPEN");
  if (open && open.baseRefName === bundle.base && open.headRefOid === bundle.head) return { ...bundle, pr: open.number, url: open.url };
  if (open) throw new Error(`PR #${open.number} on ${bundle.branch} no longer matches its publication (base ${open.baseRefName}, head ${open.headRefOid})`);
  if (prs.length) throw new StaleIntent(`PR #${prs[0].number} on ${bundle.branch} was ${prs[0].state.toLowerCase()}; group again to publish afresh`);
  const remote = (await upstreamRemote(repoRoot))!;
  const pushed = (await run(repoRoot, "git", "ls-remote", remote, `refs/heads/${bundle.branch}`)).split("\t")[0].trim();
  if (!pushed) return undefined;
  if (pushed !== bundle.head) throw new Error(`${bundle.branch} moved to ${pushed} since it was pushed`);
  if (!createMissingPr) return undefined;
  return { ...bundle, ...(await createPr(repoRoot, bundle.branch, bundle.base!, bundle.title, body)) };
}

/** Throw unless `parent`'s PR is still open on its recorded branch, head and base, and the remote branch is at that head. */
export async function verifyParent(repoRoot: string, parent: Bundle): Promise<void> {
  let pr: { state: string; headRefName: string; headRefOid: string; baseRefName: string };
  try {
    pr = JSON.parse(await run(repoRoot, "gh", "pr", "view", String(parent.pr), "--json", "state,headRefName,headRefOid,baseRefName"));
  } catch (err) {
    throw new Error(`looking up parent PR #${parent.pr} failed: ${errorText(err)}`);
  }
  const expected = { state: "OPEN", headRefName: parent.branch, headRefOid: parent.head, baseRefName: parent.base };
  const drift = Object.entries(expected).filter(([key, value]) => pr[key as keyof typeof pr] !== value);
  if (drift.length) throw new Error(`parent PR #${parent.pr} changed (${drift.map(([key]) => `${key} ${pr[key as keyof typeof pr]}`).join(", ")}); group again`);
  const remote = (await upstreamRemote(repoRoot))!;
  const pushed = (await run(repoRoot, "git", "ls-remote", remote, `refs/heads/${parent.branch}`)).split("\t")[0].trim();
  if (pushed !== parent.head) throw new Error(`parent PR #${parent.pr}'s branch ${parent.branch} moved; group again`);
}

async function createPr(cwd: string, branch: string, base: string, title: string, body: string): Promise<{ pr: number; url: string }> {
  const created = await run(cwd, "gh", "pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body);
  const url = /https:\/\/\S+\/pull\/\d+/.exec(created)?.[0];
  if (!url) throw new Error(`gh pr create printed no PR URL: ${created.trim()}`);
  return { pr: Number(/\/pull\/(\d+)/.exec(url)![1]), url };
}

function bundlePlace(repoRoot: string, config: Config): { id: string; branch: string; worktree: string } {
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const worktree = config.worktreeTemplate
    .replaceAll("{home}", homedir())
    .replaceAll("{repo}", basename(repoRoot))
    .replaceAll("{task}", `bundle-${id}`);
  return { id, branch: `techtree/bundle-${id}`, worktree };
}

async function removeBundleWorktree(repoRoot: string, worktree: string, branch: string): Promise<void> {
  await run(repoRoot, "git", "worktree", "remove", "--force", worktree).catch(() => {});
  await run(repoRoot, "git", "branch", "-D", branch).catch(() => {});
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function cherryPick(repoRoot: string, worktree: string, baseRef: string, task: Task, head: string): Promise<void> {
  const base = (await run(repoRoot, "git", "merge-base", baseRef, head)).trim();
  const commits = (await run(repoRoot, "git", "rev-list", "--reverse", "--no-merges", `${base}..${head}`)).split("\n").filter(Boolean);
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

/** `tasks` pairs each task with the commit whose subject the body quotes. */
async function prBody(opts: Pick<OpenBundleOptions, "repoRoot" | "findingTitles">, tasks: [Task, string][], worktree: string): Promise<string> {
  const lines = await Promise.all(
    tasks.map(async ([task, head]) => {
      const findings = opts.findingTitles(task);
      const subject = (await run(opts.repoRoot, "git", "log", "-1", "--format=%s", head)).trim();
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
