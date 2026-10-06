import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrState, Task } from "../../src/types.ts";
import { outboxEntry } from "../../src/web/outbox.ts";

const base: PrState = {
  number: 1, url: "https://example.com/pr/1", title: "PR", author: "me", node: "", files: [], ci: "pass", review: "REVIEW_REQUIRED",
  updatedAt: "2025-01-01T00:00:00Z", babysit: false, stale: false, stuck: false, mergeable: "MERGEABLE",
};
const task = (state: Task["state"], question?: string) => ({ id: "t", state, ...(question && { question }) }) as Task;

test("outbox rows fall into Needs you, Babysitting or Waiting by the first matching rule (DESIGN \"Outbox\")", () => {
  const cases: [string, Partial<PrState>, Task | undefined, string, string][] = [
    ["ready to merge, even while babysat", { review: "APPROVED", babysit: true }, undefined, "needs_you", "ready to merge — merge on GitHub"],
    ["babysit gave up", { ci: "fail", babysitStatus: "gave up after 3 fix attempts" }, undefined, "needs_you", "gave up after 3 fix attempts"],
    ["observe-only", { babysit: true, ci: "fail", babysitStatus: "observe-only: CI failing" }, undefined, "needs_you", "observe-only: CI failing"],
    ["problems while babysit is off", { ci: "fail", review: "CHANGES_REQUESTED", mergeable: "CONFLICTING" }, undefined, "needs_you",
      "changes requested, merge conflict, CI failing · babysit off"],
    ["the fix asks a question", { babysit: true, ci: "fail" }, task("needs_input", "Which fix?"), "needs_you", "agent asks: Which fix?"],
    ["the fix awaits review", { babysit: true, ci: "fail" }, task("review"), "needs_you", "fix ready for review"],
    ["stuck", { babysit: true, stuck: true }, undefined, "needs_you", "no progress in 24h"],
    ["stale", { stale: true }, undefined, "needs_you", "no update in 3 days"],
    ["babysat with a fix running", { babysit: true, ci: "fail", babysitStatus: "fix attempt 1/3: CI failing" }, task("running"), "babysitting",
      "fix attempt 1/3: CI failing"],
    ["babysat and healthy", { babysit: true }, undefined, "babysitting", "waiting for CI or review"],
    ["checks pending, review required", { ci: "pending" }, undefined, "waiting", "checks pending · waiting for review"],
    ["checks pending, already approved", { ci: "pending", review: "APPROVED" }, undefined, "waiting", "checks pending"],
    ["waiting on review", {}, undefined, "waiting", "waiting for review"],
  ];
  for (const [name, pr, linked, section, status] of cases) assert.deepEqual(outboxEntry({ ...base, ...pr }, linked), { section, status }, name);
});
