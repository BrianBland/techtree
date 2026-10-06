import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

/** Contents of `<cacheDir>/server.json`. */
export interface ServerInfo {
  pid: number;
  port: number;
  token: string;
  url: string;
  version: string;
  /** `dist/build-id` the server started with; absent for servers older than build ids. */
  build?: string;
}

const HEALTH_TIMEOUT_MS = 2000;
const LAUNCH_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 15_000;
const BUILD_POLL_MS = 5000;
const HANDOVER_TTL_MS = 60_000;

/** Root of this package (holds `package.json`, `dist/`, `extensions/`, `skills/`). */
export const PACKAGE_ROOT = findPackageRoot(fileURLToPath(new URL(".", import.meta.url)));

/** Walks up from `dir`, so it works both from `src/backend/` and from the bundled `dist/cli.js`. */
function findPackageRoot(dir: string): string {
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

export const lockPath = (cacheDir: string) => join(cacheDir, "server.json");

const handoverPath = (cacheDir: string) => join(cacheDir, "handover.json");

/** Record the port and token the next server must take over (DESIGN "Server lifecycle", handover file). */
export function writeHandover(cacheDir: string, info: Pick<ServerInfo, "port" | "token">): void {
  writeFileSync(handoverPath(cacheDir), JSON.stringify({ port: info.port, token: info.token }) + "\n", { mode: 0o600 });
}

/** The pending handover, if one was written in the last 60 s. */
export function readHandover(cacheDir: string): Pick<ServerInfo, "port" | "token"> | undefined {
  try {
    if (Date.now() - statSync(handoverPath(cacheDir)).mtimeMs > HANDOVER_TTL_MS) return undefined;
    return JSON.parse(readFileSync(handoverPath(cacheDir), "utf8")) as Pick<ServerInfo, "port" | "token">;
  } catch {
    return undefined;
  }
}

export const removeHandover = (cacheDir: string) => rmSync(handoverPath(cacheDir), { force: true });

/** The built package: `dist/` (`TECHTREE_DIST` overrides it, for tests). */
export const distDir = () => process.env.TECHTREE_DIST || join(PACKAGE_ROOT, "dist");

/** The id of the complete build in `dist/`, or undefined while there is none (see DESIGN "Server lifecycle"). */
export function currentBuild(): string | undefined {
  const dist = distDir();
  if (!existsSync(join(dist, "cli.js")) || !existsSync(join(dist, "web", "app.js"))) return undefined;
  try {
    return readFileSync(join(dist, "build-id"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Call `onBuild` once, when a complete build other than `started` appears in `dist/`. Returns the stop function. */
export function watchBuild(started: string | undefined, onBuild: (build: string) => void): () => void {
  let fired = false;
  const check = () => {
    const build = currentBuild();
    if (fired || !build || build === started) return;
    fired = true;
    stop();
    onBuild(build);
  };
  const poll = setInterval(check, BUILD_POLL_MS).unref();
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(distDir(), check).unref();
  } catch {
    // no dist/ yet: the poll covers it
  }
  const stop = () => {
    clearInterval(poll);
    watcher?.close();
  };
  return stop;
}

export function packageVersion(): string {
  return (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;
}

/** Write `server.json` atomically so readers never see a partial file. */
export function writeLock(cacheDir: string, info: ServerInfo): void {
  const tmp = `${lockPath(cacheDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info) + "\n", { mode: 0o600 });
  renameSync(tmp, lockPath(cacheDir));
}

export function readLock(cacheDir: string): ServerInfo | undefined {
  try {
    return JSON.parse(readFileSync(lockPath(cacheDir), "utf8")) as ServerInfo;
  } catch {
    return undefined;
  }
}

/** Remove `server.json` if it still belongs to `pid` (a newer server may have replaced it). */
export function removeLock(cacheDir: string, pid: number): void {
  if (readLock(cacheDir)?.pid === pid) rmSync(lockPath(cacheDir), { force: true });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The server named by `server.json` if its pid is alive and `/api/health` answers; see DESIGN "Server lifecycle". */
export async function liveServer(cacheDir: string): Promise<ServerInfo | undefined> {
  const info = readLock(cacheDir);
  if (!info || !Number.isInteger(info.pid) || !pidAlive(info.pid)) return undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok ? info : undefined;
  } catch {
    return undefined;
  }
}

export interface LaunchOptions {
  /** CLI entry point to run `serve` with; defaults to the built `dist/cli.js`. */
  cli?: string;
  timeoutMs?: number;
  /** Rebuild after stopping the old server; used only by an explicit package update. */
  rebuild?: boolean;
}

/** Reuse the repo's live server (restarting it when built from another build) or start a detached `techtree serve` and wait for it. */
export async function ensureServer(repoRoot: string, cacheDir: string, opts: LaunchOptions = {}): Promise<ServerInfo> {
  const live = await liveServer(cacheDir);
  if (!live) return launch(repoRoot, cacheDir, opts);
  const build = currentBuild();
  return build && live.build !== build ? restartServer(repoRoot, cacheDir, opts) : live;
}

/** Stop the repo's live server and start a new one on the same port and token (or a fresh one when none is live). */
export async function restartServer(repoRoot: string, cacheDir: string, opts: LaunchOptions = {}): Promise<ServerInfo> {
  const live = await liveServer(cacheDir);
  if (live) {
    writeHandover(cacheDir, live);
    await terminate(live.pid);
  }
  if (opts.rebuild) {
    ensureBuilt(true);
    if (live) writeHandover(cacheDir, live);
  }
  return launch(repoRoot, cacheDir, opts);
}

/** Fast-forward the installed package's upstream, rebuild it, and refresh this repo's server. */
export async function updateServer(repoRoot: string, cacheDir: string, opts: LaunchOptions = {}): Promise<ServerInfo> {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: "pipe", timeout: 60_000 }).trim();
  if (realpathSync(git("rev-parse", "--show-toplevel")) !== realpathSync(PACKAGE_ROOT)) {
    throw new Error(`techtree update requires a Git checkout at ${PACKAGE_ROOT}`);
  }
  if (git("status", "--porcelain")) throw new Error(`techtree has local changes; commit or stash them in ${PACKAGE_ROOT} before updating`);
  requireBuildTools();
  git("pull", "--ff-only");
  return restartServer(repoRoot, cacheDir, { ...opts, rebuild: true });
}

/** `techtree stop`: stop the live server and wait for it to exit, or clear a stale lockfile. Returns a message. */
export async function stopServer(cacheDir: string): Promise<string> {
  const live = await liveServer(cacheDir);
  if (live) {
    await terminate(live.pid);
    return `stopped techtree server (pid ${live.pid})`;
  }
  const stale = readLock(cacheDir);
  if (!stale) return "no techtree server running";
  removeLock(cacheDir, stale.pid);
  return `removed stale ${lockPath(cacheDir)}`;
}

/** SIGTERM `pid` and wait for it to exit, escalating to SIGKILL after 15 s. */
async function terminate(pid: number): Promise<void> {
  process.kill(pid, "SIGTERM");
  let deadline = Date.now() + STOP_TIMEOUT_MS;
  while (pidAlive(pid)) {
    if (Date.now() > deadline) {
      process.kill(pid, "SIGKILL");
      deadline = Infinity;
    }
    await sleep(50);
  }
}

/** Spawn a detached `serve` with output appended to `server.log`. Called by a handing-over server too, which is why it does not wait. */
export function spawnServer(cli: string, repoRoot: string, cacheDir: string): void {
  const logPath = join(cacheDir, "server.log");
  const log = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600); // the log holds the token-bearing URL; also tighten a log created by an older version
  try {
    spawn(process.execPath, [cli, "serve", repoRoot], { detached: true, stdio: ["ignore", log, log], cwd: repoRoot }).unref();
  } finally {
    closeSync(log);
  }
}

async function launch(repoRoot: string, cacheDir: string, opts: LaunchOptions): Promise<ServerInfo> {
  spawnServer(opts.cli ?? ensureBuilt(), repoRoot, cacheDir);
  const deadline = Date.now() + (opts.timeoutMs ?? LAUNCH_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await sleep(100);
    const started = await liveServer(cacheDir);
    if (started) return started;
  }
  throw new Error(`techtree server did not start; see ${join(cacheDir, "server.log")}`);
}

/** Path of `dist/cli.js`, building the package first when it or the web UI is missing. */
function ensureBuilt(rebuild = false): string {
  const cli = join(distDir(), "cli.js");
  if (!rebuild && existsSync(cli) && existsSync(join(distDir(), "web", "app.js"))) return cli;
  requireBuildTools();
  execFileSync(process.execPath, ["build.mjs"], { cwd: PACKAGE_ROOT, stdio: "pipe", timeout: 120_000 });
  return cli;
}

function requireBuildTools(): void {
  if (!existsSync(join(PACKAGE_ROOT, "node_modules", "esbuild"))) {
    throw new Error(`esbuild is missing; run \`npm install\` in ${PACKAGE_ROOT} before building techtree`);
  }
}
