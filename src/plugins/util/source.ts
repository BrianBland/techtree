import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { posix, join } from "node:path";
import type { NodeId, Tree } from "../../types.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const LOCKFILES = new Set(["Cargo.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "go.sum", "poetry.lock"]);
const VENDORED = /(^|\/)(vendor|third_party)\//;
const GENERATED_MARKER = /@generated|DO NOT EDIT/;

/** Directory node that owns a repo-relative file path. */
export function nodeOfFile(file: string): NodeId {
  const dir = posix.dirname(file);
  return dir === "." ? "" : dir;
}

/**
 * Text of a source file worth measuring, or undefined for binary, oversized,
 * lock, minified, vendored and generated files.
 */
export function readSource(repoRoot: string, file: string): string | undefined {
  const name = posix.basename(file);
  if (LOCKFILES.has(name) || /\.min\.\w+$/.test(name) || VENDORED.test(file)) return undefined;
  const path = join(repoRoot, file);
  try {
    if (statSync(path).size > MAX_BYTES) return undefined;
    const buf = readFileSync(path);
    if (buf.subarray(0, 8192).includes(0)) return undefined;
    const text = buf.toString("utf8");
    if (GENERATED_MARKER.test(text.slice(0, 1024))) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

/** Stable finding id: a hash of (source, file, rule, snippet), independent of line numbers. */
export function findingId(source: string, file: string, rule: string, snippet: string): string {
  return createHash("sha256").update([source, file, rule, snippet].join("\0")).digest("hex").slice(0, 16);
}

/** All file paths in the tree. */
export function treeFiles(tree: Tree): string[] {
  return Object.values(tree.nodes).flatMap((n) => n.files);
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command with the parent environment; never rejects (spawn errors give code null). */
export function run(cmd: string, args: string[], cwd: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, signal, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => resolve({ code: null, stdout: "", stderr: String(e) }));
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
  });
}
