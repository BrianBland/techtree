import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import techtree from "../../extensions/index.ts";
import { ensureServer, liveServer, lockPath, pidAlive } from "../../src/backend/launch.ts";
import { cacheDir, repoId } from "../../src/paths.ts";
import { CLI, TODO_FILE, fixture, until, withCacheHome, withEnv } from "../backend/helpers.ts";

type Handler = (...args: any[]) => unknown;

/** Records what the extension registers, standing in for pi's ExtensionAPI, and the URLs it would open in a browser. */
function fakePi() {
  const tools = new Map<string, { execute: Handler }>();
  const commands = new Map<string, { handler: Handler }>();
  const events = new Map<string, Handler>();
  const api = {
    registerTool: (tool: { name: string; execute: Handler }) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    on: (event: string, handler: Handler) => events.set(event, handler),
  };
  const opened: string[] = [];
  techtree(api as any, (url) => opened.push(url));
  return { tools, commands, events, opened };
}

function fakeCtx(cwd: string, mode = "rpc") {
  const notes: [string, string][] = [];
  const widgets: (string[] | undefined)[] = [];
  const ui = { notify: (msg: string, level: string) => notes.push([msg, level]), setWidget: (_k: string, lines?: string[]) => widgets.push(lines) };
  return { ctx: { cwd, mode, hasUI: mode !== "print", ui }, notes, widgets };
}

test("inside a worker child only techtree_report is registered", { timeout: 30_000 }, (t) => {
  withEnv(t, "TECHTREE_TASK", "task-1");
  const { tools, commands, events } = fakePi();
  assert.deepEqual([...tools.keys()], ["techtree_report"]);
  assert.equal(commands.size, 0);
  assert.equal(events.size, 0);
});

test("the factory registers /techtree and the tools without starting a server", { timeout: 30_000 }, (t) => {
  withEnv(t, "TECHTREE_TASK", undefined);
  const { repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const { tools, commands, events } = fakePi();
  assert.deepEqual([...commands.keys()], ["techtree"]);
  assert.deepEqual([...tools.keys()].sort(), ["techtree_findings", "techtree_status"]);
  assert.ok(events.has("session_shutdown"));
  assert.equal(existsSync(lockPath(join(cache, "techtree", repoId(repo)))), false);
});

test("/techtree shows the live server's URL, opens it in the browser and shows a status widget; the tools report status and findings", { timeout: 30_000 }, async (t) => {
  withEnv(t, "TECHTREE_TASK", undefined);
  const { repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const server = await ensureServer(repo, cacheDir(repoId(repo)), { cli: CLI });
  t.after(() => pidAlive(server.pid) && process.kill(server.pid, "SIGTERM"));
  const { tools, commands, events, opened } = fakePi();

  const { ctx, notes, widgets } = fakeCtx(join(repo, "src"));
  await commands.get("techtree")!.handler("", ctx);
  assert.deepEqual(notes, [[`techtree: ${server.url}`, "warning"]]);
  assert.deepEqual(opened, [server.url]);
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

test("/techtree url does not open the browser; stop stops the server; restart keeps port and token", { timeout: 30_000 }, async (t) => {
  withEnv(t, "TECHTREE_TASK", undefined);
  const { repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const dir = cacheDir(repoId(repo));
  const server = await ensureServer(repo, dir, { cli: CLI });
  const pids = [server.pid];
  t.after(() => pids.forEach((pid) => pidAlive(pid) && process.kill(pid, "SIGKILL")));
  const { commands, events, opened } = fakePi();
  t.after(() => events.get("session_shutdown")!());
  const techtreeCommand = commands.get("techtree")!;

  const url = fakeCtx(repo);
  await techtreeCommand.handler("url", url.ctx);
  assert.deepEqual(url.notes, [[`techtree: ${server.url}`, "warning"]]);
  assert.deepEqual(opened, []);

  await techtreeCommand.handler("restart", fakeCtx(repo).ctx);
  const restarted = (await liveServer(dir))!;
  pids.push(restarted.pid);
  assert.notEqual(restarted.pid, server.pid);
  assert.equal(restarted.url, server.url);
  assert.deepEqual(opened, [server.url]);

  const stop = fakeCtx(repo);
  await techtreeCommand.handler("stop", stop.ctx);
  assert.equal(pidAlive(restarted.pid), false);
  assert.match(stop.notes[0][0], /stopped/);

  await assert.rejects(Promise.resolve(techtreeCommand.handler("bogus", fakeCtx(repo).ctx)), /url, stop, restart/);
});

test("/techtree in print mode prints the URL and opens no browser", { timeout: 30_000 }, async (t) => {
  withEnv(t, "TECHTREE_TASK", undefined);
  const { repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const server = await ensureServer(repo, cacheDir(repoId(repo)), { cli: CLI });
  t.after(() => pidAlive(server.pid) && process.kill(server.pid, "SIGKILL"));
  const { commands, events, opened } = fakePi();
  t.after(() => events.get("session_shutdown")!());
  const write = t.mock.method(process.stdout, "write", () => true);
  await commands.get("techtree")!.handler("", fakeCtx(repo, "print").ctx);
  write.mock.restore();
  assert.deepEqual(opened, []);
  assert.ok(write.mock.calls.some((c) => String(c.arguments[0]).includes(server.url)));
});
