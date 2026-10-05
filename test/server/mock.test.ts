import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockBackend } from "../../src/server/mock.ts";
import { HttpError } from "../../src/server/backend.ts";
import type { ServerEvent, TaskState } from "../../src/types.ts";

const depth = (id: string) => (id === "" ? 0 : id.split("/").length);

test("mock state is a large, deep, fully scored synthetic repo", async () => {
  const mock = createMockBackend({ tickMs: 0 });
  const state = await mock.getState();
  const ids = Object.keys(state.tree.nodes);
  assert.ok(ids.length >= 600, `${ids.length} dirs`);
  assert.ok(Math.max(...ids.map(depth)) >= 7);
  assert.ok(ids.filter((id) => state.tree.nodes[id].kind === "crate").length >= 3);
  for (const id of ids) {
    const node = state.tree.nodes[id];
    for (const child of node.children) assert.equal(state.tree.nodes[child].parent, id);
    const quality = state.scores[id].quality;
    assert.ok(quality !== null && quality >= 0 && quality <= 100);
  }
  const states = new Set(state.tasks.map((t) => t.state));
  for (const s of ["queued", "running", "needs_input", "review", "pr_open", "done", "failed"] as TaskState[]) {
    assert.ok(states.has(s), `no ${s} task`);
  }
  assert.ok(state.prs.some((p) => p.ci === "fail"));
  assert.ok(state.prs.some((p) => p.stuck));
  assert.ok(state.prs.some((p) => p.stale));
  const overview = await mock.getOverview();
  assert.ok(overview.attentionTasks.length >= 2);
  assert.ok(overview.flaggedPrs.length >= 3);
  assert.ok(overview.suggestions.length > 0);
});

test("node details rank findings by impact and unknown ids are 404", async () => {
  const mock = createMockBackend({ tickMs: 0 });
  const state = await mock.getState();
  const withFindings = Object.keys(state.findingCounts).find((id) => state.findingCounts[id] > 1)!;
  const node = await mock.getNode(withFindings);
  assert.ok(node.history.length > 1);
  const impacts = node.findings.map((f) => f.impact.node);
  assert.deepEqual(impacts, [...impacts].sort((a, b) => b - a));
  assert.ok(node.suggestions.length > 0);
  await assert.rejects(mock.getNode("no/such/dir"), (err: unknown) => err instanceof HttpError && err.status === 404);
});

test("running tasks advance their checklist and stream log lines on each tick", async () => {
  const mock = createMockBackend({ tickMs: 0 });
  const events: ServerEvent[] = [];
  mock.subscribe((e) => events.push(e));
  const running = (await mock.getState()).tasks.find((t) => t.state === "running")!;
  const before = running.checklist.filter((c) => c.done).length;
  mock.tick();
  const after = (await mock.getState()).tasks.find((t) => t.id === running.id)!;
  assert.ok(after.checklist.filter((c) => c.done).length > before || after.state !== "running");
  assert.ok(events.some((e) => e.type === "task" && e.task.id === running.id));
  assert.ok(events.some((e) => e.type === "log" && e.taskId === running.id));
  assert.match(await mock.taskLog(running.id, 1), /\S/);
});

test("mutations follow task states and emit events", async () => {
  const mock = createMockBackend({ tickMs: 0 });
  const events: ServerEvent[] = [];
  mock.subscribe((e) => events.push(e));
  const state = await mock.getState();
  const byState = (s: TaskState) => state.tasks.find((t) => t.state === s)!;

  const suggestion = (await mock.getOverview()).suggestions[0];
  const started = await mock.startTask({ node: suggestion.node, findingIds: suggestion.findingIds, manualReview: true });
  assert.ok(started.plannedTo > started.plannedFrom);
  assert.ok(events.some((e) => e.type === "task" && e.task.id === started.id));

  await assert.rejects(mock.answer(byState("done").id, "x"), (err: unknown) => (err as HttpError).status === 409);
  assert.equal((await mock.answer(byState("needs_input").id, "use the trait")).state, "running");

  const review = byState("review");
  assert.match(await mock.taskDiff(review.id), /^diff --git/);
  const opened = await mock.openPr(review.id);
  assert.equal(opened.state, "pr_open");
  assert.ok(events.some((e) => e.type === "pr" && e.pr.number === opened.pr));

  assert.equal((await mock.cancel(byState("queued").id)).state, "failed");
  const pr = state.prs[0];
  assert.equal((await mock.setBabysit(pr.number, !pr.babysit)).babysit, !pr.babysit);
  await assert.rejects(mock.setBabysit(99999, true), (err: unknown) => (err as HttpError).status === 404);

  const reported = await mock.report(started.id, { plan: ["read", "fix", "test"] });
  assert.deepEqual(reported.checklist.map((c) => c.text), ["read", "fix", "test"]);

  await mock.scan("");
  mock.tick();
  assert.deepEqual(
    events.filter((e) => e.type === "scan").map((e) => e.type === "scan" && e.status),
    ["running", "done"],
  );
  await mock.rescore();
  assert.ok(events.some((e) => e.type === "scores"));
});

test("a task that finishes its checklist raises its node's quality and emits a scores event", async () => {
  const mock = createMockBackend({ tickMs: 0 });
  const events: ServerEvent[] = [];
  mock.subscribe((e) => events.push(e));
  const before = await mock.getState();
  const running = before.tasks.find((t) => t.state === "running")!;
  for (let i = 0; i < 10 && (await mock.getState()).tasks.find((t) => t.id === running.id)!.state === "running"; i++) mock.tick();
  const after = await mock.getState();
  assert.ok(["review", "pr_open"].includes(after.tasks.find((t) => t.id === running.id)!.state));
  assert.ok(after.scores[running.node].quality! > before.scores[running.node].quality!);
  assert.ok(events.some((e) => e.type === "scores"));
  assert.notDeepEqual(after.snapshot, before.snapshot);
});
