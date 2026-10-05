import type { NodeId, Tree, TreeNode } from "../types.ts";

export type SortKey = "name" | "score" | "weight";
export type SiblingOrder = (a: TreeNode, b: TreeNode) => number;

export interface PlacedNode {
  id: NodeId;
  x: number;
  y: number;
  r: number;
  depth: number;
  /** Number of children not shown: all of a collapsed node's, or the siblings a "+N more" stub stands for. */
  hiddenChildren: number;
  /** Set on a "+N more" stub: the node whose remaining children it folds. */
  stubOf?: NodeId;
}

export interface Layout {
  nodes: PlacedNode[];
  byId: Map<NodeId, PlacedNode>;
  edges: [parent: PlacedNode, child: PlacedNode][];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Children drawn under each open node, in drawing order; children left out are folded into a stub. */
export type ShownChildren = ReadonlyMap<NodeId, readonly NodeId[]>;

export interface LayoutInput {
  tree: Tree;
  shown: ShownChildren;
  radius: (id: NodeId) => number;
}

export const COLUMN_WIDTH = 200;
export const STUB_RADIUS = 12;
const NODE_GAP = 10;

/** Id of the "+N more" stub under `parent`; NUL never occurs in a path, so it cannot clash with a node. */
export function stubId(parent: NodeId): string {
  return `${parent}\0more`;
}

/**
 * Left-to-right tree layout: depth picks the column; each subtree gets a contiguous vertical
 * band at least as tall as its children's bands and its own node; parents are centred on their
 * children. Bands never intersect, so nodes never overlap. An open node showing only some of its
 * children gets a "+N more" stub after them.
 */
export function layoutTree({ tree, shown, radius }: LayoutInput): Layout {
  const nodes: PlacedNode[] = [];
  const byId = new Map<NodeId, PlacedNode>();
  const edges: Layout["edges"] = [];

  function leaf(placed: PlacedNode, top: number): number {
    const own = 2 * placed.r + NODE_GAP;
    nodes.push(placed);
    byId.set(placed.id, placed);
    placed.y = top + own / 2;
    return own;
  }

  function place(node: TreeNode, depth: number, top: number): number {
    const kids = shown.get(node.id);
    const placed: PlacedNode = { id: node.id, x: depth * COLUMN_WIDTH, y: 0, r: radius(node.id), depth, hiddenChildren: kids ? 0 : node.children.length };
    if (!kids || node.children.length === 0) return leaf(placed, top);
    const own = 2 * placed.r + NODE_GAP;
    nodes.push(placed);
    byId.set(node.id, placed);
    const start = nodes.length;
    const children: PlacedNode[] = [];
    let childTop = top;
    for (const id of kids) {
      childTop += place(tree.nodes[id], depth + 1, childTop);
      children.push(byId.get(id)!);
    }
    const folded = node.children.length - kids.length;
    if (folded > 0) {
      const stub: PlacedNode = { id: stubId(node.id), x: (depth + 1) * COLUMN_WIDTH, y: 0, r: STUB_RADIUS, depth: depth + 1, hiddenChildren: folded, stubOf: node.id };
      childTop += leaf(stub, childTop);
      children.push(stub);
    }
    const childBand = childTop - top;
    const band = Math.max(own, childBand);
    const shift = (band - childBand) / 2;
    if (shift > 0) for (let i = start; i < nodes.length; i++) nodes[i].y += shift;
    placed.y = (children[0].y + children[children.length - 1].y) / 2;
    for (const child of children) edges.push([placed, child]);
    return band;
  }

  place(tree.nodes[""], 0, 0);
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const n of nodes) {
    bounds.minX = Math.min(bounds.minX, n.x - n.r);
    bounds.minY = Math.min(bounds.minY, n.y - n.r);
    bounds.maxX = Math.max(bounds.maxX, n.x + n.r);
    bounds.maxY = Math.max(bounds.maxY, n.y + n.r);
  }
  return { nodes, byId, edges, bounds };
}

function sortedChildren(tree: Tree, node: TreeNode, order: SiblingOrder): TreeNode[] {
  return node.children.map((id) => tree.nodes[id]).sort(order);
}

/** Sibling comparator for a sort key; missing scores sort last, ties fall back to name. */
export function siblingOrder(
  key: SortKey,
  score: (id: NodeId) => number | null | undefined,
  weight: (id: NodeId) => number,
): SiblingOrder {
  const byName: SiblingOrder = (a, b) => a.name.localeCompare(b.name);
  if (key === "name") return byName;
  if (key === "weight") return (a, b) => weight(b.id) - weight(a.id) || byName(a, b);
  return (a, b) => (score(b.id) ?? -1) - (score(a.id) ?? -1) || byName(a, b);
}

/** Manual expand (true) and collapse (false) choices per node, made within the current focus. */
export type Overrides = ReadonlyMap<NodeId, boolean>;

export interface FocusInput {
  tree: Tree;
  focus: NodeId;
  order: SiblingOrder;
  overrides: Overrides;
  /** Nodes with an attention item; siblings whose subtree holds one are preferred as context. */
  attention: ReadonlySet<NodeId>;
  budget?: number;
  /** Siblings kept around the focus and around each ancestor. */
  context?: number;
}

/**
 * The children to draw when the tree is focused on `focus` (see DESIGN "UI → Tree → Focus"): the
 * ancestor path with a few siblings per level, then the focus's descendants breadth-first while
 * whole child lists fit the budget, with manual overrides applied on top. Manual expansions win:
 * automatic ones are undone, latest first, until the view fits again.
 */
export function focusView({ tree, focus, order, overrides, attention, budget = 150, context = 3 }: FocusInput): Map<NodeId, NodeId[]> {
  const shown = new Map<NodeId, NodeId[]>();
  const warm = withAncestors(tree, attention);
  const path: NodeId[] = [];
  for (let id: NodeId | null = focus; id !== null; id = tree.nodes[id].parent) path.unshift(id);
  let visible = 1;
  const queue: { id: NodeId; auto: boolean }[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const children = sortedChildren(tree, tree.nodes[path[i]], order).map((n) => n.id);
    const kids = overrides.get(path[i]) ? children : nearSiblings(children, path[i + 1], context, warm);
    shown.set(path[i], kids);
    visible += kids.length + (kids.length < children.length ? 1 : 0);
    for (const id of kids) if (id !== path[i + 1]) queue.push({ id, auto: false });
  }
  queue.unshift({ id: focus, auto: true });
  const automatic: NodeId[] = [];
  let full = false;
  for (let head = 0; head < queue.length; head++) {
    const { id, auto } = queue[head];
    const node = tree.nodes[id];
    const override = overrides.get(id);
    if (node.children.length === 0 || override === false) continue;
    if (!override) {
      if (!auto || full) continue;
      if (visible + node.children.length > budget) {
        full = true;
        continue;
      }
    }
    const kids = sortedChildren(tree, node, order).map((n) => n.id);
    shown.set(id, kids);
    visible += kids.length;
    if (!override) automatic.push(id);
    for (const kid of kids) queue.push({ id: kid, auto });
  }
  const leadsToManual = withAncestors(tree, new Set([...overrides].filter(([id, open]) => open && shown.has(id)).map(([id]) => id)));
  for (let i = automatic.length - 1; i >= 0 && visible > budget; i--) {
    if (leadsToManual.has(automatic[i])) continue;
    visible -= shown.get(automatic[i])!.length;
    shown.delete(automatic[i]);
  }
  return shown;
}

/** `pathChild` plus up to `count` of its siblings, nearest in `children` order first, attention first; in `children` order. */
function nearSiblings(children: NodeId[], pathChild: NodeId, count: number, warm: ReadonlySet<NodeId>): NodeId[] {
  if (children.length - 1 <= count + 1) return children;
  const at = children.indexOf(pathChild);
  const distance = (i: number) => Math.abs(i - at) * 2 - (i < at ? 1 : 0);
  const picked = children
    .map((id, i) => ({ id, i }))
    .filter(({ i }) => i !== at)
    .sort((a, b) => Number(warm.has(b.id)) - Number(warm.has(a.id)) || distance(a.i) - distance(b.i))
    .slice(0, count);
  const keep = new Set([pathChild, ...picked.map((p) => p.id)]);
  return children.filter((id) => keep.has(id));
}

function withAncestors(tree: Tree, ids: ReadonlySet<NodeId>): Set<NodeId> {
  const out = new Set<NodeId>();
  for (const start of ids) for (let id: NodeId | null = start; id !== null && !out.has(id); id = tree.nodes[id]?.parent ?? null) out.add(id);
  return out;
}

/**
 * The overrides after clicking a node's expand handle. A node hiding children expands; otherwise it
 * collapses, except that an ancestor of the focus folds its siblings back instead of hiding the focus.
 */
export function toggleOverride(overrides: Overrides, id: NodeId, hiding: boolean, onFocusPath: boolean): Map<NodeId, boolean> {
  const next = new Map(overrides);
  if (hiding) next.set(id, true);
  else if (onFocusPath) next.delete(id);
  else next.set(id, false);
  return next;
}
