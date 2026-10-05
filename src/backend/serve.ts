import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { openDb } from "../db.ts";
import { cacheDir, repoId } from "../paths.ts";
import { startServer } from "../server/server.ts";
import { RepoBackend } from "./backend.ts";
import { liveServer, lockPath, PACKAGE_ROOT, packageVersion, readLock, removeLock, writeLock, type ServerInfo } from "./launch.ts";

const DEFAULT_IDLE_MS = 2 * 60 * 60 * 1000;
const IDLE_CHECK_MS = 60_000;
const OWNER_WAIT_MS = 30_000;

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
  const token = randomBytes(32).toString("hex");
  const server = await startServer({
    backend,
    token,
    version,
    port: opts.port,
    staticDir: join(PACKAGE_ROOT, "dist", "web"),
    onRequest: () => (lastRequest = Date.now()),
  });
  backend.attach({ url: `http://127.0.0.1:${server.port}`, token });
  writeLock(dir, { pid: process.pid, port: server.port, token, url: server.url, version });
  console.log(server.url);

  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`techtree: stopping (${reason})`);
    clearInterval(idleTimer);
    removeLock(dir, process.pid);
    await backend.close();
    await server.close();
    ownership.release();
    process.exit(0);
  };
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

/** `techtree stop`: signal the repo's live server, or clear a stale lockfile. Returns a message. */
export async function stopServer(repoRoot: string): Promise<string> {
  const dir = cacheDir(repoId(repoRoot));
  const live = await liveServer(dir);
  if (live) {
    process.kill(live.pid, "SIGTERM");
    return `stopped techtree server (pid ${live.pid})`;
  }
  const stale = readLock(dir);
  if (!stale) return "no techtree server running";
  removeLock(dir, stale.pid);
  return `removed stale ${lockPath(dir)}`;
}
