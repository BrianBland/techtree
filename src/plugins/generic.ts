import type { CollectCtx, Effort, Finding, MetricPlugin, MetricValues, Severity } from "../types.ts";
import { findingId, readSource } from "./util/source.ts";

export const LARGE_FILE_LOC = 1000;
export const TODO_CLUSTER = 3;
const TODO_MARKER = /\b(TODO|FIXME|XXX|HACK)\b/;

interface FileStats {
  file: string;
  loc: number;
  todos: number;
}

function measure(ctx: CollectCtx, files: string[]): FileStats[] {
  const stats: FileStats[] = [];
  for (const file of files) {
    const text = readSource(ctx.repoRoot, file);
    if (text === undefined) continue;
    let loc = 0;
    let todos = 0;
    for (const line of text.split("\n")) {
      if (line.trim() !== "") loc++;
      if (TODO_MARKER.test(line)) todos++;
    }
    stats.push({ file, loc, todos });
  }
  return stats;
}

function largeFileRating(loc: number): { severity: Severity; effort: Effort } {
  if (loc >= 4 * LARGE_FILE_LOC) return { severity: "high", effort: "large" };
  if (loc >= 2 * LARGE_FILE_LOC) return { severity: "medium", effort: "large" };
  return { severity: "low", effort: "medium" };
}

export const genericPlugin: MetricPlugin = {
  id: "generic",
  metrics: [
    { key: "loc", label: "Lines of code", unit: "lines", direction: "neutral", aggregate: "sum" },
    { key: "files", label: "Files", direction: "neutral", aggregate: "sum" },
    { key: "max_file_loc", label: "Largest file", unit: "lines", direction: "lower_better", aggregate: "max" },
    { key: "todo_density", label: "TODO density", unit: "per kLOC", direction: "lower_better", aggregate: "sum", normalizeBy: "loc" },
  ],

  async collect(ctx) {
    const values: MetricValues = {};
    for (const node of Object.values(ctx.tree.nodes)) {
      const stats = measure(ctx, node.files);
      if (stats.length === 0) continue;
      values[node.id] = {
        loc: stats.reduce((s, f) => s + f.loc, 0),
        files: stats.length,
        max_file_loc: Math.max(...stats.map((f) => f.loc)),
        todo_density: stats.reduce((s, f) => s + f.todos, 0),
      };
    }
    return values;
  },

  async findings(ctx) {
    const findings: Finding[] = [];
    for (const node of Object.values(ctx.tree.nodes)) {
      const stats = measure(ctx, node.files);
      const currentMax = Math.max(0, ...stats.map((f) => f.loc));
      for (const f of stats) {
        if (f.loc >= LARGE_FILE_LOC) {
          const othersMax = Math.max(0, ...stats.filter((o) => o !== f).map((o) => o.loc));
          const effect = Math.max(LARGE_FILE_LOC, othersMax) - currentMax;
          findings.push({
            id: findingId("large-file", f.file, "large-file", ""),
            node: node.id,
            file: f.file,
            source: "large-file",
            title: `Split ${f.file} (${f.loc} lines)`,
            detail: `${f.file} has ${f.loc} non-blank lines; files over ${LARGE_FILE_LOC} lines are hard to review and change.`,
            ...largeFileRating(f.loc),
            metricEffects: effect < 0 ? { max_file_loc: effect } : {},
          });
        }
        if (f.todos >= TODO_CLUSTER) {
          findings.push({
            id: findingId("todo", f.file, "todo-cluster", ""),
            node: node.id,
            file: f.file,
            source: "todo",
            title: `Resolve ${f.todos} TODO/FIXME markers in ${f.file}`,
            detail: `${f.file} has ${f.todos} lines marked TODO, FIXME, XXX or HACK.`,
            severity: "low",
            effort: f.todos >= 10 ? "medium" : "small",
            metricEffects: { todo_density: -f.todos },
          });
        }
      }
    }
    return findings;
  },
};
