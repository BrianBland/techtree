import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";

export const CLI = join(import.meta.dirname, "..", "..", "src", "cli.ts");
export const FAKE_PI = join(import.meta.dirname, "..", "runner", "fake-pi.mjs");

/** A file the generic plugin reports as a TODO cluster, giving the fixture one finding. */
export const TODO_FILE = "src/core/lib.rs";

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
});

/** A temp dir (symlinks resolved, as `git rev-parse --show-toplevel` reports it) holding a committed fixture repo (`repo/`) and an isolated XDG cache (`cache/`), removed after the test. */
export function fixture(t: TestContext, extraFiles: Record<string, string> = {}): { tmp: string; repo: string; cache: string } {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "techtree-backend-")));
  const repo = join(tmp, "repo");
  const files: Record<string, string> = {
    [TODO_FILE]: "fn a() {}\n// TODO one\n// TODO two\n// TODO three\n",
    "src/util/mod.rs": "fn b() {}\n",
    "README.md": "fixture\n",
    ...extraFiles,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  return { tmp, repo, cache: join(tmp, "cache") };
}

/** Point `XDG_CACHE_HOME` at `cache` for the rest of the test. */
export function withCacheHome(t: TestContext, cache: string): void {
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
  });
}

/** Set (or with `undefined`, unset) an environment variable for the rest of the test. */
export function withEnv(t: TestContext, name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

export async function until<T>(probe: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
