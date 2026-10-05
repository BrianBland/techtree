import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, findingImpact } from "../../src/core/scoring.ts";
import { conflict, hotNodes, needsManualReview, priority, suggestTasks } from "../../src/core/suggest.ts";
import { treeFromFiles } from "../../src/core/tree.ts";
import type { Finding, MetricDef, ScoreResult } from "../../src/types.ts";
import { config, finding, LINT, LOC } from "./fixture.ts";

const CHURN: MetricDef = { key: "churn_90d", label: "Churn", direction: "neutral", aggregate: "sum" };

test("priority divides impact by effort cost and scales by (1 - conflict)", () => {
  const impact = { node: 10, root: 1 };
  assert.equal(priority(impact, "trivial", 0), 10);
  assert.equal(priority(impact, "small", 0), 5);
  assert.equal(priority(impact, "medium", 0), 2);
  assert.equal(priority(impact, "large", 0.5), 10 / 13 / 2);
  assert.equal(priority(impact, "trivial", 1), 0);
});

test("conflict is the fraction of paths overlapping busy files or directories", () => {
  assert.equal(conflict(["a/x.rs", "b/y.rs"], []), 0);
  assert.equal(conflict(["a/x.rs", "b/y.rs"], ["a/x.rs"]), 0.5);
  assert.equal(conflict(["a/x.rs", "b/y.rs"], ["a"]), 0.5, "busy dir contains the file");
  assert.equal(conflict(["a"], ["a/x.rs"]), 1, "suggestion dir contains a busy file");
  assert.equal(conflict(["ab/x.rs"], ["a"]), 0, "prefix must end at a path segment");
  assert.equal(conflict([""], ["z/q.rs"]), 1, "the root overlaps everything");
});

test("hot nodes are the top decile of churn among nodes of their kind", () => {
  const files = Array.from({ length: 20 }, (_, i) => `d${i}/f`).concat(["k/f"]);
  const tree = treeFromFiles("/repo", files);
  tree.nodes.k.kind = "crate";
  const own = Object.fromEntries(files.map((f, i) => [f.split("/")[0], { churn_90d: i }]));
  own.k = { churn_90d: 1 };
  const m = buildModel(tree, [CHURN], own, config());
  const hot = hotNodes(tree, m.scores);
  assert.deepEqual([...hot].sort(), ["", "d18", "d19", "k"], "ceil(21/10) = 3 of the 21 dirs; k is alone among crates");
});

test("complexity heuristic pre-ticks manual review", () => {
  const simple = finding("a", "x", {});
  assert.equal(needsManualReview([simple], false), false);
  assert.equal(needsManualReview([finding("a", "x", {}, { effort: "medium" })], false), true);
  assert.equal(needsManualReview([simple, finding("b", "x", {})], false), true);
  assert.equal(needsManualReview([simple], true), true);
  assert.equal(needsManualReview([finding("a", "x", {}, { tags: ["security"] })], false), true);
  assert.equal(needsManualReview([finding("a", "x", {}, { tags: ["style"] })], false), false);
});

test("suggestions group trivial same-file findings and sort by priority", () => {
  const tree = treeFromFiles("/repo", ["a/f.rs", "b/f.rs", "c/f.rs"]);
  const own = { a: { loc: 1000, lint_warnings: 10 }, b: { loc: 1000, lint_warnings: 5 }, c: { loc: 1000, lint_warnings: 1 } };
  const cfg = config({ weights: { lint_warnings: 1 } });
  const findings: Finding[] = [
    finding("a1", "a", { lint_warnings: -1 }, { file: "a/f.rs" }),
    finding("a2", "a", { lint_warnings: -1 }, { file: "a/f.rs" }),
    finding("b1", "b", { lint_warnings: -1 }, { file: "b/f.rs", effort: "large" }),
    finding("b2", "b", { lint_warnings: -1 }, { file: "b/f.rs", effort: "large" }),
  ];
  const model = buildModel(tree, [LOC, LINT], own, cfg);
  const result: ScoreResult = {
    sha: "",
    createdAt: "",
    tree,
    metricDefs: [LOC, LINT],
    own,
    scores: model.scores,
    findings,
    impacts: Object.fromEntries(findings.map((f) => [f.id, findingImpact(model, f)])),
  };
  const suggestions = suggestTasks(result, cfg, ["b/f.rs"]);
  assert.deepEqual(
    suggestions.map((s) => s.findingIds),
    [["a1", "a2"], ["b1"], ["b2"]],
  );
  const [grouped, busy] = suggestions;
  assert.equal(grouped.title, "2 lint fixes in a/f.rs");
  assert.ok(grouped.impact.node > result.impacts.a1.node, "group impact combines both fixes");
  assert.equal(grouped.manualReview, true, "more than one finding");
  assert.equal(busy.conflict, 1);
  assert.equal(busy.priority, 0);
  assert.equal(busy.manualReview, true, "large effort");
});
