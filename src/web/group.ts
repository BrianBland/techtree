import type { Effort, NodeId, Suggestion } from "../types.ts";

const EFFORT_ORDER: Effort[] = ["trivial", "small", "medium", "large"];

/** Stable identity of a suggestion across refetches. */
export const suggestionKey = (s: Suggestion) => `${s.project ?? ""}:${s.findingIds.join(",")}`;

/** The deepest node containing every node in `ids` ("" = repo root). */
export function commonAncestor(ids: NodeId[]): NodeId {
  const parts = ids.map((id) => (id ? id.split("/") : []));
  const common: string[] = [];
  for (let i = 0; parts.every((p) => i < p.length && p[i] === parts[0][i]); i++) common.push(parts[0][i]);
  return common.join("/");
}

/** One suggestion carrying every finding of `group` (DESIGN "Grouping suggestions"). */
export function combineSuggestions(group: Suggestion[]): Suggestion {
  const [first] = group;
  const sources = new Set(group.map((s) => s.source));
  return {
    node: commonAncestor(group.map((s) => s.node)),
    title: group.length > 1 ? `${first.title} (+${group.length - 1} more)` : first.title,
    ...(sources.size === 1 && first.source !== undefined && { source: first.source }),
    ...(first.project !== undefined && { project: first.project }),
    findingIds: [...new Set(group.flatMap((s) => s.findingIds))],
    impact: { node: group.reduce((n, s) => n + s.impact.node, 0), root: group.reduce((n, s) => n + s.impact.root, 0) },
    effort: EFFORT_ORDER[Math.max(...group.map((s) => EFFORT_ORDER.indexOf(s.effort)))],
    conflict: Math.max(...group.map((s) => s.conflict)),
    priority: group.reduce((n, s) => n + s.priority, 0),
    manualReview: group.some((s) => s.manualReview),
  };
}
