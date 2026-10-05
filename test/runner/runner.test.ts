import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../../src/config.ts";
import { openDb, suppressSqliteWarning, type Db } from "../../src/db.ts";
import { TaskRunner, type StartTask } from "../../src/runner/runner.ts";
import type { ServerEvent, Task } from "../../src/types.ts";

suppressSqliteWarning();

const FAKE_PI = join(import.meta.dirname, "fake-pi.mjs");

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

interface Harness {
  runner: TaskRunner;
  repo: string;
  cache: string;
  tmp: string;
  db: Db;
  newRunner(): TaskRunner;
  waitFor(id: string, pred: (task: Task) => boolean): Promise<Task>;
}

async function setup(t: TestContext, workers = 3): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), "techtree-runner-"));
  const repo = join(tmp, "repo");
  const cache = join(tmp, "cache");
  const bin = join(tmp, "bin");
  for (const dir of [repo, cache, bin]) mkdirSync(dir);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nsleep ${FAKE_GH_DELAY:-0}\ncat .fake-pr 2>/dev/null || exit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;

  const listeners = new Set<() => void>();
  const onEvent = (_e: ServerEvent) => listeners.forEach((l) => l());
  const runners: TaskRunner[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const id = /^\/api\/tasks\/([^/]+)\/report\?token=secret$/.exec(req.url ?? "")?.[1];
      try {
        if (!id) throw new Error(`bad url ${req.url}`);
        runners.at(-1)!.report(id, JSON.parse(body));
        res.end("{}");
      } catch (err) {
        res.statusCode = 400;
        res.end((err as Error).message);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = mergeConfig({ workers, worktreeTemplate: `${tmp}/wt/{repo}-{task}`, piCommand: [process.execPath, FAKE_PI] });
  const db = openDb(cache);
  const newRunner = () => {
    const runner = new TaskRunner({ db: openDb(cache), config, repoRoot: repo, cacheDir: cache, url, token: "secret", onEvent });
    runners.push(runner);
    return runner;
  };
  const runner = newRunner();

  t.after(() => {
    runners.forEach((r) => r.close());
    server.close();
    process.env.PATH = path;
    rmSync(tmp, { recursive: true, force: true });
  });

  const waitFor = (id: string, pred: (task: Task) => boolean) =>
    new Promise<Task>((resolve, reject) => {
      const check = () => {
        const task = runners.at(-1)!.get(id);
        if (task && pred(task)) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve(task);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        const task = runners.at(-1)!.get(id);
        reject(new Error(`timed out; task: ${JSON.stringify(task)}\n${task?.logPath && log(task)}`));
      }, 10_000);
      listeners.add(check);
      check();
    });

  return { runner, repo, cache, tmp, db, newRunner, waitFor };
}

const req = (scenario: string, manualReview = true): StartTask => ({
  node: "src",
  findingIds: ["f1"],
  prompt: `Fix it. scenario:${scenario}`,
  manualReview,
  plannedFrom: 40,
  plannedTo: 55,
});

const log = (task: Task) => readFileSync(task.logPath!, "utf8");

function persist(h: Harness, id: string, state: Task["state"], extra: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id, project: "quality", node: "", title: id, prompt: "", findingIds: [], state, manualReview: true, plannedFrom: 0, plannedTo: 0,
    checklist: [{ text: "step", done: false }], phase: "edit", logPath: join(h.cache, "tasks", `${id}.log`),
    createdAt: now, updatedAt: now, ...extra,
  };
  h.db.prepare("INSERT INTO tasks (id, node, state, data, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, "", state, JSON.stringify(task), now);
  return task;
}

async function processGone(pid: number): Promise<void> {
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("runs at most `workers` tasks and starts queued ones FIFO as slots free", async (t) => {
  const h = await setup(t, 2);
  const [a, b, c] = [h.runner.start(req("hang")), h.runner.start(req("hang")), h.runner.start(req("hang"))];
  await h.waitFor(a.id, (x) => x.checklist.length === 1);
  await h.waitFor(b.id, (x) => x.checklist.length === 1);
  assert.equal(h.runner.get(c.id)!.state, "queued");

  const cancelled = h.runner.cancel(a.id);
  assert.equal(cancelled.state, "failed");
  assert.equal(cancelled.error, "cancelled");
  const started = await h.waitFor(c.id, (x) => x.state === "running" && x.checklist.length === 1);

  assert.equal(started.branch, `techtree/${c.id}`);
  assert.equal(started.worktree, join(h.tmp, "wt", `repo-${c.id}`));
  assert.equal(git(started.worktree!, "rev-parse", "--abbrev-ref", "HEAD").trim(), `techtree/${c.id}`);
  assert.equal(git(h.repo, "status", "--porcelain"), "");
  const row = h.db.prepare("SELECT state FROM tasks WHERE id = ?").get(c.id) as { state: string };
  assert.equal(row.state, "running");
});

test("manual review: plan, phase and done updates end in review with a diff; open PR records the PR", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("happy"));
  const review = await h.waitFor(id, (x) => x.state === "review");
  assert.deepEqual(review.checklist, [
    { text: "first", done: true },
    { text: "second", done: true },
  ]);
  assert.equal(review.phase, "edit");
  assert.match(h.runner.diff(id), /\+improved/);
  assert.match(log(review), /report: \{"plan":\["first","second"\]\}/);

  h.runner.openPr(id);
  const pr = await h.waitFor(id, (x) => x.state === "pr_open");
  assert.equal(pr.pr, 42);
  assert.equal(pr.phase, "pr");
});

test("a task's model is persisted and passed to pi on every spawn, including the Open PR respawn", async (t) => {
  const h = await setup(t);
  const { id, model } = h.runner.start({ ...req("happy"), model: "fake/beta" });
  assert.equal(model, "fake/beta");
  await h.waitFor(id, (x) => x.state === "review");
  h.runner.openPr(id);
  const task = await h.waitFor(id, (x) => x.state === "pr_open");
  assert.equal(log(task).match(/stderr: model: fake\/beta/g)?.length, 2);
  const row = h.db.prepare("SELECT data FROM tasks WHERE id = ?").get(id) as { data: string };
  assert.equal((JSON.parse(row.data) as Task).model, "fake/beta");

  const plain = h.runner.start(req("happy"));
  assert.doesNotMatch(log(await h.waitFor(plain.id, (x) => x.state === "review")), /model:/);
});

test("without manual review the worker opens the PR in one go", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("auto", false));
  const states: string[] = [];
  const task = await h.waitFor(id, (x) => (states.push(x.state), x.state === "pr_open"));
  assert.equal(task.pr, 7);
  assert.ok(!states.includes("review"));
});

test("needs_input pauses the task and the answer resumes the worker", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("ask"));
  const waiting = await h.waitFor(id, (x) => x.state === "needs_input");
  assert.equal(waiting.question, "Which color?");
  assert.equal(h.runner.answer(id, "blue").state, "running");
  const done = await h.waitFor(id, (x) => x.state === "review");
  assert.equal(done.question, undefined);
  assert.match(log(done), /assistant: got: blue/);
  assert.doesNotMatch(log(done), /prompt: You stopped before/);
});

test("an extension dialog becomes needs_input and the answer is the dialog response", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("dialog"));
  const waiting = await h.waitFor(id, (x) => x.state === "needs_input");
  assert.match(waiting.question!, /Proceed\?/);
  h.runner.answer(id, "yes");
  const done = await h.waitFor(id, (x) => x.state === "review");
  assert.match(log(done), /assistant: confirmed: true/);
});

test("a worker that goes idle unfinished is nudged once, then asks for input", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("idle"));
  const waiting = await h.waitFor(id, (x) => x.state === "needs_input");
  assert.match(waiting.question!, /stopped before finishing/);
  assert.equal(log(waiting).match(/prompt: You stopped before/g)?.length, 1);
});

test("a worker exit before a settled state fails the task with the log path", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("crash"));
  const failed = await h.waitFor(id, (x) => x.state === "failed");
  assert.match(failed.error!, /exited \(3\)/);
  assert.ok(failed.error!.includes(failed.logPath!));
});

test("reports are validated against the task", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("hang"));
  await h.waitFor(id, (x) => x.checklist.length === 1);
  assert.throws(() => h.runner.report(id, { done: 1 }), /no checklist item 1/);
  assert.throws(() => h.runner.report(id, { phase: "nap" as never }), /unknown phase/);
  for (const done of ["__proto__", "length", -1, 0.5])
    assert.throws(() => h.runner.report(id, { done } as never), /no checklist item/);
  assert.equal(Object.hasOwn(Array.prototype, "done"), false);
  h.runner.cancel(id);
  assert.throws(() => h.runner.report(id, { done: 0 }), /is failed/);
});

test("restart recovery resumes sessions, fails lost workers and leaves settled tasks alone", async (t) => {
  const h = await setup(t);
  const { id: resumable } = h.runner.start(req("resume"));
  await h.waitFor(resumable, (x) => x.checklist.length === 1);
  h.runner.close();

  const persisted = (id: string, state: Task["state"], extra: Partial<Task> = {}) => persist(h, id, state, extra);
  const lost = persisted("lost", "running", { pid: 999_999 });
  const review = persisted("rev", "review");
  const prOpen = persisted("pr", "pr_open", { pr: 3 });
  const asking = join(h.tmp, "wt", "asking");
  git(h.repo, "worktree", "add", "-q", "-b", "techtree/asking", asking);
  mkdirSync(join(h.cache, "sessions", "asking"), { recursive: true });
  writeFileSync(join(h.cache, "sessions", "asking", "asking.jsonl"), JSON.stringify({ scenario: "resume" }) + "\n");
  persisted("asking", "needs_input", { question: "Which?", worktree: asking, branch: "techtree/asking" });

  const runner = h.newRunner();
  runner.recover();

  const resumed = await h.waitFor(resumable, (x) => x.state === "review");
  assert.match(log(resumed), /assistant: resumed: techtree restarted/);
  const failed = runner.get("lost")!;
  assert.equal(failed.state, "failed");
  assert.ok(failed.error!.includes(lost.logPath!));
  assert.deepEqual(runner.get("rev"), review);
  assert.deepEqual(runner.get("pr"), prOpen);

  assert.equal(runner.get("asking")!.state, "needs_input");
  assert.throws(() => runner.report("asking", { done: 0 }), /no live worker/);
  runner.answer("asking", "left");
  const answered = await h.waitFor("asking", (x) => x.state === "review");
  assert.match(log(answered), /assistant: resumed: left/);
});

test("recovery launches queued tasks only after the sweep, so they are not mistaken for lost workers", async (t) => {
  const h = await setup(t);
  h.runner.close();
  persist(h, "lost", "running", { createdAt: "2020-01-01T00:00:00.000Z" });
  persist(h, "waiting", "queued", { checklist: [], prompt: "scenario:hang", createdAt: "2020-01-02T00:00:00.000Z" });
  const runner = h.newRunner();
  runner.recover();
  assert.equal(runner.get("lost")!.state, "failed");
  const started = await h.waitFor("waiting", (x) => x.checklist.length === 1);
  assert.equal(started.state, "running");
});

test("resumed tasks wait for a worker slot like new ones", async (t) => {
  const h = await setup(t, 1);
  const [a, b] = [h.runner.start(req("happy")), h.runner.start(req("happy"))];
  await h.waitFor(a.id, (x) => x.state === "review");
  await h.waitFor(b.id, (x) => x.state === "review");
  h.runner.openPr(a.id);
  assert.equal(h.runner.openPr(b.id).state, "queued");
  await h.waitFor(a.id, (x) => x.state === "pr_open");
  assert.equal((await h.waitFor(b.id, (x) => x.state === "pr_open")).pr, 42);
});

test("a prompt rejected by pi fails the task with pi's error", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("reject"));
  const failed = await h.waitFor(id, (x) => x.state === "failed");
  assert.match(failed.error!, /No API key found/);
});

test("records from a cancelled worker cannot change the task", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("late"));
  const { pid } = await h.waitFor(id, (x) => x.checklist.length === 1);
  h.runner.cancel(id);
  await processGone(pid!);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.runner.get(id)!.state, "failed");
  const row = h.db.prepare("SELECT state FROM tasks WHERE id = ?").get(id) as { state: string };
  assert.equal(row.state, "failed");
});

test("a dialog that times out returns the task to running", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("timeout"));
  await h.waitFor(id, (x) => x.state === "needs_input");
  const resumed = await h.waitFor(id, (x) => x.state === "running");
  assert.equal(resumed.question, undefined);
  assert.equal(resumed.checklist[0].done, false);
  const done = await h.waitFor(id, (x) => x.state === "review");
  assert.match(log(done), /assistant: confirmed: false/);
});

test("an agent that settles with a dialog open has had the dialog resolved by pi", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("expired"));
  await h.waitFor(id, (x) => x.state === "needs_input");
  const done = await h.waitFor(id, (x) => x.state === "review");
  assert.equal(done.question, undefined);
});

test("a slow PR lookup does not block the event loop", async (t) => {
  const h = await setup(t);
  process.env.FAKE_GH_DELAY = "1";
  t.after(() => delete process.env.FAKE_GH_DELAY);
  let last = Date.now();
  let maxGap = 0;
  const ticker = setInterval(() => {
    maxGap = Math.max(maxGap, Date.now() - last);
    last = Date.now();
  }, 20);
  t.after(() => clearInterval(ticker));
  const { id } = h.runner.start(req("auto", false));
  assert.equal((await h.waitFor(id, (x) => x.state === "pr_open")).pr, 7);
  assert.ok(maxGap < 500, `event loop blocked for ${maxGap}ms`);
});

test("prFromText takes the last PR URL in the worker's message", { timeout: 5000 }, async () => {
  const { prFromText } = await import("../../src/runner/runner.ts");
  assert.equal(prFromText("opened https://github.com/o/r/pull/12 and then https://github.com/o/r/pull/5522."), 5522);
  assert.equal(prFromText("no link here"), undefined);
  assert.equal(prFromText(undefined), undefined);
});

test("discard stops the worker and deletes worktree, local branch and task; open PRs are refused", async (t) => {
  const h = await setup(t, 1);
  const a = h.runner.start(req("hang"));
  const b = h.runner.start(req("hang"));
  const running = await h.waitFor(a.id, (x) => x.checklist.length === 1);

  h.runner.discard(a.id);
  assert.equal(h.runner.get(a.id), undefined);
  assert.equal(h.db.prepare("SELECT id FROM tasks WHERE id = ?").get(a.id), undefined);
  assert.equal(git(h.repo, "worktree", "list").includes(running.worktree!), false);
  assert.equal(git(h.repo, "branch", "--list", running.branch!).trim(), "");
  await h.waitFor(b.id, (x) => x.state === "running"); // the freed slot is reused

  const stuck = h.runner.get(b.id)!;
  stuck.state = "pr_open";
  assert.throws(() => h.runner.discard(b.id), /open PR/);
});

/** `agentCommand` once the task's previous worker has exited. */
async function sessionFree(h: Harness, id: string): Promise<string[]> {
  for (;;) {
    try {
      return h.runner.agentCommand(id);
    } catch (err) {
      if (!/shutting down/.test((err as Error).message)) throw err;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

test("a message to a running task steers its worker, and the chat transcript records the conversation", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("chat"));
  await h.waitFor(id, (x) => x.checklist.length === 1);
  const steered = h.runner.message(id, "please finish");
  assert.equal(steered.state, "running");
  const review = await h.waitFor(id, (x) => x.state === "review");
  assert.match(log(review), /stderr: streamed as steer/);

  const chat = h.runner.chat(id);
  assert.deepEqual(
    chat.map(({ role, text }) => [role, text]).slice(1),
    [["user", "please finish"], ["tool", 'read {"path":"README.md"}'], ["assistant", "heard: please finish"]],
  );
  assert.equal(chat[0].role, "user");
  assert.match(chat[0].text, /scenario:chat/, "the initial prompt opens the transcript");
  assert.ok(chat.every((e) => !Number.isNaN(Date.parse(e.at))));
});

test("a message to a needs_input task answers it", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("ask"));
  await h.waitFor(id, (x) => x.state === "needs_input");
  assert.equal(h.runner.message(id, "blue").state, "running");
  assert.match(log(await h.waitFor(id, (x) => x.state === "review")), /assistant: got: blue/);
});

test("a message resumes a review task on its session, which returns to review", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("chat"));
  await h.waitFor(id, (x) => x.checklist.length === 1);
  h.runner.message(id, "finish up");
  await h.waitFor(id, (x) => x.state === "review");

  assert.notEqual(h.runner.message(id, "also finish the docs").state, "review");
  const again = await h.waitFor(id, (x) => x.state === "review" && h.runner.chat(id).some((e) => e.text === "heard: also finish the docs"));
  assert.match(log(again), /prompt: also finish the docs/);
});

test("a message resumes a failed task on its session and clears its error", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("chat"));
  await h.waitFor(id, (x) => x.checklist.length === 1);
  h.runner.cancel(id);
  h.runner.message(id, "keep going");
  const resumed = await h.waitFor(id, (x) => x.state === "running" && x.pid !== undefined);
  assert.equal(resumed.error, undefined);
  await h.waitFor(id, () => h.runner.chat(id).some((e) => e.text === "heard: keep going"));
});

test("a message resumes a pr_open task, which keeps its PR", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("auto", false));
  await h.waitFor(id, (x) => x.state === "pr_open");
  h.runner.message(id, "rebase please");
  const task = await h.waitFor(id, (x) => x.state === "pr_open" && log(x).includes("prompt: rebase please"));
  assert.equal(task.pr, 7);
});

test("messages are refused while queued or before a worktree exists", async (t) => {
  const h = await setup(t, 1);
  const a = h.runner.start(req("hang"));
  const b = h.runner.start(req("hang"));
  assert.throws(() => h.runner.message(b.id, "hi"), /queued/);
  assert.throws(() => h.runner.message("nope", "hi"), /unknown task/);
  h.runner.cancel(b.id);
  await h.waitFor(a.id, (x) => x.checklist.length === 1);
  h.runner.discard(a.id);
  assert.throws(() => h.runner.message(b.id, "hi"), /worktree/);
});

test("the interactive agent command resumes the task's session, and is refused while a worker is live", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start({ ...req("happy"), model: "fake/beta" });
  assert.throws(() => h.runner.agentCommand(id), /live worker/);
  await h.waitFor(id, (x) => x.state === "review");
  assert.deepEqual(await sessionFree(h, id), [
    process.execPath, FAKE_PI,
    "--session-dir", join(h.cache, "sessions", id),
    "--session-id", id,
    "--model", "fake/beta",
  ]);
});

test("a PR lookup still running when another message arrives does not finish the task", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("chat", false));
  const { worktree } = await h.waitFor(id, (x) => x.checklist.length === 1);
  writeFileSync(join(worktree!, ".fake-pr"), "9\n");
  process.env.FAKE_GH_DELAY = "0.5";
  t.after(() => delete process.env.FAKE_GH_DELAY);
  h.runner.message(id, "finish");
  await h.waitFor(id, (x) => /agent idle/.test(log(x)));
  h.runner.message(id, "one more thing");
  await new Promise((r) => setTimeout(r, 1000));
  const task = h.runner.get(id)!;
  assert.equal(task.state, "running", "the stale lookup's PR is ignored");
  assert.equal(task.pr, undefined);
  assert.notEqual(task.pid, undefined);
});

test("a message to a manually reviewed task with an open PR returns it to pr_open", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("happy"));
  await h.waitFor(id, (x) => x.state === "review");
  h.runner.openPr(id);
  await h.waitFor(id, (x) => x.state === "pr_open");
  h.runner.message(id, "address the review comments");
  const task = await h.waitFor(id, (x) => (x.state === "pr_open" || x.state === "review") && log(x).includes("prompt: address the review comments") && x.pid === undefined);
  assert.equal(task.state, "pr_open");
  assert.equal(task.pr, 42);
});

test("a cancelled worker's session stays busy until the worker has exited", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("late"));
  const { pid } = await h.waitFor(id, (x) => x.checklist.length === 1);
  h.runner.cancel(id);
  assert.throws(() => h.runner.agentCommand(id), /shutting down/);
  await processGone(pid!);
  assert.ok((await sessionFree(h, id)).includes(id));
});

test("a worker that ignores SIGTERM is killed after a second", async (t) => {
  const h = await setup(t);
  const { id } = h.runner.start(req("stubborn"));
  const { pid } = await h.waitFor(id, (x) => x.checklist.length === 1);
  const started = Date.now();
  h.runner.cancel(id);
  await processGone(pid!);
  assert.ok(Date.now() - started < 3000, `gone after ${Date.now() - started} ms`);
});

test("the chat transcript of an unknown task is an error, not an empty list", async (t) => {
  const h = await setup(t);
  assert.throws(() => h.runner.chat("nope"), /unknown task/);
});
