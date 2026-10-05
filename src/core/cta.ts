import type { Cta, NodeId, PrState, Suggestion, Task } from "../types.ts";

const TASK_RANK: Partial<Record<Task["state"], number>> = { needs_input: 3000, review: 2900 };

/** Rank tasks, PRs and suggestions into calls to action (DESIGN "Calls to action"). */
export function rankCtas(tasks: Task[], prs: PrState[], suggestions: Suggestion[]): Cta[] {
  const ctas: Cta[] = [];
  for (const task of tasks) {
    const rank = TASK_RANK[task.state];
    if (rank) ctas.push({ kind: "task", node: task.node, rank, reason: task.state === "needs_input" ? "needs input" : "ready for review", task });
  }
  for (const pr of prs) {
    const [rank, reason] = pr.ci === "fail" ? [2000, "CI failing"] : pr.stuck ? [1900, "stuck"] : pr.stale ? [1800, "stale"] : [0, ""];
    if (rank) ctas.push({ kind: "pr", node: pr.node, rank, reason, pr });
  }
  for (const s of suggestions) {
    ctas.push({ kind: "suggestion", node: s.node, rank: Math.min(s.priority, 999), reason: `+${s.impact.node.toFixed(1)} quality`, suggestion: s });
  }
  return ctas.sort((a, b) => b.rank - a.rank);
}

const isBelow = (node: NodeId, ancestor: NodeId) => (ancestor === "" ? node !== "" : node.startsWith(ancestor + "/"));

/** Split ranked CTAs into those anchored at `node` and the top `limit` anchored strictly below it. */
export function nodeCtas(node: NodeId, ranked: Cta[], limit = 10): { ownCtas: Cta[]; childCtas: Cta[] } {
  return {
    ownCtas: ranked.filter((c) => c.node === node),
    childCtas: ranked.filter((c) => isBelow(c.node, node)).slice(0, limit),
  };
}
