import type { NodeId, NodeScore, ScoreResult } from "../types.ts";
import { priority } from "./suggest.ts";

export interface ReportOptions {
  /** Nodes listed at each end of every metric (default 10). */
  nodes?: number;
  /** Findings listed (default 20). */
  findings?: number;
}

/** Plain-text summary for the terminal: best/worst nodes per scored metric and top findings by priority. */
export function formatReport(result: ScoreResult, opts: ReportOptions = {}): string {
  const perEnd = opts.nodes ?? 10;
  const label = (id: NodeId) => {
    const node = result.tree.nodes[id];
    return escapeControls((id || ".") + (node.kind === "dir" ? "" : ` (${node.kind} ${node.name})`));
  };
  const lines = [`techtree report  ${result.sha.slice(0, 12) || "(no commit)"}  ${result.createdAt}`];
  const root = result.scores[""];
  lines.push(`root quality: ${fmt(root?.quality ?? null)}`);

  for (const def of result.metricDefs) {
    if (def.direction === "neutral") continue;
    const ranked = Object.values(result.scores)
      .filter((s) => s.metrics[def.key]?.pct != null && !s.metrics[def.key].inherited)
      .sort((a, b) => pctOf(b, def.key) - pctOf(a, def.key) || a.node.localeCompare(b.node));
    if (ranked.length === 0) continue;
    const top = ranked.slice(0, perEnd);
    const bottom = ranked.slice(-perEnd).reverse();
    const row = (s: NodeScore) => {
      const m = s.metrics[def.key];
      return `  ${fmt(m.pct).padStart(5)}  ${num(m.raw).padStart(10)}  ${label(s.node)}`;
    };
    lines.push("", `${escapeControls(def.label)} [${escapeControls(def.key)}, ${def.direction.replace("_", " ")}]`, "  best:", ...top.map(row), "  worst:", ...bottom.map(row));
  }

  const findings = result.findings
    .map((f) => ({ f, impact: result.impacts[f.id] ?? { node: 0, root: 0 } }))
    .map((x) => ({ ...x, priority: priority(x.impact, x.f.effort, 0) }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, opts.findings ?? 20);
  if (findings.length) {
    lines.push("", `top findings (${findings.length} of ${result.findings.length})`);
    for (const { f, impact } of findings) {
      lines.push(`  +${fmt(impact.node)} node  +${fmt(impact.root, 2)} root  ${f.effort.padEnd(7)} ${label(f.node)}  ${escapeControls(f.title)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Repository text may contain terminal escape sequences; render control characters inert. */
function escapeControls(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function pctOf(s: NodeScore, key: string): number {
  return s.metrics[key].pct ?? 0;
}

function fmt(n: number | null, digits = 1): string {
  return n === null ? "-" : n.toFixed(digits);
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
