import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { openDb } from "../db.ts";
import { cacheDir, repoId } from "../paths.ts";
import { startServer } from "../server/server.ts";
import { RepoBackend } from "./backend.ts";
import {
  currentBuild,
  distDir,
  liveServer,
  packageVersion,
  readHandover,
  removeHandover,
  removeLock,
  spawnServer,
  stopServer as stopServerIn,
  watchBuild,
  writeHandover,
  writeLock,
  type ServerInfo,
} from "./launch.ts";

const DEFAULT_IDLE_MS = 2 * 60 * 60 * 1000;
const IDLE_CHECK_MS = 60_000;
const OWNER_WAIT_MS = 30_000;
const HANDOVER_WAIT_MS = 10 * 60 * 1000;
const HANDOVER_POLL_MS = 1000;

/** `techtree serve`: run the repo's server in the foreground until signalled or idle (DESIGN "Server lifecycle"). */
export async function serve(repoRoot: string, opts: { port?: number } = {}): Promise<void> {
  const dir = cacheDir(repoId(repoRoot));
  const existing = await liveServer(dir);
  if (existing) {
    console.log(existing.url);
    return;
  }
  const ownership = claimOwnership(dir);
  if (!ownership) {
    console.log((await waitForOwner(dir)).url);
    return;
  }
  const idleMs = Number(process.env.TECHTREE_IDLE_MS) || DEFAULT_IDLE_MS;
  const backend = new RepoBackend({ db: openDb(dir), repoRoot, cacheDir: dir, config: loadConfig(repoRoot), pollPrs: true });
  let lastRequest = Date.now();
  const version = packageVersion();
  const build = currentBuild();
  const pending = readHandover(dir);
  const token = pending?.token ?? randomBytes(32).toString("hex");
  const server = await startServer({
    backend,
    token,
    version,
    build,
    port: opts.port || pending?.port,
    staticDir: join(distDir(), "web"),
    onRequest: () => (lastRequest = Date.now()),
  });
  backend.attach({ url: `http://127.0.0.1:${server.port}`, token });
  writeLock(dir, { pid: process.pid, port: server.port, token, url: server.url, version, build });
  removeHandover(dir);
  console.log(server.url);

  let stopping = false;
  /** Shut down as DESIGN "Server lifecycle" describes; false when a shutdown is already under way. */
  const shutdown = async (reason: string) => {
    if (stopping) return false;
    stopping = true;
    console.error(`techtree: stopping (${reason})`);
    clearInterval(idleTimer);
    stopWatching();
    removeLock(dir, process.pid);
    await backend.close();
    await server.close();
    ownership.release();
    return true;
  };
  const stop = async (reason: string) => {
    if (await shutdown(reason)) process.exit(0);
  };
  const handover = async (next: string) => {
    const deadline = Date.now() + HANDOVER_WAIT_MS;
    while (backend.analyzing() && Date.now() < deadline) await sleep(HANDOVER_POLL_MS);
    if (stopping) return;
    writeHandover(dir, { port: server.port, token });
    await shutdown(`build ${next} available, handing over on port ${server.port}`);
    spawnServer(process.argv[1], repoRoot, dir);
    process.exit(0);
  };
  const stopWatching = watchBuild(build, (next) => void handover(next));
  const idleTimer = setInterval(() => {
    if (!backend.busy() && Date.now() - lastRequest >= idleMs) void stop("idle");
  }, Math.min(IDLE_CHECK_MS, idleMs));
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

/**
 * Make this process the repo's only server: an exclusive SQLite lock on `<cacheDir>/server.lock`,
 * which the OS releases when the process dies, so a crash never leaves a stale claim.
 */
function claimOwnership(dir: string): { release(): void } | undefined {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(join(dir, "server.lock"));
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    return { release: () => db.close() };
  } catch {
    db.close();
    return undefined;
  }
}

/** The server another `serve` process is starting (it holds the ownership lock). */
async function waitForOwner(dir: string): Promise<ServerInfo> {
  const deadline = Date.now() + OWNER_WAIT_MS;
  while (Date.now() < deadline) {
    const live = await liveServer(dir);
    if (live) return live;
    await sleep(100);
  }
  throw new Error("another techtree server holds the lock but never became live");
}

/** `techtree stop`: stop the repo's live server, or clear a stale lockfile. Returns a message. */
export function stopServer(repoRoot: string): Promise<string> {
  return stopServerIn(cacheDir(repoId(repoRoot)));
}
