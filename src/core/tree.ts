import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { Config, NodeId, Tree, TreeNode } from "../types.ts";

/** Build the directory tree of a repo from `git ls-files -co --exclude-standard`, minus `config.ignore`. */
export function buildTree(repoRoot: string, config: Config): Tree {
  const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return treeFromFiles(repoRoot, out.split("\0").filter(Boolean), config.ignore);
}

/** Build the tree for an explicit list of repo-relative file paths. */
export function treeFromFiles(repoRoot: string, files: string[], ignore: string[] = []): Tree {
  const ignored = ignore.map(ignoreMatcher);
  const nodes = dict<TreeNode>();
  const nodeFor = (id: NodeId): TreeNode => {
    let node = nodes[id];
    if (node) return node;
    const slash = id.lastIndexOf("/");
    const parent = id === "" ? null : slash < 0 ? "" : id.slice(0, slash);
    node = { id, name: id === "" ? basename(repoRoot) : id.slice(slash + 1), kind: "dir", parent, children: [], files: [] };
    nodes[id] = node;
    if (parent !== null) nodeFor(parent).children.push(id);
    return node;
  };
  nodeFor("");
  for (const file of files) {
    if (ignored.some((re) => re.test(file))) continue;
    const slash = file.lastIndexOf("/");
    nodeFor(slash < 0 ? "" : file.slice(0, slash)).files.push(file);
  }
  for (const node of Object.values(nodes)) {
    node.children.sort();
    node.files.sort();
  }
  return { repoRoot, nodes };
}

function ignoreMatcher(entry: string): RegExp {
  const trimmed = entry.replace(/^\/+|\/+$/g, "");
  const body = trimmed
    .split(/(\*\*|\*)/)
    .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(trimmed.includes("/") ? `^${body}(/|$)` : `(^|/)${body}(/|$)`);
}

/** An empty node-keyed record without a prototype, so ids like "constructor" are plain keys. */
export function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Depth of a node id: 0 for the root. */
export function depth(id: NodeId): number {
  return id === "" ? 0 : id.split("/").length;
}
