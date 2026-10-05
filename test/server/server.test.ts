import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../../src/server/server.ts";
import { HttpError, type Backend } from "../../src/server/backend.ts";
import type { ServerEvent } from "../../src/types.ts";

const TOKEN = "secret-token";
const calls: [string, ...unknown[]][] = [];
const listeners = new Set<(e: ServerEvent) => void>();

function record(name: string, ...fixed: unknown[]) {
  const result = fixed.length ? fixed[0] : { ok: name };
  return async (...args: unknown[]) => {
    calls.push([name, ...args]);
    if (args[0] === "missing") throw new HttpError(404, "no such thing");
    if (args[0] === "busy") throw new HttpError(409, "wrong state");
    if (args[0] === "boom") throw new Error("internal detail");
    return result;
  };
}

const backend = {
  listProjects: record("listProjects"),
  createProject: record("createProject"),
  refine: record("refine"),
  findings: record("findings"),
  updateProject: record("updateProject"),
  deleteProject: record("deleteProject", undefined),
  getState: record("getState"),
  getNode: record("getNode"),
  getOverview: record("getOverview"),
  taskLog: record("taskLog", "line 1\nline 2"),
  taskDiff: record("taskDiff", "diff --git a b"),
  models: record("models", { default: "p/m", models: ["p/m"] }),
  startTask: record("startTask"),
  answer: record("answer"),
  openPr: record("openPr"),
  cancel: record("cancel"),
  message: record("message"),
  chat: record("chat", [{ role: "user", text: "hi", at: "2024-01-01T00:00:00.000Z" }]),
  openTerminal: record("openTerminal", undefined),
  report: record("report"),
  setBabysit: record("setBabysit"),
  rescore: record("rescore", undefined),
  scan: record("scan", undefined),
  subscribe(listener: (e: ServerEvent) => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
} as unknown as Backend;

let server: RunningServer;
let staticDir: string;
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };

before(async () => {
  staticDir = mkdtempSync(join(tmpdir(), "techtree-static-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>techtree</title>");
  writeFileSync(join(staticDir, "app.js"), "console.log('app')");
  writeFileSync(join(tmpdir(), "techtree-outside.txt"), "outside");
  server = await startServer({ backend, token: TOKEN, staticDir, heartbeatMs: 20 });
});

after(async () => {
  await server.close();
  rmSync(staticDir, { recursive: true, force: true });
});

const api = (path: string, init?: RequestInit) => fetch(server.url.replace(/\/\?.*$/, "") + path, init);

function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: server.port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    })
      .on("error", reject)
      .end();
  });
}

test("binds 127.0.0.1 on a random port and puts the token in the url", () => {
  assert.ok(server.port > 0);
  assert.equal(server.url, `http://127.0.0.1:${server.port}/?token=${TOKEN}`);
});

test("api routes reject missing or wrong tokens with a JSON 401", async () => {
  for (const headers of [{} as Record<string, string>, { authorization: "Bearer nope" }, { cookie: `techtree_token_${server.port}=nope` }]) {
    const res = await api("/api/state", { headers });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "missing or invalid token" });
  }
  assert.equal((await api("/api/state?token=nope")).status, 401);
});

test("static files also require the token", async () => {
  assert.equal((await api("/")).status, 401);
  assert.equal((await api("/app.js")).status, 401);
});

test("query token sets a strict HttpOnly cookie and page loads redirect to the bare url", async () => {
  const res = await api(`/?token=${TOKEN}`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");
  const cookie = res.headers.get("set-cookie")!;
  assert.match(cookie, new RegExp(`^techtree_token_${server.port}=${TOKEN};`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const page = await api("/", { headers: { cookie: `techtree_token_${server.port}=${TOKEN}` } });
  assert.equal(page.status, 200);
  const state = await api("/api/state", { headers: { cookie: `techtree_token_${server.port}=${TOKEN}` } });
  assert.equal(state.status, 200);
});

test("servers for different repos on the same host keep separate cookies", async () => {
  const other = await startServer({ backend, staticDir });
  try {
    const cookieOf = async (s: RunningServer) =>
      (await fetch(s.url, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
    const both = `${await cookieOf(server)}; ${await cookieOf(other)}`;
    assert.equal((await api("/api/state", { headers: { cookie: both } })).status, 200);
    const otherState = await fetch(`http://127.0.0.1:${other.port}/api/state`, { headers: { cookie: both } });
    assert.equal(otherState.status, 200);
  } finally {
    await other.close();
  }
});

test("starting on an occupied port rejects instead of crashing", async () => {
  await assert.rejects(startServer({ backend, staticDir, port: server.port }), /EADDRINUSE/);
});

test("query token is accepted directly on api routes", async () => {
  assert.equal((await api(`/api/state?token=${TOKEN}`)).status, 200);
});

test("foreign Host headers are rejected", async () => {
  assert.equal(await rawGet("/api/state", { ...auth, host: "evil.example" }), 403);
  assert.equal(await rawGet("/api/state", { ...auth, host: `localhost:${server.port}` }), 200);
});

test("mutating routes require JSON and a same-origin Origin", async () => {
  const form = await api("/api/score", { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "{}" });
  assert.equal(form.status, 403);
  const foreign = await api("/api/score", { method: "POST", headers: { ...json, origin: "http://evil.example" }, body: "{}" });
  assert.equal(foreign.status, 403);
  const same = await api("/api/score", {
    method: "POST",
    headers: { ...json, origin: `http://127.0.0.1:${server.port}` },
    body: "{}",
  });
  assert.equal(same.status, 200);
  assert.equal((await api("/api/score", { headers: auth })).status, 404);
});

test("routes delegate to the matching backend method", async () => {
  const cases: [string, string, unknown, [string, ...unknown[]], unknown][] = [
    ["GET", "/api/projects", undefined, ["listProjects"], { ok: "listProjects" }],
    ["POST", "/api/projects", { name: "Perf", goal: "fast" }, ["createProject", { name: "Perf", goal: "fast" }], { ok: "createProject" }],
    ["PATCH", "/api/projects/perf", { goal: "" }, ["updateProject", "perf", { goal: "" }], { ok: "updateProject" }],
    ["DELETE", "/api/projects/perf", undefined, ["deleteProject", "perf"], { ok: true }],
    ["GET", "/api/state", undefined, ["getState", "quality"], { ok: "getState" }],
    ["GET", "/api/state?project=perf", undefined, ["getState", "perf"], { ok: "getState" }],
    ["GET", "/api/node?id=crates%2Fa&project=perf", undefined, ["getNode", "crates/a", "perf"], { ok: "getNode" }],
    ["GET", "/api/node?id=", undefined, ["getNode", "", "quality"], { ok: "getNode" }],
    ["GET", "/api/overview?project=all", undefined, ["getOverview", "all"], { ok: "getOverview" }],
    ["GET", "/api/tasks/t1/log?tail=5", undefined, ["taskLog", "t1", 5], "line 1\nline 2"],
    ["GET", "/api/tasks/t1/log", undefined, ["taskLog", "t1", 200], "line 1\nline 2"],
    ["GET", "/api/tasks/t1/diff", undefined, ["taskDiff", "t1"], "diff --git a b"],
    ["GET", "/api/models", undefined, ["models"], { default: "p/m", models: ["p/m"] }],
    [
      "POST",
      "/api/tasks",
      { node: "a", findingIds: [], manualReview: false, model: "p/m", project: "perf" },
      ["startTask", { node: "a", findingIds: [], manualReview: false, model: "p/m", project: "perf" }],
      { ok: "startTask" },
    ],
    [
      "POST",
      "/api/tasks",
      { node: "a", findingIds: ["f"], manualReview: true },
      ["startTask", { node: "a", findingIds: ["f"], manualReview: true }],
      { ok: "startTask" },
    ],
    ["POST", "/api/tasks/t1/answer", { text: "yes" }, ["answer", "t1", "yes"], { ok: "answer" }],
    ["POST", "/api/tasks/t1/open-pr", undefined, ["openPr", "t1"], { ok: "openPr" }],
    ["POST", "/api/tasks/t1/cancel", undefined, ["cancel", "t1"], { ok: "cancel" }],
    ["POST", "/api/tasks/t1/message", { text: "go on" }, ["message", "t1", "go on"], { ok: "message" }],
    ["GET", "/api/tasks/t1/chat", undefined, ["chat", "t1"], [{ role: "user", text: "hi", at: "2024-01-01T00:00:00.000Z" }]],
    ["POST", "/api/tasks/t1/open-terminal", { mode: "agent" }, ["openTerminal", "t1", "agent"], { ok: true }],
    ["POST", "/api/tasks/t1/report", { done: 2 }, ["report", "t1", { done: 2 }], { ok: "report" }],
    ["POST", "/api/prs/42/babysit", { on: true }, ["setBabysit", 42, true], { ok: "setBabysit" }],
    ["POST", "/api/score", undefined, ["rescore", "quality"], { ok: true }],
    ["POST", "/api/scan?project=perf", { node: "crates" }, ["scan", "crates", "perf"], { ok: true }],
  ];
  for (const [method, path, body, call, expected] of cases) {
    calls.length = 0;
    const res = await api(path, { method, headers: method === "GET" ? auth : json, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(res.status, 200, `${method} ${path}`);
    assert.deepEqual(calls, [call], `${method} ${path}`);
    const result = typeof expected === "string" ? await res.text() : await res.json();
    assert.deepEqual(result, expected, `${method} ${path}`);
    if (typeof expected === "string") assert.match(res.headers.get("content-type")!, /^text\/plain/);
  }
});

test("bad input, unknown routes and backend errors map to JSON status codes", async () => {
  const post = (path: string, body: string) => api(path, { method: "POST", headers: json, body });
  const cases: [Promise<Response>, number][] = [
    [api("/api/nope", { headers: auth }), 404],
    [api("/api/node", { headers: auth }), 400],
    [api("/api/tasks/t1/log?tail=abc", { headers: auth }), 400],
    [api("/api/tasks/%E0%A4%A/log", { headers: auth }), 400],
    [api("/api/node?id=missing", { headers: auth }), 404],
    [post("/api/tasks/busy/open-pr", ""), 409],
    [post("/api/tasks/boom/cancel", ""), 500],
    [post("/api/tasks", "{not json"), 400],
    [post("/api/tasks", JSON.stringify({ node: "a" })), 400],
    [post("/api/tasks", JSON.stringify({ node: "a", findingIds: [], manualReview: true, model: 7 })), 400],
    [post("/api/tasks/t1/answer", JSON.stringify({ text: 3 })), 400],
    [post("/api/tasks/t1/message", JSON.stringify({})), 400],
    [post("/api/tasks/t1/open-terminal", JSON.stringify({ mode: "screen" })), 400],
    [post("/api/tasks/busy/message", JSON.stringify({ text: "hi" })), 409],
    [post("/api/tasks/missing/open-terminal", JSON.stringify({ mode: "shell" })), 404],
    [post("/api/prs/abc/babysit", JSON.stringify({ on: true })), 404],
    [post("/api/prs/1/babysit", JSON.stringify({ on: "yes" })), 400],
    [post("/api/scan", JSON.stringify({})), 400],
    [post("/api/tasks/t1/report", JSON.stringify([1])), 400],
    [post("/api/tasks/t1/report", JSON.stringify({})), 400],
    [post("/api/tasks/t1/report", JSON.stringify({ phase: "not-a-phase" })), 400],
    [post("/api/tasks/t1/report", JSON.stringify({ plan: 42 })), 400],
    [post("/api/tasks/t1/report", JSON.stringify({ plan: ["a", 1] })), 400],
    [post("/api/tasks/t1/report", JSON.stringify({ done: -1 })), 400],
    [post("/api/tasks/t1/report", JSON.stringify({ done: 1.5 })), 400],
    [post("/api/tasks/t1/report", JSON.stringify({ needs_input: false })), 400],
    [post("/api/scan", JSON.stringify({ node: "x".repeat(1_100_000) })), 413],
  ];
  for (const [pending, status] of cases) {
    const res = await pending;
    assert.equal(res.status, status, res.url);
    const body = (await res.json()) as { error: string };
    assert.equal(typeof body.error, "string");
    assert.doesNotMatch(body.error, /internal detail/);
  }
});

test("SSE delivers backend events and heartbeats, and unsubscribes on disconnect", async () => {
  const controller = new AbortController();
  const res = await api("/api/events", { headers: auth, signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /^text\/event-stream/);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const event: ServerEvent = { type: "log", taskId: "t1", line: "hello" };
  for (const l of listeners) l(event);

  let text = "";
  while (!(text.includes(`data: ${JSON.stringify(event)}\n\n`) && text.includes(": ping\n\n"))) {
    const { value, done } = await reader.read();
    assert.ok(!done, "stream ended early");
    text += value;
  }
  assert.equal(listeners.size, 1);
  controller.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 50 && listeners.size; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(listeners.size, 0);
});

test("serves the built UI with content types and refuses path traversal", async () => {
  const index = await api("/", { headers: auth });
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type")!, /^text\/html/);
  assert.match(await index.text(), /<title>techtree/);
  const js = await api("/app.js", { headers: auth });
  assert.match(js.headers.get("content-type")!, /^text\/javascript/);
  assert.equal(await js.text(), "console.log('app')");
  assert.equal((await api("/missing.js", { headers: auth })).status, 404);
  assert.equal(await rawGet("/../techtree-outside.txt", auth), 404);
  assert.equal(await rawGet("/%2e%2e/techtree-outside.txt", auth), 404);
});

test("close ends open SSE streams", async () => {
  const other = await startServer({ backend, staticDir });
  assert.notEqual(other.token, TOKEN);
  assert.ok(other.token.length >= 32);
  const res = await fetch(other.url.replace("/?", "/api/events?"));
  const reader = res.body!.getReader();
  await reader.read();
  await other.close();
  const drain = async () => {
    while (!(await reader.read()).done);
  };
  await drain().catch(() => {}); // a reset connection also ends the stream
});
