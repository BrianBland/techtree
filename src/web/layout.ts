import type { NodeId, Tree, TreeNode } from "../types.ts";

export type SortKey = "name" | "score" | "weight";
export type SiblingOrder = (a: TreeNode, b: TreeNode) => number;

export interface PlacedNode {
  id: NodeId;
  x: number;
  y: number;
  r: number;
  depth: number;
  /** Number of children not shown because this node is collapsed. */
  hiddenChildren: number;
}

export interface Layout {
  nodes: PlacedNode[];
  byId: Map<NodeId, PlacedNode>;
  edges: [parent: PlacedNode, child: PlacedNode][];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface LayoutInput {
  tree: Tree;
  expanded: ReadonlySet<NodeId>;
  radius: (id: NodeId) => number;
  order: SiblingOrder;
}

export const COLUMN_WIDTH = 200;
const NODE_GAP = 10;

/**
 * Left-to-right tree layout: depth picks the column; each subtree gets a contiguous vertical
 * band at least as tall as its children's bands and its own node; parents are centred on their
 * children. Bands never intersect, so nodes never overlap.
 */
export function layoutTree({ tree, expanded, radius, order }: LayoutInput): Layout {
  const nodes: PlacedNode[] = [];
  const byId = new Map<NodeId, PlacedNode>();
  const edges: Layout["edges"] = [];

  function place(node: TreeNode, depth: number, top: number): number {
    const r = radius(node.id);
    const own = 2 * r + NODE_GAP;
    const open = expanded.has(node.id);
    const placed: PlacedNode = {
      id: node.id,
      x: depth * COLUMN_WIDTH,
      y: 0,
      r,
      depth,
      hiddenChildren: open ? 0 : node.children.length,
    };
    nodes.push(placed);
    byId.set(node.id, placed);
    if (!open || node.children.length === 0) {
      placed.y = top + own / 2;
      return own;
    }
    const children = sortedChildren(tree, node, order);
    const start = nodes.length;
    let childTop = top;
    for (const child of children) childTop += place(child, depth + 1, childTop);
    const childBand = childTop - top;
    const band = Math.max(own, childBand);
    const shift = (band - childBand) / 2;
    if (shift > 0) for (let i = start; i < nodes.length; i++) nodes[i].y += shift;
    const first = byId.get(children[0].id)!;
    const last = byId.get(children[children.length - 1].id)!;
    placed.y = (first.y + last.y) / 2;
    for (const child of children) edges.push([placed, byId.get(child.id)!]);
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

/**
 * Nodes to expand initially: breadth-first from the root, only nodes shallower than `maxDepth`,
 * and only while the visible node count stays within `budget`.
 */
export function initialExpanded(tree: Tree, order: SiblingOrder, budget = 150, maxDepth = 3): Set<NodeId> {
  const expanded = new Set<NodeId>();
  let visible = 1;
  let level = [tree.nodes[""]];
  for (let depth = 0; depth < maxDepth && level.length; depth++) {
    const next: TreeNode[] = [];
    for (const node of level) {
      if (node.children.length === 0) continue;
      if (visible + node.children.length > budget) return expanded;
      expanded.add(node.id);
      visible += node.children.length;
      next.push(...sortedChildren(tree, node, order));
    }
    level = next;
  }
  return expanded;
}

export function toggled(expanded: ReadonlySet<NodeId>, id: NodeId): Set<NodeId> {
  const next = new Set(expanded);
  if (!next.delete(id)) next.add(id);
  return next;
}
