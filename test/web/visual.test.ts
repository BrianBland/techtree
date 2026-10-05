import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_SCORE, ramp, researchBar, sqrtScale } from "../../src/web/visual.ts";
import { fitView, zoomAt } from "../../src/web/view.ts";
import type { Task } from "../../src/types.ts";

const lightness = (color: string) => Number(/(\d+(?:\.\d+)?)%\)$/.exec(color)![1]);

test("sizes scale with the square root of the weight", () => {
  const size = sqrtScale(400, 2, 22);
  assert.equal(size(0), 2);
  assert.equal(size(400), 22);
  assert.equal(size(100), 12);
  assert.equal(sqrtScale(0, 2, 22)(0), 2);
});

test("fill ramp spans the repo's score range on a single hue, darker is better", () => {
  const fill = ramp([40, 60, null, 80]);
  assert.equal(fill(null), NO_SCORE);
  const [low, mid, high] = [fill(40), fill(60), fill(80)];
  for (const c of [low, mid, high]) assert.match(c, /^hsl\(217 /);
  assert.ok(lightness(low) > lightness(mid) && lightness(mid) > lightness(high));
  assert.equal(fill(10), low);
  assert.equal(fill(99), high);
  assert.equal(ramp([50, 50])(50), ramp([0, 100])(50));
  assert.equal(ramp([])(50), ramp([0, 100])(50));
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
