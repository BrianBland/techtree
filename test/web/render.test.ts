import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { Backend } from "../../src/server/backend.ts";
import type { ServerEvent } from "../../src/types.ts";

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

test("switching score, weight or sort re-renders ~1000 visible nodes in under 200 ms", async (t) => {
  const { bench } = await importTsx<typeof import("./render-bench.tsx")>("./render-bench.tsx");
  const timings = bench(1000);
  t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v * 10) / 10]))));
  assert.equal(timings.visibleNodes, 1000);
  assert.ok(timings.switchScore < 200, `score switch ${timings.switchScore} ms`);
  assert.ok(timings.switchWeight < 200, `weight switch ${timings.switchWeight} ms`);
  assert.ok(timings.switchSort < 200, `sort switch ${timings.switchSort} ms`);
});

test("decorated sibling tiles never paint over each other", async () => {
  const { decoratedSiblingBoxes } = await importTsx<typeof import("./tile-boxes.tsx")>("./tile-boxes.tsx");
  const boxes = decoratedSiblingBoxes(3).filter((b) => b.node !== "repo");
  const extent = (node: string) => {
    const own = boxes.filter((b) => b.node === node);
    return { top: Math.min(...own.map((b) => b.top)), bottom: Math.max(...own.map((b) => b.bottom)) };
  };
  assert.ok(boxes.some((b) => b.cls === "alarm") && boxes.some((b) => b.cls === "ring"), "decorations rendered");
  const [a, b, c] = ["n0", "n1", "n2"].map(extent);
  // Rings and alarms are stroked 2 units wide, half of it outside their box.
  assert.ok(a.bottom + 1 < b.top - 1, `n0 ${JSON.stringify(a)} overlaps n1 ${JSON.stringify(b)}`);
  assert.ok(b.bottom + 1 < c.top - 1, `n1 ${JSON.stringify(b)} overlaps n2 ${JSON.stringify(c)}`);
});

test("the UI boots against the server and mock backend, opens nodes and answers questions", async () => {
  const { startServer } = await import("../../src/server/server.ts");
  const { createMockBackend } = await import("../../src/server/mock.ts");
  const { bootApp } = await importTsx<typeof import("./app-smoke.tsx")>("./app-smoke.tsx");
  const backend = createMockBackend({ tickMs: 0 });
  const server = await startServer({ backend, staticDir: tmpdir() });
  const app = await bootApp(`http://127.0.0.1:${server.port}`, server.token);
  const byClass = (cls: string) => app.find((n) => n.getAttribute("class") === cls);
  try {
    await app.waitFor(() => app.text().includes("Needs you") && app.text().includes("Scan coverage"), "overview");
    const glyphs = app.find((n) => /^node( |$)/.test(n.getAttribute("class") ?? ""));
    assert.ok(glyphs.length > 20 && glyphs.length <= 150, `${glyphs.length} nodes shown initially`);

    const state = await backend.getState();
    const asking = state.tasks.find((t) => t.state === "needs_input")!;
    const item = byClass("row clickable").find((n) => n.textContent.includes(asking.question!))!;
    item.dispatch("click");
    await app.waitFor(() => app.text().includes("Composite") && byClass("answer").length === 1, "node panel with question");

    const textarea = app.find((n) => n.localName === "textarea")[0] as unknown as { value: string; dispatch(t: string): void };
    textarea.value = "keep the old error type";
    textarea.dispatch("input");
    const submit = app.find((n) => n.localName === "button" && n.textContent === "Answer")[0];
    await app.waitFor(() => submit.getAttribute("disabled") === null, "answer button to enable");
    byClass("answer")[0].dispatch("submit");
    await app.waitFor(() => byClass("answer").length === 0, "answered task to resume");
    assert.equal((await backend.getState()).tasks.find((t) => t.id === asking.id)!.state, "running");
    assert.match(await backend.taskLog(asking.id, 5), /answer: keep the old error type/);

    const before = state.tasks.length;
    const startButtons = () => app.find((n) => n.localName === "button" && n.textContent === "Start");
    await app.waitFor(() => startButtons().length > 0, "suggestions with Start buttons");
    const start = startButtons()[0];
    start.dispatch("click");
    await app.waitFor(() => byClass("dialog").length === 1, "start dialog");
    byClass("dialog")[0].dispatch("submit");
    await app.waitFor(() => byClass("dialog").length === 0, "dialog to close");
    assert.equal((await backend.getState()).tasks.length, before + 1);
  } finally {
    app.close();
    await server.close();
  }
});

test("the node panel lists its own calls to action, then its children's, which select their node", async () => {
  const { startServer } = await import("../../src/server/server.ts");
  const { createMockBackend } = await import("../../src/server/mock.ts");
  const { bootApp } = await importTsx<typeof import("./app-smoke.tsx")>("./app-smoke.tsx");
  const backend = createMockBackend({ tickMs: 0 });
  const server = await startServer({ backend, staticDir: tmpdir() });
  const app = await bootApp(`http://127.0.0.1:${server.port}`, server.token);
  const byClass = (cls: string) => app.find((n) => n.getAttribute("class") === cls);
  try {
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
  } finally {
    app.close();
    await server.close();
  }
});

test("children's calls to action follow descendant task changes while the panel is open", async () => {
  const { startServer } = await import("../../src/server/server.ts");
  const { createMockBackend } = await import("../../src/server/mock.ts");
  const { bootApp } = await importTsx<typeof import("./app-smoke.tsx")>("./app-smoke.tsx");
  const backend = createMockBackend({ tickMs: 0 });
  const server = await startServer({ backend, staticDir: tmpdir() });
  const app = await bootApp(`http://127.0.0.1:${server.port}`, server.token);
  const asking = () =>
    app.find((n) => n.getAttribute("class") === "row clickable cta-child" && n.textContent.includes("needs input")).length;
  try {
    const state = await backend.getState();
    await app.waitFor(() => app.text().includes("Scan coverage"), "overview");
    app.find((n) => n.getAttribute("class") === "label" && n.textContent === state.repo.name)[0].dispatch("click");
    await app.waitFor(() => asking() > 0, "root panel with a question from a descendant");
    const before = asking();

    const running = state.tasks.find((t) => t.state === "running" && t.node !== "")!;
    await backend.report(running.id, { needs_input: "Which error type?" });
    await app.waitFor(() => asking() === before + 1, "new question listed under From children");

    await backend.answer(running.id, "the old one");
    await app.waitFor(() => asking() === before, "answered question removed from From children");
  } finally {
    app.close();
    await server.close();
  }
});

test("the UI resyncs after reconnects and never acts on stale or failed data", async () => {
  const { startServer } = await import("../../src/server/server.ts");
  const { createMockBackend } = await import("../../src/server/mock.ts");
  const { HttpError } = await import("../../src/server/backend.ts");
  const { bootApp } = await importTsx<typeof import("./app-smoke.tsx")>("./app-smoke.tsx");
  const mock = createMockBackend({ tickMs: 0 });
  const calls = { getState: 0, getOverview: 0 };
  const fail = { answer: false, rootNode: false };
  const listeners = new Set<(e: ServerEvent) => void>();
  const backend: Backend = {
    ...mock,
    getState: () => (calls.getState++, mock.getState()),
    getOverview: () => (calls.getOverview++, mock.getOverview()),
    getNode: (id) => (fail.rootNode && id === "" ? Promise.reject(new HttpError(500, "boom")) : mock.getNode(id)),
    answer: (id, text) => (fail.answer ? Promise.reject(new HttpError(409, "wrong state")) : mock.answer(id, text)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const server = await startServer({ backend, staticDir: tmpdir() });
  const app = await bootApp(`http://127.0.0.1:${server.port}`, server.token);
  const byClass = (cls: string) => app.find((n) => n.getAttribute("class") === cls);
  try {
    await app.waitFor(() => app.text().includes("Scan coverage") && listeners.size === 1, "overview and event stream");
    const state = await mock.getState();

    const healthy = state.prs.find((p) => !p.stale && !p.stuck && p.ci !== "fail")!;
    const overviews = calls.getOverview;
    listeners.forEach((l) => l({ type: "pr", pr: { ...healthy, stale: true } }));
    await app.waitFor(() => calls.getOverview > overviews, "overview refetch when a PR turns stale");

    const states = calls.getState;
    app.reconnect();
    await app.waitFor(() => calls.getState > states, "state refetch after reconnect");

    const asking = state.tasks.find((t) => t.state === "needs_input")!;
    byClass("row clickable").find((n) => n.textContent.includes(asking.question!))!.dispatch("click");
    await app.waitFor(() => byClass("answer").length === 1 && app.text().includes("This node"), "panel with question");
    fail.answer = true;
    const textarea = app.find((n) => n.localName === "textarea")[0] as unknown as { value: string; dispatch(t: string): void };
    textarea.value = "keep the old error type";
    textarea.dispatch("input");
    const submit = app.find((n) => n.localName === "button" && n.textContent === "Answer")[0];
    await app.waitFor(() => submit.getAttribute("disabled") === null, "answer button to enable");
    byClass("answer")[0].dispatch("submit");
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
  } finally {
    app.close();
    await server.close();
  }
});
