import { render } from "preact";
import type { NodeId, NodeScore, PrState, Task, Tree, TreeNode } from "../../src/types.ts";
import { layoutTree, siblingOrder, type SortKey } from "../../src/web/layout.ts";
import { ramp, scoreValue, sqrtScale, tileLooks, tileSize } from "../../src/web/visual.ts";
import { TreeView } from "../../src/web/TreeView.tsx";
import { FakeDocument, type FakeNode } from "./fake-dom.ts";

/** A random tree of `count` directories with scores for `quality`, `test_ratio`, eight stat metrics, and weights `loc`, `test_count`. */
function bigRepo(count: number) {
  let s = 42;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const nodes: Record<NodeId, TreeNode> = { "": { id: "", name: "repo", kind: "dir", parent: null, children: [], files: [] } };
  const ids: NodeId[] = [""];
  for (let i = 0; i < count - 1; i++) {
    const parent = ids[Math.floor(rand() ** 0.6 * ids.length)];
    const id = parent ? `${parent}/d${i}` : `d${i}`;
    nodes[id] = { id, name: `dir-${i}`, kind: i % 50 === 0 ? "crate" : "dir", parent, children: [], files: [] };
    nodes[parent].children.push(id);
    ids.push(id);
  }
  const scores: Record<NodeId, NodeScore> = {};
  for (const id of ids) {
    scores[id] = {
      node: id,
      quality: rand() * 100,
      metrics: {
        loc: { raw: Math.round(rand() * 5000), value: 0, pct: null },
        test_count: { raw: Math.round(rand() * 300), value: 0, pct: null },
        test_ratio: { raw: rand(), value: 0, pct: rand() * 100 },
        ...Object.fromEntries(STAT_KEYS.map((key) => [key, { raw: 0, value: 0, pct: rand() < 0.2 ? null : rand() * 100 }])),
      },
    };
  }
  const tree: Tree = { repoRoot: "/r", nodes };
  const tasks: Task[] = ids.slice(1, 40).map((node, i) => ({
    id: `t${i}`,
    node,
    title: "t",
    prompt: "",
    findingIds: [],
    state: "running",
    manualReview: false,
    plannedFrom: 40,
    plannedTo: 55,
    checklist: [
      { text: "a", done: true },
      { text: "b", done: false },
    ],
    phase: "edit",
    createdAt: "",
    updatedAt: "",
  }));
  const prs = ids.slice(50, 80).map((node, i) => ({ number: i, node, ci: i % 3 ? "pass" : "fail" }) as PrState);
  const findingCounts = Object.fromEntries(ids.filter((_, i) => i % 4 === 0).map((id, i) => [id, i % 12]));
  const hot = new Set(ids.filter((_, i) => i % 10 === 0));
  const deltas = new Map(ids.filter((_, i) => i % 25 === 0).map((id, i) => [id, i % 2 ? 2.5 : -1.5]));
  return { tree, scores, tasks, prs, ids, findingCounts, hot, deltas };
}

const STAT_KEYS = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"];

export interface Timings {
  visibleNodes: number;
  initial: number;
  switchScore: number;
  switchWeight: number;
  switchSort: number;
}

/**
 * Render `TreeView` with every node expanded, then time each control switch end to end
 * (comparator/radius/ramp rebuild + layout + Preact diff into the fake DOM). Reports the median of `runs`.
 */
export function bench(count = 1000, runs = 7): Timings {
  const doc = new FakeDocument();
  Object.assign(globalThis, { document: doc });
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const { tree, scores, tasks, prs, ids, findingCounts, hot, deltas } = bigRepo(count);
  const expanded = new Set(ids);

  const draw = (scoreKey: string, weightKey: string, sortKey: SortKey) => {
    const scoreOf = (id: NodeId) => scoreValue(scores[id], scoreKey);
    const weightOf = (id: NodeId) => scores[id].metrics[weightKey].raw;
    const side = tileSize(weightOf(""));
    const width = sqrtScale(weightOf(""), 2, 8);
    const look = tileLooks({ scores, scoreKey, statKeys: STAT_KEYS, hot, findingCounts });
    const composite = ramp(ids.map((id) => scores[id].quality));
    const layout = layoutTree({
      tree,
      expanded,
      radius: (id) => side(weightOf(id)) / 2,
      order: siblingOrder(sortKey, scoreOf, weightOf),
    });
    render(
      <TreeView
        tree={tree}
        layout={layout}
        look={look}
        deltas={deltas}
        edgeWidth={(id) => Math.round(width(weightOf(id)))}
        compositeColor={composite}
        tasks={tasks}
        prs={prs}
        selected={null}
        fitRequest={0}
        onSelect={() => {}}
        onToggle={() => {}}
      />,
      root as unknown as Element,
    );
  };
  const time = (fn: () => void) => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };
  const median = (states: [string, string, SortKey][]) => {
    const samples = Array.from({ length: runs }, (_, i) => time(() => draw(...states[i % states.length])));
    return samples.sort((a, b) => a - b)[Math.floor(runs / 2)];
  };

  const initial = time(() => draw("quality", "loc", "name"));
  const visibleNodes = (root as unknown as FakeNode).querySelectorAll((n) => n.getAttribute("class")?.startsWith("node") ?? false).length;
  return {
    visibleNodes,
    initial,
    switchScore: median([
      ["test_ratio", "loc", "name"],
      ["quality", "loc", "name"],
    ]),
    switchWeight: median([
      ["quality", "test_count", "name"],
      ["quality", "loc", "name"],
    ]),
    switchSort: median([
      ["quality", "loc", "score"],
      ["quality", "loc", "weight"],
      ["quality", "loc", "name"],
    ]),
  };
}
