import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepoBackend } from "../../src/backend/backend.ts";
import { mergeConfig } from "../../src/config.ts";
import { dbCache, openDb, suppressSqliteWarning } from "../../src/db.ts";
import type { HttpError } from "../../src/server/backend.ts";
import { startServer } from "../../src/server/server.ts";
import type { Task } from "../../src/types.ts";
import { FAKE_PI, TODO_FILE, fixture, until } from "./helpers.ts";

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
  return { backend, repo, origin, ghLog, reviewed, tmp, cache };
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

test("a combined PR cherry-picks the staged tasks' commits onto one pushed branch and records the bundle", { timeout: 30_000 }, async (t) => {
  const { backend, origin, ghLog, reviewed } = await boot(t);
  const a = await reviewed("first scenario:happy");
  const b = await reviewed("second scenario:happy");
  await backend.stage(a.id);
  await backend.stage(b.id);

  const bundle = await backend.createBundle({ taskIds: [a.id, b.id], title: "Two fixes" });
  assert.equal(bundle.pr, 77);
  assert.equal(bundle.branch, `techtree/bundle-${bundle.id}`);
  assert.deepEqual(bundle.taskIds, [a.id, b.id]);
  assert.equal(git(origin, "log", "--format=%s", `main..${bundle.branch}`).trim().split("\n").length, 2);

  const args: string[] = JSON.parse(readFileSync(ghLog, "utf8"));
  assert.deepEqual(args.slice(0, 2), ["pr", "create"]);
  assert.equal(args[args.indexOf("--title") + 1], "Two fixes");
  const body = args[args.indexOf("--body") + 1];
  assert.ok(body.includes(a.title) && body.includes(b.title));

  const tasks = (await backend.getState()).tasks;
  for (const id of [a.id, b.id]) {
    const task = tasks.find((x) => x.id === id)!;
    assert.equal(task.state, "pr_open");
    assert.equal(task.pr, 77);
    assert.equal(task.bundle, bundle.id);
  }
  assert.deepEqual((await backend.listBundles()).map((x) => x.id), [bundle.id]);
});

test("a cherry-pick conflict aborts cleanly, names the task and leaves everything staged", { timeout: 30_000 }, async (t) => {
  const { backend, repo, reviewed } = await boot(t);
  const a = await reviewed("version A scenario:readme");
  const b = await reviewed("version B scenario:readme");
  await backend.stage(a.id);
  await backend.stage(b.id);

  await assert.rejects(backend.createBundle({ taskIds: [a.id, b.id] }), (e) => status(e) === 409 && (e as Error).message.includes(b.id));
  assert.deepEqual((await backend.getState()).tasks.map((x) => x.state), ["staged", "staged"]);
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

  writeFileSync(join(tmp, "pr-state"), "MERGED\n");
  await backend.reconcileBundles();
  assert.equal((await backend.getState()).tasks[0].state, "done");
});
