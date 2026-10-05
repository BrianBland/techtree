import { render } from "preact";
import type { NodeId, NodeScore, PrState, Task, Tree, TreeNode } from "../../src/types.ts";
import { focusView, layoutTree, siblingOrder, type SortKey } from "../../src/web/layout.ts";
import { attentionNodes, ramp, scoreValue, sqrtScale, subtreeValues, tileLooks, tileSize } from "../../src/web/visual.ts";
import { TreeView } from "../../src/web/TreeView.tsx";
import { FakeDocument, type FakeNode } from "./fake-dom.ts";

const random = () => {
  let s = 42;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
};

/** A random tree of `count` directories with scores for `quality`, `test_ratio`, eight stat metrics, and weights `loc`, `test_count`. */
function bigRepo(count: number) {
  const rand = random();
  const nodes: Record<NodeId, TreeNode> = { "": { id: "", name: "repo", kind: "dir", parent: null, children: [], files: [] } };
  const ids: NodeId[] = [""];
  for (let i = 0; i < count - 1; i++) {
    const parent = ids[Math.floor(rand() ** 0.6 * ids.length)];
    const id = parent ? `${parent}/d${i}` : `d${i}`;
    nodes[id] = { id, name: `dir-${i}`, kind: i % 50 === 0 ? "crate" : "dir", parent, children: [], files: [] };
    nodes[parent].children.push(id);
    ids.push(id);
  }
  return withData(nodes, ids, rand);
}

/**
 * A Cargo-workspace-shaped tree of about `count` directories: `crates/<group>/<crate>/{src,tests,benches}`
 * with nested modules under `src`, plus a few top-level tool and docs dirs.
 */
function workspaceRepo(count: number) {
  const rand = random();
  const nodes: Record<NodeId, TreeNode> = { "": { id: "", name: "repo", kind: "dir", parent: null, children: [], files: [] } };
  const ids: NodeId[] = [""];
  const add = (parent: NodeId, name: string, kind = "dir") => {
    const id = parent ? `${parent}/${name}` : name;
    nodes[id] = { id, name, kind, parent, children: [], files: [] };
    nodes[parent].children.push(id);
    ids.push(id);
    return id;
  };
  for (const top of ["bin", "docs", "scripts", "etc"]) add(add("", top), "misc");
  const crates = add("", "crates");
  const groups = Array.from({ length: 8 }, (_, g) => add(crates, `group-${g}`));
  for (let c = 0; ids.length < count; c++) {
    const crate = add(groups[c % groups.length], `crate-${c}`, "crate");
    const src = add(crate, "src");
    if (rand() < 0.5) add(crate, "tests");
    if (rand() < 0.2) add(crate, "benches");
    const grow = (parent: NodeId, level: number) => {
      const fan = Math.floor(rand() * (level === 0 ? 6 : 3));
      for (let m = 0; m < fan && ids.length < count; m++) grow(add(parent, `mod_${level}_${m}`), level + 1);
    };
    grow(src, 0);
  }
  return withData(nodes, ids, rand);
}

function withData(nodes: Record<NodeId, TreeNode>, ids: NodeId[], rand: () => number) {
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
    project: "quality",
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
  const deltas = new Map(ids.filter((_, i) => i % 25 === 0).map((id, i) => [id, i % 2 ? 2.5 : -1.5]));
  return { tree, scores, tasks, prs, ids, findingCounts, deltas };
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
  const { tree, scores, tasks, prs, ids, findingCounts, deltas } = bigRepo(count);
  const attention = attentionNodes(tasks, prs);

  const draw = (scoreKey: string, weightKey: string, sortKey: SortKey) => {
    const scoreOf = (id: NodeId) => scoreValue(scores[id], scoreKey);
    const weightOf = (id: NodeId) => scores[id].metrics[weightKey].raw;
    const side = tileSize(weightOf(""));
    const width = sqrtScale(weightOf(""), 2, 8);
    const look = tileLooks({ scores, scoreKey, statKeys: STAT_KEYS, findingCounts });
    const composite = ramp(ids.map((id) => scores[id].quality));
    const order = siblingOrder(sortKey, scoreOf, weightOf);
    const shown = new Map(ids.map((id) => [id, tree.nodes[id].children.map((c) => tree.nodes[c]).sort(order).map((n) => n.id)]));
    const layout = layoutTree({ tree, shown, radius: (id) => side(weightOf(id)) / 2 });
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
        attention={attention}
        selected={null}
        fitRequest={0}
        onSelect={() => {}}
        onToggle={() => {}}
        onStub={() => {}}
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

export interface FocusTimings {
  nodes: number;
  maxVisible: number;
  switchFocus: number;
}

/**
 * Render a workspace-shaped tree of about `count` directories focused on the root, then time focus
 * changes to deep crates and modules end to end (focus view + layout + Preact diff). Reports the median.
 */
export function focusBench(count = 600, runs = 9): FocusTimings {
  const doc = new FakeDocument();
  Object.assign(globalThis, { document: doc });
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const { tree, scores, tasks, prs, ids, findingCounts, deltas } = workspaceRepo(count);
  const attention = attentionNodes(tasks, prs);
  const weightOf = (id: NodeId) => scores[id].metrics.loc.raw;
  const side = tileSize(weightOf(""));
  const width = sqrtScale(weightOf(""), 2, 8);
  const look = tileLooks({ scores, scoreKey: "quality", statKeys: STAT_KEYS, findingCounts });
  const composite = ramp(ids.map((id) => scores[id].quality));
  const order = siblingOrder("name", () => null, weightOf);
  const values = subtreeValues({ tree, scores, tasks, prs, findingCounts });
  let maxVisible = 0;
  const draw = (focus: NodeId) => {
    const shown = focusView({ tree, focus, order, overrides: new Map(), attention, values });
    const layout = layoutTree({ tree, shown, radius: (id) => side(weightOf(id)) / 2 });
    maxVisible = Math.max(maxVisible, layout.nodes.length);
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
        attention={attention}
        selected={focus}
        fitRequest={0}
        onSelect={() => {}}
        onToggle={() => {}}
        onStub={() => {}}
      />,
      root as unknown as Element,
    );
  };
  const depth = (id: NodeId) => (id ? id.split("/").length : 0);
  const deep = ids.filter((id) => depth(id) >= 4);
  const targets = Array.from({ length: runs }, (_, i) => (i % 3 === 2 ? "" : deep[Math.floor((i * deep.length) / runs)]));
  draw("");
  const samples = targets.map((focus) => {
    const start = performance.now();
    draw(focus);
    return performance.now() - start;
  });
  return { nodes: ids.length, maxVisible, switchFocus: samples.sort((a, b) => a - b)[Math.floor(runs / 2)] };
}
