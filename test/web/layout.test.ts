import { test } from "node:test";
import assert from "node:assert/strict";
import { initialExpanded, layoutTree, siblingOrder, toggled, type PlacedNode } from "../../src/web/layout.ts";
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
const expandAll = (tree: Tree) => new Set(Object.keys(tree.nodes));

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
    const layout = layoutTree({ tree, expanded: expandAll(tree), radius, order: byName });
    assert.equal(layout.nodes.length, 401);
    assertNoOverlap(layout.nodes);
  }
});

test("depth sets the column and parents sit between their first and last child", () => {
  const tree = makeTree(["a/x", "a/y", "a/z", "b"]);
  const layout = layoutTree({ tree, expanded: expandAll(tree), radius: () => 5, order: byName });
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
  const expanded = toggled(expandAll(tree), "a");
  const layout = layoutTree({ tree, expanded, radius: () => 5, order: byName });
  assert.deepEqual(layout.nodes.map((n) => n.id).sort(), ["", "a", "b"]);
  assert.equal(layout.byId.get("a")!.hiddenChildren, 2);
  assert.equal(layout.byId.get("b")!.hiddenChildren, 0);
  const reopened = layoutTree({ tree, expanded: toggled(expanded, "a"), radius: () => 5, order: byName });
  assert.equal(reopened.nodes.length, 6);
});

test("initial expansion is breadth-first within the depth limit and node budget", () => {
  const tree = randomTree(2000, 7);
  const expanded = initialExpanded(tree, byName, 150, 3);
  const visible = layoutTree({ tree, expanded, radius: () => 5, order: byName }).nodes.length;
  assert.ok(visible <= 150, `${visible} visible`);
  assert.ok(visible > 50, `${visible} visible`);
  const depth = (id: string) => (id === "" ? 0 : id.split("/").length);
  for (const id of expanded) assert.ok(depth(id) < 3, `${id} expanded beyond depth limit`);

  const small = makeTree(["a/b/c/d/e"]);
  assert.deepEqual([...initialExpanded(small, byName, 150, 3)].sort(), ["", "a", "a/b"]);
});

test("siblings sort by name, by score (best first, missing last) or by weight (largest first)", () => {
  const tree = makeTree(["b", "a", "c"]);
  const score: Record<string, number | null> = { a: 10, b: 90, c: null };
  const weight: Record<string, number> = { a: 5, b: 1, c: 9 };
  const order = (key: "name" | "score" | "weight") => {
    const compare = siblingOrder(key, (id) => score[id], (id) => weight[id]);
    const layout = layoutTree({ tree, expanded: expandAll(tree), radius: () => 5, order: compare });
    return ["a", "b", "c"].sort((x, y) => layout.byId.get(x)!.y - layout.byId.get(y)!.y);
  };
  assert.deepEqual(order("name"), ["a", "b", "c"]);
  assert.deepEqual(order("score"), ["b", "a", "c"]);
  assert.deepEqual(order("weight"), ["c", "a", "b"]);
});
