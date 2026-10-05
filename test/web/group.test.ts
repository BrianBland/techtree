import { test } from "node:test";
import assert from "node:assert/strict";
import { combineSuggestions, commonAncestor } from "../../src/web/group.ts";
import type { Suggestion } from "../../src/types.ts";

const s = (node: string, ids: string[], extra: Partial<Suggestion> = {}): Suggestion => ({
  node, title: `fix ${node}`, source: "dup", findingIds: ids, impact: { node: 1, root: 0.1 }, effort: "small", conflict: 0, priority: 1, manualReview: false, ...extra,
});

test("commonAncestor is the deepest shared directory", () => {
  assert.equal(commonAncestor(["crates/a/src", "crates/a/tests"]), "crates/a");
  assert.equal(commonAncestor(["crates/a", "crates/ab"]), "crates");
  assert.equal(commonAncestor(["crates", "bin"]), "");
  assert.equal(commonAncestor(["crates/a"]), "crates/a");
});

test("combined suggestions carry every finding at the common ancestor", () => {
  const c = combineSuggestions([s("crates/a/src", ["1", "2"]), s("crates/b", ["2", "3"], { effort: "large", conflict: 0.5, manualReview: true, source: "rubric" })]);
  assert.deepEqual(c, {
    node: "crates", title: "fix crates/a/src (+1 more)", findingIds: ["1", "2", "3"], impact: { node: 2, root: 0.2 },
    effort: "large", conflict: 0.5, priority: 2, manualReview: true,
  });
});
