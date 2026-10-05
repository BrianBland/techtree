import type { Cta, NodeId, PrState, Suggestion, Task } from "../types.ts";

const TASK_RANK: Partial<Record<Task["state"], number>> = { needs_input: 3000, review: 2900 };
const PER_SOURCE = 2;
const BLOCK = 8;

/**
 * Reorder ranked `items` so that every block of 8 positions holds at most 2 items per source,
 * filling each block with the best admissible item and only then with the best remaining one.
 */
export function diversify<T>(items: T[], sourceOf: (item: T) => string | undefined): T[] {
  const rest = [...items];
  const out: T[] = [];
  while (rest.length) {
    const counts = new Map<string | undefined, number>();
    for (let slot = 0; slot < BLOCK && rest.length; slot++) {
      const i = Math.max(0, rest.findIndex((item) => (counts.get(sourceOf(item)) ?? 0) < PER_SOURCE));
      const [item] = rest.splice(i, 1);
      counts.set(sourceOf(item), (counts.get(sourceOf(item)) ?? 0) + 1);
      out.push(item);
    }
  }
  return out;
}

/** Suggestions by priority, highest first, diversified by source (DESIGN "Suggestions"). */
export function rankSuggestions(suggestions: Suggestion[]): Suggestion[] {
  return diversify([...suggestions].sort((a, b) => b.priority - a.priority), (s) => s.source);
}

/** Rank tasks, PRs and suggestions into calls to action (DESIGN "Calls to action"). */
export function rankCtas(tasks: Task[], prs: PrState[], suggestions: Suggestion[]): Cta[] {
  const urgent: Cta[] = [];
  for (const task of tasks) {
    const rank = TASK_RANK[task.state];
    if (rank) urgent.push({ kind: "task", node: task.node, rank, reason: task.state === "needs_input" ? "needs input" : "ready for review", task });
  }
  for (const pr of prs) {
    const [rank, reason] = pr.ci === "fail" ? [2000, "CI failing"] : pr.stuck ? [1900, "stuck"] : pr.stale ? [1800, "stale"] : [0, ""];
    if (rank) urgent.push({ kind: "pr", node: pr.node, rank, reason, pr });
  }
  return [...urgent.sort((a, b) => b.rank - a.rank), ...suggestionCtas(rankSuggestions(suggestions))];
}

function suggestionCtas(suggestions: Suggestion[]): Cta[] {
  return suggestions.map((s) => ({ kind: "suggestion", node: s.node, rank: Math.min(s.priority, 999), reason: `+${s.impact.node.toFixed(1)} quality`, suggestion: s }));
}

const isBelow = (node: NodeId, ancestor: NodeId) => (ancestor === "" ? node !== "" : node.startsWith(ancestor + "/"));

/** Split ranked CTAs into those anchored at `node` and the top `limit` anchored strictly below it. */
export function nodeCtas(node: NodeId, ranked: Cta[], limit = 10): { ownCtas: Cta[]; childCtas: Cta[] } {
  const below = ranked.filter((c) => isBelow(c.node, node));
  const suggestions = below.flatMap((c) => (c.suggestion ? [c.suggestion] : []));
  return {
    ownCtas: ranked.filter((c) => c.node === node),
    childCtas: [...below.filter((c) => c.kind !== "suggestion"), ...suggestionCtas(rankSuggestions(suggestions))].slice(0, limit),
  };
}
