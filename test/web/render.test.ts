import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { RepoBackend, type PrSource } from "../../src/backend/backend.ts";
import { mergeConfig } from "../../src/config.ts";
import { openDb, suppressSqliteWarning } from "../../src/db.ts";
import { HttpError, type Backend } from "../../src/server/backend.ts";
import { startServer } from "../../src/server/server.ts";
import type { PrState, ServerEvent, Task } from "../../src/types.ts";
import { FAKE_PI, TODO_FILE, fixture, until } from "../backend/helpers.ts";
import type { SmokeDriver } from "./app-smoke.tsx";

suppressSqliteWarning();

/** Bundle a TSX entry (Node cannot strip JSX) and import it. */
async function importTsx<T>(entry: string): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "techtree-web-"));
  try {
    const outfile = join(dir, "entry.mjs");
    await build({
      entryPoints: [new URL(entry, import.meta.url).pathname],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      jsx: "automatic",
      jsxImportSource: "preact",
      logLevel: "error",
    });
    return (await import(pathToFileURL(outfile).href)) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("switching score, weight or sort re-renders ~1000 visible nodes in under 200 ms", { timeout: 30_000 }, async (t) => {
  const { bench } = await importTsx<typeof import("./render-bench.tsx")>("./render-bench.tsx");
  const timings = bench(1000);
  t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v * 10) / 10]))));
  assert.equal(timings.visibleNodes, 1000);
  assert.ok(timings.switchScore < 200, `score switch ${timings.switchScore} ms`);
  assert.ok(timings.switchWeight < 200, `weight switch ${timings.switchWeight} ms`);
  assert.ok(timings.switchSort < 200, `sort switch ${timings.switchSort} ms`);
});

test("changing focus on a ~600-node workspace-shaped tree re-renders in under 200 ms within the node budget", { timeout: 30_000 }, async (t) => {
  const { focusBench } = await importTsx<typeof import("./render-bench.tsx")>("./render-bench.tsx");
  const timings = focusBench(600);
  t.diagnostic(JSON.stringify({ ...timings, switchFocus: Math.round(timings.switchFocus * 10) / 10 }));
  assert.ok(timings.nodes >= 600, `${timings.nodes} nodes`);
  assert.ok(timings.maxVisible <= 150, `${timings.maxVisible} visible`);
  assert.ok(timings.switchFocus < 200, `focus switch ${timings.switchFocus} ms`);
});

test("decorated sibling tiles never paint over each other", { timeout: 30_000 }, async () => {
  const { decoratedSiblingBoxes } = await importTsx<typeof import("./tile-boxes.tsx")>("./tile-boxes.tsx");
  const boxes = decoratedSiblingBoxes(3).filter((b) => b.node !== "repo");
  const extent = (node: string) => {
    const own = boxes.filter((b) => b.node === node);
    return { top: Math.min(...own.map((b) => b.top)), bottom: Math.max(...own.map((b) => b.bottom)) };
  };
  assert.ok(boxes.some((b) => b.cls === "glow") && boxes.some((b) => b.cls === "ring"), "decorations rendered");
  const [a, b, c] = ["n0", "n1", "n2"].map(extent);
  // Rings and glows are stroked 2 units wide, half of it outside their box.
  assert.ok(a.bottom + 1 < b.top - 1, `n0 ${JSON.stringify(a)} overlaps n1 ${JSON.stringify(b)}`);
  assert.ok(b.bottom + 1 < c.top - 1, `n1 ${JSON.stringify(b)} overlaps n2 ${JSON.stringify(c)}`);
});

test("only nodes that need you glow; worst scores stand out by colour alone", { timeout: 30_000 }, async () => {
  const { decoratedSiblingBoxes } = await importTsx<typeof import("./tile-boxes.tsx")>("./tile-boxes.tsx");
  const boxes = decoratedSiblingBoxes(3, new Set(["n1"]));
  assert.deepEqual(boxes.filter((b) => b.cls === "glow").map((b) => b.node), ["n1"]);
  assert.ok(!boxes.some((b) => ["alarm", "shimmer"].includes(b.cls)), "no score-driven motion");
});

const TODOS = "fn a() {}\n// TODO one\n// TODO two\n// TODO three\n";
const ASKING_NODE = TODO_FILE.slice(0, TODO_FILE.lastIndexOf("/"));
const RUNNING_NODE = "src/util";
const UI_TIMEOUT = { timeout: 60_000 };

/** In-test PR source: the listed PRs, plus a way to merge one as the poller would announce it. */
function fakePrs(prs: PrState[]): PrSource & { merge(number: number): void } {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    list: () => prs,
    setBabysit: (number) => prs.find((p) => p.number === number)!,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    merge(number) {
      prs = prs.filter((p) => p.number !== number);
      listeners.forEach((l) => l({ type: "pr_removed", number }));
    },
  };
}

function pr(number: number, node: string, title: string): PrState {
  return {
    number,
    url: `https://example.com/pr/${number}`,
    title,
    author: "dev",
    node,
    files: [],
    ci: "pass",
    review: "",
    updatedAt: new Date().toISOString(),
    babysit: false,
    stale: false,
    stuck: false,
  };
}

/** Every `Backend` method of `real`, so a test can override a few. */
function delegate(real: Backend): Backend {
  return {
    getState: () => real.getState(),
    getNode: (id) => real.getNode(id),
    getOverview: () => real.getOverview(),
    taskLog: (id, tail) => real.taskLog(id, tail),
    taskDiff: (id) => real.taskDiff(id),
    models: () => real.models(),
    startTask: (req) => real.startTask(req),
    answer: (id, text) => real.answer(id, text),
    openPr: (id) => real.openPr(id),
    cancel: (id) => real.cancel(id),
    message: (id, text) => real.message(id, text),
    chat: (id) => real.chat(id),
    openTerminal: (id, mode) => real.openTerminal(id, mode),
    discard: (id) => real.discard(id),
    source: (path, line) => real.source(path, line),
    report: (id, report) => real.report(id, report),
    setBabysit: (n, on) => real.setBabysit(n, on),
    rescore: () => real.rescore(),
    scan: (node) => real.scan(node),
    subscribe: (listener) => real.subscribe(listener),
  };
}

interface Ui {
  backend: RepoBackend;
  prs: ReturnType<typeof fakePrs>;
  app: SmokeDriver;
  /** A task under `ASKING_NODE` waiting for an answer. */
  asking: Task;
  /** A task under `RUNNING_NODE` still working. */
  running: Task;
  byClass(cls: string): ReturnType<SmokeDriver["find"]>;
}

/**
 * Boot the real UI against the real server and `RepoBackend` over a scored fixture repo, with
 * fake pi workers: one task asking a question, one running, and one open PR on `RUNNING_NODE`.
 * `serve` can wrap the backend the server talks to.
 */
async function bootUi(t: TestContext, serve: (real: RepoBackend) => Backend = (real) => real): Promise<Ui> {
  const { tmp, repo, cache } = fixture(t, { "src/net/lib.rs": TODOS });
  mkdirSync(cache, { recursive: true });
  const prs = fakePrs([pr(7, RUNNING_NODE, "Tidy the util helpers")]);
  const config = mergeConfig({ minLoc: 1, worktreeTemplate: `${tmp}/wt/{task}`, piCommand: [process.execPath, FAKE_PI] });
  const backend = new RepoBackend({ db: openDb(cache), repoRoot: repo, cacheDir: cache, config, prs, log: () => {} });
  const server = await startServer({ backend: serve(backend), staticDir: tmp, token: "tok" });
  backend.attach({ url: `http://127.0.0.1:${server.port}`, token: "tok" });
  t.after(async () => {
    await backend.close();
    await server.close();
  });
  await backend.idle();

  const started = (node: string, scenario: string) =>
    backend.startTask({ node, findingIds: [], prompt: `Work on ${node}. scenario:${scenario}`, manualReview: true });
  const settled = (id: string, state: Task["state"]) =>
    until(() => backend.getState().then((s) => s.tasks.find((x) => x.id === id && x.state === state)), `task ${id} ${state}`);
  const asking = await settled((await started(ASKING_NODE, "ask")).id, "needs_input");
  const running = await settled((await started(RUNNING_NODE, "hang")).id, "running");

  const { bootApp } = await importTsx<typeof import("./app-smoke.tsx")>("./app-smoke.tsx");
  const app = await bootApp(`http://127.0.0.1:${server.port}`, "tok");
  t.after(() => app.close());
  return { backend, prs, app, asking, running, byClass: (cls) => app.find((n) => n.getAttribute("class") === cls) };
}

async function answerInPanel({ app, byClass }: Ui, text: string) {
  const textarea = app.find((n) => n.localName === "textarea")[0] as unknown as { value: string; dispatch(t: string): void };
  textarea.value = text;
  textarea.dispatch("input");
  const submit = app.find((n) => n.localName === "button" && n.textContent === "Answer")[0];
  await app.waitFor(() => submit.getAttribute("disabled") === null, "answer button to enable");
  byClass("answer")[0].dispatch("submit");
  return textarea;
}

test("the UI boots against the server and repo backend, opens nodes and answers questions", UI_TIMEOUT, async (t) => {
  const ui = await bootUi(t);
  const { app, backend, asking, byClass } = ui;
  await app.waitFor(() => app.text().includes("Needs you") && app.text().includes("Scan coverage"), "overview");
  const state = await backend.getState();
  const glyphs = app.find((n) => /^node( |$)/.test(n.getAttribute("class") ?? ""));
  assert.equal(glyphs.length, Object.keys(state.tree.nodes).length, "a small tree is shown fully expanded");

  const item = byClass("row clickable").find((n) => n.textContent.includes(asking.question!))!;
  item.dispatch("click");
  await app.waitFor(() => app.text().includes("Composite") && byClass("answer").length === 1, "node panel with question");

  await answerInPanel(ui, "keep the old error type");
  await app.waitFor(() => byClass("answer").length === 0, "answered task to resume");
  assert.notEqual((await backend.getState()).tasks.find((x) => x.id === asking.id)!.state, "needs_input");
  assert.match(await backend.taskLog(asking.id, 50), /answer: keep the old error type/);

  const before = state.tasks.length;
  const startButtons = () => app.find((n) => n.localName === "button" && n.textContent === "Start");
  await app.waitFor(() => startButtons().length > 0, "suggestions with Start buttons");
  startButtons()[0].dispatch("click");
  await app.waitFor(() => byClass("dialog").length === 1, "start dialog");
  const options = () => byClass("dialog")[0].querySelectorAll((n) => n.localName === "option").map((n) => n.textContent);
  await app.waitFor(() => options().includes("fake/beta"), "models from pi in the start dialog");
  assert.deepEqual(options(), ["pi default", "fake/alpha", "fake/beta"]);
  const picker = byClass("dialog")[0].querySelectorAll((n) => n.localName === "select")[0] as unknown as { value: string; dispatch(t: string): void };
  picker.value = "fake/beta";
  picker.dispatch("change");
  await new Promise((r) => setTimeout(r, 0)); // let Preact re-render with the picked model before submitting
  byClass("dialog")[0].dispatch("submit");
  await app.waitFor(() => byClass("dialog").length === 0, "dialog to close");
  const tasks = await tasksAfter(backend, before);
  assert.equal(tasks.length, before + 1);
  assert.equal(tasks.at(-1)!.model, "fake/beta");
});

/** Open the start dialog of the first suggestion and return its parts. */
async function openStartDialog({ app, byClass }: Ui) {
  await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
  const start = () => app.find((n) => n.localName === "button" && n.textContent === "Start");
  await app.waitFor(() => start().length > 0, "suggestions with Start buttons");
  start()[0].dispatch("click");
  await app.waitFor(() => byClass("dialog").length === 1, "start dialog");
  const dialog = byClass("dialog")[0];
  const submitButton = dialog.querySelectorAll((n) => n.localName === "button" && n.textContent === "Start")[0];
  return { dialog, submitButton };
}

test("the start dialog waits for the model list, so the default model is never skipped", UI_TIMEOUT, async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ui = await bootUi(t, (real) => ({ ...delegate(real), models: () => gate.then(() => ({ default: "fake/beta", models: ["fake/alpha", "fake/beta"] })) }));
  const { dialog, submitButton } = await openStartDialog(ui);
  const before = (await ui.backend.getState()).tasks.length;
  assert.notEqual(submitButton.getAttribute("disabled"), null, "Start is disabled while models load");
  dialog.dispatch("submit");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await ui.backend.getState()).tasks.length, before, "submitting early starts nothing");

  release();
  await ui.app.waitFor(() => submitButton.getAttribute("disabled") === null, "Start enabled once models load");
  dialog.dispatch("submit");
  await ui.app.waitFor(() => ui.byClass("dialog").length === 0, "dialog to close");
  assert.equal((await ui.backend.getState()).tasks.at(-1)!.model, "fake/beta");
});

/** The task list once the dialog's fire-and-forget start has added a task (the dialog closes before the POST resolves). */
async function tasksAfter(backend: { getState(): Promise<{ tasks: Task[] }> }, before: number): Promise<Task[]> {
  for (let i = 0; i < 250; i++) {
    const { tasks } = await backend.getState();
    if (tasks.length > before) return tasks;
    await new Promise((r) => setTimeout(r, 20));
  }
  return (await backend.getState()).tasks;
}

test("when the model list fails the start dialog says so and starts on pi's default", UI_TIMEOUT, async (t) => {
  const ui = await bootUi(t, (real) => ({ ...delegate(real), models: () => Promise.reject(new HttpError(503, "backend not attached")) }));
  const { dialog, submitButton } = await openStartDialog(ui);
  await ui.app.waitFor(() => submitButton.getAttribute("disabled") === null, "Start enabled after the failure");
  assert.match(dialog.textContent, /Could not load models/);
  const before = (await ui.backend.getState()).tasks.length;
  dialog.dispatch("submit");
  await ui.app.waitFor(() => ui.byClass("dialog").length === 0, "dialog to close");
  const tasks = await tasksAfter(ui.backend, before);
  assert.equal(tasks.length, before + 1);
  assert.equal(tasks.at(-1)!.model, undefined);
});

test("the node panel lists its own calls to action, then its children's, which select their node", UI_TIMEOUT, async (t) => {
  const { app, backend, byClass } = await bootUi(t);
  const state = await backend.getState();
  await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
  app.find((n) => n.getAttribute("class") === "label" && n.textContent === state.repo.name)[0].dispatch("click");
  await app.waitFor(() => byClass("row clickable cta-child").length > 0, "children's calls to action");

  const { childCtas } = await backend.getNode("");
  const rows = byClass("row clickable cta-child");
  assert.equal(rows.length, childCtas.length);
  assert.ok(rows.length <= 10);
  const text = byClass("panel")[0].textContent;
  assert.ok(text.indexOf("This node") < text.indexOf("From children"), "own section first");
  assert.ok(text.indexOf("From children") < text.indexOf("Composite"), "calls to action before the breakdown");
  assert.ok(rows[0].textContent.includes(childCtas[0].reason) && rows[0].textContent.includes(childCtas[0].node));

  rows[0].dispatch("click");
  const child = state.tree.nodes[childCtas[0].node];
  await app.waitFor(() => app.find((n) => n.localName === "h2")[0]?.textContent === child.name, "child node panel");
  const title = childCtas[0].task?.title ?? childCtas[0].pr?.title ?? childCtas[0].suggestion!.title;
  await app.waitFor(() => {
    const own = app.find((n) => n.getAttribute("class") === "ctas")[0];
    return own?.textContent.includes(title) ?? false;
  }, "the call to action under This node");
});

test("children's calls to action follow descendant task changes while the panel is open", UI_TIMEOUT, async (t) => {
  const { app, backend, running } = await bootUi(t);
  const asking = () =>
    app.find((n) => n.getAttribute("class") === "row clickable cta-child" && n.textContent.includes("needs input")).length;
  const state = await backend.getState();
  await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
  app.find((n) => n.getAttribute("class") === "label" && n.textContent === state.repo.name)[0].dispatch("click");
  await app.waitFor(() => asking() > 0, "root panel with a question from a descendant");
  const before = asking();

  await backend.report(running.id, { needs_input: "Which error type?" });
  await app.waitFor(() => asking() === before + 1, "new question listed under From children");

  await backend.answer(running.id, "the old one");
  await app.waitFor(() => asking() === before, "answered question removed from From children");
});

test("a merged or closed PR disappears from the open node panel", UI_TIMEOUT, async (t) => {
  const { app, backend, prs } = await bootUi(t);
  const [open] = prs.list();
  await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
  const name = (await backend.getState()).tree.nodes[open.node].name;
  app.find((n) => n.getAttribute("class") === "label" && n.textContent === name)[0].dispatch("click");
  const prBadges = () => app.find((n) => (n.getAttribute("class") ?? "").startsWith("badge pr")).length;
  await app.waitFor(() => app.text().includes(open.title) && prBadges() === 1, "panel listing the PR and its tree badge");

  prs.merge(open.number);
  await app.waitFor(() => !app.text().includes(open.title), "PR dropped from the panel");
  assert.equal(prBadges(), 0, "PR badge dropped from the tree");
});

test("the UI resyncs after reconnects and never acts on stale or failed data", UI_TIMEOUT, async (t) => {
  const calls = { getState: 0, getOverview: 0 };
  const fail = { answer: false, rootNode: false };
  const listeners = new Set<(e: ServerEvent) => void>();
  const ui = await bootUi(t, (real) => ({
    ...delegate(real),
    getState: () => (calls.getState++, real.getState()),
    getOverview: () => (calls.getOverview++, real.getOverview()),
    getNode: (id) => (fail.rootNode && id === "" ? Promise.reject(new HttpError(500, "boom")) : real.getNode(id)),
    answer: (id, text) => (fail.answer ? Promise.reject(new HttpError(409, "wrong state")) : real.answer(id, text)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }));
  const { app, backend, asking, byClass } = ui;
  await app.waitFor(() => app.text().includes("Scan coverage") && listeners.size === 1, "overview and event stream");
  const state = await backend.getState();

  const [healthy] = state.prs;
  const overviews = calls.getOverview;
  listeners.forEach((l) => l({ type: "pr", pr: { ...healthy, stale: true } }));
  await app.waitFor(() => calls.getOverview > overviews, "overview refetch when a PR turns stale");

  const states = calls.getState;
  app.reconnect();
  await app.waitFor(() => calls.getState > states, "state refetch after reconnect");

  byClass("row clickable").find((n) => n.textContent.includes(asking.question!))!.dispatch("click");
  await app.waitFor(() => byClass("answer").length === 1 && app.text().includes("This node"), "panel with question");
  fail.answer = true;
  const textarea = await answerInPanel(ui, "keep the old error type");
  await app.waitFor(() => app.text().includes("wrong state"), "error shown");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(textarea.value, "keep the old error type");

  fail.rootNode = true;
  const rootLabel = app.find((n) => n.getAttribute("class") === "label" && n.textContent === state.repo.name)[0];
  rootLabel.dispatch("click");
  await app.waitFor(() => app.find((n) => n.localName === "h2")[0]?.textContent === state.repo.name, "root panel");
  await app.waitFor(() => app.text().includes("internal error"), "root detail failure shown");
  assert.ok(!app.text().includes("This node"), "previous node's calls to action still shown");
  assert.equal(app.find((n) => n.localName === "button" && n.textContent === "Start").length, 0);
});

/** Open the node panel of `node` and return the task row (in the Tasks list) whose text includes `title`. */
async function taskRow({ app, backend }: Ui, node: string, title: string) {
  await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
  const name = (await backend.getState()).tree.nodes[node].name;
  app.find((n) => n.getAttribute("class") === "label" && n.textContent === name)[0].dispatch("click");
  const row = () => app.find((n) => n.getAttribute("class") === "task" && n.textContent.includes(title))[0];
  await app.waitFor(() => row() !== undefined, `task row ${title}`);
  return row;
}

const buttons = (row: ReturnType<SmokeDriver["find"]>[number]) =>
  row.querySelectorAll((n) => n.localName === "button").map((b) => b.textContent);

test("the task action bar shows each action only in the states it applies to", UI_TIMEOUT, async (t) => {
  const ui = await bootUi(t);
  const review = await ui.backend.startTask({ node: RUNNING_NODE, findingIds: [], title: "Reviewable", prompt: "scenario:happy", manualReview: true });
  await until(() => ui.backend.getState().then((s) => s.tasks.find((x) => x.id === review.id && x.state === "review")), "review");

  const running = await taskRow(ui, RUNNING_NODE, ui.running.title);
  assert.deepEqual(buttons(running()), ["Cancel", "Discard", "Log", "Diff", "Chat", "Open shell", "Open agent"]);
  const agent = running().querySelectorAll((n) => n.localName === "button" && n.textContent === "Open agent")[0];
  assert.notEqual(agent.getAttribute("disabled"), null, "agent mode waits for the live worker");

  const reviewing = () => ui.app.find((n) => n.getAttribute("class") === "task" && n.textContent.includes("Reviewable"))[0];
  await ui.app.waitFor(() => reviewing() !== undefined, "review task row");
  assert.deepEqual(buttons(reviewing()), ["Open PR", "Cancel", "Discard", "Log", "Diff", "Chat", "Open shell", "Open agent"]);
  await ui.app.waitFor(() => reviewing().querySelectorAll((n) => n.getAttribute("class") === "diff").length === 1, "diff open in review");

  await ui.backend.cancel(ui.running.id);
  await ui.app.waitFor(() => !buttons(running()).includes("Cancel"), "no cancel once failed");
  assert.deepEqual(buttons(running()), ["Discard", "Log", "Diff", "Chat", "Open shell", "Open agent"]);
});

test("the chat pane shows the transcript, sends messages to the agent and follows replies", UI_TIMEOUT, async (t) => {
  const ui = await bootUi(t);
  const row = await taskRow(ui, RUNNING_NODE, ui.running.title);
  row().querySelectorAll((n) => n.localName === "button" && n.textContent === "Chat")[0].dispatch("click");
  const pane = () => row().querySelectorAll((n) => n.getAttribute("class") === "chat")[0];
  await ui.app.waitFor(() => pane()?.textContent.includes("scenario:hang") ?? false, "transcript with the initial prompt");

  const input = pane().querySelectorAll((n) => n.localName === "textarea")[0] as unknown as { value: string; dispatch(t: string): void };
  input.value = "see https://example.com/doc";
  input.dispatch("input");
  const send = () => pane().querySelectorAll((n) => n.localName === "button" && n.textContent === "Send")[0];
  await ui.app.waitFor(() => send().getAttribute("disabled") === null, "send enabled");
  pane().querySelectorAll((n) => n.localName === "form")[0].dispatch("submit");

  await ui.app.waitFor(() => pane().textContent.includes("see https://example.com/doc"), "message in the transcript");
  assert.match(await ui.backend.taskLog(ui.running.id, 50), /prompt: see https:\/\/example.com\/doc/);
  const link = pane().querySelectorAll((n) => n.localName === "a" && n.getAttribute("href") === "https://example.com/doc");
  assert.equal(link.length, 1, "URLs in the chat are links");
});
