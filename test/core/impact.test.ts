import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, findingImpact, findingsImpact } from "../../src/core/scoring.ts";
import { treeFromFiles } from "../../src/core/tree.ts";
import { config, finding, LINT, LOC } from "./fixture.ts";

// Lint densities per kLOC: clean 0, few 2, some 5, many 10, dense 20, small 20, big 20.
const model = () =>
  buildModel(
    treeFromFiles("/repo", ["clean/f", "few/f", "some/f", "many/f", "many/tiny/f", "dense/f", "small/f", "big/f"]),
    [LOC, LINT],
    {
      clean: { loc: 1000, lint_warnings: 0 },
      few: { loc: 1000, lint_warnings: 2 },
      some: { loc: 1000, lint_warnings: 5 },
      many: { loc: 990, lint_warnings: 9 },
      "many/tiny": { loc: 10, lint_warnings: 1 },
      dense: { loc: 1000, lint_warnings: 20 },
      small: { loc: 250, lint_warnings: 5 },
      big: { loc: 4000, lint_warnings: 80 },
    },
    config({ weights: { lint_warnings: 1 } }),
  );

test("a finding with no effect has zero impact", () => {
  assert.deepEqual(findingImpact(model(), finding("f", "some", {})), { node: 0, root: 0 });
  assert.deepEqual(findingImpact(model(), finding("f", "some", { lint_warnings: 0 })), { node: 0, root: 0 });
});

test("fixing a lint improves the node and the root, even in a node with few lints", () => {
  const m = model();
  for (const node of ["few", "some", "dense"]) {
    const impact = findingImpact(m, finding("f", node, { lint_warnings: -1 }));
    assert.ok(impact.node > 0, `${node} node impact ${impact.node}`);
    assert.ok(impact.root > 0, `${node} root impact ${impact.root}`);
  }
});

test("the worst node of a kind still gains from a fix that does not pass the next-worst", () => {
  const m = buildModel(
    treeFromFiles("/repo", ["a/f", "b/f", "c/f"]),
    [LOC, LINT],
    { a: { loc: 1000, lint_warnings: 1 }, b: { loc: 1000, lint_warnings: 5 }, c: { loc: 1000, lint_warnings: 10 } },
    config({ weights: { lint_warnings: 1 } }),
  );
  assert.ok(findingImpact(m, finding("f", "c", { lint_warnings: -1 })).node > 0);
});

test("a larger effect beats a trivial one in the same node", () => {
  const m = model();
  const trivial = findingImpact(m, finding("t", "some", { lint_warnings: -1 }));
  const severe = findingImpact(m, finding("s", "some", { lint_warnings: -5 }));
  assert.ok(severe.node > trivial.node);
  assert.ok(severe.root > trivial.root);
});

test("one lint matters more to a small node than to a big node of the same density", () => {
  const m = model();
  const small = findingImpact(m, finding("s", "small", { lint_warnings: -1 }));
  const big = findingImpact(m, finding("b", "big", { lint_warnings: -1 }));
  assert.ok(small.node > big.node, `small ${small.node} vs big ${big.node}`);
  assert.ok(big.node > 0);
});

test("a fix in a node below minLoc shows up through the parent it inherits from", () => {
  const m = model();
  const impact = findingImpact(m, finding("f", "many/tiny", { lint_warnings: -1 }));
  const viaParent = findingImpact(m, finding("g", "many", { lint_warnings: -1 }));
  assert.ok(impact.node > 0);
  assert.equal(impact.node, viaParent.node, "same aggregated change at the parent");
});

test("a task's planned delta combines its findings", () => {
  const m = model();
  const one = finding("a", "some", { lint_warnings: -1 });
  const two = finding("b", "some", { lint_warnings: -1 });
  assert.deepEqual(findingsImpact(m, [one]), findingImpact(m, one));
  assert.deepEqual(findingsImpact(m, [one, two]), findingImpact(m, finding("c", "some", { lint_warnings: -2 })));
  const spread = findingsImpact(m, [one, finding("d", "dense", { lint_warnings: -1 })]);
  assert.ok(spread.root > findingImpact(m, one).root, "root gains from both nodes");
  assert.equal(spread.node, spread.root, "focus defaults to the common ancestor, here the root");
});
