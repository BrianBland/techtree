import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepoBackend } from "../../src/backend/backend.ts";
import { mergeConfig } from "../../src/config.ts";
import { dbCache, openDb, suppressSqliteWarning } from "../../src/db.ts";
import type { HttpError } from "../../src/server/backend.ts";
import { startServer } from "../../src/server/server.ts";
import type { Task } from "../../src/types.ts";
import { FAKE_PI, TODO_FILE, fixture, until, withEnv } from "./helpers.ts";

suppressSqliteWarning();

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A backend on a fixture repo with a bare `origin` remote and a fake `gh` that records its arguments. */
async function boot(t: TestContext) {
  const { tmp, repo, cache } = fixture(t);
  const origin = join(tmp, "origin.git");
  git(tmp, "clone", "-q", "--bare", repo, origin);
  git(repo, "remote", "add", "origin", origin);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const ghLog = join(tmp, "gh-args.json");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(ghLog)}, JSON.stringify(process.argv.slice(2)));\n` +
      `if (process.argv[2] === "pr" && process.argv[3] === "create") { while(require("fs").existsSync(${JSON.stringify(join(tmp, "hold-create"))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); if(require("fs").existsSync(${JSON.stringify(join(tmp, "fail-create"))})) { console.error("injected GitHub failure; inspect the pushed branch before retrying"); process.exit(1); } }\n` +
      `if (process.argv[2] === "pr" && process.argv[3] === "create") console.log("https://github.com/o/r/pull/77");\n` +
      `if (process.argv[2] === "pr" && process.argv[3] === "view") { try { console.log(require("fs").readFileSync(${JSON.stringify(join(tmp, "pr-state"))}, "utf8")); } catch { process.exit(1); } }\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  mkdirSync(cache, { recursive: true });
  const config = mergeConfig({ minLoc: 1, worktreeTemplate: `${tmp}/wt/{task}`, piCommand: [process.execPath, FAKE_PI] });
  const backend = new RepoBackend({ db: openDb(cache), repoRoot: repo, cacheDir: cache, config, log: () => {} });
  const server = await startServer({ backend, staticDir: tmp, token: "tok" });
  backend.attach({ url: `http://127.0.0.1:${server.port}`, token: "tok" });
  t.after(async () => {
    await backend.close();
    await server.close();
    process.env.PATH = path;
  });
  await backend.idle();
  const reviewed = async (prompt: string): Promise<Task> => {
    const task = await backend.startTask({ node: "", findingIds: [], prompt, manualReview: true });
    return until(async () => (await backend.getState()).tasks.find((x) => x.id === task.id && x.state === "review"), `${task.id} in review`);
  };
  return { backend, repo, origin, ghLog, reviewed, tmp, cache, url: `http://127.0.0.1:${server.port}` };
}

const status = (err: unknown) => (err as HttpError).status;

test("stage and unstage move a review task to staged and back; other states are refused", { timeout: 30_000 }, async (t) => {
  const { backend, reviewed } = await boot(t);
  const task = await reviewed("one scenario:happy");
  await assert.rejects(backend.unstage(task.id), (e) => status(e) === 409);
  assert.equal((await backend.stage(task.id)).state, "staged");
  assert.deepEqual((await backend.getOverview()).stagedTasks.map((x) => x.id), [task.id]);
  assert.deepEqual((await backend.getOverview()).attentionTasks, []);
  await assert.rejects(backend.stage(task.id), (e) => status(e) === 409);
  assert.equal((await backend.unstage(task.id)).state, "review");
});

test("a combined PR, titled by the title model, cherry-picks the staged tasks' commits onto one pushed branch and records the bundle", { timeout: 30_000 }, async (t) => {
  const { backend, origin, ghLog, reviewed } = await boot(t);
  const a = await reviewed("first scenario:happy");
  const b = await reviewed("second scenario:happy");
  await backend.stage(a.id);
  await backend.stage(b.id);

  const bundle = await backend.createBundle({ taskIds: [a.id, b.id] }); // untitled: the title model names it
  assert.equal(bundle.pr, 77);
  assert.equal(bundle.branch, `techtree/bundle-${bundle.id}`);
  assert.deepEqual(bundle.taskIds, [a.id, b.id]);
  assert.equal(git(origin, "log", "--format=%s", `main..${bundle.branch}`).trim().split("\n").length, 2);

  const args: string[] = JSON.parse(readFileSync(ghLog, "utf8"));
  assert.deepEqual(args.slice(0, 2), ["pr", "create"]);
  assert.equal(args[args.indexOf("--title") + 1], "feat: fake combined title");
  const body = args[args.indexOf("--body") + 1];
  assert.ok(body.includes(a.title) && body.includes(b.title));
  assert.match(body, /^## Summary\n/);
  assert.ok(!/Combined techtree changes|no findings|techtree change/.test(body), body);
  assert.ok(body.includes("Consolidate the selected changes."), "model summary, not a raw task/commit inventory");

  const tasks = (await backend.getState()).tasks;
  for (const id of [a.id, b.id]) {
    const task = tasks.find((x) => x.id === id)!;
    assert.equal(task.state, "pr_open");
    assert.equal(task.pr, 77);
    assert.equal(task.bundle, bundle.id);
  }
  assert.deepEqual((await backend.listBundles()).map((x) => x.id), [bundle.id]);
});

test("invalid metadata uses clean change bullets while preserving an explicit title and trailing repository template", { timeout: 30_000 }, async (t) => {
  const { backend, repo, reviewed, ghLog, tmp, origin } = await boot(t);
  mkdirSync(join(repo, ".github"));
  const template = "## Testing\n\n- [ ] Run focused checks\n\nTrailing: metadata";
  writeFileSync(join(repo, ".github/pull_request_template.md"), template);
  git(repo, "add", ".github"); git(repo, "commit", "-qm", "Add PR template"); git(repo, "push", "-q", "origin", "main");
  const file = join(tmp, "metadata"); writeFileSync(file, "invalid model response"); withEnv(t, "FAKE_PR_COPY", file);
  const a = await reviewed("first scenario:happy"); const b = await reviewed("second scenario:happy");
  await backend.stage(a.id); await backend.stage(b.id);
  const bundle = await backend.createBundle({ taskIds: [a.id,b.id], title: "refactor: consolidate validation cases" });
  assert.equal(bundle.title, "refactor: consolidate validation cases");
  const args: string[] = JSON.parse(readFileSync(ghLog, "utf8"));
  const body = args[args.indexOf("--body") + 1];
  assert.ok(body.startsWith("## Summary\n\n- "));
  assert.ok(body.includes(a.title) && body.includes(b.title));
  assert.ok(!/Combined techtree changes|no findings|techtree change|\(\+\d+ more\)/.test(body), body);
  assert.ok(body.endsWith(template), body);
  assert.equal(git(origin, "rev-parse", bundle.branch).trim(), git(bundle.worktree, "rev-parse", "HEAD").trim());
});

test("source drift during metadata generation is rejected before push", { timeout: 30_000 }, async (t) => {
  const { backend, reviewed, tmp, repo, origin } = await boot(t);
  const file = join(tmp, "metadata"); withEnv(t, "FAKE_PR_COPY", file);
  writeFileSync(`${file}.hold`, "hold");
  const task = await reviewed("scenario:happy"); await backend.stage(task.id);
  const opening = backend.createBundle({ taskIds: [task.id] }).then(() => "unexpected success", (error: Error) => error.message);
  try {
    await until(() => existsSync(`${file}.log`), "model metadata wait");
    writeFileSync(join(task.worktree!, "late.txt"), "late source change");
    git(task.worktree!, "add", "late.txt"); git(task.worktree!, "commit", "-qm", "Late source change");
    rmSync(`${file}.hold`);
    assert.match(await opening, /stale/);
    assert.equal((await backend.getState()).tasks[0].state, "staged");
    assert.equal(git(origin, "branch", "--list", "techtree/bundle-*").trim(), "");
    assert.equal(git(repo, "branch", "--list", "techtree/bundle-*").trim(), "");
  } finally { rmSync(`${file}.hold`, { force: true }); await opening; }
});

test("a combined PR conflict aborts cleanly and automatically unstages only the conflicting task", { timeout: 30_000 }, async (t) => {
  const { backend, repo, reviewed } = await boot(t);
  const a = await reviewed("version A scenario:readme");
  const b = await reviewed("version B scenario:readme");
  await backend.stage(a.id);
  await backend.stage(b.id);

  await assert.rejects(backend.createBundle({ taskIds: [a.id, b.id] }), (e) => status(e) === 409 && (e as Error).message.includes(b.id));
  assert.deepEqual((await backend.getState()).tasks.map((x) => x.state), ["staged", "review"]);
  const unstaged = (await backend.getState()).tasks.find((x) => x.id === b.id)!;
  assert.match(unstaged.error!, /automatically unstaged/i);
  assert.equal(unstaged.stagedAt, undefined);
  assert.equal(unstaged.branch, b.branch);
  assert.equal(git(repo, "rev-parse", b.branch!).trim(), git(b.worktree!, "rev-parse", "HEAD").trim());
  assert.deepEqual(await backend.listBundles(), []);
  assert.equal(git(repo, "branch", "--list", "techtree/bundle-*").trim(), "");
});

test("dismissed findings drop out of findings and suggestions, survive a rescan, and can be undone", { timeout: 30_000 }, async (t) => {
  const { backend } = await boot(t);
  const node = TODO_FILE.slice(0, TODO_FILE.lastIndexOf("/"));
  const [finding] = (await backend.getNode(node)).findings;

  await backend.dismiss([finding.id], "false positive");
  await backend.rescore();
  await backend.idle();
  const detail = await backend.getNode(node);
  assert.deepEqual(detail.findings, []);
  assert.deepEqual(detail.suggestions, []);
  assert.deepEqual(detail.dismissed.map((f) => [f.id, f.reason]), [[finding.id, "false positive"]]);
  assert.equal((await backend.getState()).findingCounts[node], undefined);
  assert.ok(!(await backend.getOverview()).suggestions.some((s) => s.findingIds.includes(finding.id)));

  await backend.undismiss([finding.id]);
  assert.deepEqual((await backend.getNode(node)).findings.map((f) => f.id), [finding.id]);
});

test("a retired bundle PR settles its tasks on a later poll, even after a failed state lookup", { timeout: 30_000 }, async (t) => {
  const { backend, reviewed, tmp, cache } = await boot(t);
  const a = await reviewed("first scenario:happy");
  await backend.stage(a.id);
  const bundle = await backend.createBundle({ taskIds: [a.id] });
  await backend.reconcileBundles();
  assert.equal((await backend.getState()).tasks[0].state, "pr_open", "an open bundle PR is left alone");

  dbCache(openDb(cache)).set("pr-retired", String(bundle.pr), true);
  await backend.reconcileBundles();
  assert.equal((await backend.getState()).tasks[0].state, "pr_open", "a failed gh lookup is retried later");

  writeFileSync(join(tmp, "pr-state"), JSON.stringify({ state: "MERGED", baseRefName: "main" }));
  await backend.reconcileBundles();
  assert.equal((await backend.getState()).tasks[0].state, "done");
});

test("background combined PR acceptance reserves and removes checked tasks immediately, permits disjoint jobs and persists outcomes", { timeout: 60_000 }, async (t) => {
  const { backend, reviewed, tmp, ghLog, cache, url } = await boot(t);
  const a = await reviewed("first scenario:happy");
  const b = await reviewed("second scenario:happy");
  const c = await reviewed("third scenario:happy");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  for (const task of [a,b,c]) await backend.stage(task.id);
  t.mock.timers.reset();
  const hold = join(tmp, "hold-create");
  writeFileSync(hold, "hold");
  try {
    const response = await fetch(`${url}/api/bundles/start`, { method: "POST", headers: { Authorization: "Bearer tok", "Content-Type": "application/json" }, body: JSON.stringify({ taskIds: [b.id,a.id], title: "First batch" }) });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.bundleJobs.length, 1);
    const first = accepted.bundleJobs[0];
    assert.deepEqual(first.taskIds, [a.id,b.id], "staging order pinned at acceptance");
    assert.deepEqual((await backend.getOverview()).stagedTasks.map((task) => task.id), [c.id]);
    await until(() => existsSync(ghLog), "publication held at GitHub");
    await assert.rejects(backend.startBundle({ taskIds: [a.id] }), (e) => status(e) === 409);
    await assert.rejects(backend.unstage(a.id), (e) => status(e) === 409);
    await assert.rejects(backend.discard(a.id), (e) => status(e) === 409);
    const second = await backend.startBundle({ taskIds: [c.id], title: "Second batch" });
    assert.equal(second.bundleJobs!.length, 2);
    assert.deepEqual((await backend.getOverview()).stagedTasks, []);
    assert.ok(second.bundleJobs!.some((job) => job.status === "queued"), "second publication waits on shared gate without blocking the UI");
    rmSync(hold);
    await until(async () => (await backend.getComposition()).bundleJobs!.every((job) => job.status === "opened"), "background outcomes");
    const jobs = (await backend.getComposition()).bundleJobs!;
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((job) => job.bundle?.url.endsWith("/77") && job.revision > first.revision));
    assert.deepEqual((await backend.getState()).tasks.map((task) => task.state), ["pr_open","pr_open","pr_open"]);
    assert.equal(dbCache(openDb(cache)).get<any[]>("bundle-jobs", "quality")!.filter((job) => job.status === "opened").length, 2);
  } finally { rmSync(hold, { force: true }); }
});

test("background failure restores staged tasks, while an unresolved conflict returns only its culprit to review", { timeout: 60_000 }, async (t) => {
  const { backend, reviewed, tmp } = await boot(t);
  const a = await reviewed("ordinary scenario:happy");
  await backend.stage(a.id);
  const fail = join(tmp, "fail-create");
  writeFileSync(fail, "fail");
  await backend.startBundle({ taskIds: [a.id], title: "Fails remotely" });
  await until(async () => (await backend.getComposition()).bundleJobs!.some((job) => job.status === "failed"), "background GitHub failure");
  const failed = (await backend.getComposition()).bundleJobs!.find((job) => job.status === "failed")!;
  assert.match(failed.error!, /injected GitHub failure/);
  assert.deepEqual((await backend.getOverview()).stagedTasks.map((task) => task.id), [a.id]);
  rmSync(fail);
  const b = await reviewed("version A scenario:readme");
  const c = await reviewed("version B scenario:readme");
  await backend.stage(b.id);
  await backend.stage(c.id);
  await backend.startBundle({ taskIds: [b.id,c.id], title: "Conflicting changes" });
  await until(async () => (await backend.getComposition()).bundleJobs!.filter((job) => job.status === "failed").length === 2, "background conflict outcome");
  const conflict = (await backend.getComposition()).bundleJobs!.find((job) => job.taskIds.includes(c.id))!;
  assert.match(conflict.error!, /no valid conflictChecks.*automatically unstaged/s);
  assert.deepEqual((await backend.getState()).tasks.map((task) => task.state), ["staged","staged","review"]);
  assert.deepEqual((await backend.getOverview()).stagedTasks.map((task) => task.id), [a.id,b.id]);
});

test("queued background publications recheck source heads and stop without remote writes on shutdown", { timeout: 60_000 }, async (t) => {
  const { backend, reviewed, tmp, origin, repo } = await boot(t);
  const tasks: Task[] = [];
  for (const prompt of ["first", "stale", "shutdown"]) {
    const task = await reviewed(`${prompt} scenario:happy`); await backend.stage(task.id); tasks.push(task);
  }
  const hold = join(tmp, "hold-create"); writeFileSync(hold, "hold");
  try {
    await backend.startBundle({ taskIds: [tasks[0].id], title: "Gate holder" });
    await until(() => git(origin, "branch", "--list", "techtree/bundle-*").trim(), "first push held at create");
    await backend.startBundle({ taskIds: [tasks[1].id], title: "Queued stale source" });
    writeFileSync(join(tasks[1].worktree!, "late.txt"), "new source content");
    git(tasks[1].worktree!, "add", "late.txt"); git(tasks[1].worktree!, "commit", "-qm", "late source change");
    rmSync(hold);
    await until(async () => (await backend.getComposition()).bundleJobs!.find((job) => job.taskIds.includes(tasks[1].id) && job.status === "failed"), "stale queued source rejected");
    assert.match((await backend.getComposition()).bundleJobs!.find((job) => job.taskIds.includes(tasks[1].id))!.error!, /stale/);
    assert.equal(git(origin, "branch", "--list", "techtree/bundle-*").trim().split("\n").length, 1);
    writeFileSync(hold, "hold");
    await backend.startBundle({ taskIds: [tasks[1].id], title: "Second gate holder" });
    await until(() => git(origin, "branch", "--list", "techtree/bundle-*").trim().split("\n").length === 2, "second push held");
    await backend.startBundle({ taskIds: [tasks[2].id], title: "Queued shutdown" });
    const closing = backend.close(); rmSync(hold); await closing;
    const jobs = (await backend.getComposition()).bundleJobs!;
    assert.match(jobs.find((job) => job.taskIds.includes(tasks[2].id))!.error!, /stopped/);
    assert.equal((await backend.getState()).tasks.find((task) => task.id === tasks[2].id)!.state, "staged");
    assert.equal(git(origin, "branch", "--list", "techtree/bundle-*").trim().split("\n").length, 2);
    assert.equal(git(repo, "branch", "--list", "techtree/bundle-*").trim().split("\n").length, 2);
  } finally { rmSync(hold, { force: true }); }
});

test("publication persistence failures reject acceptance or report a terminal outcome without losing staged tasks", { timeout: 60_000 }, async (t) => {
  const { backend, reviewed, tmp, origin, cache } = await boot(t);
  const task = await reviewed("scenario:happy"); await backend.stage(task.id);
  const db = openDb(cache); t.after(() => db.close());
  db.exec("CREATE TRIGGER reject_jobs BEFORE INSERT ON cache WHEN NEW.kind = 'bundle-jobs' BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END");
  await assert.rejects(backend.startBundle({ taskIds: [task.id] }), /injected persistence failure/);
  assert.equal((await backend.getComposition()).bundleJobs!.length, 0);
  assert.deepEqual((await backend.getOverview()).stagedTasks.map((task) => task.id), [task.id]);
  assert.equal(git(origin, "branch", "--list", "techtree/bundle-*").trim(), "");
  db.exec("DROP TRIGGER reject_jobs; CREATE TRIGGER reject_running BEFORE INSERT ON cache WHEN NEW.kind = 'bundle-jobs' AND NEW.value LIKE '%running%' BEGIN SELECT RAISE(ABORT, 'running persistence failure'); END");
  await backend.startBundle({ taskIds: [task.id] });
  await until(async () => (await backend.getComposition()).bundleJobs!.some((job) => job.status === "failed"), "running persistence failure reported");
  await until(async () => (await backend.getOverview()).stagedTasks.length === 1, "failed reservation released");
  assert.equal(git(origin, "branch", "--list", "techtree/bundle-*").trim(), "");
  db.exec("DROP TRIGGER reject_running");
  const hold = join(tmp, "hold-create"); writeFileSync(hold, "hold");
  try {
    const accepted = await backend.startBundle({ taskIds: [task.id], title: "Terminal persistence failure" });
    const acceptedId = accepted.bundleJobs!.find((job) => job.status === "queued" || job.status === "running")!.id;
    await until(() => git(origin, "branch", "--list", "techtree/bundle-*").trim(), "held push");
    db.exec("CREATE TRIGGER reject_terminal BEFORE INSERT ON cache WHEN NEW.kind = 'bundle-jobs' BEGIN SELECT RAISE(ABORT, 'terminal persistence failure'); END");
    rmSync(hold);
    await until(async () => {
      const jobs = (await backend.getComposition()).bundleJobs!;
      const latest = jobs.find((job) => job.id === acceptedId)!;
      if (latest.status === "failed") assert.fail(JSON.stringify(latest));
      return latest.status === "opened";
    }, "successful remote publication despite status write failure");
    const job = (await backend.getComposition()).bundleJobs!.find((job) => job.status === "opened")!;
    assert.match(job.error!, /Could not persist.*terminal persistence failure/);
    assert.equal(job.bundle!.pr, 77);
    assert.equal((await backend.getState()).tasks[0].state, "pr_open");
  } finally { rmSync(hold, { force: true }); }
});

test("an activity notification failure cannot turn a successfully opened background PR into failed or unhandled work", { timeout: 30_000 }, async (t) => {
  const { backend, reviewed } = await boot(t);
  const task = await reviewed("scenario:happy"); await backend.stage(task.id);
  const stop = backend.subscribe((event) => {
    if (event.type === "composition" && event.composition.bundleJobs?.some((job) => job.status === "opened")) throw new Error("injected activity listener failure");
  });
  t.after(stop);
  await backend.startBundle({ taskIds: [task.id], title: "Notification failure" });
  await until(async () => (await backend.getComposition()).bundleJobs!.some((job) => job.status === "opened" && job.error), "opened outcome with notification warning");
  const job = (await backend.getComposition()).bundleJobs![0];
  assert.equal(job.bundle!.pr, 77);
  assert.match(job.error!, /Could not refresh publication activity.*injected activity listener failure/);
  assert.equal((await backend.getState()).tasks[0].state, "pr_open");
});

test("restart adopts a locally committed background bundle instead of opening another PR", { timeout: 30_000 }, async (t) => {
  const { backend, reviewed, repo, tmp, cache, ghLog } = await boot(t);
  const task = await reviewed("scenario:happy"); await backend.stage(task.id);
  const bundle = await backend.createBundle({ taskIds: [task.id], title: "Already opened" });
  await backend.close();
  const db = openDb(cache);
  dbCache(db).set("bundle-jobs", "quality", [{ id: "recover-opened", project: "quality", taskIds: [task.id], taskTitles: [task.title], status: "running", revision: 2, createdAt: bundle.createdAt, updatedAt: bundle.createdAt }]);
  const before = readFileSync(ghLog, "utf8");
  const restarted = new RepoBackend({ db, repoRoot: repo, cacheDir: cache, config: mergeConfig({ minLoc: 1, worktreeTemplate: `${tmp}/wt/{task}`, piCommand: [process.execPath, FAKE_PI] }), log: () => {} });
  restarted.attach({ url: "http://127.0.0.1:1", token: "tok" }); t.after(() => restarted.close());
  const job = (await restarted.getComposition()).bundleJobs![0];
  assert.equal(job.status, "opened"); assert.equal(job.revision, 3); assert.equal(job.bundle!.id, bundle.id);
  assert.equal(readFileSync(ghLog, "utf8"), before, "no remote publication during recovery");
  assert.deepEqual((await restarted.getOverview()).stagedTasks, []);
});

test("background opening validates before acceptance and restart reports interrupted jobs without republishing", { timeout: 30_000 }, async (t) => {
  const { backend, reviewed, tmp, repo, cache } = await boot(t);
  const task = await reviewed("scenario:happy");
  await assert.rejects(backend.startBundle({ taskIds: [task.id] }), (e) => status(e) === 409);
  await backend.stage(task.id);
  await assert.rejects(backend.startBundle({ taskIds: [task.id,task.id] }), (e) => status(e) === 400);
  await assert.rejects(backend.startBundle({ taskIds: [] }), (e) => status(e) === 400);
  const db = openDb(cache);
  dbCache(db).set("bundle-jobs", "quality", [{ id: "crash", project: "quality", taskIds: [task.id], taskTitles: [task.title], status: "running", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z", revision: 2 }]);
  await backend.close();
  const restarted = new RepoBackend({ db, repoRoot: repo, cacheDir: cache, config: mergeConfig({ minLoc:1, worktreeTemplate:`${tmp}/wt/{task}`, piCommand:[process.execPath,FAKE_PI] }), log:()=>{} });
  restarted.attach({ url:"http://127.0.0.1:1", token:"tok" });
  t.after(() => restarted.close());
  const job = (await restarted.getComposition()).bundleJobs![0];
  assert.equal(job.status, "interrupted");
  assert.match(job.error!, /check.*GitHub.*before.*retry/i);
  assert.deepEqual((await restarted.getOverview()).stagedTasks.map((x) => x.id), [task.id]);
  assert.deepEqual(await restarted.listBundles(), []);
});
