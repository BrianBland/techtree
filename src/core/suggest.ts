import type { Config, Effort, Finding, Impact, NodeId, NodeScore, ScoreResult, Suggestion, Tree } from "../types.ts";
import { rankSuggestions } from "./cta.ts";
import { buildModel, commonAncestor, findingsImpact } from "./scoring.ts";

/** Relative cost of each effort level, the divisor in priority. */
export const EFFORT_COST: Record<Effort, number> = { trivial: 1, small: 2, medium: 5, large: 13 };

const REVIEW_TAGS = ["concurrency", "security", "api"];
const HOT_METRICS = ["churn_90d", "fan_in"];

/** Nodes in the top decile of `churn_90d` or `fan_in` among nodes of their kind. */
export function hotNodes(tree: Tree, scores: Record<NodeId, NodeScore>): Set<NodeId> {
  const hot = new Set<NodeId>();
  for (const metric of HOT_METRICS) {
    const byKind = new Map<string, { id: NodeId; raw: number }[]>();
    for (const score of Object.values(scores)) {
      const raw = score.metrics[metric]?.raw;
      if (raw === undefined) continue;
      const kind = tree.nodes[score.node].kind;
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind)!.push({ id: score.node, raw });
    }
    for (const nodes of byKind.values()) {
      const threshold = nodes.map((n) => n.raw).sort((a, b) => b - a)[Math.ceil(nodes.length / 10) - 1];
      for (const n of nodes) if (n.raw > 0 && n.raw >= threshold) hot.add(n.id);
    }
  }
  return hot;
}

/** impact.node × confidence × size ÷ effort cost × (1 − conflict). */
export function priority(impact: Impact, effort: Effort, conflict: number, confidence = 1, size = 1): number {
  return ((impact.node * confidence * size) / EFFORT_COST[effort]) * (1 - conflict);
}

/** √(loc share of the root) of the nearest scored node at or above `node`, where its impact is measured; 1 without loc. */
export function sizeFactor(result: Pick<ScoreResult, "tree" | "scores">, node: NodeId): number {
  let scored: NodeId | null = node;
  while (scored !== null && result.scores[scored]?.quality == null) scored = result.tree.nodes[scored]?.parent ?? null;
  const loc = scored === null ? undefined : result.scores[scored].metrics.loc?.raw;
  const rootLoc = result.scores[""]?.metrics.loc?.raw;
  return loc === undefined || !rootLoc ? 1 : Math.sqrt(loc / rootLoc);
}

/** Mean confidence of `findings` (unset counts as 1). */
export function confidence(findings: Finding[]): number {
  return findings.reduce((sum, f) => sum + (f.confidence ?? 1), 0) / findings.length;
}

/** Fraction of `paths` that overlap (equal, contain or are contained by) any busy path. */
export function conflict(paths: string[], busy: string[]): number {
  if (paths.length === 0 || busy.length === 0) return 0;
  return paths.filter((p) => busy.some((b) => overlaps(p, b))).length / paths.length;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a === "" || b === "" || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Complexity heuristic: whether a task should default to manual review before its PR. */
export function needsManualReview(findings: Finding[], hot: boolean): boolean {
  return (
    hot ||
    findings.length > 1 ||
    findings.some((f) => EFFORT_COST[f.effort] >= EFFORT_COST.medium || f.tags?.some((t) => REVIEW_TAGS.includes(t)))
  );
}

/** Suggested tasks for a scoring result, by priority and diversified by source. */
export function suggestTasks(result: ScoreResult, config: Config, busyPaths: string[] = []): Suggestion[] {
  const model = buildModel(result.tree, result.metricDefs, result.own, config);
  const hot = hotNodes(result.tree, result.scores);
  const groups = new Map<string, Finding[]>();
  for (const f of result.findings) {
    const key = f.effort === "trivial" && f.file ? `${f.source}\0${f.file}` : `\0${f.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  const suggestions = [...groups.values()].map((findings): Suggestion => {
    const [first] = findings;
    const node = commonAncestor(findings.map((f) => f.node));
    const impact = findings.length === 1 ? result.impacts[first.id] : findingsImpact(model, findings, node);
    const files = [...new Set(findings.flatMap((f) => (f.file ? [f.file] : [])))];
    const c = conflict(files.length ? files : [node], busyPaths);
    return {
      node,
      title: findings.length === 1 ? first.title : `${findings.length} ${first.source} fixes in ${first.file}`,
      source: first.source,
      findingIds: findings.map((f) => f.id),
      impact,
      effort: first.effort,
      conflict: c,
      priority: priority(impact, first.effort, c, confidence(findings), sizeFactor(result, node)),
      manualReview: needsManualReview(findings, hot.has(node)),
    };
  });
  return rankSuggestions(suggestions);
}
