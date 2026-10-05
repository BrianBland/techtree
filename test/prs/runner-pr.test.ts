import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../../src/config.ts";
import { openDb, suppressSqliteWarning } from "../../src/db.ts";
import { TaskRunner } from "../../src/runner/runner.ts";
import type { Task } from "../../src/types.ts";

suppressSqliteWarning();

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function setup(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "techtree-runner-pr-"));
  const repo = join(tmp, "repo");
  const cache = join(tmp, "cache");
  const bin = join(tmp, "bin");
  for (const dir of [repo, cache, bin]) mkdirSync(dir);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "checkout", "-qb", "pr-head");
  writeFileSync(join(repo, "pr.txt"), "pr work\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "pr work");
  git(repo, "checkout", "-q", "main");
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$GH_LOG"',
      'case "$1 $2" in',
      '  "pr checkout") sleep "${FAKE_GH_DELAY:-0}"; git checkout -q -b "$5" pr-head ;;',
      '  "pr view") cat .fake-pr 2>/dev/null || exit 1 ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  const saved = { PATH: process.env.PATH, GH_LOG: process.env.GH_LOG, FAKE_GH_DELAY: process.env.FAKE_GH_DELAY };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.GH_LOG = join(tmp, "gh.log");

  let runner: TaskRunner | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const id = /^\/api\/tasks\/([^/]+)\/report/.exec(req.url ?? "")![1];
        runner!.report(id, JSON.parse(body));
        res.end("{}");
      } catch (err) {
        res.statusCode = 400;
        res.end((err as Error).message);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const listeners = new Set<() => void>();
  runner = new TaskRunner({
    db: openDb(cache),
    config: mergeConfig({ worktreeTemplate: `${tmp}/wt/{task}`, piCommand: [process.execPath, join(import.meta.dirname, "../runner/fake-pi.mjs")] }),
    repoRoot: repo,
    cacheDir: cache,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token: "secret",
    onEvent: () => listeners.forEach((l) => l()),
  });
  t.after(() => {
    runner!.close();
    server.close();
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
    rmSync(tmp, { recursive: true, force: true });
  });
  const waitFor = (id: string, pred: (task: Task) => boolean) =>
    new Promise<Task>((resolve, reject) => {
      const check = () => {
        const task = runner!.get(id)!;
        if (pred(task)) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve(task);
        }
      };
      const timer = setTimeout(() => reject(new Error(`timed out: ${JSON.stringify(runner!.get(id))}`)), 10_000);
      listeners.add(check);
      check();
    });
  return { runner, repo, tmp, waitFor, ghLog: () => readFileSync(join(tmp, "gh.log"), "utf8") };
}

test("a task started on an existing PR checks the PR out in its worktree and finishes on that PR", async (t) => {
  const h = await setup(t);
  const prompt = "/skill:techtree-babysit Fix PR #7. scenario:auto";
  const started = h.runner.start({ node: "", findingIds: [], title: "Babysit PR #7", prompt, manualReview: false, plannedFrom: 0, plannedTo: 0, pr: 7 });
  const task = await h.waitFor(started.id, (x) => x.state === "pr_open" || x.state === "failed");
  assert.equal(task.state, "pr_open", task.error);
  assert.equal(task.pr, 7);
  assert.equal(task.branch, `techtree/${task.id}`);
  assert.equal(git(task.worktree!, "rev-parse", "--abbrev-ref", "HEAD"), task.branch);
  assert.equal(git(task.worktree!, "rev-parse", "HEAD~1"), git(h.repo, "rev-parse", "pr-head"), "work builds on the PR head");
  assert.match(h.ghLog(), new RegExp(`^pr checkout 7 --branch techtree/${task.id}$`, "m"));
  assert.match(h.ghLog(), /^pr view 7 /m);
  const log = readFileSync(task.logPath!, "utf8");
  assert.ok(log.includes(`prompt: ${prompt}`), "the prompt is sent as given");
  assert.ok(!log.includes("techtree-worker"), log);
});

test("resumeTask respawns a pr_open task on its session with the given prompt", async (t) => {
  const h = await setup(t);
  const started = h.runner.start({ node: "", findingIds: [], prompt: "Fix. scenario:auto", manualReview: false, plannedFrom: 0, plannedTo: 0 });
  await h.waitFor(started.id, (x) => x.state === "pr_open");
  assert.throws(() => h.runner.resumeTask("nope", "x"), /unknown task/);

  h.runner.resumeTask(started.id, "/skill:techtree-babysit CI failing");
  assert.throws(() => h.runner.resumeTask(started.id, "again"), /not pr_open/, "a live task cannot be resumed");
  const task = await h.waitFor(started.id, (x) => x.state === "pr_open" || x.state === "failed");
  assert.equal(task.state, "pr_open", task.error);
  assert.ok(readFileSync(task.logPath!, "utf8").includes("prompt: /skill:techtree-babysit CI failing"));
});

const babysitStart = (prompt: string) =>
  ({ node: "", findingIds: [], title: "Babysit PR #7", prompt, manualReview: false, plannedFrom: 0, plannedTo: 0, pr: 7 });

test("a slow PR checkout does not block the event loop", async (t) => {
  const h = await setup(t);
  process.env.FAKE_GH_DELAY = "1";
  const started = Date.now();
  const id = h.runner.start(babysitStart("Fix. scenario:auto")).id;
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(Date.now() - started < 500, "timers keep firing while gh checks out");
  assert.equal(h.runner.get(id)!.worktree, undefined, "checkout still in progress");
  const task = await h.waitFor(id, (x) => x.state === "pr_open" || x.state === "failed");
  assert.equal(task.state, "pr_open", task.error);
});

test("a PR task cancelled during its checkout never starts a worker and stays on its PR", async (t) => {
  const h = await setup(t);
  process.env.FAKE_GH_DELAY = "0.3";
  const id = h.runner.start(babysitStart("Fix. scenario:auto")).id;
  h.runner.cancel(id);
  await h.waitFor(id, (x) => x.worktree !== undefined);
  await new Promise((r) => setTimeout(r, 100));
  const task = h.runner.get(id)!;
  assert.equal(task.state, "pr_open");
  assert.equal(task.pr, 7);
  assert.equal(task.pid, undefined);
});

test("cancelling a running fix of an open PR stops its worker and returns the task to pr_open", async (t) => {
  const h = await setup(t);
  const id = h.runner.start(babysitStart("Fix. scenario:hang")).id;
  const running = await h.waitFor(id, (x) => x.state === "running" && x.pid !== undefined);
  const task = h.runner.cancel(id);
  assert.equal(task.state, "pr_open");
  assert.equal(task.pr, 7);
  assert.equal(task.worktree, running.worktree, "the worktree is kept for the next fix");
  assert.equal(task.pid, undefined);
});
