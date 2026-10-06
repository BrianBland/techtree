import { QUALITY } from "../core/projects.ts";
import type { Config, MetricPlugin, Project, ScoreResult } from "../types.ts";
import { commandPlugin } from "./command.ts";
import { scanPlugin, rubricScan } from "./llm-scan.ts";
import { planPlugin } from "./plan.ts";
import { findingId } from "./util/source.ts";

/** Shared structure and neutral metrics, without running project analysis or producing findings. */
export function sharedPlugins(available: MetricPlugin[]): MetricPlugin[] {
  return available.map((plugin) => ({
    id: plugin.id,
    annotate: plugin.annotate,
    metrics: plugin.id === "generic" || plugin.id === "git" ? plugin.metrics.filter((d) => d.direction === "neutral") : [],
    collect: plugin.id === "generic" || plugin.id === "git" ? plugin.collect : async () => ({}),
  }));
}

/** A project's selected scorers, carrying neutral metrics from the shared tree. */
export function projectPlugins(project: Project, available: MetricPlugin[], base?: ScoreResult, resolved = (_id: string) => false): MetricPlugin[] {
  const { plugins = [], rubric, command, plan } = project.scorer;
  // ponytail: generic/git collect again for selected scorers; reuse raw base outputs if rescore cost matters.
  const selected = plugins.filter((id) => !(id === "llm-scan" && rubric)).map((id) => {
    const plugin = available.find((p) => p.id === id);
    if (!plugin) throw new Error(`unknown plugin ${JSON.stringify(id)}`);
    return project.id === QUALITY || !plugin.findings ? plugin : {
      ...plugin,
      findings: async (ctx) => (await plugin.findings!(ctx)).map((f) => ({ ...f, id: findingId(project.id, f.id, "plugin", "") })),
    } satisfies MetricPlugin;
  });
  const neutral = base?.metricDefs.filter((d) => d.direction === "neutral") ?? [];
  const keys = new Set(neutral.map((d) => d.key));
  return [
    ...(base ? [{
      id: "shared",
      metrics: neutral,
      collect: async () => Object.fromEntries(Object.entries(base.own).map(([node, values]) => [node, Object.fromEntries(Object.entries(values).filter(([key]) => keys.has(key)))])),
    }] : []),
    ...selected,
    ...(rubric ? [scanPlugin(rubricScan(project.id, rubric))] : []),
    ...(command?.length ? [commandPlugin(project.id, command)] : []),
    ...(plan ? [planPlugin(project.id, resolved)] : []),
  ];
}

export function projectWeights(result: ScoreResult, config: Config, project: Project, available: MetricPlugin[]): Record<string, number> {
  const pluginMetrics = new Set(available.filter((p) => project.scorer.plugins?.includes(p.id)).flatMap((p) => p.metrics.map((d) => d.key)));
  const scored = result.metricDefs.filter((d) => d.direction !== "neutral" && !pluginMetrics.has(d.key)).map((d) => [d.key, 1]);
  return { ...Object.fromEntries(scored), ...config.weights };
}
