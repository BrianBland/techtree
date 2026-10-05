import { test } from "node:test";
import assert from "node:assert/strict";
import { diversify, interleave, nodeCtas, rankCtas } from "../../src/core/cta.ts";
import type { PrState, Suggestion, Task } from "../../src/types.ts";

const task = (node: string, state: Task["state"]) => ({ id: node + state, node, state }) as Task;
const pr = (node: string, f: Partial<PrState>) => ({ number: 1, node, ci: "pass", stale: false, stuck: false, ...f }) as PrState;
const sug = (node: string, priority: number) => ({ node, priority, impact: { node: 1, root: 0 } }) as Suggestion;

test("rankCtas orders needs_input, review, failing/stuck/stale PRs, then suggestions", () => {
  const ranked = rankCtas(
    [task("a", "review"), task("a", "running"), task("b", "needs_input")],
    [pr("c", { stale: true }), pr("d", { ci: "fail" }), pr("e", { stuck: true }), pr("f", {})],
    [sug("g", 2), sug("h", 5)],
  );
  assert.deepEqual(ranked.map((c) => c.node), ["b", "a", "d", "e", "c", "h", "g"]);
});

test("nodeCtas splits own from strictly-below, limited", () => {
  const ranked = rankCtas([], [], [sug("a", 3), sug("a/b", 2), sug("ab", 9), sug("a/c/d", 1), sug("", 4)]);
  const { ownCtas, childCtas } = nodeCtas("a", ranked, 1);
  assert.deepEqual(ownCtas.map((c) => c.node), ["a"]);
  assert.deepEqual(childCtas.map((c) => c.node), ["a/b"]);
  assert.equal(nodeCtas("", ranked).childCtas.length, 4);
});

const src = (node: string, priority: number, source: string) => ({ ...sug(node, priority), source }) as Suggestion;

test("diversify caps each source at 2 per block of 8, falling back to the best remaining", () => {
  const items = [..."aaaabc"].map((source, i) => ({ source, i }));
  assert.deepEqual(diversify(items, (x) => x.source).map((x) => x.i), [0, 1, 4, 5, 2, 3]);
  const many = [..."aaaaaaaaaaaab"].map((source, i) => ({ source, i }));
  const order = diversify(many, (x) => x.source).map((x) => x.i);
  assert.deepEqual(order.slice(0, 3), [0, 1, 12], "b is promoted into the first block");
  assert.equal(order.length, many.length);
  const blocks = [..."aaabbbcccdddeee"].map((source, i) => ({ source, i }));
  const second = diversify(blocks, (x) => x.source).slice(8).map((x) => x.source);
  assert.ok(new Set(second).size >= 3, "the cap resets for every block");
});

test("rankCtas diversifies suggestions by source after sorting by priority", () => {
  const suggestions = [src("a", 10, "unwrap"), src("b", 9, "unwrap"), src("c", 8, "unwrap"), src("d", 7, "unwrap"), src("e", 1, "duplication")];
  assert.deepEqual(rankCtas([task("t", "review")], [], suggestions).map((c) => c.node), ["t", "a", "b", "e", "c", "d"]);
});

test("childCtas are diversified among the node's descendants", () => {
  const ranked = rankCtas([], [], [
    src("x/a", 10, "unwrap"), src("x/b", 9, "unwrap"), src("y", 8.5, "duplication"), src("x/c", 8, "unwrap"), src("x/d", 1, "test-smell"),
  ]);
  assert.deepEqual(nodeCtas("x", ranked).childCtas.map((c) => c.node), ["x/a", "x/b", "x/d", "x/c"]);
});

test("interleave takes the first of each list, then the second of each, and so on", () => {
  assert.deepEqual(interleave([["q1", "q2", "q3"], [], ["p1"], ["f1", "f2"]]), ["q1", "p1", "f1", "q2", "f2", "q3"]);
});
