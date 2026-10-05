import { useEffect, useMemo, useRef } from "preact/hooks";
import type { NodeId, PrState, Task, Tree } from "../types.ts";
import type { Layout, PlacedNode } from "./layout.ts";
import { researchBar } from "./visual.ts";
import { fitView, zoomAt, type View } from "./view.ts";

export interface TreeViewProps {
  tree: Tree;
  layout: Layout;
  fill: (id: NodeId) => string;
  edgeWidth: (id: NodeId) => number;
  /** Colour of a composite score, for research bars. */
  compositeColor: (score: number) => string;
  tasks: Task[];
  prs: PrState[];
  selected: NodeId | null;
  /** Incremented to request fit-to-view. */
  fitRequest: number;
  onSelect(id: NodeId): void;
  onToggle(id: NodeId): void;
}

const BAR_WIDTH = 40;
const BAR_HEIGHT = 5;
const DRAG_THRESHOLD = 3;

export function TreeView(props: TreeViewProps) {
  const { tree, layout, fill, edgeWidth, compositeColor, tasks, prs, selected, fitRequest, onSelect, onToggle } = props;
  const svg = useRef<SVGSVGElement>(null);
  const world = useRef<SVGGElement>(null);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const apply = (next: View) => {
    view.current = next;
    world.current?.setAttribute("transform", `translate(${next.x},${next.y}) scale(${next.k})`);
  };

  useEffect(() => {
    const el = svg.current;
    if (el) apply(fitView(layout.bounds, el.clientWidth, el.clientHeight));
  }, [fitRequest]);

  useEffect(() => {
    const el = svg.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      apply(zoomAt(view.current, e.clientX - box.left, e.clientY - box.top, Math.exp(-e.deltaY * 0.0015)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    suppressClick.current = false;
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!d.moved) svg.current!.setPointerCapture(e.pointerId);
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    apply({ ...view.current, x: view.current.x + dx, y: view.current.y + dy });
  };
  const onPointerUp = () => {
    suppressClick.current = drag.current?.moved ?? false;
    drag.current = null;
  };
  const click = (handler: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    if (!suppressClick.current) handler();
  };

  const edges = useMemo(
    () =>
      layout.edges.map(([p, c]) => {
        const mx = (p.x + c.x) / 2;
        return (
          <path key={c.id} d={`M${p.x},${p.y}C${mx},${p.y} ${mx},${c.y} ${c.x},${c.y}`} stroke-width={edgeWidth(c.id)} />
        );
      }),
    [layout, edgeWidth],
  );

  const prsByNode = useMemo(() => groupBy(prs, (p) => p.node), [prs]);
  const runningByNode = useMemo(() => groupBy(tasks.filter((t) => t.state === "running"), (t) => t.node), [tasks]);

  return (
    <svg ref={svg} class="tree" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <defs>
        <pattern id="stripes" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="3" height="6" fill="rgba(255,255,255,0.55)" />
          <animateTransform attributeName="patternTransform" type="translate" from="0 0" to="6 0" dur="0.8s" repeatCount="indefinite" additive="sum" />
        </pattern>
      </defs>
      <g ref={world}>
        <g class="edges">{edges}</g>
        {layout.nodes.map((n) => (
          <NodeGlyph
            key={n.id}
            node={n}
            name={tree.nodes[n.id].name}
            kind={tree.nodes[n.id].kind}
            expandable={tree.nodes[n.id].children.length > 0}
            fill={fill(n.id)}
            selected={n.id === selected}
            prs={prsByNode.get(n.id)}
            running={runningByNode.get(n.id)}
            compositeColor={compositeColor}
            onSelect={click(() => onSelect(n.id))}
            onToggle={click(() => onToggle(n.id))}
          />
        ))}
      </g>
    </svg>
  );
}

interface GlyphProps {
  node: PlacedNode;
  name: string;
  kind: string;
  expandable: boolean;
  fill: string;
  selected: boolean;
  prs?: PrState[];
  running?: Task[];
  compositeColor: (score: number) => string;
  onSelect(e: MouseEvent): void;
  onToggle(e: MouseEvent): void;
}

function NodeGlyph({ node, name, kind, expandable, fill, selected, prs, running, compositeColor, onSelect, onToggle }: GlyphProps) {
  const { x, y, r } = node;
  const handleX = x + r + 9;
  return (
    <g class={selected ? "node selected" : "node"} onClick={onSelect}>
      <circle cx={x} cy={y} r={r} fill={fill} class={kind === "crate" ? "crate" : undefined} />
      {expandable && (
        <g class="handle" onClick={onToggle}>
          <circle cx={handleX} cy={y} r={6} />
          <text x={handleX} y={y + 3.5}>{node.hiddenChildren ? "+" : "−"}</text>
        </g>
      )}
      <text class="label" x={x + r + (expandable ? 19 : 5)} y={y + 4}>
        {name}
        {node.hiddenChildren > 0 && <tspan class="hidden-count"> {node.hiddenChildren}</tspan>}
      </text>
      {running?.map((task, i) => (
        <ResearchBar key={task.id} task={task} x={x - BAR_WIDTH / 2} y={y + r + 4 + i * (BAR_HEIGHT + 2)} color={compositeColor} />
      ))}
      {prs && (
        <g class={prs.some((p) => p.ci === "fail") ? "pr-bubble failing" : "pr-bubble"}>
          <circle cx={x + r * 0.75} cy={y - r * 0.75} r={7} />
          <text x={x + r * 0.75} y={y - r * 0.75 + 3.5}>{prs.length}</text>
        </g>
      )}
    </g>
  );
}

function ResearchBar({ task, x, y, color }: { task: Task; x: number; y: number; color: (score: number) => string }) {
  const { solid, progress, planned } = researchBar(task);
  const stripeColor = color(task.plannedTo);
  return (
    <g class="research">
      <rect class="track" x={x} y={y} width={BAR_WIDTH} height={BAR_HEIGHT} />
      <rect x={x} y={y} width={solid * BAR_WIDTH} height={BAR_HEIGHT} fill={color(task.plannedFrom)} />
      <rect x={x + solid * BAR_WIDTH} y={y} width={(planned - solid) * BAR_WIDTH} height={BAR_HEIGHT} fill={stripeColor} opacity={0.3} />
      <rect x={x + solid * BAR_WIDTH} y={y} width={(progress - solid) * BAR_WIDTH} height={BAR_HEIGHT} fill={stripeColor} />
      <rect x={x + solid * BAR_WIDTH} y={y} width={(progress - solid) * BAR_WIDTH} height={BAR_HEIGHT} fill="url(#stripes)" />
    </g>
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}
