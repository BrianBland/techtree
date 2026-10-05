import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import techtree from "../../extensions/techtree.ts";
import { ensureServer, lockPath, pidAlive } from "../../src/backend/launch.ts";
import { cacheDir, repoId } from "../../src/paths.ts";
import { CLI, TODO_FILE, fixture, until, withCacheHome } from "../backend/helpers.ts";

type Handler = (...args: any[]) => unknown;

/** Records what the extension registers, standing in for pi's ExtensionAPI. */
function fakePi() {
  const tools = new Map<string, { execute: Handler }>();
  const commands = new Map<string, { handler: Handler }>();
  const events = new Map<string, Handler>();
  const api = {
    registerTool: (tool: { name: string; execute: Handler }) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    on: (event: string, handler: Handler) => events.set(event, handler),
  };
  techtree(api as any);
  return { tools, commands, events };
}

function fakeCtx(cwd: string, mode = "rpc") {
  const notes: [string, string][] = [];
  const widgets: (string[] | undefined)[] = [];
  const ui = { notify: (msg: string, level: string) => notes.push([msg, level]), setWidget: (_k: string, lines?: string[]) => widgets.push(lines) };
  return { ctx: { cwd, mode, hasUI: mode !== "print", ui }, notes, widgets };
}

function withEnv(t: TestContext, name: string, value: string | undefined) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("inside a worker child only techtree_report is registered", (t) => {
  withEnv(t, "TECHTREE_TASK", "task-1");
  const { tools, commands, events } = fakePi();
  assert.deepEqual([...tools.keys()], ["techtree_report"]);
  assert.equal(commands.size, 0);
  assert.equal(events.size, 0);
});

test("the factory registers /techtree and the tools without starting a server", (t) => {
  withEnv(t, "TECHTREE_TASK", undefined);
  const { repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const { tools, commands, events } = fakePi();
  assert.deepEqual([...commands.keys()], ["techtree"]);
  assert.deepEqual([...tools.keys()].sort(), ["techtree_findings", "techtree_status"]);
  assert.ok(events.has("session_shutdown"));
  assert.equal(existsSync(lockPath(join(cache, "techtree", repoId(repo)))), false);
});

test("/techtree shows the live server's URL and a status widget; the tools report status and findings", async (t) => {
  withEnv(t, "TECHTREE_TASK", undefined);
  const { repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const server = await ensureServer(repo, cacheDir(repoId(repo)), { cli: CLI });
  t.after(() => pidAlive(server.pid) && process.kill(server.pid, "SIGTERM"));
  const { tools, commands, events } = fakePi();

  const { ctx, notes, widgets } = fakeCtx(join(repo, "src"));
  await commands.get("techtree")!.handler("", ctx);
  assert.deepEqual(notes, [[`techtree: ${server.url}`, "warning"]]);
  const widget = await until(() => widgets.find((w) => w?.[0].includes("running")), "status widget");
  assert.deepEqual(widget, [`techtree: 0 running · 0 need attention · ${server.url}`]);
  await events.get("session_shutdown")!();

  const status = (await tools.get("techtree_status")!.execute("1", {}, undefined, undefined, ctx)) as { content: { text: string }[] };
  assert.match(status.content[0].text, new RegExp(`techtree: ${server.url.replace(/[?]/g, "\\?")}`));
  assert.match(status.content[0].text, /root quality: /);
  assert.match(status.content[0].text, /running tasks: 0/);

  const findings = (await tools.get("techtree_findings")!.execute("2", { path: TODO_FILE }, undefined, undefined, ctx)) as {
    content: { text: string }[];
  };
  assert.match(findings.content[0].text, /^techtree findings for src\/core .*: 1 total/);
  assert.match(findings.content[0].text, new RegExp(TODO_FILE));

  const fallback = (await tools.get("techtree_findings")!.execute("3", { path: "src/core/missing/dir" }, undefined, undefined, ctx)) as {
    content: { text: string }[];
  };
  assert.match(fallback.content[0].text, /^techtree findings for src\/core /, "an unscored path falls back to its deepest scored ancestor");
});
