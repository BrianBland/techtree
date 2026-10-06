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

export const ROW_HEIGHT = 120;
export const STUB_RADIUS = 12;
/** Half the width of a tile with its side badges, in tile radii (badges reach 5/16 of the side past each edge). */
export const DECORATED_HALF_WIDTH = 13 / 8;
/** Advance of one label character: 12px monospace. */
export const CHAR_WIDTH = 7.25;
/** Room for the expand handle before a label. */
export const HANDLE_WIDTH = 14;
const LABEL_CHARS = 14;
const NODE_GAP = 12;
/** Height of the label line under a tile. */
export const LABEL_HEIGHT = 20;

/** Id of the "+N more" stub under `parent`; NUL never occurs in a path, so it cannot clash with a node. */
export function stubId(parent: NodeId): string {
  return `${parent}\0more`;
}

/** The name as drawn under a tile: cut to LABEL_CHARS characters with an ellipsis. */
export function labelName(name: string): string {
  return name.length > LABEL_CHARS ? `${name.slice(0, LABEL_CHARS - 1)}…` : name;
}

/** Width of a tile's label line: the expand handle, the cut name and the hidden-children count. */
export function labelWidth(name: string, expandable: boolean, hiddenChildren: number): number {
  const chars = labelName(name).length + (hiddenChildren > 0 ? 1 + String(hiddenChildren).length : 0);
  return (expandable ? HANDLE_WIDTH : 0) + chars * CHAR_WIDTH;
}

/**
 * Top-to-bottom tree layout: depth picks the row; each subtree gets a contiguous horizontal band at
 * least as wide as its children's bands and its own slot (tile with badges, or label, whichever is
 * wider); parents are centred over their children. Bands never intersect, so nothing overlaps. An
 * open node showing only some of its children gets a "+N more" stub after them.
 */
export function layoutTree({ tree, shown, radius }: LayoutInput): Layout {
  const nodes: PlacedNode[] = [];
  const byId = new Map<NodeId, PlacedNode>();
  const edges: Layout["edges"] = [];
  const halfWidths = new Map<NodeId, number>();

  function slot(placed: PlacedNode, label: number): number {
    const half = Math.max(DECORATED_HALF_WIDTH * placed.r, label / 2);
    halfWidths.set(placed.id, half);
    return 2 * half + NODE_GAP;
  }

  function leaf(placed: PlacedNode, own: number, left: number): number {
    nodes.push(placed);
    byId.set(placed.id, placed);
    placed.x = left + own / 2;
    return own;
  }

  function place(node: TreeNode, depth: number, left: number): number {
    const kids = shown.get(node.id);
    const placed: PlacedNode = { id: node.id, x: 0, y: depth * ROW_HEIGHT, r: radius(node.id), depth, hiddenChildren: kids ? 0 : node.children.length };
    const own = slot(placed, labelWidth(node.name, node.children.length > 0, placed.hiddenChildren));
    if (!kids || node.children.length === 0) return leaf(placed, own, left);
    nodes.push(placed);
    byId.set(node.id, placed);
    const start = nodes.length;
    const children: PlacedNode[] = [];
    let childLeft = left;
    for (const id of kids) {
      childLeft += place(tree.nodes[id], depth + 1, childLeft);
      children.push(byId.get(id)!);
    }
    const folded = node.children.length - kids.length;
    if (folded > 0) {
      const stub: PlacedNode = { id: stubId(node.id), x: 0, y: (depth + 1) * ROW_HEIGHT, r: STUB_RADIUS, depth: depth + 1, hiddenChildren: folded, stubOf: node.id };
      childLeft += leaf(stub, slot(stub, labelWidth(`+${folded} more`, false, 0)), childLeft);
      children.push(stub);
    }
    const childBand = childLeft - left;
    const band = Math.max(own, childBand);
    const shift = (band - childBand) / 2;
    if (shift > 0) for (let i = start; i < nodes.length; i++) nodes[i].x += shift;
    placed.x = (children[0].x + children[children.length - 1].x) / 2;
    for (const child of children) edges.push([placed, child]);
    return band;
  }

  place(tree.nodes[""], 0, 0);
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const n of nodes) {
    bounds.minX = Math.min(bounds.minX, n.x - halfWidths.get(n.id)!);
    bounds.minY = Math.min(bounds.minY, n.y - n.r);
    bounds.maxX = Math.max(bounds.maxX, n.x + halfWidths.get(n.id)!);
    bounds.maxY = Math.max(bounds.maxY, n.y + n.r + LABEL_HEIGHT);
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
  active?: ReadonlySet<NodeId>;
  prioritizeActive?: boolean;
  /** Subtree value per node (see `subtreeValues`); missing nodes are worth 0. */
  values: ReadonlyMap<NodeId, number>;
  budget?: number;
  /** Siblings kept around the focus and around each ancestor. */
  context?: number;
}

const MAX_FOCUS_CHILDREN = 40;
const CHAIN_CHILDREN = 2;

/**
 * The children to draw when the tree is focused on `focus` (see DESIGN "UI → Tree → Focus"): the
 * ancestor path with a few siblings per level, every child of the focus, then best-first chains into
 * the descendants of highest subtree value while they fit the budget, with manual overrides applied on
 * top. Manual expansions win: automatic openings are undone, latest first, until the view fits again.
 */
export function focusView({ tree, focus, order, overrides, attention, active = attention, prioritizeActive = true, values, budget = 70, context = 3 }: FocusInput): Map<NodeId, NodeId[]> {
  const shown = new Map<NodeId, NodeId[]>();
  const warm = withAncestors(tree, active);
  const activityOrder = (a: NodeId, b: NodeId) => (Number(warm.has(b)) - Number(warm.has(a))) * (prioritizeActive ? 1 : -1);
  const valueOf = (id: NodeId) => values.get(id) ?? 0;
  const byValue: SiblingOrder = (a, b) => activityOrder(a.id, b.id) || valueOf(b.id) - valueOf(a.id) || order(a, b);
  let visible = 1;
  const revealed = (id: NodeId, kids: readonly NodeId[]) => kids.length + (kids.length < tree.nodes[id].children.length ? 1 : 0);
  const open = (id: NodeId, kids: NodeId[]) => {
    shown.set(id, kids);
    visible += revealed(id, kids);
  };
  const toManual = withAncestors(tree, new Set([...overrides].filter(([, expanded]) => expanded).map(([id]) => id)));
  const forced = (node: TreeNode) => toManual.has(node.id);
  const openable = (node: TreeNode) => node.children.length > 0 && overrides.get(node.id) !== false;
  /**
   * The `count` most valuable children, in sort order; all of them when only one would be left out.
   * Children leading to a manual expansion are always kept, so value changes never hide it.
   */
  const best = (node: TreeNode, count: number) => {
    const ranked = sortedChildren(tree, node, byValue);
    const picked = new Set(ranked.slice(0, ranked.length === count + 1 ? count + 1 : count));
    for (const child of ranked) if (forced(child)) picked.add(child);
    return sortedChildren(tree, node, order).filter((n) => picked.has(n)).map((n) => n.id);
  };

  const path: NodeId[] = [];
  for (let id: NodeId | null = focus; id !== null; id = tree.nodes[id].parent) path.unshift(id);
  const contextNodes: NodeId[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const children = sortedChildren(tree, tree.nodes[path[i]], order).map((n) => n.id);
    const kids = overrides.get(path[i]) ? children : nearSiblings(children, path[i + 1], context, activityOrder);
    open(path[i], kids);
    contextNodes.push(...kids.filter((id) => id !== path[i + 1]));
  }
  for (const id of contextNodes) {
    if (!overrides.get(id) || tree.nodes[id].children.length === 0) continue;
    const kids = sortedChildren(tree, tree.nodes[id], order).map((n) => n.id);
    open(id, kids);
    contextNodes.push(...kids);
  }

  let frontier: TreeNode[] = [];
  let full = false;
  const reach = (kids: NodeId[]) => {
    for (const id of kids) if (openable(tree.nodes[id]) && (!full || forced(tree.nodes[id]))) frontier.push(tree.nodes[id]);
  };
  const focusNode = tree.nodes[focus];
  const focusOverride = overrides.get(focus);
  if (openable(focusNode)) {
    open(focus, focusOverride ? sortedChildren(tree, focusNode, order).map((n) => n.id) : best(focusNode, MAX_FOCUS_CHILDREN));
    reach(shown.get(focus)!);
  }
  const automatic: NodeId[] = [];
  while (frontier.length > 0) {
    let top = 0;
    for (let i = 1; i < frontier.length; i++) if (byValue(frontier[i], frontier[top]) < 0) top = i;
    const [node] = frontier.splice(top, 1);
    const override = overrides.get(node.id);
    const kids = override ? sortedChildren(tree, node, order).map((n) => n.id) : best(node, CHAIN_CHILDREN);
    if (!forced(node) && visible + revealed(node.id, kids) > budget) {
      full = true;
      frontier = frontier.filter(forced);
      continue;
    }
    open(node.id, kids);
    if (!override) automatic.push(node.id);
    reach(kids);
  }
  const leadsToManual = withAncestors(tree, new Set([...overrides].filter(([id, expanded]) => expanded && shown.has(id)).map(([id]) => id)));
  for (let i = automatic.length - 1; i >= 0 && visible > budget; i--) {
    if (leadsToManual.has(automatic[i])) continue;
    visible -= revealed(automatic[i], shown.get(automatic[i])!);
    shown.delete(automatic[i]);
  }
  return shown;
}

/** `pathChild` plus up to `count` siblings, activity preference then nearest; in drawing order. */
function nearSiblings(children: NodeId[], pathChild: NodeId, count: number, activityOrder: (a: NodeId, b: NodeId) => number): NodeId[] {
  if (children.length - 1 <= count + 1) return children;
  const at = children.indexOf(pathChild);
  const distance = (i: number) => Math.abs(i - at) * 2 - (i < at ? 1 : 0);
  const picked = children
    .map((id, i) => ({ id, i }))
    .filter(({ i }) => i !== at)
    .sort((a, b) => activityOrder(a.id, b.id) || distance(a.i) - distance(b.i))
    .slice(0, count);
  const keep = new Set([pathChild, ...picked.map((p) => p.id)]);
  return children.filter((id) => keep.has(id));
}

export function withAncestors(tree: Tree, ids: ReadonlySet<NodeId>): Set<NodeId> {
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
