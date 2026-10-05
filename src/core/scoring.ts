import type {
  Aggregate,
  Config,
  Finding,
  Impact,
  MetricDef,
  MetricScore,
  MetricValues,
  NodeId,
  NodeScore,
  Tree,
} from "../types.ts";
import { depth } from "./tree.ts";

const LOC = "loc";

/** Everything needed to score the repo and answer what-if questions cheaply. */
export interface Model {
  tree: Tree;
  defs: MetricDef[];
  config: Config;
  own: MetricValues;
  agg: MetricValues;
  scores: Record<NodeId, NodeScore>;
  ranked: Set<NodeId>;
  /** Sorted values of the ranked nodes, keyed by `peerKey(kind, metric)`. */
  peers: Map<string, number[]>;
  hasLoc: boolean;
}

/** Aggregate own values up the tree, normalize, rank against peers and compute composites. */
export function buildModel(tree: Tree, defs: MetricDef[], own: MetricValues, config: Config): Model {
  const bottomUp = Object.keys(tree.nodes).sort((a, b) => depth(b) - depth(a));
  const agg: MetricValues = {};
  for (const id of bottomUp) {
    agg[id] = aggregateNode(defs, own[id], tree.nodes[id].children.map((c) => agg[c]));
  }
  const m: Model = { tree, defs, config, own, agg, scores: {}, ranked: new Set(), peers: new Map(), hasLoc: defs.some((d) => d.key === LOC) };
  for (const id of bottomUp) {
    if (!isRanked(m, agg[id])) continue;
    m.ranked.add(id);
    for (const def of defs) {
      if (def.direction === "neutral" || agg[id][def.key] === undefined) continue;
      const key = peerKey(tree.nodes[id].kind, def.key);
      const values = m.peers.get(key) ?? [];
      values.push(normalize(def, agg[id]));
      m.peers.set(key, values);
    }
  }
  for (const values of m.peers.values()) values.sort((a, b) => a - b);
  for (const id of bottomUp.reverse()) {
    const parent = tree.nodes[id].parent;
    m.scores[id] = scoreNode(m, id, agg[id], parent === null ? undefined : m.scores[parent]);
  }
  return m;
}

/** Δquality from fixing one finding. */
export function findingImpact(m: Model, finding: Finding): Impact {
  return whatIf(m, { [finding.node]: finding.metricEffects }, finding.node);
}

/** Δquality from fixing several findings together, at `focus` (default: their deepest common ancestor). */
export function findingsImpact(m: Model, findings: Finding[], focus?: NodeId): Impact {
  const effects: MetricValues = {};
  for (const f of findings) {
    const node = (effects[f.node] ??= {});
    for (const [key, delta] of Object.entries(f.metricEffects)) node[key] = (node[key] ?? 0) + delta;
  }
  return whatIf(m, effects, focus ?? commonAncestor(findings.map((f) => f.node)));
}

/**
 * Apply `effects` to own values and rescore only the changed nodes and their ancestors.
 * A ranked node's pct moves by its percentile shift within the unchanged peer distribution
 * (own old value included), so even the worst node of a kind sees its fixes.
 */
export function whatIf(m: Model, effects: MetricValues, focus: NodeId): Impact {
  const changed = new Set<NodeId>();
  for (const start of Object.keys(effects)) {
    for (let id: NodeId | null = start; id !== null && !changed.has(id); id = m.tree.nodes[id]?.parent ?? null) {
      if (m.tree.nodes[id]) changed.add(id);
    }
  }
  const bottomUp = [...changed].sort((a, b) => depth(b) - depth(a));
  const agg = new Map<NodeId, Record<string, number>>();
  for (const id of bottomUp) {
    const kids = m.tree.nodes[id].children.map((c) => agg.get(c) ?? m.agg[c]);
    agg.set(id, aggregateNode(m.defs, applyEffects(m.own[id], effects[id]), kids));
  }
  const scores = new Map<NodeId, NodeScore>();
  for (const id of bottomUp.reverse()) {
    const parent = m.tree.nodes[id].parent;
    const parentScore = parent === null ? undefined : (scores.get(parent) ?? m.scores[parent]);
    scores.set(id, scoreNode(m, id, agg.get(id)!, parentScore, m.scores[id]));
  }
  const delta = (id: NodeId): number => {
    const before = m.scores[id]?.quality;
    const after = scores.get(id)?.quality;
    return before == null || after == null ? 0 : after - before;
  };
  return { node: delta(focus), root: delta("") };
}

/**
 * Interpolated mid-rank percentile (0..100) of `v` among `sorted`, with one occurrence of
 * `exclude` (the node's own baseline value) removed.
 */
export function percentile(sorted: number[], v: number, exclude?: number): number {
  const skip = exclude === undefined ? sorted.length : lowerBound(sorted, exclude, 0, sorted.length);
  const at = (i: number) => sorted[i < skip ? i : i + 1];
  const m = exclude === undefined ? sorted.length : sorted.length - 1;
  if (m === 0) return 50;
  const lower = (x: number) => virtualBound(at, m, (y) => y < x);
  const upper = (x: number) => virtualBound(at, m, (y) => y <= x);
  const tiePct = (x: number) => (100 * (lower(x) + (upper(x) - lower(x)) / 2)) / m;
  const lo = lower(v);
  if (upper(v) > lo) return tiePct(v);
  if (lo === 0) return 0;
  if (lo === m) return 100;
  const a = at(lo - 1);
  const b = at(lo);
  return tiePct(a) + ((tiePct(b) - tiePct(a)) * (v - a)) / (b - a);
}

function virtualBound(at: (i: number) => number, n: number, before: (y: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (before(at(mid))) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBound(sorted: number[], x: number, lo: number, hi: number): number {
  return virtualBound((i) => sorted[i], hi - lo, (y) => y < x) + lo;
}

/** Weighted mean of present non-null pcts with weight > 0; null if none. */
export function composite(metrics: Record<string, MetricScore>, weights: Record<string, number>): number | null {
  let sum = 0;
  let total = 0;
  for (const [key, score] of Object.entries(metrics)) {
    const w = weights[key] ?? 0;
    if (score.pct === null || w <= 0) continue;
    sum += w * score.pct;
    total += w;
  }
  return total > 0 ? sum / total : null;
}

/** Deepest node containing every given node. */
export function commonAncestor(ids: NodeId[]): NodeId {
  if (ids.length === 0) return "";
  let parts = ids[0] === "" ? [] : ids[0].split("/");
  for (const id of ids.slice(1)) {
    const other = id === "" ? [] : id.split("/");
    let i = 0;
    while (i < parts.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join("/");
}

function aggregateNode(
  defs: MetricDef[],
  own: Record<string, number> | undefined,
  children: (Record<string, number> | undefined)[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of defs) {
    const parts: { value: number; loc: number }[] = [];
    if (own?.[def.key] !== undefined) parts.push({ value: own[def.key], loc: own[LOC] ?? 0 });
    for (const child of children) {
      if (child?.[def.key] !== undefined) parts.push({ value: child[def.key], loc: child[LOC] ?? 0 });
    }
    if (parts.length) out[def.key] = combine(def.aggregate, parts);
  }
  return out;
}

function combine(how: Aggregate, parts: { value: number; loc: number }[]): number {
  const sum = (f: (p: { value: number; loc: number }) => number) => parts.reduce((s, p) => s + f(p), 0);
  switch (how) {
    case "sum":
      return sum((p) => p.value);
    case "max":
      return Math.max(...parts.map((p) => p.value));
    case "mean_by_loc": {
      const loc = sum((p) => p.loc);
      return loc > 0 ? sum((p) => p.value * p.loc) / loc : sum((p) => p.value) / parts.length;
    }
  }
}

function normalize(def: MetricDef, agg: Record<string, number>): number {
  const raw = agg[def.key];
  if (!def.normalizeBy) return raw;
  const divisor = agg[def.normalizeBy] ?? 0;
  if (divisor <= 0) return 0;
  return def.normalizeBy === LOC ? (raw * 1000) / divisor : raw / divisor;
}

function isRanked(m: Model, agg: Record<string, number>): boolean {
  return !m.hasLoc || (agg[LOC] ?? 0) >= m.config.minLoc;
}

function peerKey(kind: string, metric: string): string {
  return `${kind}\0${metric}`;
}

function scoreNode(
  m: Model,
  id: NodeId,
  agg: Record<string, number>,
  parent: NodeScore | undefined,
  baseline?: NodeScore,
): NodeScore {
  const kind = m.tree.nodes[id].kind;
  const ranked = isRanked(m, agg);
  const metrics: Record<string, MetricScore> = {};
  for (const def of m.defs) {
    const raw = agg[def.key];
    if (raw === undefined) continue;
    const value = normalize(def, agg);
    if (def.direction === "neutral") {
      metrics[def.key] = { raw, value, pct: null };
    } else if (ranked) {
      const peers = m.peers.get(peerKey(kind, def.key)) ?? [];
      const old = m.ranked.has(id) && m.agg[id][def.key] !== undefined ? normalize(def, m.agg[id]) : undefined;
      const oldPct = baseline?.metrics[def.key]?.pct;
      const pct =
        old !== undefined && oldPct != null
          ? Math.min(100, Math.max(0, directed(def, oldPct) + percentile(peers, value) - percentile(peers, old)))
          : percentile(peers, value, old);
      metrics[def.key] = { raw, value, pct: directed(def, pct) };
    } else {
      metrics[def.key] = { raw, value, pct: parent?.metrics[def.key]?.pct ?? null, inherited: true };
    }
  }
  return { node: id, quality: composite(metrics, m.config.weights), metrics };
}

/** Converts between raw percentile and direction-adjusted pct (it is its own inverse). */
function directed(def: MetricDef, pct: number): number {
  return def.direction === "lower_better" ? 100 - pct : pct;
}

function applyEffects(own: Record<string, number> | undefined, effects: Record<string, number> | undefined) {
  if (!effects) return own;
  const out = { ...own };
  for (const [key, delta] of Object.entries(effects)) out[key] = Math.max(0, (out[key] ?? 0) + delta);
  return out;
}
