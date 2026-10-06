import { render } from "preact";
import type { NodeId, PrState, Task, Tree, TreeNode } from "../../src/types.ts";
import { layoutTree } from "../../src/web/layout.ts";
import { ramp, tileSize, type TileLook } from "../../src/web/visual.ts";
import { TreeView } from "../../src/web/TreeView.tsx";
import { FakeDocument, type FakeNode } from "./fake-dom.ts";

export interface Box {
  node: string;
  cls: string;
  left: number;
  right: number;
}

/**
 * Render `count` equal-weight sibling leaves with every decoration (attention glow on `attention`, all
 * by default; selection ring, crate marks, question, failing PR and finding badges) and return each
 * tile's painted rect boxes' horizontal extents in world units.
 */
export function decoratedSiblingBoxes(count: number, attention?: ReadonlySet<NodeId>): Box[] {
  const doc = new FakeDocument();
  Object.assign(globalThis, { document: doc });
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const nodes: Record<NodeId, TreeNode> = { "": { id: "", name: "repo", kind: "crate", parent: null, children: [], files: [] } };
  for (let i = 0; i < count; i++) {
    const id = `n${i}`;
    nodes[id] = { id, name: id, kind: "crate", parent: "", children: [], files: [] };
    nodes[""].children.push(id);
  }
  const tree: Tree = { repoRoot: "/r", nodes };
  const ids = Object.keys(nodes);
  const side = tileSize(1);
  const layout = layoutTree({ tree, shown: new Map([["", nodes[""].children]]), radius: () => side(1) / 2 });
  const look: TileLook = { fill: "red", pips: Array(8).fill("red"), xp: 50 };
  const tasks = ids.map((node, i) => ({ id: `t${i}`, node, state: "needs_input" }) as Task);
  const prs = ids.map((node, i) => ({ number: i, node, ci: "fail" }) as PrState);
  render(
    <TreeView
      tree={tree}
      layout={layout}
      look={() => look}
      deltas={new Map()}
      edgeWidth={() => 2}
      compositeColor={ramp([0, 100])}
      tasks={tasks}
      prs={prs}
      attention={attention ?? new Set(ids)}
      suggestionCounts={Object.fromEntries(ids.map((id) => [id, 12]))}
      selected="n0"
      fitRequest={0}
      onSelect={() => {}}
      onToggle={() => {}}
      onStub={() => {}}
    />,
    root as unknown as Element,
  );

  const boxes: Box[] = [];
  const walk = (el: FakeNode, node: string, tx: number, k: number) => {
    const scale = /scale\(([\d.]+)\)/.exec(el.getAttribute("transform") ?? "");
    const k2 = scale ? k * Number(scale[1]) : k;
    if (el.localName === "rect") {
      const x = Number(el.getAttribute("x") ?? 0);
      const w = Number(el.getAttribute("width"));
      boxes.push({ node, cls: el.getAttribute("class") ?? "", left: tx + x * k2, right: tx + (x + w) * k2 });
    }
    for (const child of el.childNodes) if (child.nodeType === 1) walk(child, node, tx, k2);
  };
  for (const g of (root as unknown as FakeNode).querySelectorAll((n) => /^node( |$)/.test(n.getAttribute("class") ?? ""))) {
    const translate = /translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(String((g.style as Record<string, unknown>).transform))!;
    const id = g.querySelectorAll((n) => n.getAttribute("class") === "label")[0].textContent;
    walk(g, id, Number(translate[1]), 1);
  }
  return boxes;
}
