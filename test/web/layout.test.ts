import { test } from "node:test";
import assert from "node:assert/strict";
import { focusView, layoutTree, siblingOrder, stubId, toggleOverride, type PlacedNode, type ShownChildren } from "../../src/web/layout.ts";
import type { NodeId, Tree, TreeNode } from "../../src/types.ts";

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

function assertNoOverlap(nodes: PlacedNode[]) {
  const columns = new Map<number, PlacedNode[]>();
  for (const n of nodes) columns.set(n.x, [...(columns.get(n.x) ?? []), n]);
  for (const column of columns.values()) {
    column.sort((a, b) => a.y - b.y);
    for (let i = 1; i < column.length; i++) {
      assert.ok(column[i - 1].y + column[i - 1].r < column[i].y - column[i].r, `${column[i - 1].id} overlaps ${column[i].id}`);
    }
  }
  const maxR = Math.max(...nodes.map((n) => n.r));
  const xs = [...columns.keys()].sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] > 2 * maxR, "columns overlap");
}

test("nodes never overlap, for varied radii and shapes", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const tree = randomTree(400, seed);
    const radius = (id: NodeId) => 3 + (id.length * 7) % 20;
    const layout = layoutTree({ tree, shown: expandAll(tree), radius });
    assert.equal(layout.nodes.length, 401);
    assertNoOverlap(layout.nodes);
  }
});

test("depth sets the column and parents sit between their first and last child", () => {
  const tree = makeTree(["a/x", "a/y", "a/z", "b"]);
  const layout = layoutTree({ tree, shown: expandAll(tree), radius: () => 5 });
  const at = (id: string) => layout.byId.get(id)!;
  assert.ok(at("").x < at("a").x && at("a").x === at("b").x && at("a").x < at("a/x").x);
  assert.equal(at("a").y, (at("a/x").y + at("a/z").y) / 2);
  assert.ok(at("a/x").y < at("a/y").y && at("a/y").y < at("a/z").y);
  assert.ok(at("a").y < at("b").y);
  assert.deepEqual(
    layout.edges.map(([p, c]) => `${p.id}>${c.id}`).sort(),
    [">a", ">b", "a>a/x", "a>a/y", "a>a/z"],
  );
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
  assert.ok(layout.byId.get("c")!.y < stub.y, "stub after the shown children");
  assert.deepEqual(layout.edges.map(([p, c]) => `${p.id}>${c.id}`), [">b", ">c", `>${stubId("")}`]);
  assertNoOverlap(layout.nodes);
});

const focusOn = (tree: Tree, focus: string, extra: Partial<Parameters<typeof focusView>[0]> = {}) =>
  focusView({ tree, focus, order: byName, overrides: new Map(), attention: new Set(), ...extra });
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

test("root focus expands breadth-first while whole child lists fit the budget", () => {
  const tree = randomTree(2000, 7);
  const shown = focusOn(tree, "", { budget: 150 });
  const visible = visibleCount(tree, shown);
  assert.ok(visible <= 150 && visible > 50, `${visible} visible`);
  for (const [id, kids] of shown) assert.equal(kids.length, tree.nodes[id].children.length, `${id} shows all its children`);
  const depth = (id: string) => (id === "" ? 0 : id.split("/").length);
  const closed = layoutTree({ tree, shown, radius: () => 5 }).nodes.filter((n) => n.hiddenChildren > 0);
  assert.ok(Math.max(...[...shown.keys()].map(depth)) <= Math.min(...closed.map((n) => n.depth)), "breadth-first: nothing opens below a closed node's level");

  const small = makeTree(["a/b/c/d/e"]);
  assert.equal(visibleCount(small, focusOn(small, "")), 6, "a small tree is fully expanded");
});

test("a deep focus keeps the ancestor path, a few siblings per level folded into stubs, and spends the rest on its descendants", () => {
  const tree = wideTree(8, 5); // 8 + 64 + 512 + 4096 + 32768 nodes
  const focus = "n4/n4";
  const shown = focusOn(tree, focus, { budget: 150, context: 3 });
  const layout = layoutTree({ tree, shown, radius: () => 5 });
  assert.ok(layout.nodes.length <= 150, `${layout.nodes.length} visible`);
  for (const [parent, child] of [["", "n4"], ["n4", "n4/n4"]]) {
    assert.ok(shown.get(parent)!.includes(child), `${child} on the path`);
    assert.equal(shown.get(parent)!.length, 4, `${parent}: path child plus 3 siblings`);
    assert.equal(layout.byId.get(stubId(parent))!.hiddenChildren, 4);
  }
  assert.deepEqual(shown.get("n4"), ["n4/n2", "n4/n3", "n4/n4", "n4/n5"], "nearest siblings by sort order");
  const descendants = layout.nodes.filter((n) => n.id.startsWith(`${focus}/`)).length;
  assert.equal(layout.nodes.length, 147, "1 root + 2 × (path child, 3 siblings, stub) + 8 children + 64 grandchildren + 8 grandchild lists of 8");
  assert.equal(descendants, 8 + 64 + 64);
  assert.ok(descendants > layout.nodes.length / 2, "descendants get most of the budget");
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

  const unfold = toggleOverride(new Map(), "", true, true);
  assert.equal(focusOn(tree, "n4", { overrides: unfold }).get("")!.length, 8, "expanding an ancestor unfolds its stub");
  assert.equal(focusOn(tree, "n4", { overrides: toggleOverride(unfold, "", false, true) }).get("")!.length, 4, "collapsing folds it again");

  const collapseFocus = toggleOverride(new Map(), "n4", false, false);
  assert.equal(focusOn(tree, "n4", { overrides: collapseFocus }).has("n4"), false);
  assert.ok(focusOn(tree, "n4", { overrides: collapseFocus }).has(""), "the path stays open");
});
test("siblings sort by name, by score (best first, missing last) or by weight (largest first)", () => {
  const tree = makeTree(["b", "a", "c"]);
  const score: Record<string, number | null> = { a: 10, b: 90, c: null };
  const weight: Record<string, number> = { a: 5, b: 1, c: 9 };
  const order = (key: "name" | "score" | "weight") => {
    const compare = siblingOrder(key, (id) => score[id], (id) => weight[id]);
    const layout = layoutTree({ tree, shown: focusOn(tree, "", { order: compare }), radius: () => 5 });
    return ["a", "b", "c"].sort((x, y) => layout.byId.get(x)!.y - layout.byId.get(y)!.y);
  };
  assert.deepEqual(order("name"), ["a", "b", "c"]);
  assert.deepEqual(order("score"), ["b", "a", "c"]);
  assert.deepEqual(order("weight"), ["c", "a", "b"]);
});
