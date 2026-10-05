import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, suppressSqliteWarning } from "../../src/db.ts";
import { PrPoller, type PrPollerOptions } from "../../src/prs/poller.ts";
import type { PrState, ServerEvent, Task } from "../../src/types.ts";
import { DAY, T0, fakeGh, ghPr, makeTree, type FakeGh } from "./helpers.ts";

suppressSqliteWarning();

interface Harness {
  gh: FakeGh;
  poller: PrPoller;
  events: PrState[];
  clock: { now: number };
  newPoller(): PrPoller;
}

function setup(t: TestContext, opts: Partial<PrPollerOptions> = {}): Harness {
  const gh = fakeGh(t);
  const cache = mkdtempSync(join(tmpdir(), "techtree-prs-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const events: PrState[] = [];
  const clock = { now: T0 };
  const newPoller = () =>
    new PrPoller({
      db: openDb(cache),
      repoRoot: cache,
      gh: gh.gh,
      tree: () => makeTree("src/core", "docs"),
      now: () => clock.now,
      onEvent: (e: ServerEvent) => e.type === "pr" && events.push(structuredClone(e.pr)),
      ...opts,
    });
  return { gh, poller: newPoller(), events, clock, newPoller };
}

const task = (over: Partial<Task>): Task => ({
  id: "t1", node: "", title: "t", prompt: "", findingIds: [], state: "pr_open", manualReview: false, plannedFrom: 0,
  plannedTo: 0, checklist: [], phase: "pr", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", ...over,
});

test("a poll turns gh's open PRs into persisted PrStates and emits only changes", async (t) => {
  const h = setup(t, { tasks: () => [task({ id: "t9", branch: "branch-5" })] });
  h.gh.setList([
    ghPr(5, {
      files: [
        { path: "src/core/x.ts", additions: 50, deletions: 20 },
        { path: "docs/y.md", additions: 30, deletions: 0 },
      ],
      reviewDecision: null,
      reviews: [
        { author: { login: "alice" }, state: "COMMENTED" },
        { author: { login: "bob" }, state: "APPROVED" },
        { author: { login: "me" }, state: "COMMENTED" },
        { author: { login: "carol" }, state: "CHANGES_REQUESTED" },
      ],
      mergeable: "CONFLICTING",
      headRefOid: "abc",
    }),
  ]);
  await h.poller.poll();
  const expected: PrState = {
    number: 5,
    url: "https://github.com/o/r/pull/5",
    title: "PR 5",
    author: "me",
    node: "src/core",
    files: ["src/core/x.ts", "docs/y.md"],
    ci: "pass",
    review: "",
    updatedAt: new Date(T0).toISOString(),
    babysit: false,
    stale: false,
    stuck: false,
    taskId: "t9",
    mergeable: "CONFLICTING",
    branch: "branch-5",
    head: "abc",
    reviewCount: 2,
  };
  assert.deepEqual(h.poller.list(), [expected]);
  assert.equal(h.poller.status, "ok");
  assert.equal(h.poller.user, "me");
  assert.deepEqual(h.events, [expected]);
  assert.deepEqual(h.newPoller().list(), [expected], "persisted");

  await h.poller.poll();
  assert.equal(h.events.length, 1, "an unchanged PR is not re-emitted");
});

test("CI rollup: any failure fails, else anything unfinished is pending, else pass", async (t) => {
  const h = setup(t);
  const run = (status: string, conclusion = "") => ({ __typename: "CheckRun", name: "c", status, conclusion });
  const ctx = (state: string) => ({ __typename: "StatusContext", context: "s", state });
  const cases: [unknown[] | null, PrState["ci"]][] = [
    [[], "pass"],
    [null, "pass"],
    [[run("COMPLETED", "SUCCESS"), run("COMPLETED", "SKIPPED"), run("COMPLETED", "NEUTRAL"), ctx("SUCCESS")], "pass"],
    [[run("COMPLETED", "SUCCESS"), run("IN_PROGRESS")], "pending"],
    [[run("QUEUED"), run("COMPLETED", "SUCCESS")], "pending"],
    [[ctx("PENDING")], "pending"],
    [[ctx("EXPECTED")], "pending"],
    [[run("IN_PROGRESS"), run("COMPLETED", "FAILURE")], "fail"],
    [[run("COMPLETED", "CANCELLED")], "fail"],
    [[run("COMPLETED", "TIMED_OUT")], "fail"],
    [[run("COMPLETED", "ACTION_REQUIRED")], "fail"],
    [[run("COMPLETED", "STARTUP_FAILURE")], "fail"],
    [[ctx("PENDING"), ctx("ERROR")], "fail"],
    [[ctx("FAILURE")], "fail"],
  ];
  h.gh.setList(cases.map(([rollup], i) => ghPr(i + 1, { statusCheckRollup: rollup })));
  await h.poller.poll();
  assert.deepEqual(
    cases.map((_, i) => h.poller.get(i + 1)?.ci),
    cases.map(([, ci]) => ci),
  );
});

test("task PRs missing from the author list are fetched one by one; closed ones are dropped", async (t) => {
  const tasks = [
    task({ id: "a", pr: 1 }),
    task({ id: "b", pr: 2 }),
    task({ id: "c", pr: 3 }),
    task({ id: "d", pr: 4, state: "done" }),
  ];
  const h = setup(t, { tasks: () => tasks });
  h.gh.setList([ghPr(1)]);
  h.gh.setView(2, ghPr(2, { author: { login: "bot" } }));
  h.gh.setView(3, ghPr(3, { state: "MERGED" }));
  await h.poller.poll();
  assert.deepEqual(h.poller.list().map((p) => [p.number, p.taskId, p.author]), [[1, "a", "me"], [2, "b", "bot"]]);
  const calls = h.gh.calls();
  assert.equal(calls.length, 4, calls.join("\n"));
  assert.match(calls[0], /^api user/);
  assert.match(calls[1], /^pr list .*--author @me/);
  assert.deepEqual(calls.slice(2).map((c) => c.split(" ").slice(0, 3).join(" ")), ["pr view 2", "pr view 3"]);

  await h.poller.poll();
  assert.equal(h.gh.calls().filter((c) => c.startsWith("api user")).length, 1, "the user is looked up once");
});

test("merged or closed PRs leave the list and the table", async (t) => {
  const h = setup(t);
  h.gh.setList([ghPr(1), ghPr(2)]);
  await h.poller.poll();
  h.gh.setList([ghPr(2)]);
  await h.poller.poll();
  assert.deepEqual(h.poller.list().map((p) => p.number), [2]);
  assert.deepEqual(h.newPoller().list().map((p) => p.number), [2]);
});

test("stale after 3 days without update, stuck after 24h without progress", async (t) => {
  const h = setup(t);
  h.gh.setList([ghPr(1, { updatedAt: new Date(T0 - 2 * DAY).toISOString() })]);
  await h.poller.poll();
  assert.deepEqual(flags(h.poller.get(1)), { stale: false, stuck: true }, "first seen: progress dates from updatedAt");

  h.clock.now = T0 + DAY - 1;
  h.gh.setList([ghPr(1, { updatedAt: new Date(T0).toISOString(), headRefOid: "sha2" })]);
  await h.poller.poll();
  assert.deepEqual(flags(h.poller.get(1)), { stale: false, stuck: false }, "a new commit is progress");

  h.clock.now = T0 + 2 * DAY - 2;
  await h.poller.poll();
  assert.equal(h.poller.get(1)?.stuck, false);
  h.clock.now = T0 + 2 * DAY - 1;
  await h.poller.poll();
  assert.equal(h.poller.get(1)?.stuck, true, "24h after the last progress");

  h.gh.setList([ghPr(1, { updatedAt: new Date(T0).toISOString(), headRefOid: "sha2", reviewDecision: "APPROVED" })]);
  h.clock.now = T0 + 3 * DAY - 1;
  await h.poller.poll();
  assert.deepEqual(flags(h.poller.get(1)), { stale: false, stuck: false }, "a review change is progress");

  h.clock.now = T0 + 3 * DAY;
  await h.poller.poll();
  assert.equal(h.poller.get(1)?.stale, true);

  h.gh.setList([ghPr(1, { updatedAt: new Date(T0).toISOString(), headRefOid: "sha2", reviewDecision: "APPROVED", statusCheckRollup: [] , reviews: [{ author: { login: "x" }, state: "COMMENTED" }] })]);
  h.clock.now = T0 + 5 * DAY;
  await h.poller.poll();
  assert.equal(h.poller.get(1)?.stuck, false, "a new review is progress");
});

test("babysit, fix attempts and last progress survive polls and restarts", async (t) => {
  const h = setup(t);
  h.gh.setList([ghPr(1)]);
  await h.poller.poll();
  h.poller.update(1, { babysit: true, babysitStatus: "watching" }, 2);
  h.gh.setList([ghPr(1, { title: "renamed" })]);
  await h.poller.poll();
  const reopened = h.newPoller();
  assert.equal(reopened.get(1)?.babysit, true);
  assert.equal(reopened.get(1)?.babysitStatus, "watching");
  assert.equal(reopened.get(1)?.title, "renamed");
  assert.equal(reopened.fixAttempts(1), 2);
  h.clock.now = T0 + DAY;
  await reopened.poll();
  assert.equal(reopened.get(1)?.stuck, true, "last progress kept across restarts");
});

test("gh failures never throw: status explains, PRs are kept, polling backs off", async (t) => {
  const h = setup(t, { intervalMs: 1000, maxBackoffMs: 5000 });
  h.gh.setList([ghPr(1)]);
  await h.poller.poll();
  assert.equal(h.poller.delayMs, 1000);

  h.gh.setFail("gh auth login required\nmore detail\n");
  await h.poller.poll();
  assert.equal(h.poller.status, "gh failed: gh auth login required");
  assert.deepEqual(h.poller.list().map((p) => p.number), [1]);
  assert.equal(h.poller.delayMs, 2000);
  await h.poller.poll();
  assert.equal(h.poller.delayMs, 4000);
  await h.poller.poll();
  assert.equal(h.poller.delayMs, 5000);

  h.gh.setFail(null);
  h.gh.setList([ghPr(1), ghPr(2)]);
  await h.poller.poll();
  assert.equal(h.poller.status, "ok");
  assert.equal(h.poller.delayMs, 1000);
  assert.equal(h.poller.list().length, 2);
});

test("a missing gh binary or malformed output is a status, not a crash", async (t) => {
  const missing = setup(t, { gh: ["/nonexistent/gh"] }).poller;
  await missing.poll();
  assert.match(missing.status, /^gh failed: /);

  const h = setup(t);
  h.gh.setList("not json" as never);
  await h.poller.poll();
  assert.match(h.poller.status, /^gh failed: /);
});

test("overlapping polls share one gh run", async (t) => {
  const h = setup(t);
  h.gh.setList([ghPr(1)]);
  await Promise.all([h.poller.poll(), h.poller.poll(), h.poller.poll()]);
  assert.equal(h.gh.calls().filter((c) => c.startsWith("pr list")).length, 1);
});

test("start polls at once and keeps polling until stopped", async (t) => {
  const h = setup(t, { intervalMs: 20 });
  h.gh.setList([ghPr(1)]);
  h.poller.start();
  t.after(() => h.poller.stop());
  while (h.gh.calls().filter((c) => c.startsWith("pr list")).length < 2) await new Promise((r) => setTimeout(r, 10));
  h.poller.stop();
  await h.poller.poll();
  const count = h.gh.calls().length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.gh.calls().length, count, "no polls after stop");
});

function flags(pr: PrState | undefined) {
  return { stale: pr?.stale, stuck: pr?.stuck };
}
