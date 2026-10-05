import { execFileSync } from "node:child_process";
import type { Cache, CollectCtx, Config, Finding, MetricDef, MetricPlugin, MetricValues, ScoreResult } from "../types.ts";
import { buildModel, findingImpact } from "./scoring.ts";
import { buildTree } from "./tree.ts";

export interface ScoreOptions {
  repoRoot: string;
  config: Config;
  plugins: MetricPlugin[];
  cache: Cache;
  log(msg: string): void;
  signal?: AbortSignal;
}

/** Score a repo: build the tree, run plugins, aggregate, rank and estimate every finding's impact. */
export async function score(opts: ScoreOptions): Promise<ScoreResult> {
  const { repoRoot, config, plugins, log } = opts;
  const tree = buildTree(repoRoot, config);
  for (const plugin of plugins) {
    try {
      await plugin.annotate?.(tree);
    } catch (err) {
      log(`${plugin.id}: annotate failed: ${errorText(err)}`);
    }
  }
  const ctx: CollectCtx = { repoRoot, tree, config, cache: opts.cache, log, signal: opts.signal };
  const attempt = async <T>(plugin: MetricPlugin, hook: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (err) {
      log(`${plugin.id}: ${hook} failed: ${errorText(err)}`);
      return undefined;
    }
  };
  const outputs = await Promise.all(
    plugins.map(async (plugin) => ({
      plugin,
      values: await attempt(plugin, "collect", () => plugin.collect(ctx)),
      findings: plugin.findings ? await attempt(plugin, "findings", () => plugin.findings!(ctx)) : [],
    })),
  );

  const metricDefs: MetricDef[] = [];
  const own: MetricValues = {};
  const findings = new Map<string, Finding>();
  for (const { plugin, values, findings: found } of outputs) {
    if (values) {
      for (const def of plugin.metrics) if (!metricDefs.some((d) => d.key === def.key)) metricDefs.push(def);
      for (const [node, metrics] of Object.entries(values)) {
        if (tree.nodes[node]) Object.assign((own[node] ??= {}), metrics);
      }
    }
    for (const f of found ?? []) {
      if (!tree.nodes[f.node]) log(`${plugin.id}: dropped finding ${f.id} on unknown node "${f.node}"`);
      else if (!findings.has(f.id)) findings.set(f.id, f);
    }
  }

  const model = buildModel(tree, metricDefs, own, config);
  const impacts: ScoreResult["impacts"] = {};
  for (const f of findings.values()) impacts[f.id] = findingImpact(model, f);
  return {
    sha: headSha(repoRoot),
    createdAt: new Date().toISOString(),
    tree,
    metricDefs,
    own,
    scores: model.scores,
    findings: [...findings.values()],
    impacts,
  };
}

function headSha(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
