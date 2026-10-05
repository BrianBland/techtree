import { test } from "node:test";
import assert from "node:assert/strict";
import { DECORATED_HALF_WIDTH, focusView, labelName, labelWidth, layoutTree, siblingOrder, stubId, toggleOverride, type PlacedNode, type ShownChildren } from "../../src/web/layout.ts";
import { subtreeValues } from "../../src/web/visual.ts";
import { fitView } from "../../src/web/view.ts";
import type { NodeId, Task, Tree, TreeNode } from "../../src/types.ts";

function makeTree(paths: string[]): Tree {
  const nodes: Record<NodeId, TreeNode> = { "": { id: "", name: "repo", kind: "dir", parent: null, children: [], files: [] } };
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const id = parts.slice(0, i).join("/");
      if (nodes[id]) continue;
      const parent = parts.slice(0, i - 1).join("/");
      nodes[id] = { id, name: parts[i - 1], kind: "dir", parent, children: [], files: [] };
      nodes[parent].children.push(id);
    }
  }
  return { repoRoot: "/r", nodes };
}

function randomTree(count: number, seed: number): Tree {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const ids = [""];
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const parent = ids[Math.floor(rand() * ids.length)];
    const id = parent ? `${parent}/d${i}` : `d${i}`;
    ids.push(id);
    paths.push(id);
  }
  return makeTree(paths);
}

const byName = siblingOrder("name", () => null, () => 0);
const open = (tree: Tree, ids: string[] = Object.keys(tree.nodes)): ShownChildren =>
  new Map(ids.map((id) => [id, [...tree.nodes[id].children].sort()]));
const expandAll = (tree: Tree) => open(tree);

function assertNoOverlap(tree: Tree, nodes: PlacedNode[]) {
  const rows = new Map<number, PlacedNode[]>();
  for (const n of nodes) rows.set(n.y, [...(rows.get(n.y) ?? []), n]);
  const halfWidth = (n: PlacedNode) => {
    const node = tree.nodes[n.id];
    const label = node ? labelWidth(node.name, node.children.length > 0, n.hiddenChildren) : labelWidth(`+${n.hiddenChildren} more`, false, 0);
    return Math.max(DECORATED_HALF_WIDTH * n.r, label / 2);
  };
  for (const row of rows.values()) {
    row.sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      assert.ok(row[i - 1].x + halfWidth(row[i - 1]) < row[i].x - halfWidth(row[i]), `${row[i - 1].id} overlaps ${row[i].id}`);
    }
  }
  const maxR = Math.max(...nodes.map((n) => n.r));
  const ys = [...rows.keys()].sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] > 2 * maxR, "rows overlap");
}

test("nodes and their labels never overlap, for varied radii and shapes", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const tree = randomTree(400, seed);
    const radius = (id: NodeId) => 3 + (id.length * 7) % 20;
    const layout = layoutTree({ tree, shown: expandAll(tree), radius });
    assert.equal(layout.nodes.length, 401);
    assertNoOverlap(tree, layout.nodes);
  }
});

test("top to bottom: depth sets the row, siblings share it left to right, parents sit centred over their children", () => {
  const tree = makeTree(["a/x", "a/y", "a/z", "b"]);
  const layout = layoutTree({ tree, shown: expandAll(tree), radius: () => 5 });
  const at = (id: string) => layout.byId.get(id)!;
  assert.ok(at("").y < at("a").y && at("a").y === at("b").y && at("a").y < at("a/x").y);
  assert.ok(at("a/x").y === at("a/y").y && at("a/y").y === at("a/z").y);
  assert.equal(at("a").x, (at("a/x").x + at("a/z").x) / 2);
  assert.ok(at("a/x").x < at("a/y").x && at("a/y").x < at("a/z").x);
  assert.ok(at("a").x < at("b").x);
  assert.deepEqual(
    layout.edges.map(([p, c]) => `${p.id}>${c.id}`).sort(),
    [">a", ">b", "a>a/x", "a>a/y", "a>a/z"],
  );
});

test("labels are cut to 14 characters with an ellipsis", () => {
  assert.equal(labelName("short"), "short");
  assert.equal(labelName("a-very-long-directory-name"), "a-very-long-d…");
  assert.equal(labelName("a-very-long-directory-name").length, 14);
});

test("collapsed nodes hide their descendants and report hidden children", () => {
  const tree = makeTree(["a/x/deep", "a/y", "b"]);
  const layout = layoutTree({ tree, shown: open(tree, ["", "a/x"]), radius: () => 5 });
  assert.deepEqual(layout.nodes.map((n) => n.id).sort(), ["", "a", "b"]);
  assert.equal(layout.byId.get("a")!.hiddenChildren, 2);
  assert.equal(layout.byId.get("b")!.hiddenChildren, 0);
});

test("an open node showing some children gets a +N more stub after them, without overlaps", () => {
  const tree = makeTree(["a", "b", "c", "d", "e"]);
  const layout = layoutTree({ tree, shown: new Map([["", ["b", "c"]]]), radius: () => 5 });
  const stub = layout.byId.get(stubId(""))!;
  assert.deepEqual([stub.stubOf, stub.hiddenChildren], ["", 3]);
  assert.deepEqual(layout.nodes.map((n) => n.id), ["", "b", "c", stubId("")]);
  assert.ok(layout.byId.get("c")!.x < stub.x, "stub after the shown children");
  assert.deepEqual(layout.edges.map(([p, c]) => `${p.id}>${c.id}`), [">b", ">c", `>${stubId("")}`]);
  assertNoOverlap(tree, layout.nodes);
});

const focusOn = (tree: Tree, focus: string, extra: Partial<Parameters<typeof focusView>[0]> = {}) =>
  focusView({ tree, focus, order: byName, overrides: new Map(), attention: new Set(), values: new Map(), ...extra });
const visibleCount = (tree: Tree, shown: ShownChildren) => layoutTree({ tree, shown, radius: () => 5 }).nodes.length;

/** A wide, deep tree: `fan` dirs per level, `depth` levels. */
function wideTree(fan: number, depth: number): Tree {
  const paths: string[] = [];
  const grow = (prefix: string, level: number) => {
    if (level === depth) return paths.push(prefix);
    for (let i = 0; i < fan; i++) grow(prefix ? `${prefix}/n${i}` : `n${i}`, level + 1);
  };
  grow("", 0);
  return makeTree(paths);
}

/** Subtree values with the given node values at a few spots and 0 elsewhere. */
function hotSpots(tree: Tree, spots: Record<NodeId, number>): Map<NodeId, number> {
  const values = new Map<NodeId, number>();
  for (const [spot, value] of Object.entries(spots)) {
    for (let id: NodeId | null = spot; id !== null; id = tree.nodes[id].parent) values.set(id, Math.max(values.get(id) ?? 0, value));
  }
  return values;
}

test("every immediate child of the focus is shown, even past the budget; beyond 40, the 40 most valuable and a stub", () => {
  const wide = wideTree(30, 2);
  const shown = focusOn(wide, "", { budget: 10 });
  assert.equal(shown.get("")!.length, 30);
  assert.equal(shown.size, 1, "nothing else fits");

  const crowded = makeTree(Array.from({ length: 50 }, (_, i) => `c${String(i).padStart(2, "0")}`));
  const values = new Map(crowded.nodes[""].children.map((id, i) => [id, i]));
  const kids = focusOn(crowded, "", { values }).get("")!;
  assert.deepEqual(kids, crowded.nodes[""].children.slice(10), "the 40 most valuable, in sort order");
  assert.equal(layoutTree({ tree: crowded, shown: new Map([["", kids]]), radius: () => 5 }).byId.get(stubId(""))!.hiddenChildren, 10);
});

test("chains drill into the highest-value subtrees first, two children at a time with a stub for the rest", () => {
  const tree = wideTree(4, 4);
  const values = hotSpots(tree, { "n2/n1/n3/n0": 100, "n0/n3/n3/n3": 50 });
  const shown = focusOn(tree, "", { values, budget: 30 });
  assert.deepEqual(shown.get("n2"), ["n2/n0", "n2/n1"], "the most valuable child, then the next by sort order");
  assert.ok(shown.get("n2/n1")!.includes("n2/n1/n3") && shown.get("n2/n1/n3")!.includes("n2/n1/n3/n0"), "a chain down to the hottest spot");
  assert.ok(shown.get("n0/n3")!.includes("n0/n3/n3") && shown.get("n0/n3/n3")!.includes("n0/n3/n3/n3"), "and to the next hottest");
  const layout = layoutTree({ tree, shown, radius: () => 5 });
  assert.equal(layout.byId.get(stubId("n2"))!.hiddenChildren, 2);
  assert.ok(layout.nodes.length <= 30);

  const tight = focusOn(tree, "", { values, budget: 14 });
  assert.ok(tight.has("n2/n1/n3") && !tight.has("n0"), "the hottest chain comes first");
});

test("the view stays within the budget, well below a breadth-first fill", () => {
  const tree = randomTree(2000, 7);
  const shown = focusOn(tree, "");
  const visible = visibleCount(tree, shown);
  assert.ok(visible <= 70 && visible > 66, `${visible} visible`);
  for (const [id, kids] of shown) {
    if (id !== "") assert.ok(kids.length <= 2 || kids.length === 3 && tree.nodes[id].children.length === 3, `${id} opens 2 children, or 3 rather than folding one`);
  }

  const small = makeTree(["a/b/c/d/e"]);
  assert.equal(visibleCount(small, focusOn(small, "")), 6, "a small tree is fully expanded");
});

test("a node needing attention deep in the tree gets a path to it", () => {
  const tree = wideTree(6, 4);
  const deep = "n5/n4/n3/n2";
  const values = subtreeValues({ tree, scores: {}, tasks: [{ node: deep, state: "review" } as Task], prs: [], findingCounts: {} });
  const shown = focusOn(tree, "", { values });
  assert.ok(shown.get("n5")!.includes("n5/n4"));
  assert.ok(shown.get("n5/n4")!.includes("n5/n4/n3"));
  assert.ok(shown.get("n5/n4/n3")!.includes(deep));
});

test("a deep focus keeps the ancestor path, a few siblings per level folded into stubs, and spends the rest on its descendants", () => {
  const tree = wideTree(8, 5);
  const focus = "n4/n4";
  const shown = focusOn(tree, focus, { context: 3 });
  const layout = layoutTree({ tree, shown, radius: () => 5 });
  for (const [parent, child] of [["", "n4"], ["n4", "n4/n4"]]) {
    assert.ok(shown.get(parent)!.includes(child), `${child} on the path`);
    assert.equal(shown.get(parent)!.length, 4, `${parent}: path child plus 3 siblings`);
    assert.equal(layout.byId.get(stubId(parent))!.hiddenChildren, 4);
  }
  assert.deepEqual(shown.get("n4"), ["n4/n2", "n4/n3", "n4/n4", "n4/n5"], "nearest siblings by sort order");
  assert.equal(shown.get(focus)!.length, 8);
  const descendants = layout.nodes.filter((n) => n.id.startsWith(`${focus}/`)).length;
  assert.equal(layout.nodes.length, 70, "1 root + 2 × (path child, 3 siblings, stub) + 8 children + 17 openings of 2 children and a stub");
  assert.equal(descendants, 8 + 17 * 3);
});

test("siblings holding an attention item are preferred as context", () => {
  const tree = wideTree(8, 2);
  const shown = focusOn(tree, "n4", { attention: new Set(["n0/n3"]), context: 3 });
  assert.deepEqual(shown.get(""), ["n0", "n3", "n4", "n5"]);
});

test("folding a single sibling is skipped: it is shown instead of a stub", () => {
  const tree = wideTree(5, 1);
  assert.deepEqual(focusOn(tree, "n0", { context: 3 }).get(""), ["n0", "n1", "n2", "n3", "n4"]);
});

test("manual overrides expand or collapse within the focused view", () => {
  const tree = wideTree(8, 3);
  const base = focusOn(tree, "n4", { budget: 30 });
  assert.equal(base.has("n0"), false);

  const expandSibling = toggleOverride(new Map(), "n2", true, false);
  assert.deepEqual(focusOn(tree, "n4", { budget: 30, overrides: expandSibling }).get("n2")?.length, 8, "a context sibling expands on demand");

  const opened = [...base.keys()].find((id) => id.startsWith("n4/"))!;
  const expandChain = toggleOverride(new Map(), opened, true, false);
  assert.equal(focusOn(tree, "n4", { budget: 30, overrides: expandChain }).get(opened)?.length, 8, "an opened node unfolds its stub");

  const unfold = toggleOverride(new Map(), "", true, true);
  assert.equal(focusOn(tree, "n4", { overrides: unfold }).get("")!.length, 8, "expanding an ancestor unfolds its stub");
  assert.equal(focusOn(tree, "n4", { overrides: toggleOverride(unfold, "", false, true) }).get("")!.length, 4, "collapsing folds it again");

  const collapseFocus = toggleOverride(new Map(), "n4", false, false);
  assert.equal(focusOn(tree, "n4", { overrides: collapseFocus }).has("n4"), false);
  assert.ok(focusOn(tree, "n4", { overrides: collapseFocus }).has(""), "the path stays open");
});

test("manual expansions stay within the budget by undoing automatic ones, latest first", () => {
  const tree = wideTree(20, 2);
  const before = focusOn(tree, "");
  assert.equal(visibleCount(tree, before), 69);
  const collapsed = tree.nodes[""].children.find((id) => !before.has(id))!;
  const after = focusOn(tree, "", { overrides: toggleOverride(new Map(), collapsed, true, false) });
  assert.ok(visibleCount(tree, after) <= 70, `${visibleCount(tree, after)} visible`);
  assert.equal(after.get(collapsed)?.length, 20, "the manual expansion is kept");
  const lastAuto = [...before.keys()].at(-1)!;
  assert.equal(after.has(lastAuto), false, "the latest automatic opening made room");

  const deep = wideTree(20, 3);
  const opened = focusOn(deep, "");
  const grandchild = opened.get([...opened.keys()][1])![0];
  const manual = focusOn(deep, "", { overrides: toggleOverride(new Map(), grandchild, true, false) });
  assert.equal(manual.get(grandchild)?.length, 20, "a manual expansion under an automatic one keeps its parent open");
  assert.ok(visibleCount(deep, manual) <= 70, `${visibleCount(deep, manual)} visible`);
});

test("a manual expansion stays shown when subtree values change", () => {
  const tree = makeTree(["a/w", "a/x/deep", "a/y", "a/z"]);
  const overrides = toggleOverride(new Map(), "a/x", true, false);
  const before = focusOn(tree, "", { overrides, values: hotSpots(tree, { "a/x/deep": 9 }) });
  assert.deepEqual(before.get("a/x"), ["a/x/deep"]);
  const after = focusOn(tree, "", { overrides, values: hotSpots(tree, { "a/y": 9, "a/z": 9 }) });
  assert.ok(after.get("a")!.includes("a/x"), "the path to the manual expansion is kept");
  assert.deepEqual(after.get("a/x"), ["a/x/deep"]);
});

test("a very wide manual expansion stays fast", () => {
  const paths = Array.from({ length: 10_000 }, (_, i) => (i % 2 ? `a/leaf${i}` : `a/dir${i}/x`));
  const tree = makeTree(paths);
  const overrides = toggleOverride(new Map(), "a", true, false);
  const start = performance.now();
  const shown = focusOn(tree, "", { overrides });
  const elapsed = performance.now() - start;
  assert.equal(shown.get("a")!.length, 10_000);
  assert.ok(elapsed < 150, `${Math.round(elapsed)} ms`);
});

test("fit keeps every label and badge inside the viewport", () => {
  const tree = makeTree(["thirteen-chars", "thirteen-char2", "thirteen-char3"]);
  const layout = layoutTree({ tree, shown: new Map([["", tree.nodes[""].children]]), radius: () => 12 });
  const view = fitView(layout.bounds, 400, 600);
  for (const n of layout.nodes) {
    const half = Math.max(DECORATED_HALF_WIDTH * n.r, labelWidth(tree.nodes[n.id].name, tree.nodes[n.id].children.length > 0, 0) / 2);
    assert.ok((n.x - half) * view.k + view.x >= 0 && (n.x + half) * view.k + view.x <= 400, `${n.id} clipped`);
  }
});

test("siblings sort by name, by score (best first, missing last) or by weight (largest first)", () => {
  const tree = makeTree(["b", "a", "c"]);
  const score: Record<string, number | null> = { a: 10, b: 90, c: null };
  const weight: Record<string, number> = { a: 5, b: 1, c: 9 };
  const order = (key: "name" | "score" | "weight") => {
    const compare = siblingOrder(key, (id) => score[id], (id) => weight[id]);
    const layout = layoutTree({ tree, shown: focusOn(tree, "", { order: compare }), radius: () => 5 });
    return ["a", "b", "c"].sort((x, y) => layout.byId.get(x)!.x - layout.byId.get(y)!.x);
  };
  assert.deepEqual(order("name"), ["a", "b", "c"]);
  assert.deepEqual(order("score"), ["b", "a", "c"]);
  assert.deepEqual(order("weight"), ["c", "a", "b"]);
});
