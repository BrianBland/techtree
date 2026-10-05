import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPOSITE, NO_SCORE, attentionNodes, ramp, researchBar, scoreDeltas, sparkline, sqrtScale, statMetrics, subtreeValues, tileLooks, tileSize } from "../../src/web/visual.ts";
import { fitView, zoomAt } from "../../src/web/view.ts";
import type { MetricDef, NodeScore, PrState, Task, Tree } from "../../src/types.ts";

const hsl = (color: string) => {
  const [h, s, l] = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(color)!.slice(1).map(Number);
  return { h, s, l };
};
const hueIn = (color: string, from: number, to: number) => {
  const { h } = hsl(color);
  return from <= to ? h >= from && h <= to : h >= from || h <= to;
};

test("sqrtScale maps 0..max onto the output range proportionally to the square root", () => {
  const size = sqrtScale(400, 2, 22);
  assert.equal(size(0), 2);
  assert.equal(size(400), 22);
  assert.equal(size(100), 12);
  assert.equal(sqrtScale(0, 2, 22)(0), 2);
});

test("tile sides scale with the square root of the weight, snapped to the 8-unit grid", () => {
  const side = tileSize(400);
  assert.equal(side(0), 24);
  assert.equal(side(400), 64);
  assert.equal(side(100), 48);
  for (let w = 0; w <= 400; w += 7) assert.equal(side(w) % 8, 0);
  assert.equal(tileSize(0)(0), 24);
});

test("diverging ramp: the worst scores are saturated red, the best cool teal-green", () => {
  const fill = ramp([40, 60, null, 80]);
  assert.equal(fill(null), NO_SCORE);
  const [worst, mid, best] = [fill(40), fill(60), fill(80)];
  assert.ok(hueIn(worst, 345, 10), worst);
  assert.ok(hsl(worst).s >= 90, worst);
  assert.ok(hueIn(mid, 35, 60), mid);
  assert.ok(hueIn(best, 140, 190), best);
  assert.ok(hsl(worst).s - hsl(best).s >= 20, "bad end is more saturated than the good end");
  assert.ok(hueIn(fill(45), 0, 30) && fill(45) !== worst, "near-worst scores stay hot but distinct");
  assert.equal(fill(10), worst);
  assert.equal(fill(99), best);
  assert.equal(ramp([50, 50])(50), ramp([0, 100])(50));
  assert.equal(ramp([])(50), ramp([0, 100])(50));
});

test("attention nodes are those with a task needing input or review, or a failing, stuck or stale PR; never a bad score", () => {
  const task = (node: string, state: Task["state"]) => ({ node, state }) as Task;
  const pr = (node: string, flags: Partial<PrState>) => ({ node, ci: "pass", stuck: false, stale: false, ...flags }) as PrState;
  const tasks = [task("ask", "needs_input"), task("rev", "review"), task("run", "running"), task("q", "queued"), task("old", "failed")];
  const prs = [pr("red", { ci: "fail" }), pr("stuck", { stuck: true }), pr("stale", { stale: true }), pr("ok", {}), pr("wait", { ci: "pending" })];
  assert.deepEqual([...attentionNodes(tasks, prs)].sort(), ["ask", "red", "rev", "stale", "stuck"]);
});

test("stat pips are the weighted quality metrics, heaviest first, at most eight", () => {
  const def = (key: string, direction: MetricDef["direction"] = "lower_better"): MetricDef => ({ key, label: key, direction, aggregate: "sum" });
  const defs = [def("loc", "neutral"), def("a"), def("b"), def("c"), def("zero"), ...["d", "e", "f", "g", "h", "i"].map((k) => def(k))];
  const weights = { loc: 5, a: 1, b: 3, c: 2, zero: 0, d: 1, e: 1, f: 1, g: 1, h: 1, i: 1 };
  assert.deepEqual(statMetrics(defs, weights), ["b", "c", "a", "d", "e", "f", "g", "h"]);
});

test("score deltas list nodes whose selected score moved by at least 0.5", () => {
  const score = (quality: number | null, pct: number | null): NodeScore => ({ node: "", quality, metrics: { m: { raw: 0, value: 0, pct } } });
  const before = { a: score(40, 10), b: score(50, 20), c: score(60, 30), d: score(null, null) };
  const after = { a: score(43.2, 10), b: score(50.3, 25), c: score(59, 30), d: score(70, null), e: score(10, 10) };
  assert.deepEqual([...scoreDeltas(before, after, COMPOSITE)], [["a", 3.2], ["c", -1]]);
  assert.deepEqual([...scoreDeltas(before, after, "m")], [["b", 5]]);
});

function task(partial: Partial<Task>): Task {
  return {
    id: "t",
    node: "",
    title: "",
    prompt: "",
    findingIds: [],
    state: "running",
    manualReview: false,
    plannedFrom: 40,
    plannedTo: 60,
    checklist: [],
    phase: "plan",
    createdAt: "",
    updatedAt: "",
    ...partial,
  };
}

test("research bar is solid to plannedFrom, filled to checklist completion, then planned to plannedTo", () => {
  const checklist = [
    { text: "a", done: true },
    { text: "b", done: true },
    { text: "c", done: false },
    { text: "d", done: false },
  ];
  assert.deepEqual(researchBar(task({ checklist })), { solid: 0.4, progress: 0.5, planned: 0.6 });
  assert.deepEqual(researchBar(task({ phase: "edit" })), { solid: 0.4, progress: 0.48, planned: 0.6 });
  assert.deepEqual(researchBar(task({ plannedTo: 30 })), { solid: 0.4, progress: 0.4, planned: 0.4 });
});

test("fit-to-view centres the bounds inside the viewport with padding", () => {
  const bounds = { minX: 0, minY: -100, maxX: 1000, maxY: 100 };
  const view = fitView(bounds, 600, 400, 50);
  assert.equal(view.k, 0.5);
  assert.deepEqual([bounds.minX * view.k + view.x, bounds.maxX * view.k + view.x], [50, 550]);
  assert.equal(((bounds.minY + bounds.maxY) / 2) * view.k + view.y, 200);
});

test("zooming keeps the point under the cursor fixed and clamps the scale", () => {
  const view = { x: 10, y: 20, k: 1 };
  const zoomed = zoomAt(view, 110, 220, 2);
  assert.equal(zoomed.k, 2);
  assert.deepEqual([(110 - view.x) / view.k, (220 - view.y) / view.k], [(110 - zoomed.x) / zoomed.k, (220 - zoomed.y) / zoomed.k]);
  assert.equal(zoomAt(view, 0, 0, 1000).k, 8);
  assert.equal(zoomAt(view, 0, 0, 0.0001).k, 0.05);
});

test("sparklines map 0..100 onto the box, top is best, gaps are skipped", () => {
  assert.equal(sparkline([0, 50, null, 100], 30, 10), "0,10 10,5 30,0");
  assert.equal(sparkline([], 30, 10), "");
});

test("tile looks colour pips by absolute percentile and leave missing metrics empty", () => {
  const score = (quality: number, metrics: Record<string, number | null>): NodeScore => ({
    node: "",
    quality,
    metrics: Object.fromEntries(Object.entries(metrics).map(([k, pct]) => [k, { raw: 0, value: 0, pct }])),
  });
  const scores = { a: score(90, { x: 0, y: 100 }), b: score(91, { x: 100 }), c: score(92, { x: null }) };
  const look = tileLooks({ scores, scoreKey: COMPOSITE, statKeys: ["x", "y"], findingCounts: { a: 3 } });
  assert.deepEqual(look("a").pips, [ramp([0, 100])(0), ramp([0, 100])(100)]);
  assert.deepEqual(look("b").pips, [ramp([0, 100])(100), null]);
  assert.deepEqual(look("c").pips, [null, null]);
  assert.equal(look("a").fill, ramp([90, 92])(90));
  assert.deepEqual([look("a").findings, look("b").findings, look("a").xp], [3, 0, 90]);
});

test("tile looks tolerate unscored nodes and nodes missing from the scores", () => {
  const scores: Record<string, NodeScore> = { a: { node: "a", quality: null, metrics: {} }, b: { node: "b", quality: 70, metrics: {} } };
  const look = tileLooks({ scores, scoreKey: COMPOSITE, statKeys: ["x"], findingCounts: {} });
  for (const id of ["a", "missing"]) {
    assert.deepEqual(look(id), { fill: NO_SCORE, pips: [null], xp: null, findings: 0 });
  }
});

test("subtree value: the largest node value below, from attention, running work, then badness × √own loc and own findings", () => {
  const node = (id: string, parent: string | null, children: string[]) => ({ id, name: id || "repo", kind: "dir", parent, children, files: [] });
  const tree: Tree = { repoRoot: "/r", nodes: { "": node("", null, ["a", "c"]), a: node("a", "", ["a/b"]), "a/b": node("a/b", "a", []), c: node("c", "", []) } };
  const scored = (id: string, quality: number | null, loc: number): NodeScore => ({ node: id, quality, metrics: { loc: { raw: loc, value: loc, pct: null } } });
  const scores = { "": scored("", null, 1000), a: scored("a", 80, 600), "a/b": scored("a/b", 40, 400), c: scored("c", 70, 400) };
  const values = (tasks: Task[] = [], prs: PrState[] = []) => subtreeValues({ tree, scores, tasks, prs, findingCounts: { c: 3 } });

  const calm = values();
  assert.equal(calm.get("a/b"), 60 * 20);
  assert.equal(calm.get("a"), 60 * 20, "a's own 200 lines at quality 80 are worth less than a/b's");
  assert.equal(calm.get("c"), 30 * 20 + 3 * 10);
  assert.equal(calm.get(""), 60 * 20);

  const running = values([{ node: "c", state: "running" } as Task]);
  assert.ok(running.get("c")! > running.get("a")!, "running work beats badness");
  const stuck = values([{ node: "c", state: "running" } as Task], [{ node: "a/b", ci: "pass", stuck: true, stale: false } as PrState]);
  assert.ok(stuck.get("a")! > stuck.get("c")!, "attention beats running work");
  assert.equal(stuck.get(""), stuck.get("a/b"));
});
