import { createHash } from "node:crypto";
import type { Cache, Effort, Finding, MetricPlugin, MetricValues, NodeId, Severity } from "../types.ts";

/** A work item reported by a Plan task, stored in cache kind `plan`, key = project id. */
export interface PlanItem {
  id: string;
  node: NodeId;
  title: string;
  detail: string;
  effort: Effort;
  severity: Severity;
}

const KIND = "plan";
const SEVERITIES: Severity[] = ["low", "medium", "high"];
const EFFORTS: Effort[] = ["trivial", "small", "medium", "large"];

export function planItems(cache: Cache, project: string): PlanItem[] {
  return cache.get<PlanItem[]>(KIND, project) ?? [];
}

/**
 * Validate reported items against the tree's nodes; returns the items or the list of problems.
 * Severity defaults to `medium`.
 */
export function parsePlanItems(raw: unknown, project: string, hasNode: (id: NodeId) => boolean): PlanItem[] | string {
  if (!Array.isArray(raw)) return "items must be a list";
  const problems: string[] = [];
  const items = raw.flatMap((value, i): PlanItem[] => {
    const r = value as Record<string, unknown>;
    const severity = r?.severity ?? "medium";
    const valid =
      typeof r?.node === "string" &&
      typeof r.title === "string" &&
      r.title.trim() !== "" &&
      typeof r.detail === "string" &&
      EFFORTS.includes(r.effort as Effort) &&
      SEVERITIES.includes(severity as Severity);
    if (!valid) {
      problems.push(`item ${i} needs node, title, detail, effort and a valid severity`);
      return [];
    }
    if (!hasNode(r.node as string)) {
      problems.push(`item ${i}: no node ${JSON.stringify(r.node)}`);
      return [];
    }
    const node = r.node as string;
    const title = (r.title as string).trim();
    const id = createHash("sha256").update(JSON.stringify([KIND, project, node, title])).digest("hex").slice(0, 16);
    return [{ id, node, title, detail: r.detail as string, effort: r.effort as Effort, severity: severity as Severity }];
  });
  return problems.length ? problems.join("; ") : items;
}

/** Store `items`, replacing earlier items with the same id. */
export function addPlanItems(cache: Cache, project: string, items: PlanItem[]): void {
  const ids = new Set(items.map((i) => i.id));
  cache.set(KIND, project, [...planItems(cache, project).filter((i) => !ids.has(i.id)), ...items]);
}

/** Plan progress (DESIGN "Project scorers"): `resolved(id)` says whether a finished change task carries the item. */
export function planPlugin(project: string, resolved: (id: string) => boolean): MetricPlugin {
  return {
    id: KIND,
    metrics: [
      { key: "plan_items", label: "Plan items", direction: "neutral", aggregate: "sum" },
      { key: "progress", label: "Plan progress", direction: "higher_better", aggregate: "sum", normalizeBy: "plan_items" },
    ],
    async collect(ctx): Promise<MetricValues> {
      const values: MetricValues = {};
      for (const item of planItems(ctx.cache, project)) {
        const own = (values[item.node] ??= { plan_items: 0, progress: 0 });
        own.plan_items++;
        if (resolved(item.id)) own.progress++;
      }
      return values;
    },
    async findings(ctx): Promise<Finding[]> {
      return planItems(ctx.cache, project)
        .filter((item) => !resolved(item.id))
        .map((item) => ({ ...item, source: KIND, metricEffects: { progress: 1 } }));
    },
  };
}
