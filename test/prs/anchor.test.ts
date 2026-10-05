import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorPr } from "../../src/prs/anchor.ts";
import { makeTree } from "./helpers.ts";

const tree = makeTree("crates/a/src", "crates/b", "docs");

test("anchors at the deepest node holding at least 60% of the changed lines", () => {
  const files = [
    { path: "crates/a/src/lib.rs", lines: 70 },
    { path: "crates/b/main.rs", lines: 30 },
  ];
  assert.equal(anchorPr(files, tree), "crates/a/src");
});

test("exactly 60% qualifies; just under falls back to the ancestor", () => {
  assert.equal(anchorPr([{ path: "crates/a/src/x.rs", lines: 60 }, { path: "docs/x.md", lines: 40 }], tree), "crates/a/src");
  assert.equal(anchorPr([{ path: "crates/a/src/x.rs", lines: 59 }, { path: "docs/x.md", lines: 41 }], tree), "");
  assert.equal(anchorPr([{ path: "crates/a/src/x.rs", lines: 59 }, { path: "crates/b/x.rs", lines: 41 }], tree), "crates");
});

test("an even split anchors at the common ancestor", () => {
  assert.equal(anchorPr([{ path: "crates/a/src/x.rs", lines: 50 }, { path: "crates/b/y.rs", lines: 50 }], tree), "crates");
});

test("files in directories that are not nodes count toward their deepest existing ancestor", () => {
  assert.equal(anchorPr([{ path: "crates/b/new/mod.rs", lines: 10 }], tree), "crates/b");
  assert.equal(anchorPr([{ path: "target/out.txt", lines: 80 }, { path: "docs/x.md", lines: 20 }], tree), "");
  assert.equal(anchorPr([{ path: "README.md", lines: 5 }], tree), "");
});

test("without changed lines every file weighs one line; without files the anchor is the root", () => {
  const renames = [
    { path: "docs/a.md", lines: 0 },
    { path: "docs/b.md", lines: 0 },
    { path: "crates/b/c.rs", lines: 0 },
  ];
  assert.equal(anchorPr(renames, tree), "docs");
  assert.equal(anchorPr([], tree), "");
});
