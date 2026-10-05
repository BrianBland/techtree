import { test } from "node:test";
import assert from "node:assert/strict";
import { messageBlocked } from "../../src/web/task-actions.ts";
import type { Task } from "../../src/types.ts";

const task = (state: Task["state"], extra: Partial<Task> = {}): Task => ({
  id: "t", project: "quality", node: "", title: "t", prompt: "", findingIds: [], state, manualReview: true, plannedFrom: 0, plannedTo: 0,
  checklist: [], phase: "edit", worktree: "/w", createdAt: "", updatedAt: "", ...extra,
});

test("chat messages are blocked, with a reason, exactly where the server would refuse them", () => {
  assert.equal(messageBlocked(task("queued")), "waiting for a worker slot");
  assert.equal(messageBlocked(task("running")), "starting");
  assert.equal(messageBlocked(task("done")), "the task is done");
  for (const ok of [task("running", { pid: 1 }), task("needs_input"), task("review"), task("failed"), task("pr_open")])
    assert.equal(messageBlocked(ok), undefined, ok.state);
});
