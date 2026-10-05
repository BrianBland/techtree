import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, commonAncestor, composite, findingsImpact, percentile } from "../../src/core/scoring.ts";
import { treeFromFiles } from "../../src/core/tree.ts";
import { config, LINT, LOC, MAX_FILE, TEST_RATIO } from "./fixture.ts";

const tree = () => treeFromFiles("/repo", ["a/x/f.rs", "a/y/f.rs", "b/f.rs"]);

test("aggregates own values up the tree per metric rule", () => {
  const m = buildModel(
    tree(),
    [LOC, LINT, TEST_RATIO, MAX_FILE],
    {
      "a/x": { loc: 100, lint_warnings: 1, test_ratio: 0.5, max_file_loc: 10 },
      "a/y": { loc: 300, lint_warnings: 2, test_ratio: 0.1, max_file_loc: 30 },
      b: { loc: 600, test_ratio: 0.9, max_file_loc: 20 },
    },
    config(),
  );
  assert.deepEqual(m.agg.a, { loc: 400, lint_warnings: 3, test_ratio: 0.2, max_file_loc: 30 });
  assert.equal(m.agg[""].loc, 1000);
  assert.equal(m.agg[""].max_file_loc, 30);
  assert.ok(Math.abs(m.agg[""].test_ratio - 0.62) < 1e-9);
  assert.equal(m.agg.b.lint_warnings, undefined, "no own value anywhere below b");
  assert.equal(m.scores.a.metrics.lint_warnings.value, 7.5, "lints per kLOC");
});

test("scores and what-if work for directory names that shadow Object.prototype members", () => {
  const t = treeFromFiles("/repo", ["constructor/f", "__proto__/f", "toString/f"]);
  const own = Object.fromEntries([
    ["constructor", { loc: 1000, lint_warnings: 1 }],
    ["__proto__", { loc: 1000, lint_warnings: 5 }],
    ["toString", { loc: 1000, lint_warnings: 9 }],
  ]);
  const m = buildModel(t, [LOC, LINT], own, config());
  assert.deepEqual(Object.keys(m.scores).sort(), ["", "__proto__", "constructor", "toString"]);
  assert.equal(m.agg[""].lint_warnings, 15);
  const pct = (id: string) => m.scores[id].metrics.lint_warnings.pct!;
  assert.ok(pct("constructor") > pct("__proto__"));
  const impact = findingsImpact(m, [{ id: "f", node: "__proto__", source: "s", title: "", detail: "", severity: "low", effort: "trivial", metricEffects: { lint_warnings: -1 } }]);
  assert.ok(impact.node > 0);
});

test("mean_by_loc falls back to the plain mean without loc", () => {
  const m = buildModel(tree(), [TEST_RATIO], { "a/x": { test_ratio: 0.2 }, "a/y": { test_ratio: 0.6 } }, config());
  assert.ok(Math.abs(m.agg.a.test_ratio - 0.4) < 1e-9);
});

test("percentile is an interpolated mid-rank among the other peers", () => {
  assert.equal(percentile([], 5), 50);
  assert.equal(percentile([5], 5, 5), 50, "alone among peers");
  assert.equal(percentile([1, 2, 3], 1, 1), 0);
  assert.equal(percentile([1, 2, 3], 2, 2), 50);
  assert.equal(percentile([1, 2, 3], 3, 3), 100);
  assert.equal(percentile([1, 1, 3], 1, 1), 25, "ties share the mid-rank");
  assert.equal(percentile([1, 3], 2), 50, "halfway between peers");
  assert.equal(percentile([1, 3], 2.5), 62.5, "linear between the peers' tie percentiles (25 and 75)");
  assert.equal(percentile([1, 3], 0), 0);
  assert.equal(percentile([1, 3], 4), 100);
});

test("ranks peers of the same kind, flips lower_better, nulls neutral, and leaves nodes below minLoc unscored", () => {
  const t = treeFromFiles("/repo", ["a/f", "b/f", "c/f", "c/tiny/f", "k/f"]);
  t.nodes.k.kind = "crate";
  const m = buildModel(
    t,
    [LOC, LINT],
    {
      a: { loc: 1000, lint_warnings: 1 },
      b: { loc: 1000, lint_warnings: 1 },
      c: { loc: 1000, lint_warnings: 9 },
      "c/tiny": { loc: 10, lint_warnings: 0 },
      k: { loc: 1000, lint_warnings: 50 },
    },
    config(),
  );
  const pct = (id: string) => m.scores[id].metrics.lint_warnings.pct;
  assert.equal(pct("a"), pct("b"), "ties are fair");
  assert.ok(pct("a")! > pct("c")!, "fewer lints rank higher");
  assert.equal(pct("k"), 50, "a crate is not ranked against dirs");
  assert.equal(pct("c/tiny"), null, "tiny node is unscored");
  assert.equal(m.scores["c/tiny"].quality, null);
  assert.equal(m.scores.a.metrics.loc.pct, null, "neutral metrics have no pct");
});

test("every node is ranked when no plugin defines loc", () => {
  const m = buildModel(tree(), [TEST_RATIO], { "a/x": { test_ratio: 0.1 }, b: { test_ratio: 0.9 } }, config());
  assert.notEqual(m.scores.b.metrics.test_ratio.pct, null);
  assert.ok(m.scores.b.metrics.test_ratio.pct! > m.scores["a/x"].metrics.test_ratio.pct!);
});

test("composite is the weighted mean over present non-neutral metrics with weight > 0", () => {
  const weights = { a: 3, b: 1, c: 0 };
  assert.equal(
    composite(
      { a: { raw: 0, value: 0, pct: 100 }, b: { raw: 0, value: 0, pct: 0 }, c: { raw: 0, value: 0, pct: 0 }, d: { raw: 0, value: 0, pct: 0 } },
      weights,
    ),
    75,
  );
  assert.equal(composite({ a: { raw: 1, value: 1, pct: null } }, weights), null);
  assert.equal(composite({}, weights), null);
});

test("commonAncestor finds the deepest shared directory", () => {
  assert.equal(commonAncestor(["a/b/c", "a/b/d", "a/b"]), "a/b");
  assert.equal(commonAncestor(["a/b", "ab"]), "");
  assert.equal(commonAncestor(["x"]), "x");
});
