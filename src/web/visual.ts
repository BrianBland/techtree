import type { ApiState, MetricDef, NodeId, NodeScore, PrState, Task, TaskPhase } from "../types.ts";

export const NO_SCORE = "hsl(228 10% 42%)";
/** The selected-score key meaning the composite quality rather than one metric. */
export const COMPOSITE = "quality";
const PHASES: TaskPhase[] = ["plan", "explore", "edit", "test", "pr"];
/** Hue, saturation, lightness stops from worst (t = 0) to best (t = 1); negative hues wrap. */
const RAMP_STOPS: [t: number, h: number, s: number, l: number][] = [
  [0, -4, 100, 56],
  [0.15, 18, 100, 54],
  [0.3, 40, 90, 52],
  [0.5, 54, 75, 52],
  [0.75, 130, 50, 46],
  [1, 172, 60, 42],
];
const TILE_GRID = 8;
const MAX_STAT_PIPS = 8;
const MIN_DELTA = 0.5;

/** Maps 0..maxValue onto minOut..maxOut proportionally to √value. */
export function sqrtScale(maxValue: number, minOut: number, maxOut: number): (value: number) => number {
  const top = Math.sqrt(maxValue) || 1;
  return (value) => minOut + (maxOut - minOut) * (Math.sqrt(Math.max(0, value)) / top);
}

/** Tile side for a weight: 24..64 by √weight, snapped to the pixel grid. */
export function tileSize(maxWeight: number): (weight: number) => number {
  const scale = sqrtScale(maxWeight, 24, 64);
  return (weight) => Math.round(scale(weight) / TILE_GRID) * TILE_GRID;
}

/** Diverging fill normalised to the range of `values`: worst is hot saturated red, best cool teal. */
export function ramp(values: (number | null)[]): (value: number | null) => string {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v === null) continue;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const span = max - min;
  return (value) => {
    if (value === null) return NO_SCORE;
    return rampColor(span > 0 ? Math.min(1, Math.max(0, (value - min) / span)) : 0.5);
  };
}

function rampColor(t: number): string {
  const upper = RAMP_STOPS.findIndex(([at]) => at >= t);
  const [t1, h1, s1, l1] = RAMP_STOPS[upper];
  const [t0, h0, s0, l0] = RAMP_STOPS[Math.max(0, upper - 1)];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * f);
  return `hsl(${(mix(h0, h1) + 360) % 360} ${mix(s0, s1)}% ${mix(l0, l1)}%)`;
}

/** Nodes that need you: a task in `needs_input` or `review`, or a failing, stuck or stale PR. */
export function attentionNodes(tasks: Task[], prs: PrState[]): Set<NodeId> {
  return new Set([
    ...tasks.filter((t) => t.state === "needs_input" || t.state === "review").map((t) => t.node),
    ...prs.filter((p) => p.ci === "fail" || p.stuck || p.stale).map((p) => p.node),
  ]);
}

const ATTENTION_VALUE = 1_000_000;
const RUNNING_VALUE = 100_000;
const FINDING_VALUE = 10;

/**
 * Subtree value per node (see DESIGN "UI → Tree → Focus"): the largest node value in its subtree, where
 * node value = attention + running work + (100 − quality) × √own loc + 10 × own findings.
 */
export function subtreeValues({ tree, scores, tasks, prs, findingCounts }: Pick<ApiState, "tree" | "scores" | "tasks" | "prs" | "findingCounts">): Map<NodeId, number> {
  const attention = attentionNodes(tasks, prs);
  const running = new Set(tasks.filter((t) => t.state === "running").map((t) => t.node));
  const loc = (id: NodeId) => scores[id]?.metrics.loc?.raw ?? 0;
  const values = new Map<NodeId, number>();
  const visit = (id: NodeId): number => {
    const node = tree.nodes[id];
    const quality = scores[id]?.quality;
    const ownLoc = Math.max(0, loc(id) - node.children.reduce((sum, child) => sum + loc(child), 0));
    let value =
      (attention.has(id) ? ATTENTION_VALUE : 0) +
      (running.has(id) ? RUNNING_VALUE : 0) +
      (quality === null || quality === undefined ? 0 : (100 - quality) * Math.sqrt(ownLoc)) +
      FINDING_VALUE * (findingCounts[id] ?? 0);
    for (const child of node.children) value = Math.max(value, visit(child));
    values.set(id, value);
    return value;
  };
  visit("");
  return values;
}

/** Metric keys shown as stat pips: weighted quality metrics, heaviest first. */
export function statMetrics(defs: MetricDef[], weights: Record<string, number>): string[] {
  return defs
    .filter((d) => d.direction !== "neutral" && (weights[d.key] ?? 0) > 0)
    .sort((a, b) => weights[b.key] - weights[a.key])
    .slice(0, MAX_STAT_PIPS)
    .map((d) => d.key);
}

/** The selected score of a node: composite quality, or one metric's percentile. */
export function scoreValue(score: NodeScore | undefined, key: string): number | null {
  return (key === COMPOSITE ? score?.quality : score?.metrics[key]?.pct) ?? null;
}

/** Signed change of the selected score per node, for nodes scored before and after that moved by ≥ 0.5. */
export function scoreDeltas(before: Record<NodeId, NodeScore>, after: Record<NodeId, NodeScore>, key: string): Map<NodeId, number> {
  const deltas = new Map<NodeId, number>();
  for (const id of Object.keys(after)) {
    const from = scoreValue(before[id], key);
    const to = scoreValue(after[id], key);
    if (from === null || to === null || Math.abs(to - from) < MIN_DELTA) continue;
    deltas.set(id, Math.round((to - from) * 10) / 10);
  }
  return deltas;
}

/** Checklist completion, or the phase's position when there is no checklist yet. */
export function taskCompletion(task: Task): number {
  if (task.checklist.length) return task.checklist.filter((item) => item.done).length / task.checklist.length;
  return PHASES.indexOf(task.phase) / PHASES.length;
}

/** Research bar stops as fractions of the 0..100 score axis. */
export function researchBar(task: Task): { solid: number; progress: number; planned: number } {
  const solid = task.plannedFrom / 100;
  const planned = Math.max(task.plannedFrom, task.plannedTo) / 100;
  return { solid, progress: round(solid + (planned - solid) * taskCompletion(task)), planned };
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** SVG polyline points for a sparkline of 0..100 values; gaps (null) are skipped. */
export function sparkline(values: (number | null)[], width: number, height: number): string {
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((v, i) => (v === null ? null : `${round(i * step)},${round(height - (v / 100) * height)}`))
    .filter((p) => p !== null)
    .join(" ");
}

/** What a tree tile shows at a glance. */
export interface TileLook {
  fill: string;
  /** Stat pip colours by percentile, null where the node lacks the metric. */
  pips: (string | null)[];
  /** Composite quality for the XP bar. */
  xp: number | null;
  findings: number;
}

export interface TileLookInput {
  scores: Record<NodeId, NodeScore>;
  scoreKey: string;
  statKeys: string[];
  findingCounts: Record<NodeId, number>;
}

/** Tile looks for the selected score: fill over the repo's range, pips on a fixed 0..100 ramp. */
export function tileLooks({ scores, scoreKey, statKeys, findingCounts }: TileLookInput): (id: NodeId) => TileLook {
  const fill = ramp(Object.values(scores).map((s) => scoreValue(s, scoreKey)));
  const pip = ramp([0, 100]);
  return (id) => {
    const score = scores[id];
    return {
      fill: fill(scoreValue(score, scoreKey)),
      pips: statKeys.map((key) => {
        const pct = score?.metrics[key]?.pct;
        return pct === undefined || pct === null ? null : pip(pct);
      }),
      xp: score?.quality ?? null,
      findings: findingCounts[id] ?? 0,
    };
  };
}
