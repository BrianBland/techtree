import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { RepoBackend } from "../../src/backend/backend.ts";
import { mergeConfig } from "../../src/config.ts";
import { createProject } from "../../src/core/projects.ts";
import { dbCache, openDb, suppressSqliteWarning } from "../../src/db.ts";
import type { HttpError } from "../../src/server/backend.ts";
import { startServer } from "../../src/server/server.ts";
import { FAKE_PI, TODO_FILE, fixture, until } from "./helpers.ts";

suppressSqliteWarning();

const NODE = TODO_FILE.slice(0, TODO_FILE.lastIndexOf("/"));

async function boot(t: TestContext) {
  const { tmp, repo, cache } = fixture(t);
  mkdirSync(cache, { recursive: true });
  const config = mergeConfig({ minLoc: 1, worktreeTemplate: `${tmp}/wt/{task}`, piCommand: [process.execPath, FAKE_PI] });
  const backend = new RepoBackend({ db: openDb(cache), repoRoot: repo, cacheDir: cache, config, log: () => {} });
  const server = await startServer({ backend, staticDir: tmp, token: "tok" });
  backend.attach({ url: `http://127.0.0.1:${server.port}`, token: "tok" });
  t.after(async () => {
    await backend.close();
    await server.close();
  });
  await backend.idle();
  return backend;
}

const status = (promise: Promise<unknown>) =>
  promise.then(
    () => 200,
    (err: HttpError) => err.status,
  );

test("projects: Quality is built in; custom projects are created, renamed and deleted", { timeout: 30_000 }, async (t) => {
  const backend = await boot(t);
  assert.deepEqual((await backend.listProjects()).map((p) => [p.id, p.name, p.builtin]), [["quality", "Quality", true]]);

  const perf = await backend.createProject({ name: "Faster startup", goal: "cold start below 1 s" });
  assert.deepEqual([perf.id, perf.goal, perf.scorer], ["faster-startup", "cold start below 1 s", {}]);
  assert.equal((await backend.createProject({ name: "Faster startup" })).id, "faster-startup-2");
  assert.equal((await backend.createProject({ name: "All" })).id, "all-2", "`all` is reserved for the cross-project overview");
  assert.equal(await status(backend.createProject({ name: "  " })), 400);

  const renamed = await backend.updateProject(perf.id, { name: "Startup", goal: "" });
  assert.deepEqual([renamed.name, renamed.goal], ["Startup", undefined]);

  assert.equal(await status(backend.deleteProject("quality")), 409);
  assert.equal(await status(backend.deleteProject("nope")), 404);
  await backend.deleteProject(perf.id);
  assert.deepEqual((await backend.listProjects()).map((p) => p.id), ["quality", "faster-startup-2", "all-2"]);
  assert.equal(await status(backend.getState(perf.id)), 404);
});

test("projects: tasks, findings and scores are scoped to their project; the tree is shared", { timeout: 30_000 }, async (t) => {
  const backend = await boot(t);
  const perf = await backend.createProject({ name: "Perf", goal: "halve p99 latency" });

  const quality = await backend.getState();
  const state = await backend.getState(perf.id);
  assert.equal(state.project.id, perf.id);
  assert.deepEqual(Object.keys(state.tree.nodes), Object.keys(quality.tree.nodes));
  assert.equal(state.scores[NODE].metrics.loc.raw, quality.scores[NODE].metrics.loc.raw, "tiles keep their size");
  assert.equal(state.scores[NODE].quality, null, "no scorer: neutral tiles");
  assert.deepEqual(Object.keys(state.findingCounts), []);
  assert.deepEqual((await backend.getNode(NODE, perf.id)).findings, []);
  assert.equal((await backend.getNode(NODE)).findings.length, 1);
  assert.equal(await status(backend.scan(NODE, perf.id)), 400);

  const task = await backend.startTask({ node: NODE, findingIds: [], prompt: "Profile it. scenario:ask", manualReview: true, project: perf.id });
  assert.equal(task.project, perf.id);
  assert.match(task.prompt, /^Project: Perf\nGoal: halve p99 latency\n\nProfile it/);
  assert.deepEqual((await backend.getState(perf.id)).tasks.map((x) => x.id), [task.id]);
  assert.deepEqual((await backend.getState()).tasks, []);
  assert.deepEqual((await backend.getNode(NODE)).tasks, []);

  await until(async () => (await backend.getState(perf.id)).tasks.find((x) => x.state === "needs_input"), "task to ask");
  assert.deepEqual((await backend.getOverview()).attentionTasks, []);
  assert.deepEqual((await backend.getOverview(perf.id)).attentionTasks.map((x) => x.id), [task.id]);
  assert.equal(await status(backend.deleteProject(perf.id)), 409, "a project with a live task is kept");
});

test("projects: overviews list a project's queued and running tasks under activeTasks", { timeout: 30_000 }, async (t) => {
  const backend = await boot(t);
  const perf = await backend.createProject({ name: "Perf" });
  const task = await backend.startTask({ node: "", findingIds: [], prompt: "scenario:hang", manualReview: true, project: perf.id });
  await until(async () => (await backend.getState(perf.id)).tasks.find((x) => x.state === "running"), "task to run");
  assert.deepEqual((await backend.getOverview(perf.id)).activeTasks.map((x) => x.id), [task.id]);
  assert.deepEqual((await backend.getOverview("all")).activeTasks.map((x) => x.id), [task.id]);
  assert.deepEqual((await backend.getOverview()).activeTasks, []);
});

test("projects: a started suggestion is no longer offered until its task is discarded", { timeout: 30_000 }, async (t) => {
  const backend = await boot(t);
  const [first] = (await backend.getOverview()).suggestions;
  assert.ok(first, "the fixture has a suggestion");
  const offered = async () => (await backend.getOverview()).suggestions.some((s) => s.findingIds.join() === first.findingIds.join());
  const task = await backend.startTask({ node: first.node, findingIds: first.findingIds, prompt: "scenario:hang", manualReview: true });
  assert.equal(await offered(), false);
  await until(async () => (await backend.getState()).tasks.find((x) => x.worktree), "task worktree");
  await backend.discard(task.id);
  assert.equal(await offered(), true);
});

test("projects: the cross-project overview lists every project's attention items first, then labelled suggestions", { timeout: 30_000 }, async (t) => {
  const backend = await boot(t);
  const perf = await backend.createProject({ name: "Perf" });
  const ask = (project?: string) =>
    backend.startTask({ node: NODE, findingIds: [], prompt: "Go. scenario:ask", manualReview: true, ...(project && { project }) });
  const ids = [(await ask()).id, (await ask(perf.id)).id];
  await until(async () => {
    const { attentionTasks } = await backend.getOverview("all");
    return attentionTasks.length === 2;
  }, "both tasks to ask");

  const all = await backend.getOverview("all");
  assert.deepEqual(all.attentionTasks.map((x) => [x.id, x.project]), [[ids[0], "quality"], [ids[1], perf.id]]);
  assert.ok(all.suggestions.length > 0);
  assert.ok(all.suggestions.every((s) => s.project === "quality"), "only Quality has a scorer, so only it suggests");
});

test("projects: a task whose PR was merged or closed no longer blocks deleting its project", { timeout: 30_000 }, async (t) => {
  const { tmp, repo, cache } = fixture(t);
  mkdirSync(cache, { recursive: true });
  const db = openDb(cache);
  const perf = createProject(db, "Perf");
  const now = new Date().toISOString();
  const task = { id: "t1", project: perf.id, node: "", title: "t", prompt: "", findingIds: [], state: "pr_open", manualReview: false, pr: 7,
    plannedFrom: 0, plannedTo: 0, checklist: [], phase: "pr", createdAt: now, updatedAt: now };
  db.prepare("INSERT INTO tasks (id, node, state, data, updated_at, project) VALUES ('t1', '', 'pr_open', ?, ?, ?)").run(JSON.stringify(task), now, perf.id);
  const config = mergeConfig({ minLoc: 1, worktreeTemplate: `${tmp}/wt/{task}`, piCommand: [process.execPath, FAKE_PI] });
  const backend = new RepoBackend({ db, repoRoot: repo, cacheDir: cache, config, log: () => {} });
  backend.attach({ url: "http://127.0.0.1:9", token: "tok" });
  t.after(() => backend.close());
  await backend.idle();

  assert.equal(await status(backend.deleteProject(perf.id)), 409, "its PR may still be open");
  dbCache(db).set("pr-retired", "7", true);
  await backend.deleteProject(perf.id);
  assert.deepEqual((await backend.listProjects()).map((p) => p.id), ["quality"]);
  assert.deepEqual((await backend.getState()).tasks, []);
});
