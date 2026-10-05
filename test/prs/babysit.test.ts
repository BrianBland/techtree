import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, suppressSqliteWarning } from "../../src/db.ts";
import { Babysitter, type BabysitRunner } from "../../src/prs/babysit.ts";
import { PrPoller } from "../../src/prs/poller.ts";
import type { StartTask } from "../../src/runner/runner.ts";
import type { Task } from "../../src/types.ts";
import { fakeGh, ghPr, makeTree, type FakeGh } from "./helpers.ts";

suppressSqliteWarning();

/** Records what babysit asks the task runner to do instead of spawning pi. */
class FakeRunner implements BabysitRunner {
  tasks = new Map<string, Task>();
  started: StartTask[] = [];
  resumed: { taskId: string; prompt: string }[] = [];
  cancelled: string[] = [];

  get(taskId: string) {
    return this.tasks.get(taskId);
  }
  start(req: StartTask): Task {
    this.started.push(req);
    const task = makeTask({ id: `b${this.started.length}`, node: req.node, title: req.title!, prompt: req.prompt!, pr: req.pr, worktree: "/wt", state: "queued" });
    this.tasks.set(task.id, task);
    return task;
  }
  resumeTask(taskId: string, prompt: string): Task {
    this.resumed.push({ taskId, prompt });
    const task = this.tasks.get(taskId)!;
    task.state = "queued";
    return task;
  }
  cancel(taskId: string): Task {
    this.cancelled.push(taskId);
    const task = this.tasks.get(taskId)!;
    task.state = "failed";
    return task;
  }
  launches() {
    return this.started.length + this.resumed.length;
  }
}

function makeTask(over: Partial<Task>): Task {
  return {
    id: "t", project: "quality", node: "", title: "t", prompt: "", findingIds: [], state: "pr_open", manualReview: false, plannedFrom: 0,
    plannedTo: 0, checklist: [], phase: "pr", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", ...over,
  };
}

interface Harness {
  gh: FakeGh;
  runner: FakeRunner;
  poller: PrPoller;
  babysitter: Babysitter;
  /** Set PR 1's gh state and poll. */
  pr(over?: Record<string, unknown>): Promise<void>;
}

async function setup(t: TestContext, initial: Record<string, unknown> = {}): Promise<Harness> {
  const gh = fakeGh(t);
  const cache = mkdtempSync(join(tmpdir(), "techtree-babysit-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const runner = new FakeRunner();
  const poller: PrPoller = new PrPoller({
    db: openDb(cache),
    repoRoot: cache,
    gh: gh.gh,
    tree: () => makeTree("src"),
    tasks: () => [...runner.tasks.values()],
    onUpdate: (prev, next) => babysitter.onUpdate(prev, next),
    onRemove: (removed) => babysitter.onRemove(removed),
  });
  const babysitter = new Babysitter({ poller, runner });
  const pr = async (over: Record<string, unknown> = {}) => {
    gh.setList([ghPr(1, { ...initial, ...over })]);
    await poller.poll();
  };
  await pr();
  return { gh, runner, poller, babysitter, pr };
}

const failing = { statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }] };
const pending = { statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }] };

test("CI turning red on a babysat PR without a task starts a babysit task on the PR", async (t) => {
  const h = await setup(t);
  await h.babysitter.setBabysit(1, true);
  assert.equal(h.runner.launches(), 0, "green PR: nothing to do");
  await h.pr(failing);
  assert.equal(h.runner.started.length, 1);
  const req = h.runner.started[0];
  assert.equal(req.pr, 1);
  assert.equal(req.node, "src");
  assert.equal(req.manualReview, false);
  assert.equal(req.title, "Babysit PR #1");
  assert.match(req.prompt!, /^\/skill:techtree-babysit /);
  assert.match(req.prompt!, /#1/);
  assert.match(req.prompt!, /branch-1/);
  assert.match(req.prompt!, /CI failing/);
  assert.equal(h.poller.get(1)?.babysitStatus, "fix attempt 1/3: CI failing");
});

test("babysit does nothing for PRs it is not switched on for", async (t) => {
  const h = await setup(t);
  await h.pr(failing);
  assert.equal(h.runner.launches(), 0);
});

test("a PR whose task is pr_open resumes that task's session", async (t) => {
  const h = await setup(t);
  h.runner.tasks.set("w1", makeTask({ id: "w1", pr: 1, worktree: "/wt/w1" }));
  await h.pr();
  await h.babysitter.setBabysit(1, true);
  await h.pr({ mergeable: "CONFLICTING" });
  assert.deepEqual(h.runner.started, []);
  assert.equal(h.runner.resumed.length, 1);
  assert.equal(h.runner.resumed[0].taskId, "w1");
  assert.match(h.runner.resumed[0].prompt, /^\/skill:techtree-babysit .*merge conflict/s);
});

test("while a fix is running, new events do not launch another agent", async (t) => {
  const h = await setup(t);
  await h.babysitter.setBabysit(1, true);
  await h.pr(failing);
  await h.pr({ ...failing, reviewDecision: "CHANGES_REQUESTED" });
  assert.equal(h.runner.launches(), 1);
  assert.equal(h.poller.get(1)?.babysitStatus, "fix in progress: changes requested");
});

test("changes requested, a new review and a merge conflict are triggers", async (t) => {
  for (const [over, label] of [
    [{ reviewDecision: "CHANGES_REQUESTED" }, "changes requested"],
    [{ reviews: [{ author: { login: "alice" }, state: "COMMENTED" }] }, "new review"],
    [{ mergeable: "CONFLICTING" }, "merge conflict"],
  ] as const) {
    const h = await setup(t);
    await h.babysitter.setBabysit(1, true);
    await h.pr(over);
    assert.equal(h.runner.started.length, 1, label);
    assert.match(h.runner.started[0].prompt!, new RegExp(label));
  }
});

test("an approval or a passing CI alone is not a trigger", async (t) => {
  const h = await setup(t, pending);
  await h.babysitter.setBabysit(1, true);
  await h.pr({ reviews: [{ author: { login: "alice" }, state: "APPROVED" }] });
  await h.pr({ statusCheckRollup: [] });
  assert.equal(h.runner.launches(), 0);
});

test("switching babysit on acts on a PR that is already failing", async (t) => {
  const h = await setup(t, failing);
  const pr = await h.babysitter.setBabysit(1, true);
  assert.equal(pr.babysit, true);
  assert.equal(h.runner.started.length, 1);
  assert.equal(h.poller.get(1)?.babysitStatus, "fix attempt 1/3: CI failing");
});

test("babysit switches off when the PR is ready to merge, and never merges", async (t) => {
  const h = await setup(t, failing);
  await h.babysitter.setBabysit(1, true);
  await h.pr({ statusCheckRollup: [], reviewDecision: "APPROVED", mergeable: "MERGEABLE" });
  assert.deepEqual(h.runner.cancelled, ["b1"], "a fix still queued or running is stopped");
  assert.equal(h.poller.get(1)?.babysit, false);
  assert.equal(h.poller.get(1)?.babysitStatus, "ready to merge");
  assert.ok(!h.gh.calls().some((c) => c.startsWith("pr merge")), "no gh merge call");
});

test("after 3 failed fix attempts babysit gives up", async (t) => {
  const h = await setup(t);
  await h.babysitter.setBabysit(1, true);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await h.pr(failing);
    assert.equal(h.runner.launches(), attempt);
    h.runner.tasks.get("b1")!.state = "pr_open";
    await h.pr(pending);
  }
  assert.equal(h.runner.started.length, 1, "later attempts resume the babysit task");
  await h.pr(failing);
  assert.equal(h.runner.launches(), 3);
  assert.equal(h.poller.get(1)?.babysit, false);
  assert.equal(h.poller.get(1)?.babysitStatus, "gave up after 3 fix attempts");

  await h.babysitter.setBabysit(1, true);
  assert.equal(h.runner.launches(), 4, "switching on again resets the attempts");
});

test("observe-only: another author's PR is never pushed to or replied on, only reported", async (t) => {
  const h = await setup(t, { author: { login: "alice" } });
  h.runner.tasks.set("w1", makeTask({ id: "w1", pr: 1, worktree: "/wt/w1" }));
  await h.babysitter.setBabysit(1, true);
  await h.pr({ ...failing, mergeable: "CONFLICTING" });
  assert.equal(h.runner.launches(), 0);
  assert.equal(h.poller.get(1)?.babysitStatus, "observe-only: CI failing, merge conflict");
  assert.equal(h.poller.get(1)?.babysit, true);
});

test("observe-only while the current gh user is unknown", async (t) => {
  const h = await setup(t, failing);
  h.gh.setUser(null);
  await h.babysitter.setBabysit(1, true);
  assert.equal(h.runner.launches(), 0);
  assert.equal(h.poller.get(1)?.babysitStatus, "observe-only: CI failing");
});

test("the gh user is re-checked: after an account switch a former own PR is observe-only", async (t) => {
  const h = await setup(t);
  h.runner.tasks.set("w1", makeTask({ id: "w1", pr: 1, worktree: "/wt/w1" }));
  await h.pr();
  await h.babysitter.setBabysit(1, true);
  h.gh.setUser("another-account");
  await h.pr(failing);
  assert.equal(h.runner.launches(), 0, "poll-driven launch");
  assert.equal(h.poller.get(1)?.babysitStatus, "observe-only: CI failing");

  await h.babysitter.setBabysit(1, false);
  h.gh.setUser("me");
  await h.pr(pending);
  h.gh.setUser("another-account");
  await h.babysitter.setBabysit(1, true);
  await h.pr(failing);
  assert.equal(h.runner.launches(), 0, "toggle after the switch");
});

test("successful fixes do not use up the failed-attempt budget", async (t) => {
  const h = await setup(t);
  await h.babysitter.setBabysit(1, true);
  for (let fix = 1; fix <= 4; fix++) {
    await h.pr(failing);
    assert.equal(h.runner.launches(), fix);
    assert.equal(h.poller.get(1)?.babysitStatus, "fix attempt 1/3: CI failing");
    h.runner.tasks.get("b1")!.state = "pr_open";
    await h.pr();
  }
  assert.equal(h.poller.get(1)?.babysit, true);
});

test("a merged or closed PR stops babysitting and its running fix", async (t) => {
  const h = await setup(t, failing);
  await h.babysitter.setBabysit(1, true);
  assert.equal(h.runner.launches(), 1);
  h.gh.setList([]);
  await h.poller.poll();
  assert.equal(h.poller.get(1), undefined);
  assert.deepEqual(h.runner.cancelled, ["b1"]);
  await assert.rejects(h.babysitter.setBabysit(1, true), /unknown PR #1/);
  assert.equal(h.runner.launches(), 1);
});

test("a closed PR without babysit leaves its task alone", async (t) => {
  const h = await setup(t);
  h.runner.tasks.set("w1", makeTask({ id: "w1", pr: 1, worktree: "/wt/w1", state: "running" }));
  await h.pr();
  h.gh.setList([]);
  await h.poller.poll();
  assert.deepEqual(h.runner.cancelled, []);
});
