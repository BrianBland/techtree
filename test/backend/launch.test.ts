import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureServer, liveServer, lockPath, packageVersion, pidAlive, readLock, writeLock, type ServerInfo } from "../../src/backend/launch.ts";
import { stopServer } from "../../src/backend/serve.ts";
import { cacheDir, repoId } from "../../src/paths.ts";
import type { Backend } from "../../src/server/backend.ts";
import { startServer } from "../../src/server/server.ts";
import { CLI, fixture, until, withCacheHome } from "./helpers.ts";

const lock = (over: Partial<ServerInfo>): ServerInfo => ({ pid: process.pid, port: 1, token: "t", url: "u", version: "0", ...over });

test("/api/health answers without a token and reveals only the version", async (t) => {
  const staticDir = mkdtempSync(join(tmpdir(), "techtree-health-"));
  const server = await startServer({ backend: {} as Backend, staticDir, version: "9.9.9" });
  t.after(async () => {
    await server.close();
    rmSync(staticDir, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: "9.9.9" });
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/state`)).status, 401);
});

test("a lockfile is live only with a running pid whose port answers /api/health", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techtree-lock-"));
  const health = createServer((req, res) => res.writeHead(req.url === "/api/health" ? 200 : 404).end("{}"));
  await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
  const port = (health.address() as AddressInfo).port;
  t.after(() => {
    health.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(await liveServer(dir), undefined, "no lockfile");
  writeLock(dir, lock({ port, pid: 2 ** 22 + 12345 }));
  assert.equal(await liveServer(dir), undefined, "dead pid");
  writeLock(dir, lock({ port: 1 }));
  assert.equal(await liveServer(dir), undefined, "pid alive but nothing listening");
  writeLock(dir, lock({ port }));
  assert.deepEqual(await liveServer(dir), lock({ port }));
});

test("ensureServer starts one detached server, reuses it, replaces a stale one, and stop shuts it down", async (t) => {
  const { repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const dir = cacheDir(repoId(repo));
  const pids: number[] = [];
  t.after(() => pids.forEach((pid) => pidAlive(pid) && process.kill(pid, "SIGKILL")));

  const first = await ensureServer(repo, dir, { cli: CLI });
  pids.push(first.pid);
  assert.notEqual(first.pid, process.pid);
  assert.equal(first.version, packageVersion());
  assert.equal(first.url, `http://127.0.0.1:${first.port}/?token=${first.token}`);
  const state = await fetch(`http://127.0.0.1:${first.port}/api/state`, { headers: { authorization: `Bearer ${first.token}` } });
  assert.equal(state.status, 200);
  assert.equal(((await state.json()) as { repo: { root: string } }).repo.root, repo);

  assert.equal((await ensureServer(repo, dir, { cli: CLI })).pid, first.pid, "a live server is reused");

  process.kill(first.pid, "SIGKILL");
  await until(() => !pidAlive(first.pid), "killed server to exit");
  assert.equal(readLock(dir)?.pid, first.pid, "a killed server leaves its lockfile behind");
  const second = await ensureServer(repo, dir, { cli: CLI });
  pids.push(second.pid);
  assert.notEqual(second.pid, first.pid);

  assert.match(await stopServer(repo), /stopped/);
  await until(() => !pidAlive(second.pid), "stopped server to exit");
  assert.equal(existsSync(lockPath(dir)), false, "a clean exit removes the lockfile");
  assert.equal(await stopServer(repo), "no techtree server running");
});

test("stop removes a stale lockfile", async (t) => {
  const { repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const dir = cacheDir(repoId(repo));
  mkdirSync(dir, { recursive: true });
  writeLock(dir, lock({ pid: 2 ** 22 + 12345 }));
  assert.match(await stopServer(repo), /removed stale/);
  assert.equal(existsSync(lockPath(dir)), false);
});

test("serve --port listens on the given port and prints the URL; a bad port is a usage error", async (t) => {
  const { repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));

  const child = spawn(process.execPath, [CLI, "serve", repo, "--port", String(port)], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => child.kill("SIGKILL"));
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const info = await until(() => liveServer(cacheDir(repoId(repo))), "server on the given port");
  assert.equal(info.port, port);
  await until(() => stdout.includes(info.url), "printed URL");
  child.kill("SIGTERM");

  const bad = spawnSync(process.execPath, [CLI, "serve", repo, "--port", "nope"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /invalid --port nope/);
});
