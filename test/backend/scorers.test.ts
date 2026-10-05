import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepoBackend } from "../../src/backend/backend.ts";
import { mergeConfig } from "../../src/config.ts";
import { getProject } from "../../src/core/projects.ts";
import { openDb, suppressSqliteWarning, type Db } from "../../src/db.ts";
import { startServer } from "../../src/server/server.ts";
import type { HttpError } from "../../src/server/backend.ts";
import { FAKE_PI, TODO_FILE, fixture, until } from "./helpers.ts";

suppressSqliteWarning();

const NODE = TODO_FILE.slice(0, TODO_FILE.lastIndexOf("/"));

async function boot(t: TestContext, { piCommand = [process.execPath, FAKE_PI], db }: { piCommand?: string[]; db?: Db } = {}) {
  const { tmp, repo, cache } = fixture(t);
  mkdirSync(cache, { recursive: true });
  return start(t, { tmp, repo, cache, db: db ?? openDb(cache), piCommand });
}

async function start(t: TestContext, { tmp, repo, cache, db, piCommand }: { tmp: string; repo: string; cache: string; db: Db; piCommand: string[] }) {
  const config = mergeConfig({ minLoc: 1, worktreeTemplate: `${tmp}/wt/{task}`, piCommand });
  const backend = new RepoBackend({ db, repoRoot: repo, cacheDir: cache, config, log: () => {} });
  const server = await startServer({ backend, staticDir: tmp, token: "tok" });
  backend.attach({ url: `http://127.0.0.1:${server.port}`, token: "tok" });
  t.after(async () => {
    await backend.close();
    await server.close();
  });
  await backend.idle();
  return { backend, tmp, repo, cache, db };
}

/** Rescore and wait for the run (and any run it queued) to finish. */
async function rescored(backend: RepoBackend) {
  await backend.rescore();
  await backend.idle();
}

test("scorers: a rubric scan puts the rubric in the prompt and stores its findings under the project", { timeout: 30_000 }, async (t) => {
  const { tmp } = fixture(t);
  const promptLog = join(tmp, "prompts.txt");
  const fakeScan = join(tmp, "fake-scan.mjs");
  writeFileSync(
    fakeScan,
    `import { appendFileSync } from "node:fs";
const prompt = process.argv.at(-1);
appendFileSync(${JSON.stringify(promptLog)}, prompt + "\\n");
const file = /=== (.+) ===/.exec(prompt)[1];
process.stdout.write(JSON.stringify([{ title: "Allocates in loop", detail: "Hoist it.", file, severity: "high", effort: "small" }]));
`,
  );
  const { backend } = await boot(t, { piCommand: [process.execPath, fakeScan] });
  const perf = await backend.createProject({ name: "Perf" });
  await backend.updateProject(perf.id, { scorer: { rubric: "allocation-heavy hot paths" } });

  await backend.scan(NODE, perf.id);
  const findings = await until(async () => {
    const found = (await backend.getNode(NODE, perf.id)).findings;
    return found.length ? found : undefined;
  }, "rubric findings");

  assert.match(readFileSync(promptLog, "utf8"), /Rubric: allocation-heavy hot paths/);
  assert.deepEqual(findings.map((f) => [f.source, f.title]), [["rubric", "Allocates in loop"]]);
  assert.ok((await backend.getState(perf.id)).scores[NODE].metrics.issues, "the issues metric scores the node");
  assert.ok((await backend.getOverview(perf.id)).coverage.scannedNodes > 0);
  assert.ok(!(await backend.getNode(NODE)).findings.some((f) => f.source === "rubric"), "Quality keeps its own findings");
});

test("scorers: command values feed the project's scores; a failing command surfaces in the overview", { timeout: 30_000 }, async (t) => {
  const { backend, tmp } = await boot(t);
  const script = join(tmp, "score.mjs");
  writeFileSync(
    script,
    `process.stdout.write(JSON.stringify({
  metrics: [{ key: "p99_ms", label: "p99", direction: "lower_better", unit: "ms" }],
  values: { "${TODO_FILE}": { p99_ms: 40 }, "src/util/mod.rs": { p99_ms: 5 }, "src/util": { p99_ms: 1 } },
  findings: [{ file: "${TODO_FILE}", title: "Slow parse", detail: "", severity: "medium" }],
}));`,
  );
  const perf = await backend.createProject({ name: "Perf" });
  await backend.updateProject(perf.id, { scorer: { command: [process.execPath, script] } });
  await rescored(backend);

  const state = await backend.getState(perf.id);
  assert.equal(state.scores[NODE].metrics.p99_ms.raw, 40);
  assert.equal(state.scores["src/util"].metrics.p99_ms.raw, 6, "a file's value counts for its directory; repeats sum by default");
  assert.equal(state.scores[""].metrics.p99_ms.raw, 46);
  assert.ok(state.scores["src/util"].quality! > state.scores[NODE].quality!, "lower latency ranks better");
  assert.equal(state.weights.p99_ms, 1);
  assert.deepEqual((await backend.getNode(NODE, perf.id)).findings.map((f) => [f.source, f.title]), [["command", "Slow parse"]]);
  assert.equal((await backend.getOverview(perf.id)).scorerErrors, undefined);

  writeFileSync(script, `process.stderr.write("bench crashed\\n"); process.exit(2);`);
  await rescored(backend);
  const { scorerErrors } = await backend.getOverview(perf.id);
  assert.equal(scorerErrors?.length, 1);
  assert.match(scorerErrors![0], /exited with 2: bench crashed/);
});

test("scorers: plan items become findings and suggestions; progress counts items whose change task finished", { timeout: 60_000 }, async (t) => {
  const booted = await boot(t);
  const { backend, db } = booted;
  const feature = await backend.createProject({ name: "Feature", goal: "add caching" });
  assert.equal((await backend.startTask({ node: "", findingIds: [], manualReview: true, kind: "plan", project: "quality" }).catch((e: HttpError) => e.status)), 400);

  const task = await backend.startTask({ node: "", findingIds: [], manualReview: true, kind: "plan", prompt: "scenario:plan", project: feature.id });
  assert.equal(task.kind, "plan");
  assert.equal(task.branch, undefined);
  assert.match(task.prompt, /techtree_report \{items/);
  await until(async () => (await backend.getState(feature.id)).tasks.find((x) => x.state === "done"), "plan task to finish");
  await backend.idle();

  assert.equal(getProject(db, feature.id)?.scorer.plan, true, "planning turns plan scoring on");
  const node = await backend.getNode(NODE, feature.id);
  assert.deepEqual(node.findings.map((f) => [f.source, f.title]), [["plan", "Cache parsed config"]]);
  assert.deepEqual(node.suggestions.map((s) => s.title), ["Cache parsed config"]);
  assert.equal(node.score.metrics.plan_items.raw, 1);
  assert.equal(node.score.metrics.progress.raw, 0);
  assert.equal((await backend.getState(feature.id)).scores["src/util"].metrics.progress, undefined, "nodes without items are unscored");

  const now = new Date().toISOString();
  const change = { id: "c1", project: feature.id, node: NODE, title: "t", prompt: "", findingIds: [node.findings[0].id], state: "pr_open", manualReview: false,
    pr: 9, plannedFrom: 0, plannedTo: 0, checklist: [], phase: "pr", createdAt: now, updatedAt: now };
  db.prepare("INSERT INTO tasks (id, node, state, data, updated_at, project) VALUES ('c1', ?, 'pr_open', ?, ?, ?)").run(NODE, JSON.stringify(change), now, feature.id);
  const { backend: restarted } = await start(t, { ...booted, piCommand: [process.execPath, FAKE_PI] });
  await rescored(restarted);
  const after = await restarted.getNode(NODE, feature.id);
  assert.equal(after.score.metrics.progress.raw, 1);
  assert.deepEqual(after.findings, [], "resolved items are no longer suggested");
});

test("scorers: a scorer task's proposal is accepted into the project's scorer", { timeout: 60_000 }, async (t) => {
  const { backend, cache } = await boot(t);
  const perf = await backend.createProject({ name: "Perf" });
  const task = await backend.startTask({ node: "", findingIds: [], manualReview: true, kind: "scorer", prompt: "scenario:scorer", project: perf.id });
  assert.equal(task.title, "Draft scorer");
  assert.ok(task.prompt.includes(join(cache, "projects", perf.id)), "the agent is told where to write scripts");

  const review = await until(async () => (await backend.getState(perf.id)).tasks.find((x) => x.state === "review"), "proposal");
  assert.deepEqual(review.proposal, { rubric: "allocation-heavy hot paths" });
  assert.equal(await backend.openPr(task.id).catch((e: HttpError) => e.status), 409, "scorer tasks open no PR");

  const done = await backend.acceptScorer(task.id);
  assert.equal(done.state, "done");
  assert.deepEqual((await backend.listProjects()).find((p) => p.id === perf.id)?.scorer, { rubric: "allocation-heavy hot paths" });
  assert.equal(await backend.acceptScorer(task.id).catch((e: HttpError) => e.status), 409);
  await backend.idle();
  assert.ok((await backend.getOverview(perf.id)).coverage.totalNodes > 0, "the rubric makes the project scannable");
});
