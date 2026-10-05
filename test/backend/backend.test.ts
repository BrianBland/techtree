import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepoBackend } from "../../src/backend/backend.ts";
import { mergeConfig } from "../../src/config.ts";
import { openDb, suppressSqliteWarning } from "../../src/db.ts";
import { HttpError } from "../../src/server/backend.ts";
import { startServer } from "../../src/server/server.ts";
import type { Config, ServerEvent, Task } from "../../src/types.ts";
import { FAKE_PI, TODO_FILE, fixture, until } from "./helpers.ts";

suppressSqliteWarning();

async function boot(t: TestContext, repo: string, cache: string, tmp: string, piCommand = [process.execPath, FAKE_PI], extra: Partial<Config> = {}) {
  mkdirSync(cache, { recursive: true });
  const config = mergeConfig({ minLoc: 1, worktreeTemplate: `${tmp}/wt/{task}`, piCommand, ...extra });
  const backend = new RepoBackend({ db: openDb(cache), repoRoot: repo, cacheDir: cache, config, log: () => {} });
  const events: ServerEvent[] = [];
  backend.subscribe((e) => events.push(e));
  const server = await startServer({ backend, staticDir: tmp, token: "tok" });
  backend.attach({ url: `http://127.0.0.1:${server.port}`, token: "tok" });
  const shutdown = async () => {
    await backend.close();
    await server.close();
  };
  t.after(shutdown);
  await backend.idle();
  return { backend, events, shutdown };
}

const status = (err: unknown) => (err as HttpError).status;

test("scores on start, runs a task through review with a diff, and survives a restart", { timeout: 30_000 }, async (t) => {
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

test("maps unknown ids and wrong task states to HTTP errors", { timeout: 30_000 }, async (t) => {
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

test("discard removes the task and emits task_removed", { timeout: 30_000 }, async (t) => {
  const { tmp, repo, cache } = fixture(t);
  const { backend, events } = await boot(t, repo, cache, tmp);
  assert.equal(status(await backend.discard("nope").catch((e) => e)), 404);
  const task = await backend.startTask({ node: "", findingIds: [], prompt: "scenario:hang", manualReview: true });
  await backend.discard(task.id);
  assert.ok(events.some((e) => e.type === "task_removed" && e.taskId === task.id));
  assert.equal((await backend.getState()).tasks.some((x) => x.id === task.id), false);
});

test("rescore requests during a run queue exactly one more run", { timeout: 30_000 }, async (t) => {
  const { tmp, repo, cache } = fixture(t);
  const { backend, events } = await boot(t, repo, cache, tmp);
  const before = events.filter((e) => e.type === "scores").length;
  await backend.rescore();
  await backend.rescore();
  await backend.rescore();
  await backend.idle();
  assert.equal(events.filter((e) => e.type === "scores").length - before, 2);
});

test("files changed in a running task's worktree make overlapping suggestions conflict", { timeout: 30_000 }, async (t) => {
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

test("scan emits running and done events, then rescores", { timeout: 30_000 }, async (t) => {
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

test("reads fail with 503 when the first scoring run failed", { timeout: 30_000 }, async (t) => {
  const { tmp, cache } = fixture(t);
  const notARepo = join(tmp, "plain");
  mkdirSync(notARepo);
  const { backend } = await boot(t, notARepo, cache, tmp);
  const err = await backend.getState().catch((e) => e);
  assert.equal(status(err), 503);
  assert.match(err.message, /^not scored yet: /);
});

const TODOS = "fn a() {}\n// TODO one\n// TODO two\n// TODO three\n";

test("prototype-named ids are ordinary nodes, before and after a restart", { timeout: 30_000 }, async (t) => {
  const { tmp, repo, cache } = fixture(t, { "constructor/lib.rs": TODOS, "__proto__/lib.rs": TODOS });
  const first = await boot(t, repo, cache, tmp);
  const counts = JSON.parse(JSON.stringify((await first.backend.getState()).findingCounts));
  assert.equal(counts.constructor, 1);
  assert.equal(counts.__proto__, 1);
  assert.equal(status(await first.backend.getNode("toString").catch((e) => e)), 404);
  await first.shutdown();

  const { backend } = await boot(t, repo, cache, tmp);
  assert.equal(status(await backend.getNode("toString").catch((e) => e)), 404);
  assert.equal(status(await backend.startTask({ node: "toString", findingIds: [], manualReview: true }).catch((e) => e)), 404);
  assert.equal(status(await backend.scan("hasOwnProperty").catch((e) => e)), 404);
  assert.equal((await backend.getNode("constructor")).findings.length, 1);
});

test("busy paths keep non-ASCII file names exact", { timeout: 30_000 }, async (t) => {
  const file = "src/uni/café.rs";
  const { tmp, repo, cache } = fixture(t, { [file]: TODOS });
  const { backend } = await boot(t, repo, cache, tmp);
  const [before] = (await backend.getNode("src/uni")).suggestions;
  assert.equal(before.conflict, 0);
  const task = await backend.startTask({ node: "src/uni", findingIds: [], prompt: "scenario:hang", manualReview: true });
  const running = await until(() => backend.getState().then((s) => s.tasks.find((x) => x.id === task.id && x.worktree && x.state === "running")), "running task");
  writeFileSync(join(running.worktree!, file), "changed\n");
  const [after] = (await backend.getNode("src/uni")).suggestions;
  assert.equal(after.conflict, 1);
  await backend.cancel(task.id);
});

test("closing the backend stops running scans and waits for their children", { timeout: 30_000 }, async (t) => {
  const { tmp, repo, cache } = fixture(t);
  const pidFile = join(tmp, "scanner.pid");
  const hangingScanner = join(tmp, "hang-scan.mjs");
  writeFileSync(
    hangingScanner,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
  );
  const { backend } = await boot(t, repo, cache, tmp, [process.execPath, hangingScanner]);
  await backend.scan("src/util");
  const pid = Number(await until(() => (existsSync(pidFile) ? readFileSync(pidFile, "utf8") : undefined), "scanner started"));
  t.after(() => isAlive(pid) && process.kill(pid, "SIGKILL"));
  await backend.close();
  assert.equal(isAlive(pid), false, "the scanner child has exited");
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A pi command that logs each run to `runs` and fails while `broken` exists. */
function countingPi(tmp: string): { command: string[]; runs: () => number; broken: string } {
  const runs = join(tmp, "pi-runs");
  const broken = join(tmp, "pi-broken");
  const script = join(tmp, "pi.sh");
  writeFileSync(script, `#!/bin/sh\necho run >> "${runs}"\n[ -e "${broken}" ] && exit 1\nexec "${process.execPath}" "${FAKE_PI}" "$@"\n`);
  chmodSync(script, 0o755);
  return { command: [script], runs: () => (existsSync(runs) ? readFileSync(runs, "utf8").split("\n").length - 1 : 0), broken };
}

test("models come from pi --list-models, cached; a failed listing is empty and retried", { timeout: 30_000 }, async (t) => {
  const { tmp, repo, cache } = fixture(t);
  const pi = countingPi(tmp);
  writeFileSync(pi.broken, "");
  const { backend } = await boot(t, repo, cache, tmp, pi.command);
  assert.deepEqual(await backend.models(), { default: null, models: [] });
  assert.deepEqual((await backend.models()).models, []);
  assert.equal(pi.runs(), 2, "failures are not cached");

  execFileSync("rm", [pi.broken]);
  assert.deepEqual((await backend.models()).models, ["fake/alpha", "fake/beta"]);
  assert.deepEqual((await backend.models()).models, ["fake/alpha", "fake/beta"]);
  assert.equal(pi.runs(), 3, "a good listing is cached");
});

test("the default model is config.defaultModel, else the last model a task used, else null", { timeout: 30_000 }, async (t) => {
  const { tmp, repo, cache } = fixture(t);
  const { backend } = await boot(t, repo, cache, tmp);
  assert.equal((await backend.models()).default, null);
  const first = await backend.startTask({ node: "", findingIds: [], prompt: "scenario:hang", manualReview: true, model: "fake/alpha" });
  const second = await backend.startTask({ node: "", findingIds: [], prompt: "scenario:hang", manualReview: true, model: "fake/beta" });
  await backend.startTask({ node: "", findingIds: [], prompt: "scenario:hang", manualReview: true });
  assert.equal((await backend.models()).default, "fake/beta");
  for (const task of [first, second]) await backend.cancel(task.id);

  const other = fixture(t);
  const configured = await boot(t, other.repo, other.cache, other.tmp, undefined, { defaultModel: "fake/alpha" });
  await configured.backend.startTask({ node: "", findingIds: [], prompt: "scenario:hang", manualReview: true, model: "fake/beta" });
  assert.equal((await configured.backend.models()).default, "fake/alpha");
});

test("source returns lines around a line at the scored commit and rejects bad paths", { timeout: 30_000 }, async (t) => {
  const { tmp, repo, cache } = fixture(t, { "src/many.ts": Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") });
  const { backend } = await boot(t, repo, cache, tmp);
  const slice = await backend.source("src/many.ts", 30);
  assert.equal(slice.startLine, 20);
  assert.equal(slice.lines[10], "line 30");
  assert.equal(slice.lines.length, 31);
  assert.equal((await backend.source("src/many.ts")).lines.length, 30);
  assert.equal(status(await backend.source("../etc/passwd").catch((e) => e)), 400);
  assert.equal(status(await backend.source("-p").catch((e) => e)), 400);
  assert.equal(status(await backend.source("nope.ts").catch((e) => e)), 404);
});

test("open in terminal runs the configured template detached in the worktree; agent mode waits for the worker", { timeout: 30_000 }, async (t) => {
  const { tmp, repo, cache } = fixture(t);
  const out = join(tmp, "opened.json");
  const record = `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(1)))`;
  const { backend } = await boot(t, repo, cache, tmp, undefined, { terminal: [process.execPath, "-e", record, "{cwd}", "{command}"] });
  assert.equal(status(await backend.openTerminal("nope", "shell").catch((e) => e)), 404);

  const task = await backend.startTask({ node: "", findingIds: [], prompt: "scenario:happy", manualReview: true });
  assert.equal(status(await backend.openTerminal(task.id, "agent").catch((e) => e)), 409, "agent mode while the worker is live");
  const reviewed = await until(() => backend.getState().then((s) => s.tasks.find((x) => x.id === task.id && x.state === "review")), "review");

  await backend.openTerminal(task.id, "agent");
  const [cwd, command] = await until(() => existsSync(out) && (JSON.parse(readFileSync(out, "utf8")) as string[]), "terminal to run");
  assert.equal(cwd, reviewed.worktree);
  assert.ok(command.startsWith(`'${process.execPath}' '${FAKE_PI}' '--session-dir'`), command);
  assert.ok(command.endsWith(`'--session-id' '${task.id}'`), command);

  rmSync(out);
  await backend.openTerminal(task.id, "shell");
  assert.deepEqual(await until(() => existsSync(out) && JSON.parse(readFileSync(out, "utf8")), "shell terminal"), [reviewed.worktree]);
  assert.ok((await backend.chat(task.id)).some((e) => e.role === "user" && e.text.includes("scenario:happy")));
});

test("a terminal program that cannot start is a 501", { timeout: 30_000 }, async (t) => {
  const { tmp, repo, cache } = fixture(t);
  const { backend } = await boot(t, repo, cache, tmp, undefined, { terminal: [join(tmp, "no-such-terminal"), "{cwd}"] });
  const task = await backend.startTask({ node: "", findingIds: [], prompt: "scenario:happy", manualReview: true });
  await until(() => backend.getState().then((s) => s.tasks.find((x) => x.id === task.id && x.state === "review")), "review");
  const err = await backend.openTerminal(task.id, "shell").catch((e) => e);
  assert.equal(status(err), 501);
  assert.match(err.message, /no-such-terminal/);
});
