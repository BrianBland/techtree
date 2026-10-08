import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { RepoBackend, type PrSource } from "../../src/backend/backend.ts";
import { mergeConfig } from "../../src/config.ts";
import { openDb, suppressSqliteWarning } from "../../src/db.ts";
import { HttpError, type Backend } from "../../src/server/backend.ts";
import { startServer } from "../../src/server/server.ts";
import type { ApiComposition, Bundle, PrState, ServerEvent, Task } from "../../src/types.ts";
import { FAKE_PI, TODO_FILE, fixture, until, withEnv } from "../backend/helpers.ts";
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
    return { left: Math.min(...own.map((b) => b.left)), right: Math.max(...own.map((b) => b.right)) };
  };
  assert.ok(boxes.some((b) => b.cls === "glow") && boxes.some((b) => b.cls === "ring"), "decorations rendered");
  const [a, b, c] = ["n0", "n1", "n2"].map(extent);
  // Rings and glows are stroked 2 units wide, half of it outside their box.
  assert.ok(a.right + 1 < b.left - 1, `n0 ${JSON.stringify(a)} overlaps n1 ${JSON.stringify(b)}`);
  assert.ok(b.right + 1 < c.left - 1, `n1 ${JSON.stringify(b)} overlaps n2 ${JSON.stringify(c)}`);
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
    autoBabysit: () => false,
    setAutoBabysit: () => {},
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
    listProjects: () => real.listProjects(),
    createProject: (input) => real.createProject(input),
    refine: (input) => real.refine(input),
    findings: (ids, project) => real.findings(ids, project),
    updateProject: (id, input) => real.updateProject(id, input),
    deleteProject: (id) => real.deleteProject(id),
    getState: (project) => real.getState(project),
    getNode: (id, project) => real.getNode(id, project),
    getOverview: (project) => real.getOverview(project),
    taskLog: (id, tail) => real.taskLog(id, tail),
    taskDiff: (id) => real.taskDiff(id),
    acceptScorer: (id) => real.acceptScorer(id),
    models: () => real.models(),
    startTask: (req) => real.startTask(req),
    answer: (id, text) => real.answer(id, text),
    openPr: (id) => real.openPr(id),
    cancel: (id) => real.cancel(id),
    stage: (id) => real.stage(id),
    unstage: (id) => real.unstage(id),
    createBundle: (input) => real.createBundle(input),
    startBundle: (input) => real.startBundle(input),
    listBundles: (project) => real.listBundles(project),
    getComposition: (project) => real.getComposition(project),
    planComposition: (project) => real.planComposition(project),
    setAutoComposition: (on, project) => real.setAutoComposition(on, project),
    publishComposition: (input) => real.publishComposition(input),
    dismiss: (ids, reason, project) => real.dismiss(ids, reason, project),
    undismiss: (ids) => real.undismiss(ids),
    message: (id, text) => real.message(id, text),
    chat: (id) => real.chat(id),
    openTerminal: (id, mode) => real.openTerminal(id, mode),
    discard: (id) => real.discard(id),
    source: (path, line) => real.source(path, line),
    report: (id, report) => real.report(id, report),
    setBabysit: (n, on) => real.setBabysit(n, on),
    listPrs: () => real.listPrs(),
    setAutoBabysit: (on) => real.setAutoBabysit(on),
    rescore: (project) => real.rescore(project),
    scan: (node, project) => real.scan(node, project),
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
 * `serve` can wrap the backend the server talks to; `files` adds files to the fixture repo.
 */
async function bootUi(t: TestContext, serve: (real: RepoBackend) => Backend = (real) => real, files: Record<string, string> = {}): Promise<Ui> {
  const { tmp, repo, cache } = fixture(t, { "src/net/lib.rs": TODOS, ...files });
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
    until(() => backend.getState().then((s) => s.tasks.find((x) => x.id === id && x.state === state && (state !== "running" || x.worktree))), `task ${id} ${state}`);
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

test("a stub under the focus expands in place; an ancestor's stub selects its parent", UI_TIMEOUT, async (t) => {
  const wide = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`wide/a${i}/x.rs`, "fn x() {}\n"]));
  const { app, byClass } = await bootUi(t, undefined, wide);
  await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
  const label = (g: ReturnType<SmokeDriver["find"]>[number]) => g.querySelectorAll((n) => n.getAttribute("class") === "label")[0]?.textContent;
  const tiles = () => app.find((n) => /^node( |$)/.test(n.getAttribute("class") ?? ""));
  const tile = (name: string) => tiles().find((g) => label(g) === name);
  const stubs = () => byClass("stub");
  const shownUnderWide = () => tiles().filter((g) => /^a\d$/.test(label(g) ?? "")).length;

  await app.waitFor(() => stubs().some((g) => label(g) === "+4 more"), "wide's +4 more stub under the root focus");
  assert.equal(shownUnderWide(), 2);
  stubs().find((g) => label(g) === "+4 more")!.dispatch("click");
  await app.waitFor(() => shownUnderWide() === 6, "the stub to expand wide in place");
  assert.ok(app.text().includes("Scan coverage"), "nothing got selected");
  assert.ok(tile("src"), "the root focus is kept");

  tile("a0")!.dispatch("click");
  await app.waitFor(() => stubs().some((g) => label(g) === "+2 more"), "a0 focused, with wide's siblings folded");
  stubs().find((g) => label(g) === "+2 more")!.dispatch("click");
  await app.waitFor(() => byClass("node selected").map(label).includes("wide"), "the ancestor stub to select wide");
  assert.equal(shownUnderWide(), 6, "wide is the focus, so all its children show");
});

test("root selection restores root focus and its highlight, but shows the overview sidebar", UI_TIMEOUT, async (t) => {
  const urls = recordUrls(t);
  const { app, backend, byClass } = await bootUi(t, (real) => ({
    ...delegate(real),
    getState: async () => {
      const state = await real.getState();
      return { ...state, scores: { ...state.scores, [RUNNING_NODE]: { ...state.scores[RUNNING_NODE], quality: null } } };
    },
  }), Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`sibling${i}/lib.rs`, "fn sibling() {}\n"])));
  const state = await backend.getState();
  await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
  assert.ok(app.find((n) => n.getAttribute("class") === "work-effect question").length >= 2, "question edges reach root");
  const edgeClasses = app.find((n) => (n.getAttribute("class") ?? "").startsWith("work-effect ")).map((n) => n.getAttribute("class"));
  assert.ok(edgeClasses.lastIndexOf("work-effect question") > edgeClasses.lastIndexOf("work-effect running"), "stronger effects paint last on shared buses");
  const root = app.find((n) => /^node( |$)/.test(n.getAttribute("class") ?? "") && n.querySelectorAll((c) => c.localName === "title")[0]?.textContent.startsWith(state.repo.name))[0];
  assert.equal(root.querySelectorAll((n) => n.getAttribute("class") === "glow").length, 0, "ancestor tile does not inherit glow");
  assert.ok(app.find((n) => n.getAttribute("class") === "badge actioned").length >= 2, "actioned task counts shown");
  assert.equal(app.find((n) => n.getAttribute("class") === "badge findings").length, 0, "findings are not presented as task counts");
  const tile = (name: string) => app.find((n) => n.getAttribute("class") === "label" && n.textContent === name)[0];
  const selected = () => app.find((n) => (n.getAttribute("class") ?? "").split(" ").includes("selected"));
  const tiles = () => app.find((n) => /^node( |$)/.test(n.getAttribute("class") ?? ""));
  const rootNodes = tiles().length;
  tile(state.tree.nodes[ASKING_NODE].name).dispatch("click");
  await app.waitFor(() => byClass("answer").length === 1, "net focused");
  const focusedNodes = tiles().length;
  assert.ok(rootNodes > focusedNodes, "a deep focus folds root siblings");
  assert.match(urls.at(-1)!, /focus=src/);
  tile(state.repo.name).dispatch("click");
  await app.waitFor(() => app.text().includes("Scan coverage") && selected().length === 1, "root selected with overview");
  assert.equal(selected()[0].querySelectorAll((n) => n.getAttribute("class") === "label")[0].textContent, state.repo.name);
  assert.equal(tiles().length, rootNodes, "root focus restores rendered siblings");
  assert.equal(urls.at(-1), "/", "root focus clears the URL parameter");
  tile(state.tree.nodes[ASKING_NODE].name).dispatch("click");
  await app.waitFor(() => byClass("answer").length === 1, "net panel reopened");
  app.find((n) => n.localName === "button" && n.textContent === "close")[0].dispatch("click");
  await app.waitFor(() => app.text().includes("Scan coverage"), "Close returns to overview");
  assert.equal(selected().length, 0);
  assert.equal(tiles().length, focusedNodes, "Close still preserves the deep focus");
  await backend.startTask({ node: "", title: "Root worker", findingIds: [], prompt: "scenario:hang", manualReview: true });
  const rootTask = () => byClass("row clickable").find((n) => n.textContent.includes("Root worker"));
  await app.waitFor(() => rootTask() !== undefined, "root task in overview");
  rootTask()!.dispatch("click");
  await app.waitFor(() => selected().length === 1 && tiles().length === rootNodes, "inbox root selection restores root focus");
  assert.ok(app.text().includes("Scan coverage"), "root selections from inbox also show overview");
  assert.equal(urls.at(-1), "/");
  const priority = app.find((n) => n.localName === "select" && n.textContent === "ActiveInactive")[0];
  assert.ok(priority, "activity priority control");
  const hide = app.find((n) => n.localName === "label" && n.textContent === "Hide unscored")[0];
  assert.ok(hide, "unscored visibility control");
  const mode = priority as unknown as { value: string; dispatch(type: string): void };
  mode.value = "inactive";
  mode.dispatch("change");
  await app.waitFor(() => mode.value === "inactive", "inactive priority selected");
  const checkbox = hide.querySelectorAll((n) => n.localName === "input")[0] as unknown as { checked: boolean; dispatch(type: string): void };
  checkbox.checked = true;
  checkbox.dispatch("change");
  await app.waitFor(() => tile(state.tree.nodes[RUNNING_NODE].name) === undefined, "gray leaf hidden");
  assert.ok(tile(state.repo.name), "root retained");
  checkbox.checked = false;
  checkbox.dispatch("change");
  await app.waitFor(() => tile(state.tree.nodes[RUNNING_NODE].name) !== undefined, "gray leaf restored");
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

async function openParentTask(ui: Ui) {
  ui.app.find((n) => n.localName === "button" && n.textContent === "close")[0]?.dispatch("click");
  await ui.backend.startTask({ node: "src", title: "Parent worker", findingIds: [], prompt: "scenario:hang", manualReview: true });
  const row = () => ui.byClass("row clickable").find((n) => n.textContent.includes("Parent worker"));
  await ui.app.waitFor(() => row() !== undefined, "parent worker in overview");
  row()!.dispatch("click");
}

test("the node panel lists its own calls to action, then its children's, which select their node", UI_TIMEOUT, async (t) => {
  const ui = await bootUi(t);
  const { app, backend, byClass } = ui;
  const state = await backend.getState();
  await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
  await openParentTask(ui);
  await app.waitFor(() => byClass("row clickable cta-child").length > 0, "children's calls to action");

  const { childCtas } = await backend.getNode("src");
  const rows = byClass("row clickable cta-child");
  assert.equal(rows.length, childCtas.length);
  assert.ok(rows.length <= 10);
  const text = byClass("panel")[0].textContent;
  assert.ok(text.indexOf("This node") < text.indexOf("From children"), "own section first");
  assert.ok(text.indexOf("From children") < text.indexOf("Composite"), "calls to action before the breakdown");
  assert.ok(rows[0].textContent.includes(childCtas[0].reason) && rows[0].textContent.includes(childCtas[0].node.slice("src/".length)));

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
  const ui = await bootUi(t);
  const { app, backend, running } = ui;
  const asking = () =>
    app.find((n) => n.getAttribute("class") === "row clickable cta-child" && n.textContent.includes("needs input")).length;
  const state = await backend.getState();
  await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
  await openParentTask(ui);
  await app.waitFor(() => asking() > 0, "parent panel with a question from a descendant");
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
  const fail = { answer: false, parentNode: false };
  const listeners = new Set<(e: ServerEvent) => void>();
  const ui = await bootUi(t, (real) => ({
    ...delegate(real),
    getState: () => (calls.getState++, real.getState()),
    getOverview: () => (calls.getOverview++, real.getOverview()),
    getNode: (id) => (fail.parentNode && id === "src" ? Promise.reject(new HttpError(500, "boom")) : real.getNode(id)),
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

  fail.parentNode = true;
  await openParentTask(ui);
  await app.waitFor(() => app.find((n) => n.localName === "h2")[0]?.textContent === "src", "parent panel");
  await app.waitFor(() => app.text().includes("internal error"), "parent detail failure shown");
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
  assert.deepEqual(buttons(reviewing()), ["Open PR", "Stage", "Cancel", "Discard", "Log", "Diff", "Chat", "Open shell", "Open agent"]);
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

test("chat events that arrive while the transcript loads stay in the pane", UI_TIMEOUT, async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ui = await bootUi(t, (real) => ({
    ...delegate(real),
    chat: async (id) => {
      const snapshot = await real.chat(id);
      await gate;
      return snapshot;
    },
  }));
  const row = await taskRow(ui, RUNNING_NODE, ui.running.title);
  row().querySelectorAll((n) => n.localName === "button" && n.textContent === "Chat")[0].dispatch("click");
  const pane = () => row().querySelectorAll((n) => n.getAttribute("class") === "chat")[0];
  await ui.app.waitFor(() => pane() !== undefined, "chat pane");
  await new Promise((r) => setTimeout(r, 50)); // the server has taken its snapshot
  await ui.backend.message(ui.running.id, "sent while loading");
  await ui.app.waitFor(() => pane().textContent.includes("sent while loading"), "live message shown");
  release();
  await ui.app.waitFor(() => pane().textContent.includes("scenario:hang"), "snapshot merged");
  assert.ok(pane().textContent.includes("sent while loading"), "the live message survives the snapshot");
});

/** Record the URLs the app writes with `history.replaceState`, for the rest of the test. */
function recordUrls(t: TestContext): string[] {
  const urls: string[] = [];
  Object.assign(globalThis, { location: { search: "", pathname: "/" }, history: { replaceState: (_s: unknown, _t: string, url: string) => urls.push(url) } });
  t.after(() => {
    delete (globalThis as { location?: unknown }).location;
    delete (globalThis as { history?: unknown }).history;
  });
  return urls;
}

test("the project switcher creates a project, switches the view and keeps it in the URL", UI_TIMEOUT, async (t) => {
  const urls = recordUrls(t);
  const { app, backend } = await bootUi(t);
  await app.waitFor(() => app.text().includes("Scan coverage"), "Quality overview");
  const switcher = () => app.find((n) => n.getAttribute("class") === "project-switcher")[0] as unknown as SmokeDriver["root"] & { value: string };
  const choose = (value: string) => {
    switcher().value = value;
    switcher().dispatch("change");
  };
  const type = (tag: string, value: string) => {
    const field = app.find((n) => n.getAttribute("class") === "dialog project-dialog")[0].querySelectorAll((n) => n.localName === tag)[0] as unknown as { value: string; dispatch(t: string): void };
    field.value = value;
    field.dispatch("input");
  };

  choose("__new");
  await app.waitFor(() => app.text().includes("New project"), "new project dialog");
  type("input", "Faster startup");
  type("textarea", "cold start below 1 s");
  await new Promise((r) => setTimeout(r, 0));
  app.find((n) => n.getAttribute("class") === "dialog project-dialog")[0].dispatch("submit");
  await app.waitFor(() => app.text().includes("No scorer yet") && app.text().includes("cold start below 1 s"), "the new project's overview");
  assert.deepEqual((await backend.listProjects()).map((p) => p.id), ["quality", "faster-startup"]);
  assert.equal(urls.at(-1), "?project=faster-startup");
  assert.ok(!app.text().includes("Scan coverage"), "no scorer, no scan coverage");

  const heading = () => app.find((n) => n.localName === "h2")[0]?.textContent;
  choose("all");
  await app.waitFor(() => heading() === "All projects" && app.text().includes("Top suggestions") && urls.at(-1) === "?project=all", "cross-project overview in the URL");
  assert.ok(app.find((n) => n.getAttribute("class") === "project-tag").some((n) => n.textContent === "Quality"), "items are labelled with their project");

  choose("quality");
  await app.waitFor(() => heading() === "Quality" && app.text().includes("Scan coverage"), "back to Quality");
  assert.equal(urls.at(-1), "/");
});

test("Quality settings edit its scorer and the UI recovers when the last project is deleted", UI_TIMEOUT, async (t) => {
  const { app, backend } = await bootUi(t);
  await app.waitFor(() => app.text().includes("Refine scorer"), "Quality scorer action");
  app.find((n) => n.localName === "button" && n.getAttribute("title") === "Project settings")[0].dispatch("click");
  await app.waitFor(() => app.text().includes("Metric plugins"), "Quality scorer settings");
  const dialog = app.find((n) => n.getAttribute("class") === "dialog project-dialog")[0];
  assert.ok(dialog.querySelectorAll((n) => n.localName === "button" && n.textContent === "Delete").length);
  for (const checkbox of dialog.querySelectorAll((n) => n.localName === "input" && n.getAttribute("type") === "checkbox")) {
    (checkbox as unknown as { checked: boolean }).checked = false;
    checkbox.dispatch("change");
    await new Promise((r) => setTimeout(r, 0));
  }
  dialog.dispatch("submit");
  await backend.idle();
  await app.waitFor(() => app.text().includes("No scorer yet"), "Quality without plugins");
  assert.deepEqual((await backend.getState()).project.scorer, {});
  for (const task of (await backend.getState()).tasks) await backend.discard(task.id);
  await backend.deleteProject("quality");
  app.reconnect();
  await app.waitFor(() => app.text().includes("No projects. Create one"), "empty projects UI");
  const switcher = app.find((n) => n.getAttribute("class") === "project-switcher")[0] as unknown as { value: string; dispatch(t: string): void };
  switcher.value = "__new";
  switcher.dispatch("change");
  await app.waitFor(() => app.text().includes("New project"), "creation remains available");
  const createdDialog = app.find((n) => n.getAttribute("class") === "dialog project-dialog")[0];
  const name = createdDialog.querySelectorAll((n) => n.localName === "input")[0] as unknown as { value: string; dispatch(t: string): void };
  name.value = "Quality";
  name.dispatch("input");
  await new Promise((r) => setTimeout(r, 0));
  createdDialog.dispatch("submit");
  await app.waitFor(() => app.text().includes("No scorer yet"), "recreated Quality loads without another event");
  assert.equal((await backend.getState()).project.id, "quality");
});

test("New task here starts a free-form task in the selected project", UI_TIMEOUT, async (t) => {
  const { app, backend, byClass } = await bootUi(t);
  const perf = await backend.createProject({ name: "Perf" });
  await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
  const switcher = app.find((n) => n.getAttribute("class") === "project-switcher")[0] as unknown as { value: string; dispatch(t: string): void };
  switcher.value = perf.id;
  switcher.dispatch("change");
  await app.waitFor(() => app.text().includes("No scorer yet"), "Perf overview");
  const state = await backend.getState();
  app.find((n) => n.getAttribute("class") === "label" && n.textContent === state.tree.nodes[ASKING_NODE].name)[0].dispatch("click");
  const newTask = () => app.find((n) => n.localName === "button" && n.textContent === "New task here");
  await app.waitFor(() => newTask().length === 1, "node panel");
  assert.ok(!app.text().includes("Scan subtree"), "no scorer, nothing to scan");
  newTask()[0].dispatch("click");
  await app.waitFor(() => byClass("dialog").length === 1, "start dialog");
  const dialog = byClass("dialog")[0];
  const start = dialog.querySelectorAll((n) => n.localName === "button" && n.textContent === "Start")[0];
  await new Promise((r) => setTimeout(r, 50));
  assert.notEqual(start.getAttribute("disabled"), null, "an empty prompt cannot start");
  const prompt = dialog.querySelectorAll((n) => n.localName === "textarea")[0] as unknown as { value: string; dispatch(t: string): void };
  prompt.value = "Profile the startup path. scenario:hang";
  prompt.dispatch("input");
  await app.waitFor(() => start.getAttribute("disabled") === null, "Start enabled");
  dialog.dispatch("submit");
  const task = await until(async () => (await backend.getState(perf.id)).tasks[0], "the Perf task");
  assert.equal(task.node, ASKING_NODE);
  assert.match(task.prompt, /^Profile the startup path/);
});

test("dragging the inbox's right edge resizes it within bounds, remembers the width and double-click resets it", UI_TIMEOUT, async (t) => {
  const stored = new Map([["techtree.panelWidth", "500"]]);
  const localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) };
  Object.assign(globalThis, { localStorage, innerWidth: 1600 });
  t.after(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    delete (globalThis as { innerWidth?: unknown }).innerWidth;
  });
  const { app, byClass } = await bootUi(t);
  const handle = () => app.find((n) => n.getAttribute("aria-label") === "Resize inbox")[0];
  const width = () => handle().getAttribute("aria-valuenow");
  const tick = () => new Promise((r) => setTimeout(r, 0));
  await app.waitFor(() => byClass("panel-resizer").length === 2, "resize handles");
  assert.equal(width(), "500", "the saved width is restored");

  const drag = async (from: number, to: number) => {
    handle().dispatch("pointerdown", { clientX: from, pointerId: 1 });
    await tick();
    handle().dispatch("pointermove", { clientX: to, pointerId: 1 });
    await tick();
    handle().dispatch("pointerup", { pointerId: 1 });
    await tick();
  };
  await drag(800, 1000);
  assert.deepEqual([width(), stored.get("techtree.panelWidth")], ["700", "700"]);
  await drag(0, 1000);
  assert.equal(width(), "1200", "at most 75% of the window");
  await drag(1500, 500);
  assert.equal(width(), "320", "at least 320 px");

  handle().dispatch("dblclick");
  await tick();
  assert.equal(width(), "440");
  assert.equal(stored.has("techtree.panelWidth"), false);
});

test("the inbox is on the left, the tree in the middle and the outbox on the right, listing open PRs by section", UI_TIMEOUT, async (t) => {
  const { app } = await bootUi(t);
  await app.waitFor(() => app.text().includes("Outbox") && app.text().includes("Tidy the util helpers"), "outbox with the PR");
  const main = app.find((n) => n.localName === "main")[0];
  const classes = main.childNodes.map((n) => n.getAttribute("class") ?? "");
  const at = (cls: string) => classes.findIndex((c) => c.split(" ").includes(cls));
  assert.ok(at("panel-column") < at("tree") && at("tree") < at("outbox"), classes.join(" | "));
  const outbox = main.childNodes[at("outbox")];
  assert.ok(outbox.textContent.includes("Waiting") && outbox.textContent.includes("waiting for review"), outbox.textContent);
  assert.ok(!main.childNodes[at("panel-column")].textContent.includes("Tidy the util helpers"), "PRs left the inbox overview");
});

test("an outbox row moving to another section keeps its open task and unsent chat draft", UI_TIMEOUT, async (t) => {
  const { app, backend, prs, running } = await bootUi(t);
  prs.list()[0].taskId = running.id;
  await app.waitFor(() => app.text().includes("Outbox"), "outbox");
  app.reconnect();
  const outbox = () => app.find((n) => (n.getAttribute("class") ?? "").includes("panel outbox"))[0];
  const inOutbox = (pred: (n: SmokeDriver["root"]) => boolean) => outbox().querySelectorAll(pred);
  const button = (label: string) => inOutbox((n) => n.localName === "button" && n.textContent === label)[0];
  await app.waitFor(() => button("▸ task") !== undefined, "expand control for the linked task");
  button("▸ task").dispatch("click");
  await app.waitFor(() => button("Chat") !== undefined, "task action bar");
  button("Chat").dispatch("click");
  await app.waitFor(() => inOutbox((n) => n.localName === "textarea").length === 1, "chat pane");
  const draft = inOutbox((n) => n.localName === "textarea")[0] as unknown as { value: string; dispatch(t: string): void };
  draft.value = "half-typed";
  draft.dispatch("input");

  await backend.report(running.id, { needs_input: "Which fix?" });
  await app.waitFor(() => outbox().textContent.includes("agent asks: Which fix?"), "row moved to Needs you");
  const after = inOutbox((n) => n.localName === "textarea")[0] as unknown as { value: string } | undefined;
  assert.equal(after?.value, "half-typed");
});

test("switching projects with a node open drops the old project's actions; All projects shows the overview", UI_TIMEOUT, async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ui = await bootUi(t, (real) => ({ ...delegate(real), getNode: (id, project) => (project === "perf" ? gate : Promise.resolve()).then(() => real.getNode(id, project)) }));
  const { app, backend } = ui;
  await backend.createProject({ name: "Perf" });
  await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
  const switcher = () => app.find((n) => n.getAttribute("class") === "project-switcher")[0] as unknown as SmokeDriver["root"] & { value: string };
  const choose = (value: string) => {
    switcher().value = value;
    switcher().dispatch("change");
  };
  const node = TODO_FILE.slice(0, TODO_FILE.lastIndexOf("/"));
  const name = (await backend.getState()).tree.nodes[node].name;
  app.find((n) => n.getAttribute("class") === "label" && n.textContent === name)[0].dispatch("click");
  const starts = () => app.find((n) => n.localName === "button" && n.textContent === "Start");
  await app.waitFor(() => starts().length > 0, "Quality's suggestion in the node panel");

  app.reconnect(); // refetch the project list, which now includes Perf
  await app.waitFor(() => switcher().querySelectorAll((n) => n.localName === "option").some((o) => o.textContent === "Perf"), "Perf in the switcher");
  choose("perf");
  await app.waitFor(() => app.text().includes("New task here") && !app.text().includes("Scan subtree"), "Perf's node panel");
  assert.equal(starts().length, 0, "no Start for Quality's suggestion while Perf's details load");
  release();

  choose("all");
  await app.waitFor(() => app.find((n) => n.localName === "h2")[0]?.textContent === "All projects", "the cross-project overview");
  await app.waitFor(() => app.text().includes("Projects without a scorer"), "Perf listed without a scorer");
  for (const label of ["Draft scorer", "Plan the work"]) assert.ok(app.find((n) => n.localName === "button" && n.textContent === label).length, label);
});

test("project settings show a scorer saved meanwhile, and saving a new name keeps it", UI_TIMEOUT, async (t) => {
  const { app, backend } = await bootUi(t);
  const perf = await backend.createProject({ name: "Perf" });
  await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
  app.reconnect();
  const switcher = () => app.find((n) => n.getAttribute("class") === "project-switcher")[0] as unknown as SmokeDriver["root"] & { value: string };
  await app.waitFor(() => switcher().querySelectorAll((n) => n.localName === "option").some((o) => o.textContent === "Perf"), "Perf in the switcher");
  switcher().value = perf.id;
  switcher().dispatch("change");
  await app.waitFor(() => app.text().includes("Draft scorer"), "Perf's overview");
  await backend.updateProject(perf.id, { scorer: { rubric: "allocation-heavy hot paths" } }); // e.g. an accepted proposal

  app.find((n) => n.localName === "button" && n.getAttribute("title") === "Project settings")[0].dispatch("click");
  await app.waitFor(() => app.text().includes("Project settings"), "settings dialog");
  const dialog = app.find((n) => n.getAttribute("class") === "dialog project-dialog")[0];
  type Field = { value: string; getAttribute(name: string): string | null; dispatch(t: string): void };
  const [, rubric] = dialog.querySelectorAll((n) => n.localName === "textarea") as unknown as Field[];
  assert.equal(rubric.value ?? rubric.getAttribute("value"), "allocation-heavy hot paths", "the rubric textarea shows the current scorer");
  const name = dialog.querySelectorAll((n) => n.localName === "input")[0] as unknown as Field;
  name.value = "Faster";
  name.dispatch("input");
  await new Promise((r) => setTimeout(r, 0));
  dialog.dispatch("submit");
  await until(async () => (await backend.listProjects()).find((p) => p.id === perf.id)?.name === "Faster", "the rename");
  assert.deepEqual((await backend.listProjects()).find((p) => p.id === perf.id)?.scorer, { rubric: "allocation-heavy hot paths" });
});

test("saving a project's goal shows the new goal", UI_TIMEOUT, async (t) => {
  const { app, backend } = await bootUi(t);
  await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
  app.find((n) => n.localName === "button" && n.getAttribute("title") === "Project settings")[0].dispatch("click");
  await app.waitFor(() => app.text().includes("Project settings"), "settings dialog");
  const dialog = app.find((n) => n.getAttribute("class") === "dialog project-dialog")[0];
  const goal = dialog.querySelectorAll((n) => n.localName === "textarea")[0] as unknown as { value: string; dispatch(t: string): void };
  goal.value = "fewer unwraps";
  goal.dispatch("input");
  await new Promise((r) => setTimeout(r, 0));
  dialog.dispatch("submit");
  await app.waitFor(() => app.text().includes("fewer unwraps") && !app.text().includes("Project settings"), "the new goal in the overview");
  assert.equal((await backend.listProjects())[0].goal, "fewer unwraps");
});

type Toggle = ReturnType<SmokeDriver["find"]>[number] & { checked: boolean };
/** Preact writes `checked` as an attribute until a test assigns the property. */
const isChecked = (box: Toggle) => box.checked ?? box.getAttribute("checked") === "true";

test("the start dialog leaves Open PR automatically unchecked (manual review) unless the user opts in", UI_TIMEOUT, async (t) => {
  const { app, backend, byClass } = await bootUi(t);
  const startButtons = () => app.find((n) => n.localName === "button" && n.textContent === "Start");
  for (const optIn of [false, true]) {
    const before = (await backend.getState()).tasks.length;
    await app.waitFor(() => startButtons().length > 0, "suggestions with Start buttons");
    startButtons()[0].dispatch("click");
    await app.waitFor(() => byClass("dialog").length === 1, "start dialog");
    const label = byClass("dialog")[0].querySelectorAll((n) => n.localName === "label" && n.textContent.includes("Open PR automatically"))[0];
    const box = label.querySelectorAll((n) => n.localName === "input")[0] as Toggle;
    assert.equal(isChecked(box), false);
    if (optIn) {
      box.checked = true;
      box.dispatch("change");
      await new Promise((r) => setTimeout(r, 0));
    }
    await app.waitFor(() => byClass("dialog")[0].querySelectorAll((n) => n.localName === "button" && n.textContent === "Start")[0].getAttribute("disabled") === null, "start enabled");
    byClass("dialog")[0].dispatch("submit");
    await app.waitFor(() => byClass("dialog").length === 0, "dialog to close");
    const tasks = await tasksAfter(backend, before);
    assert.equal(tasks.at(-1)!.manualReview, !optIn);
    await backend.cancel(tasks.at(-1)!.id);
  }
});

test("smart grouping upgrades one staged list with advisory badges and freely publishable selections", UI_TIMEOUT, async (t) => {
  const { tmp } = fixture(t);
  const groups = join(tmp, "groups.json");
  withEnv(t, "FAKE_GROUPS", groups);
  const published: unknown[] = [];
  const combined: unknown[] = [];
  let failPublish = false;
  const ui = await bootUi(t, (real) => ({
    ...delegate(real),
    startBundle: async (input) => {
      combined.push(input);
      if (failPublish) throw new HttpError(409, "selected change needs conflict review");
      const bundle: Bundle = { id: "combined", project: "quality", title: "Selected changes", branch: "combined", worktree: "", taskIds: input.taskIds, pr: 77, url: "https://example.com/pull/77", createdAt: new Date().toISOString() };
      return { ...(await real.getComposition(input.project)), bundleJobs: [{ id: "combined", project: "quality", taskIds: input.taskIds, taskTitles: ["Selected changes"], status: "opened", revision: 1, createdAt: bundle.createdAt, updatedAt: bundle.createdAt, bundle }] };
    },
    publishComposition: async (input) => {
      published.push(input);
      return real.getComposition(input.project);
    },
  }));
  const { app, backend } = ui;
  const reviewed = async (title: string) => {
    const task = await backend.startTask({ node: "", findingIds: [], title, prompt: "scenario:happy", manualReview: true });
    return until(() => backend.getState().then((s) => s.tasks.find((x) => x.id === task.id && x.state === "review")), `${title} in review`);
  };
  const a = await reviewed("Retry validation");
  await backend.stage(a.id);
  const section = () => app.find((n) => n.getAttribute("class") === "staged-bundle")[0];
  const checkboxes = () => section().querySelectorAll((n) => n.localName === "input" && n.getAttribute("type") === "checkbox" && !n.parentNode?.textContent.includes("Group automatically")) as Toggle[];
  await app.waitFor(() => section()?.textContent.includes("Retry validation") ?? false, "staged section");
  const b = await reviewed("Retry tests");
  await backend.stage(b.id);
  await app.waitFor(() => checkboxes().length === 2, "the task staged while the section is open");
  const c = await reviewed("Tree colors");
  await backend.stage(c.id);
  const d = await reviewed("Theme spacing");
  await backend.stage(d.id);
  const e = await reviewed("Theme fonts");
  await backend.stage(e.id);
  await app.waitFor(() => checkboxes().length === 5, "five unchecked staged tasks");
  assert.deepEqual(checkboxes().map(isChecked), [false, false, false, false, false]);
  assert.match(section().textContent, /Open combined PR \(0\)/);
  assert.match(section().textContent, /groupModel|titleModel/, "automatic grouping says it needs a cheap model");
  checkboxes()[0].checked = true;
  checkboxes()[0].dispatch("change");
  await app.waitFor(() => section().textContent.includes("Open combined PR (1)"), "selection before grouping");

  writeFileSync(groups, JSON.stringify({ groups: [
    { tasks: ["title:Tree colors"], parent: null, rationale: "solo visual change" },
    { tasks: ["title:Retry tests", "title:Retry validation"], parent: null, rationale: "both about retries" },
    { tasks: ["title:Theme fonts", "title:Theme spacing"], parent: null, rationale: "theme styles" },
  ] }));
  const button = (text: string) => section().querySelectorAll((n) => n.localName === "button" && n.textContent === text)[0];
  const rows = () => section().querySelectorAll((n) => n.localName === "li" && n.parentNode?.getAttribute("class") === "list staged-tasks");
  const badges = () => section().querySelectorAll((n) => n.getAttribute("class") === "group-badge");
  const boxFor = (title: string) => rows().find((n) => n.textContent.includes(title))!.querySelectorAll((n) => n.localName === "input")[0] as Toggle;
  button("Smart group").dispatch("click");
  await app.waitFor(() => badges().length === 4, "badged rows in the ordinary list");
  assert.equal(published.length, 0, "grouping never publishes");
  assert.equal(section().querySelectorAll((n) => n.getAttribute("class") === "list staged-tasks").length, 1, "one task list, not one per group");
  assert.equal(section().querySelectorAll((n) => n.getAttribute("class") === "suggested-group").length, 0, "duplicate group cards removed");
  assert.deepEqual(rows().map((n) => ["Tree colors", "Retry tests", "Retry validation", "Theme fonts", "Theme spacing"].find((title) => n.textContent.includes(title))), [c.title, b.title, a.title, e.title, d.title], "sort follows suggested groups and member order");
  assert.deepEqual(badges().map((n) => n.textContent), ["Group 1", "Group 1", "Group 2", "Group 2"]);
  const colors = badges().map((n) => n.style.color);
  assert.ok(colors[0] && colors[2], "badges have visible colors");
  assert.equal(colors[0], colors[1]);
  assert.equal(colors[2], colors[3]);
  assert.notEqual(colors[0], colors[2], "different groups have distinct colors as well as labels");
  assert.deepEqual(badges().map((n) => n.getAttribute("title")), ["both about retries", "both about retries", "theme styles", "theme styles"]);
  assert.equal(rows()[0].querySelectorAll((n) => n.getAttribute("class") === "group-badge").length, 0, "solo changes have no badge");
  assert.deepEqual(checkboxes().map(isChecked), [false, false, true, false, false], "regrouping preserves manual selection");
  assert.ok(!section().textContent.includes("Select group"));
  assert.ok(!section().textContent.includes("Publish 5 PRs"));
  button("Clear selection").dispatch("click");
  await app.waitFor(() => button("Open combined PR (0)") !== undefined, "selection cleared for manual regrouping");
  boxFor(a.title).checked = true;
  boxFor(a.title).dispatch("change");
  boxFor(c.title).checked = true;
  boxFor(c.title).dispatch("change");
  await app.waitFor(() => button("Open combined PR (2)")?.getAttribute("disabled") === null, "cross-badge selection is publishable");
  const contents = section().childNodes;
  const controlsIndex = contents.findIndex((n) => n.textContent.includes("Open combined PR (2)"));
  const listIndex = contents.findIndex((n) => n.getAttribute("class") === "list staged-tasks");
  assert.ok(controlsIndex < listIndex, "publication controls precede the task list");
  failPublish = true;
  button("Open combined PR (2)").dispatch("click");
  await app.waitFor(() => section().querySelectorAll((n) => n.getAttribute("class") === "publication-error").some((n) => n.textContent.includes("selected change needs conflict review")), "server failure is visible beside publication controls");
  assert.ok(isChecked(boxFor(a.title)) && isChecked(boxFor(c.title)), "failure preserves the selection for adjustment");
  failPublish = false;
  await app.waitFor(() => button("Open combined PR (2)")?.getAttribute("disabled") === null, "retry enabled");
  button("Open combined PR (2)").dispatch("click");
  await app.waitFor(() => combined.length === 2 && button("Open combined PR (0)") !== undefined, "combined request succeeds and resets selection");
  assert.deepEqual(combined, [{ project: "quality", taskIds: [a.id, c.id] }, { project: "quality", taskIds: [a.id, c.id] }], "publishes precisely the checked tasks in staging order, not badge order or whole groups");
  assert.equal(published.length, 0);
  assert.equal(section().querySelectorAll((n) => n.getAttribute("class") === "publication-error").length, 0, "successful retry clears the error");
  assert.ok(section().querySelectorAll((n) => n.localName === "a" && n.getAttribute("href") === "https://example.com/pull/77").some((n) => n.textContent === "#77"), "opened PR link is visible");
  // Stale suggestions cannot hide or duplicate tasks, or make a restaged task selected.
  const f = await reviewed("Newly staged");
  await backend.stage(f.id);
  await app.waitFor(() => checkboxes().length === 6 && section().textContent.includes("group again"), "stale proposal falls back to the same full list");
  assert.equal(badges().length, 0);
  assert.deepEqual(checkboxes().map(isChecked), [false, false, false, false, false, false]);
  boxFor(a.title).checked = true;
  boxFor(a.title).dispatch("change");
  await app.waitFor(() => button("Open combined PR (1)") !== undefined, "manual ungrouped selection");
  await backend.unstage(a.id);
  await app.waitFor(() => checkboxes().length === 5, "unstaged task removed");
  await backend.stage(a.id);
  await app.waitFor(() => checkboxes().length === 6, "restaged task restored unchecked");
  assert.deepEqual(checkboxes().map(isChecked), [false, false, false, false, false, false]);

  const auto = section().querySelectorAll((n) => n.localName === "label" && n.textContent.includes("Group automatically"))[0].querySelectorAll((n) => n.localName === "input")[0] as Toggle;
  assert.equal(isChecked(auto), true);
  auto.checked = false;
  auto.dispatch("change");
  await until(async () => (await backend.getComposition()).auto === false, "automatic grouping off");
});

test("background publication hides accepted selections and surfaces revisioned outcomes without blocking another selection", UI_TIMEOUT, async (t) => {
  let jobs: NonNullable<ApiComposition["bundleJobs"]> = [];
  const listeners = new Set<(event: ServerEvent) => void>();
  let realBackend: Backend;
  let holdOverview = false;
  let releaseOverview: (() => void) | undefined;
  const composition = async () => ({ ...(await realBackend.getComposition()), bundleJobs: jobs });
  const emit = async () => { const c = await composition(); for (const listener of listeners) listener({ type: "composition", composition: c }); };
  const { app, backend } = await bootUi(t, (real) => {
    realBackend = real;
    return { ...delegate(real),
      getComposition: composition,
      getOverview: async (project) => {
        const overview = await real.getOverview(project);
        const pending = new Set(jobs.filter((job) => job.status === "queued" || job.status === "running").flatMap((job) => job.taskIds));
        const result = { ...overview, stagedTasks: overview.stagedTasks.filter((task) => !pending.has(task.id)) };
        if (holdOverview) {
          holdOverview = false;
          await new Promise<void>((resolve) => { releaseOverview = resolve; });
        }
        return result;
      },
      subscribe: (listener) => { listeners.add(listener); const stop = real.subscribe(listener); return () => { listeners.delete(listener); stop(); }; },
      startBundle: async (input) => {
        const now = new Date().toISOString();
        jobs = [{ id: "background", project: "quality", taskIds: input.taskIds, taskTitles: ["Background first"], status: "queued", revision: 1, createdAt: now, updatedAt: now }];
        const accepted = await composition();
        jobs = jobs.map((job) => ({ ...job, status: "running", revision: 2 }));
        await emit();
        return accepted; // Deliberately older than the event delivered before the response.
      },
    };
  });
  for (const title of ["Background first", "Background second"]) {
    const task = await backend.startTask({ node: "", findingIds: [], title, prompt: "scenario:happy", manualReview: true });
    await until(() => backend.getState().then((s) => s.tasks.find((x) => x.id === task.id && x.state === "review")), "review");
    await backend.stage(task.id);
  }
  const rows = () => app.find((n) => n.localName === "li" && n.parentNode?.getAttribute("class") === "list staged-tasks");
  await app.waitFor(() => rows().length === 2, "staged tasks");
  const box = rows()[0].querySelectorAll((n) => n.localName === "input")[0] as Toggle;
  box.checked = true; box.dispatch("change");
  await app.waitFor(() => app.text().includes("Open combined PR (1)"), "checked task");
  holdOverview = true;
  app.find((n) => n.localName === "button" && n.textContent === "Open combined PR (1)")[0].dispatch("click");
  await app.waitFor(() => rows().length === 1 && app.text().includes("Opening PR in background"), "accepted task hidden and running outcome survives late acceptance");
  assert.match(rows()[0].textContent, /Background second/);
  const next = rows()[0].querySelectorAll((n) => n.localName === "input")[0] as Toggle;
  next.checked = true; next.dispatch("change");
  await app.waitFor(() => app.find((n) => n.localName === "button" && n.textContent === "Open combined PR (1)")[0]?.getAttribute("disabled") === null, "another selection can be submitted");
  jobs = jobs.map((job) => ({ ...job, status: "failed", revision: 3, error: "GitHub unavailable; staged changes restored" }));
  await emit();
  await app.waitFor(() => rows().length === 2 && app.text().includes("GitHub unavailable; staged changes restored"), "failed selection restored with outcome");
  await app.waitFor(() => !!releaseOverview, "older overview request held");
  releaseOverview!();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(rows().length, 2, "late pre-failure overview must not hide restored changes");
  assert.equal(isChecked(rows()[0].querySelectorAll((n) => n.localName === "input")[0] as Toggle), false);
  jobs = jobs.map((job) => ({ ...job, status: "opened", revision: 4, error: undefined, bundle: { id: "background", project: "quality", taskIds: job.taskIds, title: "Background first", branch: "bundle", worktree: "", pr: 88, url: "https://example.com/pull/88", createdAt: job.createdAt } }));
  await emit();
  await app.waitFor(() => app.find((n) => n.localName === "a" && n.getAttribute("href") === "https://example.com/pull/88").length > 0, "opened PR outcome link");
  // Reconnect reads persisted outcomes, including when the staged pool becomes empty.
  for (const task of (await backend.getState()).tasks.filter((task) => task.state === "staged")) await backend.unstage(task.id);
  app.reconnect();
  await app.waitFor(() => rows().length === 0 && app.text().includes("PR opening activity") && app.find((n) => n.localName === "a" && n.getAttribute("href") === "https://example.com/pull/88").length > 0, "outcome stays visible after reconnect with no staged tasks");
});

test("open stacks stay visible with root and child PR links when nothing is staged", UI_TIMEOUT, async (t) => {
  const bundle = (id: string, pr: number, title: string, parent?: string): Bundle => ({
    id, project: "quality", title, branch: `techtree/bundle-${id}`, worktree: "", taskIds: [], pr, url: `https://example.com/pull/${pr}`, createdAt: "2024-01-01T00:00:00.000Z",
    base: parent ? `techtree/bundle-${parent}` : "main", stack: "root", ...(parent && { parent }),
  });
  const stacks = [bundle("root", 100, "Retry validation"), bundle("child", 101, "Retry tests", "root")];
  const { app } = await bootUi(t, (real) => ({
    ...delegate(real),
    getComposition: async (project) => ({ ...(await real.getComposition(project)), stacks, lastResult: { bundleIds: ["root", "child"] } }) satisfies ApiComposition,
  }));
  await app.waitFor(() => app.text().includes("Retry tests"), "stacks in the overview");
  const links = app.find((n) => n.localName === "a" && /\/pull\/10[01]$/.test(n.getAttribute("href") ?? "")).map((n) => n.textContent);
  assert.deepEqual(links, ["#100", "#101"]);
  assert.match(app.text(), /#100[^#]*→[^#]*#101|#101[^#]*→ #100/);
  assert.match(app.text(), /Opened 2 PRs\./, "publication result stays visible when the pool empties");
});
