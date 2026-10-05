import type { CollectCtx, MetricPlugin, MetricValues, NodeId } from "../types.ts";
import { nodeOfFile, run } from "./util/source.ts";

const DAY_MS = 86_400_000;
export const PR_CACHE_MS = 10 * 60_000;

interface OpenPr {
  number: number;
  files: string[];
}

interface Activity {
  churn: number;
  authors: Set<string>;
}

async function git(ctx: CollectCtx, args: string[]): Promise<string> {
  const res = await run("git", ["-c", "core.quotePath=false", ...args], ctx.repoRoot, ctx.signal);
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

async function recentActivity(ctx: CollectCtx): Promise<Map<NodeId, Activity>> {
  const out = await git(ctx, ["log", "--since=90.days", "--numstat", "--no-renames", "--format=%x00%ae"]);
  const activity = new Map<NodeId, Activity>();
  for (const commit of out.split("\0").slice(1)) {
    const [author, ...lines] = commit.split("\n");
    for (const line of lines) {
      const [added, deleted, file] = line.split("\t");
      if (file === undefined) continue;
      const node = nodeOfFile(file);
      if (!(node in ctx.tree.nodes)) continue;
      const a = activity.get(node) ?? { churn: 0, authors: new Set() };
      a.churn += (Number(added) || 0) + (Number(deleted) || 0);
      a.authors.add(author);
      activity.set(node, a);
    }
  }
  return activity;
}

async function lastTouched(ctx: CollectCtx): Promise<Map<NodeId, number>> {
  const out = await git(ctx, ["log", "--name-only", "--no-renames", "--format=%x00%ct"]);
  const newest = new Map<NodeId, number>();
  for (const commit of out.split("\0").slice(1)) {
    const [time, ...files] = commit.split("\n");
    for (const file of files) {
      const node = nodeOfFile(file);
      if (file && !newest.has(node)) newest.set(node, Number(time) * 1000);
    }
  }
  return newest;
}

async function openPrs(ctx: CollectCtx): Promise<OpenPr[]> {
  const cached = ctx.cache.get<{ at: number; prs: OpenPr[] }>("gh-open-prs", ctx.repoRoot);
  if (cached && Date.now() - cached.at < PR_CACHE_MS) return cached.prs;
  const remotes = await run("git", ["remote", "-v"], ctx.repoRoot, ctx.signal);
  if (!remotes.stdout.includes("github.com")) return [];
  const res = await run(
    "gh",
    ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,files"],
    ctx.repoRoot,
    ctx.signal,
  );
  if (res.code !== 0) return [];
  let prs: OpenPr[];
  try {
    const raw = JSON.parse(res.stdout) as { number: number; files: { path: string }[] | null }[];
    prs = raw.map((p) => ({ number: p.number, files: (p.files ?? []).map((f) => f.path) }));
  } catch {
    return [];
  }
  ctx.cache.set("gh-open-prs", ctx.repoRoot, { at: Date.now(), prs });
  return prs;
}

function prOverlap(prs: OpenPr[]): Map<NodeId, number> {
  const counts = new Map<NodeId, number>();
  for (const pr of prs) {
    for (const node of new Set(pr.files.map(nodeOfFile))) counts.set(node, (counts.get(node) ?? 0) + 1);
  }
  return counts;
}

export const gitPlugin: MetricPlugin = {
  id: "git",
  metrics: [
    { key: "churn_90d", label: "Churn (90d)", unit: "lines", direction: "neutral", aggregate: "sum" },
    { key: "authors_90d", label: "Authors (90d)", direction: "neutral", aggregate: "max" },
    { key: "last_touched_days", label: "Last touched", unit: "days", direction: "neutral", aggregate: "max" },
    { key: "open_pr_overlap", label: "Open PRs", direction: "neutral", aggregate: "max" },
  ],

  async collect(ctx) {
    let activity: Map<NodeId, Activity>;
    let touched: Map<NodeId, number>;
    try {
      [activity, touched] = await Promise.all([recentActivity(ctx), lastTouched(ctx)]);
    } catch (e) {
      ctx.log(`git: ${(e as Error).message}`);
      return {};
    }
    const overlap = prOverlap(await openPrs(ctx));
    const now = Date.now();
    const values: MetricValues = {};
    for (const node of Object.values(ctx.tree.nodes)) {
      const touchedAt = touched.get(node.id);
      if (touchedAt === undefined) continue;
      const a = activity.get(node.id);
      values[node.id] = {
        churn_90d: a?.churn ?? 0,
        authors_90d: a?.authors.size ?? 0,
        last_touched_days: Math.max(0, Math.floor((now - touchedAt) / DAY_MS)),
        open_pr_overlap: overlap.get(node.id) ?? 0,
      };
    }
    return values;
  },
};
