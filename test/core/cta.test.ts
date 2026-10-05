import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeCtas, rankCtas } from "../../src/core/cta.ts";
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
