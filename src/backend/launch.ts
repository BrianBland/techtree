import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
}

const HEALTH_TIMEOUT_MS = 2000;
const LAUNCH_TIMEOUT_MS = 30_000;

/** Root of this package (holds `package.json`, `dist/`, `extensions/`, `skills/`). */
export const PACKAGE_ROOT = findPackageRoot(fileURLToPath(new URL(".", import.meta.url)));

/** Walks up from `dir`, so it works both from `src/backend/` and from the bundled `dist/cli.js`. */
function findPackageRoot(dir: string): string {
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

export const lockPath = (cacheDir: string) => join(cacheDir, "server.json");

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
}

/** Reuse the repo's live server or start a detached `techtree serve` and wait for it. */
export async function ensureServer(repoRoot: string, cacheDir: string, opts: LaunchOptions = {}): Promise<ServerInfo> {
  const live = await liveServer(cacheDir);
  if (live) return live;
  const cli = opts.cli ?? ensureBuilt();
  const log = openSync(join(cacheDir, "server.log"), "a");
  try {
    spawn(process.execPath, [cli, "serve", repoRoot], { detached: true, stdio: ["ignore", log, log], cwd: repoRoot }).unref();
  } finally {
    closeSync(log);
  }
  const deadline = Date.now() + (opts.timeoutMs ?? LAUNCH_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await sleep(100);
    const started = await liveServer(cacheDir);
    if (started) return started;
  }
  throw new Error(`techtree server did not start; see ${join(cacheDir, "server.log")}`);
}

/** Path of `dist/cli.js`, building the package first when it or the web UI is missing. */
function ensureBuilt(): string {
  const cli = join(PACKAGE_ROOT, "dist", "cli.js");
  if (existsSync(cli) && existsSync(join(PACKAGE_ROOT, "dist", "web", "app.js"))) return cli;
  if (!existsSync(join(PACKAGE_ROOT, "node_modules", "esbuild"))) {
    throw new Error(`techtree is not built and esbuild is missing; run \`npm install && npm run build\` in ${PACKAGE_ROOT}`);
  }
  execFileSync(process.execPath, ["build.mjs"], { cwd: PACKAGE_ROOT, stdio: "ignore" });
  return cli;
}
