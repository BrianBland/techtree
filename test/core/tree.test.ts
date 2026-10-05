import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildTree, treeFromFiles } from "../../src/core/tree.ts";
import { config, fixtureRepo } from "./fixture.ts";

test("builds a node per directory with files below it, honouring .gitignore and config.ignore", () => {
  const root = fixtureRepo({
    ".gitignore": "*.log\n",
    "README.md": "",
    "src/lib.rs": "",
    "src/a/b/deep.rs": "",
    "src/debug.log": "",
    "crates/x/target/out.rs": "",
    "vendor/gen/v.rs": "",
  });
  writeFileSync(join(root, "src/new.rs"), "untracked but not ignored");
  const tree = buildTree(root, config({ ignore: ["target", "vendor/gen"] }));

  assert.deepEqual(Object.keys(tree.nodes).sort(), ["", "src", "src/a", "src/a/b"]);
  const rootNode = tree.nodes[""];
  assert.equal(rootNode.parent, null);
  assert.deepEqual(rootNode.files, [".gitignore", "README.md"]);
  assert.deepEqual(rootNode.children, ["src"]);
  assert.deepEqual(tree.nodes.src.files, ["src/lib.rs", "src/new.rs"]);
  assert.deepEqual(tree.nodes["src/a"], { id: "src/a", name: "a", kind: "dir", parent: "src", children: ["src/a/b"], files: [] });
});

test("ignore globs match within and across segments", () => {
  const tree = treeFromFiles("/r", ["a/gen-1/f", "a/keep/f", "b/x/y/z.snap", "b/x/f"], ["gen-*", "b/**/*.snap"]);
  assert.deepEqual(Object.keys(tree.nodes).sort(), ["", "a", "a/keep", "b", "b/x"]);
  assert.deepEqual(tree.nodes["b/x"].children, []);
});

test("handles a large repo quickly", () => {
  const files = Array.from({ length: 10_000 }, (_, i) => `d${i % 50}/s${i % 400}/f${i}.rs`);
  const start = performance.now();
  const tree = treeFromFiles("/r", files);
  assert.equal(Object.keys(tree.nodes).length, 1 + 50 + 400);
  assert.ok(performance.now() - start < 1000);
});
