import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { openDb } from "../db.ts";
import { cacheDir, repoId } from "../paths.ts";
import { startServer } from "../server/server.ts";
import { RepoBackend } from "./backend.ts";
import { liveServer, lockPath, PACKAGE_ROOT, packageVersion, readLock, removeLock, writeLock } from "./launch.ts";

const DEFAULT_IDLE_MS = 2 * 60 * 60 * 1000;
const IDLE_CHECK_MS = 60_000;

/** `techtree serve`: run the repo's server in the foreground until signalled or idle (DESIGN "Server lifecycle"). */
export async function serve(repoRoot: string, opts: { port?: number } = {}): Promise<void> {
  const dir = cacheDir(repoId(repoRoot));
  const existing = await liveServer(dir);
  if (existing) {
    console.log(existing.url);
    return;
  }
  const idleMs = Number(process.env.TECHTREE_IDLE_MS) || DEFAULT_IDLE_MS;
  const backend = new RepoBackend({ db: openDb(dir), repoRoot, cacheDir: dir, config: loadConfig(repoRoot) });
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
    backend.close();
    await server.close();
    process.exit(0);
  };
  const idleTimer = setInterval(() => {
    if (!backend.busy() && Date.now() - lastRequest >= idleMs) void stop("idle");
  }, Math.min(IDLE_CHECK_MS, idleMs));
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
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
