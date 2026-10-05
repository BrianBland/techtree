import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { rustPlugin } from "../../src/plugins/rust.ts";
import type { Tree } from "../../src/types.ts";
import { buildTree, fixture, makeCtx, memoryCache, script, writeFiles } from "./helpers.ts";

const CORE_LIB = `//! docs mention .unwrap() here
pub fn parse(s: &str) -> u32 {
    if s.is_empty() && true { return 0; }
    let _msg = "call .unwrap() in a string";
    s.parse().unwrap()
}

pub(crate) fn helper(x: Option<u8>) -> u8 {
    match x { Some(v) => v, None => 0 }
}

pub async fn untested_one() {}
fn private() { for i in 0..3 { let _ = i; } }
fn life<'a>(x: &'a str) -> &'a str { x }
struct Thing;
impl Default for Thing { fn default() -> Self { Thing } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses() { assert_eq!(parse("1"), 1); Some(1).unwrap(); let _c = '}'; }
    #[test]
    #[ignore]
    fn slow() {}
}
`;

function workspace(): string {
  return fixture({
    "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\nmy-core = { path = "crates/core" }\n`,
    "crates/core/Cargo.toml": `[package]\nname = "my-core" # the core\nversion = "0.1.0"\n`,
    "crates/core/src/lib.rs": CORE_LIB,
    "crates/core/src/extra.rs": "pub fn exported() {}\n\n#[cfg(test)]\nmod extra_tests;\n",
    "crates/core/src/extra/extra_tests.rs": "use super::*;\n#[tokio::test]\nasync fn covers() { exported(); None::<u8>.unwrap(); }\n",
    "crates/core/tests/it.rs": `#[tokio::test(flavor = "multi_thread")]\nasync fn it() { None::<u8>.expect("x"); }\n`,
    "crates/core/examples/demo.rs": "fn main() { Some(1).unwrap(); }\n",
    "crates/app/Cargo.toml": `[package]\nname = "app"\n\n[dependencies]\nmy-core = { workspace = true }\n\n[dev-dependencies.renamed]\npackage = "my-core"\n`,
    "crates/app/src/main.rs": "fn main() {}\n",
    "crates/tool/Cargo.toml": `[package]\nname = "tool"\n\n[dependencies]\ncore2 = { package = "my-core", path = "../core" }\n\n[target.'cfg(unix)'.dependencies]\napp.workspace = true\n`,
  });
}

function annotated(root: string): Tree {
  const tree = buildTree(root);
  rustPlugin.annotate!(tree);
  return tree;
}

test("annotate turns directories whose Cargo.toml has [package] into named crates", () => {
  const tree = annotated(workspace());
  assert.deepEqual(
    Object.values(tree.nodes)
      .filter((n) => n.kind === "crate")
      .map((n) => [n.id, n.name]),
    [
      ["crates/app", "app"],
      ["crates/core", "my-core"],
      ["crates/tool", "tool"],
    ],
  );
  assert.equal(tree.nodes[""].kind, "dir");
});

test("own values count non-test fns, branches, unwraps and tests, ignoring comments, strings and test code", async () => {
  const values = await rustPlugin.collect(makeCtx(annotated(workspace())));
  assert.deepEqual(values["crates/core/src"], {
    fn_count: 7,
    pub_fn_count: 3,
    complexity: 4,
    unwrap_density: 1,
    test_count: 2,
    test_ratio: 2,
    ignored_tests: 1,
  });
  assert.deepEqual(values["crates/core/src/extra"], {
    fn_count: 0,
    pub_fn_count: 0,
    complexity: 0,
    unwrap_density: 0,
    test_count: 1,
    test_ratio: 1,
    ignored_tests: 0,
  });
  assert.equal(values["crates/core/tests"].test_count, 1);
  assert.equal(values["crates/core/tests"].unwrap_density, 0);
  assert.equal(values["crates/core/examples"].unwrap_density, 0);
  assert.equal(values["crates/core/examples"].fn_count, 0);
  assert.equal(values[""], undefined);
});

test("fan_in counts distinct workspace crates depending on each crate, including renamed deps", async () => {
  const values = await rustPlugin.collect(makeCtx(annotated(workspace())));
  assert.deepEqual(values["crates/core"], { fan_in: 2 });
  assert.deepEqual(values["crates/app"], { fan_in: 1 });
  assert.deepEqual(values["crates/tool"], { fan_in: 0 });
});

test("test_time sums nextest JUnit suites per package from CARGO_TARGET_DIR", async (t) => {
  const root = workspace();
  const target = fixture({
    "nextest/ci/test-results.xml": `<?xml version="1.0"?>
<testsuites name="nextest-run" tests="3" time="4.0">
  <testsuite name="my-core" tests="1" time="1.5"><testcase name="a" time="1.5"/></testsuite>
  <testsuite name="my-core::it" tests="1" time="0.5"></testsuite>
  <testsuite name="app::bin/app" tests="1" time="2"></testsuite>
</testsuites>`,
  });
  process.env.CARGO_TARGET_DIR = target;
  t.after(() => delete process.env.CARGO_TARGET_DIR);
  const values = await rustPlugin.collect(makeCtx(annotated(root)));
  assert.equal(values["crates/core"].test_time, 2);
  assert.equal(values["crates/app"].test_time, 2);
  assert.equal(values["crates/tool"].test_time, undefined);
});

test("unwrap/expect findings are grouped per file with ids that survive unrelated edits", async () => {
  const root = workspace();
  const unwraps = async () => (await rustPlugin.findings!(makeCtx(annotated(root)))).filter((f) => f.source === "unwrap");
  const before = await unwraps();
  assert.deepEqual(
    before.map((f) => [f.file, f.node, f.line, f.metricEffects]),
    [["crates/core/src/lib.rs", "crates/core/src", 5, { unwrap_density: -1 }]],
  );
  writeFiles(root, { "crates/core/src/lib.rs": "use std::fmt;\n\n" + CORE_LIB.replace("s.parse().unwrap()", "s.parse().expect(\"num\")") });
  const after = await unwraps();
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[0].line, 7);
});

test("public fns never mentioned by the crate's test code are reported per file", async () => {
  const findings = (await rustPlugin.findings!(makeCtx(annotated(workspace())))).filter((f) => f.source === "test-gap");
  assert.equal(findings.length, 1);
  const [gap] = findings;
  assert.equal(gap.file, "crates/core/src/lib.rs");
  assert.match(gap.detail, /untested_one/);
  assert.doesNotMatch(gap.detail, /parse/);
  assert.deepEqual(gap.metricEffects, { test_count: 1, test_ratio: 1 });
  assert.deepEqual(gap.tags, ["api"]);
});

const CLIPPY_FIXTURE = join(import.meta.dirname, "fixtures", "clippy.jsonl");

/** Workspace with crates alpha and broken plus a fake cargo replaying `output` (`@ROOT@` = workspace root). */
function clippyWorkspace(output = readFileSync(CLIPPY_FIXTURE, "utf8")): { root: string; calls: () => string[] } {
  const root = fixture({
    "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n`,
    "crates/alpha/Cargo.toml": `[package]\nname = "alpha"\n`,
    "crates/alpha/src/lib.rs": "pub fn answer() -> i32 {\n    return 42;\n}\n\npub fn empty(v: &[u8]) -> bool {\n    v.len() == 0\n}\n",
    "crates/broken/Cargo.toml": `[package]\nname = "broken"\n`,
    "crates/broken/src/lib.rs": `pub fn oops() -> i32 { "no" }\n`,
  });
  const bin = fixture({});
  const log = join(bin, "calls.log");
  // Cargo reports canonical paths (e.g. /private/var on macOS), so the recording is replayed with the realpath.
  writeFiles(bin, { "out.jsonl": output });
  script(join(bin, "cargo"), `echo "$*" >> "${log}"\nsed "s#@ROOT@#${realpathSync(root)}#g" "${join(bin, "out.jsonl")}"\nexit 101`);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  test.after(() => (process.env.PATH = saved));
  return { root, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

test("clippy is off by default: no cargo run and no lint_warnings", async () => {
  const { root, calls } = clippyWorkspace();
  const values = await rustPlugin.collect(makeCtx(annotated(root)));
  assert.deepEqual(calls(), []);
  assert.equal(values["crates/alpha/src"].lint_warnings, undefined);
});

test("one clippy run attributes diagnostics to crates; crates that fail to build get no value", async () => {
  const { root, calls } = clippyWorkspace();
  const logs: string[] = [];
  const ctx = makeCtx(annotated(root), { logs, config: { plugins: { rust: { clippy: true, clippyArgs: ["--all-targets"] } } } });
  const values = await rustPlugin.collect(ctx);
  const findings = (await rustPlugin.findings!(ctx)).filter((f) => f.source === "clippy");

  assert.deepEqual(calls(), ["clippy --message-format=json -p alpha -p broken --all-targets"]);
  assert.equal(values["crates/alpha/src"].lint_warnings, 2);
  assert.equal(values["crates/broken/src"].lint_warnings, undefined);
  assert.ok(logs.some((l) => l.includes("broken")));
  assert.deepEqual(
    findings.map((f) => [f.title.split(":")[0], f.node, f.file, f.effort, f.metricEffects]).sort(),
    [
      ["len_zero", "crates/alpha/src", "crates/alpha/src/lib.rs", "trivial", { lint_warnings: -1 }],
      ["needless_return", "crates/alpha/src", "crates/alpha/src/lib.rs", "trivial", { lint_warnings: -1 }],
    ],
  );
});

test("clippy results are cached per crate key; only changed or uncached crates are re-linted", async (t) => {
  const { root, calls } = clippyWorkspace();
  process.env.TECHTREE_CLIPPY = "1";
  t.after(() => delete process.env.TECHTREE_CLIPPY);
  const cache = memoryCache();
  const lint = async (config = {}) => rustPlugin.collect(makeCtx(annotated(root), { cache, config }));

  await lint();
  const second = await lint();
  assert.equal(second["crates/alpha/src"].lint_warnings, 2);
  await lint({ plugins: { rust: { exclude: ["broken"] } } });
  writeFiles(root, { "crates/alpha/src/lib.rs": readFileSync(join(root, "crates/alpha/src/lib.rs"), "utf8") + "\n// edit\n" });
  await lint({ plugins: { rust: { exclude: ["broken"] } } });

  assert.deepEqual(calls(), [
    "clippy --message-format=json -p alpha -p broken",
    "clippy --message-format=json -p broken",
    "clippy --message-format=json -p alpha",
  ]);
});

const ALPHA_MANIFEST = "@ROOT@/crates/alpha/Cargo.toml";

function artifact(kind: string): string {
  return JSON.stringify({ reason: "compiler-artifact", manifest_path: ALPHA_MANIFEST, target: { kind: [kind], name: kind } });
}

function lenZero(column: number): string {
  const byte = 60 + column;
  return JSON.stringify({
    reason: "compiler-message",
    manifest_path: ALPHA_MANIFEST,
    message: {
      level: "warning",
      message: "length comparison to zero",
      code: { code: "clippy::len_zero" },
      spans: [
        {
          file_name: "crates/alpha/src/lib.rs",
          is_primary: true,
          line_start: 6,
          column_start: column,
          byte_start: byte,
          byte_end: byte + 12,
          text: [{ text: "    v.len() == 0" }],
        },
      ],
      children: [],
    },
  });
}

test("a crate whose build script fails gets no lint value and is not cached", async (t) => {
  const failedBuildScript = [artifact("custom-build"), JSON.stringify({ reason: "build-finished", success: false })].join("\n");
  const { root, calls } = clippyWorkspace(failedBuildScript);
  process.env.TECHTREE_CLIPPY = "1";
  t.after(() => delete process.env.TECHTREE_CLIPPY);
  const cache = memoryCache();
  const logs: string[] = [];
  const config = { plugins: { rust: { exclude: ["broken"] } } };
  const values = await rustPlugin.collect(makeCtx(annotated(root), { cache, config, logs }));
  await rustPlugin.collect(makeCtx(annotated(root), { cache, config }));

  assert.equal(values["crates/alpha/src"].lint_warnings, undefined);
  assert.ok(logs.some((l) => l.includes("alpha")));
  assert.deepEqual(calls(), ["clippy --message-format=json -p alpha", "clippy --message-format=json -p alpha"]);
});

test("separate diagnostics on one line each count, while repeated emissions of one span collapse", async (t) => {
  const { root } = clippyWorkspace([artifact("lib"), lenZero(5), lenZero(5), lenZero(20)].join("\n"));
  process.env.TECHTREE_CLIPPY = "1";
  t.after(() => delete process.env.TECHTREE_CLIPPY);
  const ctx = makeCtx(annotated(root), { config: { plugins: { rust: { exclude: ["broken"] } } } });
  const values = await rustPlugin.collect(ctx);
  const findings = (await rustPlugin.findings!(ctx)).filter((f) => f.source === "clippy");

  assert.equal(values["crates/alpha/src"].lint_warnings, 2);
  assert.equal(findings.length, 2);
  assert.notEqual(findings[0].id, findings[1].id);
});

test("fan_in credits aliases a member inherits from [workspace.dependencies] to the real package", async () => {
  const root = fixture({
    "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\ncore-alias = { package = "my-core", path = "crates/core" }\n\n[workspace.dependencies.other-alias]\npackage = "my-core"\npath = "crates/core"\n`,
    "crates/core/Cargo.toml": `[package]\nname = "my-core"\n`,
    "crates/a/Cargo.toml": `[package]\nname = "a"\n\n[dependencies]\ncore-alias = { workspace = true }\n`,
    "crates/b/Cargo.toml": `[package]\nname = "b"\n\n[dev-dependencies]\nother-alias.workspace = true\n`,
    "crates/c/Cargo.toml": `[package]\nname = "c"\n\n[dependencies.core-alias]\nworkspace = true\n`,
  });
  const values = await rustPlugin.collect(makeCtx(annotated(root)));
  assert.deepEqual(values["crates/core"], { fan_in: 3 });
});

test("unwraps in binary entry points and build scripts are not counted; confidence weighs each call", async () => {
  const root = fixture({
    "Cargo.toml": `[package]\nname = "solo"\n`,
    "build.rs": "fn main() { std::env::var(\"X\").unwrap(); }\n",
    "src/main.rs": "fn main() { run().unwrap(); }\n",
    "src/bin/tool.rs": "fn main() { run().unwrap(); }\n",
    "src/lib.rs": [
      "pub fn a(r: Result<u8, ()>) -> u8 { r.unwrap() }",
      "pub fn b(r: Result<u8, ()>) -> u8 { r.expect(\"validated by caller\") }",
      "pub fn c(m: &std::sync::Mutex<u8>) -> u8 { *m.lock().unwrap() }",
      "pub fn d() -> std::net::IpAddr { \"127.0.0.1\".parse::<std::net::IpAddr>().unwrap() }",
      "",
    ].join("\n"),
  });
  const ctx = makeCtx(annotated(root));
  const values = await rustPlugin.collect(ctx);
  assert.equal(values[""].unwrap_density, 0);
  assert.equal(values.src.unwrap_density, 4);
  assert.equal(values["src/bin"].unwrap_density, 0);
  const unwraps = (await rustPlugin.findings!(ctx)).filter((f) => f.source === "unwrap");
  assert.deepEqual(unwraps.map((f) => f.file), ["src/lib.rs"]);
  assert.equal(unwraps[0].confidence, (1 + 0.6 + 0.2 + 0.2) / 4);
});

test("test gaps are reported with low confidence, and only for crates other crates depend on", async () => {
  const findings = (await rustPlugin.findings!(makeCtx(annotated(workspace())))).filter((f) => f.source === "test-gap");
  assert.deepEqual(findings.map((f) => [f.file, f.confidence]), [["crates/core/src/lib.rs", 0.3]]);
  const leaf = fixture({ "Cargo.toml": `[package]\nname = "leaf"\n`, "src/lib.rs": "pub fn untested() {}\n" });
  const ctx = makeCtx(annotated(leaf));
  assert.deepEqual((await rustPlugin.findings!(ctx)).filter((f) => f.source === "test-gap"), []);
  assert.equal((await rustPlugin.collect(ctx)).src.pub_fn_count, 1, "test_ratio still counts the untested fn");
});
