import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { mergeConfig } from "../../src/config.ts";
import { dbCache, openDb, suppressSqliteWarning } from "../../src/db.ts";
import type { Cache, CollectCtx, Config, Tree } from "../../src/types.ts";

suppressSqliteWarning();

/** Create a temp dir populated with `files` (repo-relative path → content). */
export function fixture(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "techtree-plugins-"));
  writeFiles(root, files);
  return root;
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** Write an executable shell script at `path`. */
export function script(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** Directory tree of `root` (skipping .git and target), every node kind "dir". */
export function buildTree(root: string): Tree {
  const tree: Tree = { repoRoot: root, nodes: Object.create(null) };
  const walk = (id: string, parent: string | null) => {
    const node = { id, name: id === "" ? "root" : posix.basename(id), kind: "dir", parent, children: [] as string[], files: [] as string[] };
    tree.nodes[id] = node;
    for (const entry of readdirSync(join(root, id), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === "target") continue;
      const path = id === "" ? entry.name : `${id}/${entry.name}`;
      if (entry.isDirectory()) {
        node.children.push(path);
        walk(path, id);
      } else node.files.push(path);
    }
  };
  walk("", null);
  return tree;
}

export function memoryCache(): Cache {
  return dbCache(openDb(":memory:"));
}

export function makeCtx(tree: Tree, opts: { config?: Partial<Config>; cache?: Cache; logs?: string[] } = {}): CollectCtx {
  return {
    repoRoot: tree.repoRoot,
    tree,
    config: mergeConfig(opts.config ?? {}),
    cache: opts.cache ?? memoryCache(),
    log: (msg) => opts.logs?.push(msg),
  };
}

export function git(root: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
}
