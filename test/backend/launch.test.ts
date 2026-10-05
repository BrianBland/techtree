import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureServer, liveServer, lockPath, packageVersion, pidAlive, readLock, writeLock, type ServerInfo } from "../../src/backend/launch.ts";
import { stopServer } from "../../src/backend/serve.ts";
import { cacheDir, repoId } from "../../src/paths.ts";
import type { Backend } from "../../src/server/backend.ts";
import { startServer } from "../../src/server/server.ts";
import { CLI, fixture, until, withCacheHome, withEnv } from "./helpers.ts";

const lock = (over: Partial<ServerInfo>): ServerInfo => ({ pid: process.pid, port: 1, token: "t", url: "u", version: "0", ...over });

test("/api/health answers without a token and reveals only the version and build", { timeout: 30_000 }, async (t) => {
  const staticDir = mkdtempSync(join(tmpdir(), "techtree-health-"));
  const server = await startServer({ backend: {} as Backend, staticDir, version: "9.9.9", build: "b1" });
  t.after(async () => {
    await server.close();
    rmSync(staticDir, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: "9.9.9", build: "b1" });
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/state`)).status, 401);
});

test("a lockfile is live only with a running pid whose port answers /api/health", { timeout: 30_000 }, async (t) => {
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

test("ensureServer starts one detached server, reuses it, replaces a stale one, and stop shuts it down", { timeout: 30_000 }, async (t) => {
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
  assert.equal(pidAlive(second.pid), false, "stop returns once the server has exited");
  assert.equal(existsSync(lockPath(dir)), false, "a clean exit removes the lockfile");
  assert.equal(await stopServer(repo), "no techtree server running");
});

test("stop removes a stale lockfile", { timeout: 30_000 }, async (t) => {
  const { repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const dir = cacheDir(repoId(repo));
  mkdirSync(dir, { recursive: true });
  writeLock(dir, lock({ pid: 2 ** 22 + 12345 }));
  assert.match(await stopServer(repo), /removed stale/);
  assert.equal(existsSync(lockPath(dir)), false);
});

test("serve --port listens on the given port and prints the URL; a bad port is a usage error", { timeout: 30_000 }, async (t) => {
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

test("concurrent serve processes for one repo start a single server", { timeout: 30_000 }, async (t) => {
  const { repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, [CLI, "serve", repo], { stdio: ["ignore", "pipe", "ignore"] }));
  t.after(() => children.forEach((c) => c.kill("SIGKILL")));
  const urls = await Promise.all(
    children.map(
      (child) =>
        new Promise<string>((resolve) => {
          let out = "";
          child.stdout.on("data", (chunk) => {
            out += chunk;
            if (out.includes("\n")) resolve(out.split("\n")[0]);
          });
        }),
    ),
  );
  assert.equal(new Set(urls).size, 1, "every process reports the same server");
  await until(() => children.filter((c) => c.exitCode === null).length === 1, "the losing processes to exit");
  const owner = children.find((c) => c.exitCode === null)!;
  assert.equal((await liveServer(cacheDir(repoId(repo))))?.pid, owner.pid);
  owner.kill("SIGTERM");
});

test("the detached server's log, which holds the token URL, is private to the user", { timeout: 30_000 }, async (t) => {
  const { repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const dir = cacheDir(repoId(repo));
  writeFileSync(join(dir, "server.log"), "older log\n", { mode: 0o644 });
  const server = await ensureServer(repo, dir, { cli: CLI });
  t.after(() => pidAlive(server.pid) && process.kill(server.pid, "SIGKILL"));
  assert.equal(statSync(join(dir, "server.log")).mode & 0o777, 0o600);
});

/** A fake `dist/` (complete build) whose build id the test controls; servers spawned afterwards inherit it via `TECHTREE_DIST`. */
function fakeDist(t: TestContext, tmp: string, name: string, build: string): string {
  const dist = join(tmp, name);
  mkdirSync(join(dist, "web"), { recursive: true });
  writeFileSync(join(dist, "cli.js"), "");
  writeFileSync(join(dist, "web", "app.js"), "");
  writeFileSync(join(dist, "build-id"), build);
  withEnv(t, "TECHTREE_DIST", dist);
  return dist;
}

test("a server hands over to a new build on the same port and token when dist/build-id changes", { timeout: 30_000 }, async (t) => {
  const { tmp, repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const dir = cacheDir(repoId(repo));
  const dist = fakeDist(t, tmp, "dist", "one");
  const pids: number[] = [];
  t.after(() => pids.forEach((pid) => pidAlive(pid) && process.kill(pid, "SIGKILL")));

  const first = await ensureServer(repo, dir, { cli: CLI });
  pids.push(first.pid);
  assert.equal(first.build, "one");
  writeFileSync(join(dist, "build-id"), "two");
  const second = await until(async () => {
    const live = await liveServer(dir);
    return live?.build === "two" ? live : undefined;
  }, "the replacement server");
  pids.push(second.pid);
  assert.notEqual(second.pid, first.pid);
  assert.equal(pidAlive(first.pid), false);
  assert.deepEqual([second.port, second.token, second.url], [first.port, first.token, first.url]);
  assert.match(readFileSync(join(dir, "server.log"), "utf8"), /handing over/);
});

test("ensureServer restarts a live server built from another build id, keeping port and token", { timeout: 30_000 }, async (t) => {
  const { tmp, repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const dir = cacheDir(repoId(repo));
  const pids: number[] = [];
  t.after(() => pids.forEach((pid) => pidAlive(pid) && process.kill(pid, "SIGKILL")));

  fakeDist(t, tmp, "dist-a", "a");
  const old = await ensureServer(repo, dir, { cli: CLI });
  pids.push(old.pid);
  fakeDist(t, tmp, "dist-b", "b");
  const fresh = await ensureServer(repo, dir, { cli: CLI });
  pids.push(fresh.pid);
  assert.notEqual(fresh.pid, old.pid);
  assert.equal(fresh.build, "b");
  assert.deepEqual([fresh.port, fresh.token], [old.port, old.token]);
});
