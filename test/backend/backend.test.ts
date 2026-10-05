import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepoBackend } from "../../src/backend/backend.ts";
import { mergeConfig } from "../../src/config.ts";
import { openDb, suppressSqliteWarning } from "../../src/db.ts";
import { HttpError } from "../../src/server/backend.ts";
import { startServer } from "../../src/server/server.ts";
import type { ServerEvent, Task } from "../../src/types.ts";
import { FAKE_PI, TODO_FILE, fixture, until } from "./helpers.ts";

suppressSqliteWarning();

async function boot(t: TestContext, repo: string, cache: string, tmp: string, piCommand = [process.execPath, FAKE_PI]) {
  mkdirSync(cache, { recursive: true });
  const config = mergeConfig({ minLoc: 1, worktreeTemplate: `${tmp}/wt/{task}`, piCommand });
  const backend = new RepoBackend({ db: openDb(cache), repoRoot: repo, cacheDir: cache, config, log: () => {} });
  const events: ServerEvent[] = [];
  backend.subscribe((e) => events.push(e));
  const server = await startServer({ backend, staticDir: tmp, token: "tok" });
  backend.attach({ url: `http://127.0.0.1:${server.port}`, token: "tok" });
  const shutdown = async () => {
    backend.close();
    await server.close();
  };
  t.after(shutdown);
  await backend.idle();
  return { backend, events, shutdown };
}

const status = (err: unknown) => (err as HttpError).status;

test("scores on start, runs a task through review with a diff, and survives a restart", async (t) => {
  const { tmp, repo, cache } = fixture(t);
  const first = await boot(t, repo, cache, tmp);
  assert.ok(first.events.some((e) => e.type === "scores"), "initial scoring emits a scores event");

  const state = await first.backend.getState();
  assert.ok(state.snapshot);
  const node = TODO_FILE.slice(0, TODO_FILE.lastIndexOf("/"));
  assert.equal(state.findingCounts[node], 1);

  const detail = await first.backend.getNode(node);
  const [finding] = detail.findings;
  assert.equal(finding.file, TODO_FILE);
  assert.ok(detail.history.length >= 1);
  assert.deepEqual(detail.suggestions[0].findingIds, [finding.id]);
  assert.deepEqual(detail.ownCtas.map((c) => c.kind), ["suggestion"]);
  assert.ok((await first.backend.getNode("")).childCtas.some((c) => c.node === node));

  const started = await first.backend.startTask({
    node,
    findingIds: [finding.id],
    prompt: "Fix the TODOs. scenario:happy",
    manualReview: true,
  });
  assert.equal(started.title, finding.title);
  assert.equal(started.plannedFrom, state.scores[node].quality ?? 0);
  assert.ok(finding.impact.node > 0);
  assert.equal(started.plannedTo, started.plannedFrom + finding.impact.node);

  const reviewed = await until(
    () => first.events.findLast((e): e is { type: "task"; task: Task } => e.type === "task" && e.task.state === "review")?.task,
    "task in review",
  );
  assert.deepEqual(reviewed.checklist.map((c) => c.done), [true, true]);
  assert.match(await first.backend.taskDiff(started.id), /change-\d+\.txt/);
  assert.match(await first.backend.taskLog(started.id, 1), /state: review/);
  assert.deepEqual((await first.backend.getOverview()).attentionTasks.map((t) => t.id), [started.id]);

  await first.shutdown();
  const second = await boot(t, repo, cache, tmp);
  assert.ok(!second.events.some((e) => e.type === "scores"), "an unchanged HEAD is not rescored on restart");
  const restored = await second.backend.getState();
  assert.deepEqual(restored.snapshot, state.snapshot);
  assert.equal(restored.tasks.find((t) => t.id === started.id)?.state, "review");
  assert.match(await second.backend.taskDiff(started.id), /change-\d+\.txt/);
});

test("maps unknown ids and wrong task states to HTTP errors", async (t) => {
  const { tmp, repo, cache } = fixture(t);
  const { backend } = await boot(t, repo, cache, tmp);
  assert.equal(status(await backend.getNode("nope").catch((e) => e)), 404);
  assert.equal(status(await backend.cancel("nope").catch((e) => e)), 404);
  assert.equal(status(await backend.taskLog("nope", 5).catch((e) => e)), 404);
  assert.equal(status(await backend.startTask({ node: "", findingIds: ["nope"], manualReview: true }).catch((e) => e)), 400);
  assert.equal(status(await backend.setBabysit(1, true).catch((e) => e)), 404);
  assert.equal(status(await backend.scan("nope").catch((e) => e)), 404);

  const task = await backend.startTask({ node: "", findingIds: [], prompt: "scenario:hang", manualReview: true });
  await backend.cancel(task.id);
  assert.equal(status(await backend.answer(task.id, "hi").catch((e) => e)), 409);
  assert.equal(status(await backend.openPr(task.id).catch((e) => e)), 409);
});

test("rescore requests during a run queue exactly one more run", async (t) => {
  const { tmp, repo, cache } = fixture(t);
  const { backend, events } = await boot(t, repo, cache, tmp);
  const before = events.filter((e) => e.type === "scores").length;
  await backend.rescore();
  await backend.rescore();
  await backend.rescore();
  await backend.idle();
  assert.equal(events.filter((e) => e.type === "scores").length - before, 2);
});

test("files changed in a running task's worktree make overlapping suggestions conflict", async (t) => {
  const { tmp, repo, cache } = fixture(t);
  const { backend } = await boot(t, repo, cache, tmp);
  const node = TODO_FILE.slice(0, TODO_FILE.lastIndexOf("/"));
  const [before] = (await backend.getNode(node)).suggestions;
  assert.equal(before.conflict, 0);
  const task = await backend.startTask({ node, findingIds: [], prompt: "scenario:hang", manualReview: true });
  const running = await until(() => backend.getState().then((s) => s.tasks.find((x) => x.id === task.id && x.worktree && x.state === "running")), "running task");
  execFileSync("sh", ["-c", `echo changed >> ${TODO_FILE}`], { cwd: running.worktree });
  const [after] = (await backend.getNode(node)).suggestions;
  assert.equal(after.conflict, 1);
  await backend.cancel(task.id);
});

test("scan emits running and done events, then rescores", async (t) => {
  const { tmp, repo, cache } = fixture(t);
  const fakeScanner = join(tmp, "fake-scan.mjs");
  writeFileSync(fakeScanner, 'console.log("[]");\n');
  const { backend, events } = await boot(t, repo, cache, tmp, [process.execPath, fakeScanner]);
  const scoresBefore = events.filter((e) => e.type === "scores").length;
  await backend.scan("src/util");
  assert.equal(status(await backend.scan("src/util").catch((e) => e)), 409);
  await until(() => events.some((e) => e.type === "scan" && e.status === "done"), "scan done");
  await until(() => events.filter((e) => e.type === "scores").length > scoresBefore, "rescore after scan");
  const scanEvents = events.flatMap((e) => (e.type === "scan" ? [[e.node, e.status, e.message]] : []));
  assert.deepEqual(scanEvents, [
    ["src/util", "running", undefined],
    ["src/util", "running", "1/1 batches"],
    ["src/util", "done", "0 findings in 1 batches"],
  ]);
  assert.equal((await backend.getOverview()).coverage.scannedNodes, 1);
});
