import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CLI, fixture, withCacheHome, withEnv } from "./helpers.ts";
import { cacheDir, repoId } from "../../src/paths.ts";

async function installedPackage(t: TestContext) {
  const { tmp, repo, cache } = fixture(t);
  withCacheHome(t, cache);
  const upstream = join(tmp, "upstream");
  const pkg = join(tmp, "installed");
  mkdirSync(upstream);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(upstream, "init", "-q", "-b", "main");
  writeFileSync(join(upstream, "package.json"), JSON.stringify({ type: "module", version: "0.1.0" }));
  writeFileSync(join(upstream, ".gitignore"), "dist/\nnode_modules/\n");
  writeFileSync(join(upstream, "launch.ts"), readFileSync(new URL("../../src/backend/launch.ts", import.meta.url)));
  writeFileSync(join(upstream, "ui.txt"), "old ui");
  // This fixture builder uses only Node, but exercises the install's build-dependency preflight.
  writeFileSync(join(upstream, "build.mjs"), `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
mkdirSync("dist/web", { recursive: true });
writeFileSync("dist/cli.js", "");
writeFileSync("dist/web/app.js", readFileSync("ui.txt"));
writeFileSync("dist/build-id", randomUUID());
`);
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "initial package");
  git(tmp, "clone", "-q", upstream, pkg);
  mkdirSync(join(pkg, "node_modules", "esbuild"), { recursive: true });
  execFileSync(process.execPath, ["build.mjs"], { cwd: pkg });
  withEnv(t, "TECHTREE_DIST", join(pkg, "dist"));
  const launch = await import(pathToFileURL(join(pkg, "launch.ts")).href) as typeof import("../../src/backend/launch.ts");
  const dir = cacheDir(repoId(repo));
  const pids: number[] = [];
  t.after(() => pids.forEach((pid) => launch.pidAlive(pid) && process.kill(pid, "SIGKILL")));
  const start = async () => {
    const server = await launch.ensureServer(repo, dir, { cli: CLI });
    pids.push(server.pid);
    return server;
  };
  const update = async () => {
    const server = await launch.updateServer(repo, dir, { cli: CLI });
    pids.push(server.pid);
    return server;
  };
  const changeUpstream = (file = "ui.txt", content = "new ui") => {
    writeFileSync(join(upstream, file), content);
    git(upstream, "add", file);
    git(upstream, "commit", "-qm", "update package");
  };
  return { repo, pkg, upstream, dir, launch, git, start, update, changeUpstream };
}

test("update pulls the package, rebuilds existing bundles, and serves fresh UI on the same URL", { timeout: 30_000 }, async (t) => {
  const h = await installedPackage(t);
  const old = await h.start();
  const targetHead = h.git(h.repo, "rev-parse", "HEAD");
  h.changeUpstream();
  const fresh = await h.update();
  assert.equal(h.git(h.pkg, "rev-parse", "HEAD"), h.git(h.upstream, "rev-parse", "HEAD"));
  assert.equal(h.git(h.repo, "rev-parse", "HEAD"), targetHead, "does not pull the scored repository");
  assert.equal(h.git(h.pkg, "branch", "--show-current"), "main", "does not switch branches");
  assert.notEqual(fresh.build, old.build);
  assert.notEqual(fresh.pid, old.pid);
  assert.equal(h.launch.pidAlive(old.pid), false);
  assert.deepEqual([fresh.port, fresh.token, fresh.url], [old.port, old.token, old.url]);
  const app = await fetch(`http://127.0.0.1:${fresh.port}/app.js`, { headers: { authorization: `Bearer ${fresh.token}` } });
  assert.equal(app.status, 200);
  assert.equal(await app.text(), "new ui");
  const restarted = await h.launch.restartServer(h.repo, h.dir, { cli: CLI });
  t.after(() => h.launch.pidAlive(restarted.pid) && process.kill(restarted.pid, "SIGKILL"));
  assert.equal(restarted.build, fresh.build, "plain restart does not rebuild");
});

test("update rebuilds and starts even when the package is already up to date and no server is live", { timeout: 30_000 }, async (t) => {
  const h = await installedPackage(t);
  writeFileSync(join(h.pkg, "dist", "web", "app.js"), "stale bundle");
  const fresh = await h.update();
  assert.equal(readFileSync(join(h.pkg, "dist", "web", "app.js"), "utf8"), "old ui");
  assert.equal((await h.launch.liveServer(h.dir))?.pid, fresh.pid);
});

test("update refuses local changes and divergent branches without stopping the live server", { timeout: 30_000 }, async (t) => {
  const h = await installedPackage(t);
  const old = await h.start();
  h.changeUpstream();
  writeFileSync(join(h.pkg, "ui.txt"), "my edit");
  await assert.rejects(h.update(), /local changes/);
  assert.equal(readFileSync(join(h.pkg, "ui.txt"), "utf8"), "my edit");
  assert.equal((await h.launch.liveServer(h.dir))?.pid, old.pid);
  h.git(h.pkg, "add", "ui.txt");
  h.git(h.pkg, "commit", "-qm", "local commit");
  const localHead = h.git(h.pkg, "rev-parse", "HEAD");
  await assert.rejects(h.update(), /fast-forward/i);
  assert.equal(h.git(h.pkg, "rev-parse", "HEAD"), localHead);
  assert.equal((await h.launch.liveServer(h.dir))?.pid, old.pid);
});

test("update refuses a package nested inside another Git repository", { timeout: 30_000 }, async (t) => {
  const h = await installedPackage(t);
  const nested = join(h.pkg, "nested");
  mkdirSync(nested);
  writeFileSync(join(nested, "package.json"), '{"type":"module"}');
  writeFileSync(join(nested, "launch.ts"), readFileSync(join(h.pkg, "launch.ts")));
  const launch = await import(pathToFileURL(join(nested, "launch.ts")).href) as typeof h.launch;
  const head = h.git(h.pkg, "rev-parse", "HEAD");
  await assert.rejects(launch.updateServer(h.repo, h.dir, { cli: CLI }), /Git checkout/);
  assert.equal(h.git(h.pkg, "rev-parse", "HEAD"), head);
});

test("update checks build dependencies before pulling or stopping the live server", { timeout: 30_000 }, async (t) => {
  const h = await installedPackage(t);
  const old = await h.start();
  const head = h.git(h.pkg, "rev-parse", "HEAD");
  h.changeUpstream();
  rmSync(join(h.pkg, "node_modules"), { recursive: true });
  await assert.rejects(h.update(), /esbuild.*missing/);
  assert.equal(h.git(h.pkg, "rev-parse", "HEAD"), head);
  assert.equal((await h.launch.liveServer(h.dir))?.pid, old.pid);
});

test("a failed update build surfaces its error without launching stale bundles", { timeout: 30_000 }, async (t) => {
  const h = await installedPackage(t);
  const old = await h.start();
  h.changeUpstream("build.mjs", 'throw new Error("fixture build failed");\n');
  await assert.rejects(h.update(), /fixture build failed/);
  assert.equal(h.launch.pidAlive(old.pid), false);
  assert.equal(await h.launch.liveServer(h.dir), undefined);
});
