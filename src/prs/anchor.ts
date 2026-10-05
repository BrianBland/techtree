import { dirname } from "node:path/posix";
import type { NodeId, Tree } from "../types.ts";

export interface ChangedFile {
  path: string;
  /** Additions + deletions. */
  lines: number;
}

/** The deepest node containing at least 60% of a PR's changed lines. See docs/DESIGN.md "PRs". */
export function anchorPr(files: ChangedFile[], tree: Tree): NodeId {
  const anyLines = files.some((f) => f.lines > 0);
  const subtreeLines = new Map<NodeId, number>();
  let total = 0;
  for (const file of files) {
    const lines = anyLines ? file.lines : 1;
    total += lines;
    for (let node: NodeId | null = containingNode(file.path, tree); node !== null; node = tree.nodes[node].parent)
      subtreeLines.set(node, (subtreeLines.get(node) ?? 0) + lines);
  }
  let anchor: NodeId = "";
  for (const [node, lines] of subtreeLines)
    if (lines * 10 >= total * 6 && depth(node) > depth(anchor)) anchor = node;
  return anchor;
}

function containingNode(path: string, tree: Tree): NodeId {
  let dir = dirname(path);
  while (dir !== "." && !tree.nodes[dir]) dir = dirname(dir);
  return dir === "." ? "" : dir;
}

function depth(node: NodeId): number {
  return node === "" ? 0 : node.split("/").length;
}
