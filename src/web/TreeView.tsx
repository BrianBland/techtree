import { useEffect, useMemo, useRef } from "preact/hooks";
import type { NodeId, PrState, Task, Tree } from "../types.ts";
import type { Layout, PlacedNode } from "./layout.ts";
import { researchBar, type TileLook } from "./visual.ts";
import { fitView, zoomAt, type View } from "./view.ts";

export interface TreeViewProps {
  tree: Tree;
  layout: Layout;
  look: (id: NodeId) => TileLook;
  edgeWidth: (id: NodeId) => number;
  /** Colour of a composite score, for research bars. */
  compositeColor: (score: number) => string;
  tasks: Task[];
  prs: PrState[];
  /** Selected-score changes from the latest rescore; a new map replays the flash. */
  deltas: ReadonlyMap<NodeId, number>;
  selected: NodeId | null;
  /** Incremented to request fit-to-view. */
  fitRequest: number;
  onSelect(id: NodeId): void;
  onToggle(id: NodeId): void;
}

/** Tiles are drawn as SPRITE×SPRITE pixel sprites scaled to their side. */
const SPRITE = 16;
const BAR = { x: 2, y: 12, width: 12, height: 2 };
/**
 * Decorations stay inside the tile's layout band (side + NODE_GAP): badges sit beside the tile
 * rather than above or below it, and the alarm/selection rings hug the tile in world units.
 */
const BADGE = 7;
const BADGE_OUTSET = 5;
const RING_GAP = 3;
const ELBOW = 20;
const DRAG_THRESHOLD = 3;
const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
let flashGeneration = 0;

export function TreeView(props: TreeViewProps) {
  const { tree, layout, look, edgeWidth, compositeColor, tasks, prs, deltas, selected, fitRequest, onSelect, onToggle } = props;
  const svg = useRef<SVGSVGElement>(null);
  const world = useRef<SVGGElement>(null);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const apply = (next: View) => {
    view.current = next;
    world.current?.setAttribute("transform", `translate(${next.x},${next.y}) scale(${next.k})`);
  };

  const fitted = useRef(false);
  useEffect(() => {
    const el = svg.current;
    if (el && el.clientWidth > 0) {
      apply(fitView(layout.bounds, el.clientWidth, el.clientHeight));
      fitted.current = true;
    }
  }, [fitRequest]);

  // The first real layout (after data loads and the SVG has a size) is fitted once automatically.
  useEffect(() => {
    const el = svg.current;
    if (fitted.current || !el || el.clientWidth === 0) return;
    apply(fitView(layout.bounds, el.clientWidth, el.clientHeight));
    fitted.current = true;
  }, [layout]);

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
        const end = Math.round(c.x - c.r);
        const d = `M${Math.round(p.x + p.r)} ${Math.round(p.y)}H${end - ELBOW}V${Math.round(c.y)}H${end}`;
        return <path key={c.id} d={d} style={{ d: `path("${d}")` }} stroke-width={edgeWidth(c.id)} />;
      }),
    [layout, edgeWidth],
  );

  const prsByNode = useMemo(() => groupBy(prs, (p) => p.node), [prs]);
  const runningByNode = useMemo(() => groupBy(tasks.filter((t) => t.state === "running"), (t) => t.node), [tasks]);
  const askingNodes = useMemo(() => new Set(tasks.filter((t) => t.state === "needs_input").map((t) => t.node)), [tasks]);
  const flashKey = useMemo(() => ++flashGeneration, [deltas]);

  return (
    <svg ref={svg} class="tree" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <defs>
        <pattern id="stripes" width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="1" height="2" fill="rgba(255,255,255,0.6)" />
          {!reducedMotion && (
            <animateTransform attributeName="patternTransform" type="translate" from="0 0" to="2 0" dur="0.6s" repeatCount="indefinite" additive="sum" />
          )}
        </pattern>
      </defs>
      <g ref={world}>
        <g class="edges">{edges}</g>
        {layout.nodes.map((n) => {
          const node = tree.nodes[n.id];
          return (
            <Tile
              key={n.id}
              node={n}
              name={node.name}
              crate={node.kind === "crate"}
              expandable={node.children.length > 0}
              look={look(n.id)}
              selected={n.id === selected}
              prs={prsByNode.get(n.id)}
              running={runningByNode.get(n.id)?.[0]}
              asking={askingNodes.has(n.id)}
              delta={deltas.get(n.id)}
              flashKey={flashKey}
              compositeColor={compositeColor}
              onSelect={click(() => onSelect(n.id))}
              onToggle={click(() => onToggle(n.id))}
            />
          );
        })}
      </g>
    </svg>
  );
}

interface TileProps {
  node: PlacedNode;
  name: string;
  crate: boolean;
  expandable: boolean;
  look: TileLook;
  selected: boolean;
  prs?: PrState[];
  running?: Task;
  asking: boolean;
  delta?: number;
  flashKey: number;
  compositeColor: (score: number) => string;
  onSelect(e: MouseEvent): void;
  onToggle(e: MouseEvent): void;
}

function Tile(props: TileProps) {
  const { node, name, crate, expandable, look, selected, prs, running, asking, delta, flashKey, compositeColor, onSelect, onToggle } = props;
  const side = node.r * 2;
  const gutter = (side * (SPRITE - 2 + BADGE)) / SPRITE;
  const classes = ["node", selected && "selected", look.worst && "worst", look.hot && "hot", crate && "crate"].filter(Boolean).join(" ");
  return (
    <g class={classes} style={{ transform: `translate(${Math.round(node.x - node.r)}px,${Math.round(node.y - node.r)}px)` }} onClick={onSelect}>
      {look.worst && <rect class="alarm" x={-RING_GAP} y={-RING_GAP} width={side + 2 * RING_GAP} height={side + 2 * RING_GAP} />}
      {selected && <rect class="ring" x={-RING_GAP} y={-RING_GAP} width={side + 2 * RING_GAP} height={side + 2 * RING_GAP} />}
      <g transform={`scale(${side / SPRITE})`}>
        <rect class="frame" width={SPRITE} height={SPRITE} />
        <rect x={1} y={1} width={SPRITE - 2} height={SPRITE - 2} fill={look.fill} />
        <path class="bevel-light" d="M1 1h14v1H2v13H1z" />
        <path class="bevel-dark" d="M15 2v13H2v-1h12V2z" />
        {crate && <path class="gem" d="M0 0h2v2H0zM14 0h2v2h-2zM0 14h2v2H0zM14 14h2v2h-2zM6 -1h4v2H6z" />}
        {look.pips.map((color, i) => (
          <rect key={i} class={color ? "pip" : "pip empty"} x={2 + (i % 4) * 3} y={2 + Math.floor(i / 4) * 3} width={2} height={2} fill={color ?? undefined} />
        ))}
        {look.hot && <rect class="shimmer" x={1} y={1} width={SPRITE - 2} height={SPRITE - 2} />}
        <rect class="track" {...BAR} />
        {running ? (
          <ResearchBar task={running} color={compositeColor} />
        ) : (
          look.xp !== null && <rect class="xp" x={BAR.x} y={BAR.y} width={(BAR.width * look.xp) / 100} height={BAR.height} />
        )}
        {delta !== undefined && <rect key={flashKey} class="flash" width={SPRITE} height={SPRITE} />}
        {asking && <Badge kind="ask" x={-BADGE_OUTSET} y={0} text="!" />}
        {prs && <Badge kind={prs.some((p) => p.ci === "fail") ? "pr failing" : "pr"} x={SPRITE - 2} y={0} text={prs.length} />}
        {look.findings > 0 && <Badge kind="findings" x={SPRITE - 2} y={SPRITE - BADGE} text={look.findings > 9 ? "9+" : look.findings} />}
      </g>
      {expandable && (
        <g class="handle" onClick={onToggle}>
          <rect x={gutter + 4} y={node.r - 5} width={10} height={10} />
          <text x={gutter + 9} y={node.r + 3.5}>{node.hiddenChildren ? "+" : "−"}</text>
        </g>
      )}
      <text class="label" x={gutter + (expandable ? 18 : 6)} y={node.r + 4}>
        {name}
        {node.hiddenChildren > 0 && <tspan class="hidden-count"> {node.hiddenChildren}</tspan>}
      </text>
      {delta !== undefined && (
        <text key={flashKey} class={delta > 0 ? "delta up" : "delta down"} x={node.r} y={-6}>
          {delta > 0 ? `+${delta}` : `−${-delta}`}
        </text>
      )}
    </g>
  );
}

function Badge({ kind, x, y, text }: { kind: string; x: number; y: number; text: string | number }) {
  return (
    <g class={`badge ${kind}`}>
      <rect x={x} y={y} width={BADGE} height={BADGE} />
      <text x={x + BADGE / 2} y={y + 5.4}>{text}</text>
    </g>
  );
}

function ResearchBar({ task, color }: { task: Task; color: (score: number) => string }) {
  const { solid, progress, planned } = researchBar(task);
  const { x, y, width, height } = BAR;
  const stripeColor = color(task.plannedTo);
  const start = x + solid * width;
  return (
    <g class="research">
      <rect x={x} y={y} width={solid * width} height={height} fill={color(task.plannedFrom)} />
      <rect x={start} y={y} width={(planned - solid) * width} height={height} fill={stripeColor} opacity={0.35} />
      <rect x={start} y={y} width={(progress - solid) * width} height={height} fill={stripeColor} />
      <rect x={start} y={y} width={(progress - solid) * width} height={height} fill="url(#stripes)" />
    </g>
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}
