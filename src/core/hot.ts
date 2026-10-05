import type { NodeId, NodeScore, Tree } from "../types.ts";

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
