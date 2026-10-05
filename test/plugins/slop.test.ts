import { test } from "node:test";
import assert from "node:assert/strict";
import { slopPlugin } from "../../src/plugins/slop.ts";
import type { Finding } from "../../src/types.ts";
import { buildTree, fixture, makeCtx } from "./helpers.ts";

async function run(files: Record<string, string>) {
  const ctx = makeCtx(buildTree(fixture(files)));
  return { values: await slopPlugin.collect(ctx), findings: await slopPlugin.findings!(ctx) };
}

const only = (findings: Finding[], source: string) => findings.filter((f) => f.source === source);

/** `n` distinct significant lines, numbered from `from`. */
const block = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `    let value_${from + i} = compute_value(${from + i}, "x");`).join("\n");

const fnWith = (name: string, body: string) => `use std::fmt;\n\nfn ${name}() {\n${body}\n}\n`;

test("a block of 10+ significant lines in two files is one finding on the first copy", async () => {
  const { values, findings } = await run({
    "a/x.rs": fnWith("one", block(12)),
    "b/y.rs": fnWith("two", "    unrelated();\n" + block(12).replace("compute_value(3", "compute_value( 3 /* spaced */") + "\n    // a comment\n}\nfn other() {\n    more();"),
  });
  const dups = only(findings, "duplication");
  assert.deepEqual(dups.map((f) => [f.file, f.line, f.title, f.metricEffects]), [
    ["a/x.rs", 4, "Deduplicate 12-line block in a/x.rs (also in b/y.rs)", { dup_lines: -12 }],
  ]);
  assert.match(dups[0].detail, /b\/y\.rs:5/);
  assert.equal(dups[0].effort, "small");
  assert.equal(dups[0].severity, "low");
  assert.equal(dups[0].confidence, 0.9);
  assert.equal(values.a.dup_lines, 12);
  assert.equal(values.b.dup_lines, 12);
});

test("three copies give one finding listing the others; trivial lines do not make a window", async () => {
  const { values, findings } = await run({
    "a.rs": fnWith("a", block(10)),
    "b.rs": fnWith("b", block(10)),
    "c.rs": fnWith("c", block(10)),
    "d.rs": fnWith("d", block(9) + "\n    }\n    }\n    }\n    #[inline]\n    use foo::bar;"),
    "e.rs": fnWith("e", block(9) + "\n    }\n    }\n    }\n    #[inline]\n    use foo::bar;"),
  });
  const dups = only(findings, "duplication");
  assert.deepEqual(dups.map((f) => f.title), ["Deduplicate 10-line block in a.rs (also in b.rs, +1 more)"]);
  assert.equal(dups[0].severity, "medium");
  assert.equal(values[""].dup_lines, 30, "d.rs and e.rs share only 9 significant lines");
});

test("windows of short lines never match; test-code blocks under 20 lines count but are not reported", async () => {
  const getters = Array.from({ length: 12 }, (_, i) => `fn g${i}(&self) -> u8 { self.f${i} }`).join("\n");
  const testMod = (name: string) => `fn ${name}() {}\n#[cfg(all(test, unix))]\nmod tests {\n${block(15)}\n}\n`;
  const { values, findings } = await run({
    "a.rs": getters, "b.rs": getters,
    "c.rs": testMod("c"), "d.rs": testMod("d"),
    "tests/e.rs": fnWith("e", block(19, 100)), "tests/f.rs": fnWith("f", block(19, 100)),
    "tests/g.rs": fnWith("g", block(20, 200)), "tests/h.rs": fnWith("h", block(20, 200)),
  });
  assert.deepEqual(only(findings, "duplication").map((f) => f.file), ["tests/g.rs"]);
  assert.equal(values[""].dup_lines, 2 * 16, "a.rs and b.rs count nothing; c.rs and d.rs share `mod tests {` and 15 lines");
  assert.equal(values.tests.dup_lines, 2 * 19 + 2 * 20);
});

test("blocks that differ only in string literals are different code", async () => {
  const { values } = await run({ "a.rs": fnWith("a", block(12)), "b.rs": fnWith("b", block(12).replace(/"x"/g, '"y"')) });
  assert.equal(values[""].dup_lines, 0);
});

test("repetitive code within one file is not duplication", async () => {
  const { values, findings } = await run({ "a.rs": fnWith("a", Array(30).fill("    total += step(1);").join("\n")) });
  assert.deepEqual(only(findings, "duplication"), []);
  assert.equal(values[""].dup_lines, 0);
});

test("noise comments are classified; docs, licenses, SAFETY, TODOs, directives and why-comments are kept", async () => {
  const src = [
    "// Copyright 2024 Example Corp. Licensed under MIT.",
    "// See LICENSE for details.",
    "",
    "//! Crate docs.",
    "/// Documented fn.",
    "// ---- Section ----",
    "fn main() {",
    "    // let x = foo(1);",
    "    // bar(x);",
    "    start();",
    "    // removed: old handler",
    "    start_again();",
    "    // create the client",
    "    let client = Client::new();",
    "    // SAFETY: the pointer is valid for the whole call;",
    "    unsafe { go(client) };",
    "    // TODO: handle(x);",
    "    // clippy::needless_return is wrong here",
    "    // retry because the server drops the first request",
    "    let response = retry_request(client);",
    "    // The checked recovery rejects the high-s form (EIP-2);",
    "    done(response);",
    "}",
    "",
  ].join("\n");
  const { values, findings } = await run({ "src/main.rs": src });
  assert.equal(values.src.comment_noise, 5);
  const [noise] = only(findings, "comment-noise");
  assert.equal(noise.title, "Remove 5 noise comment lines in src/main.rs");
  assert.deepEqual(noise.metricEffects, { comment_noise: -5 });
  assert.equal(noise.effort, "trivial");
  assert.equal(noise.line, 6);
  assert.ok(Math.abs(noise.confidence! - (0.9 + 0.8 + 0.8 + 0.7 + 0.6) / 5) < 1e-9);
  for (const n of [6, 8, 9, 11, 13]) assert.match(noise.detail, new RegExp(`:${n}\\b`));
});

test("a banner's label line is part of the banner, tables are not; stale notes must be short standalone notes", async () => {
  const src = [
    "// ==========================================",
    "// NsmSession",
    "// ==========================================",
    "fn a() {}",
    "",
    "// removed",
    "fn b() {}",
    "",
    "// Removed nodes should not be found",
    "fn c() {}",
    "",
    "// +-------+-----------+",
    "// | Bytes | Field     |",
    "// +-------+-----------+",
    "// | 0..4  | selector  |",
    "// +-------+-----------+",
    "fn e() {}",
    "",
    "// The handler was rewritten and this path is",
    "// removed from the state root for every status.",
    "fn d() {}",
    "",
  ].join("\n");
  const [noise] = only((await run({ "a.rs": src })).findings, "comment-noise");
  assert.equal(noise.title, "Remove 4 noise comment lines in a.rs");
  assert.match(noise.detail, /a\.rs:2 \(divider\)/);
  assert.match(noise.detail, /a\.rs:6 \(stale note\)/);
});

test("a file without noise comments has no finding and a zero metric", async () => {
  const { values, findings } = await run({ "a.ts": "// Why: the API rejects empty batches.\nexport const x = send(batch);\n" });
  assert.equal(values[""].comment_noise, 0);
  assert.deepEqual(only(findings, "comment-noise"), []);
});

const TESTS = `
fn check_roundtrip(v: u8) { assert_eq!(decode(encode(v)), v); }
fn roundtrip_helper(v: u8) { check_roundtrip(v) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoke() { let _ = encode(1); }

    #[test]
    fn also_nothing() {
        let v = encode(2);
        println!("{v:?}");
    }

    #[test]
    fn uses_helper() { roundtrip_helper(3); }

    #[test]
    fn unwraps() { decode(encode(3)).unwrap(); }

    #[test]
    #[should_panic]
    fn panics() { decode_strict(vec![]); }

    #[test]
    fn result() -> Result<(), String> { decode(encode(4))?; Ok(()) }

    #[test]
    fn via_macro() { check_all!(encode); }

    #[test]
    fn parse_a() { let input = "a"; assert_eq!(parse(input).len(), 1); }

    #[test]
    fn parse_b() { let input = "bb"; assert_eq!(parse(input).len(), 2); }

    #[test]
    fn parse_c() {
        let input = "ccc";
        assert_eq!(parse(input).len(), 3);
    }

    #[tokio::test]
    async fn trivial() {
        assert!(true);
        assert_eq!(1, 1);
        let x = encode(5);
        assert_eq!(x, x);
        assert_eq!(x, 5);
        assert_eq!(encode(6), encode(6));
    }

    #[rstest]
    #[case(1, "one")]
    fn display_short(#[case] v: u8, #[case] want: &str) { let rendered = v.to_string(); assert_eq!(rendered, want); }

    #[rstest]
    #[case(2, "two")]
    fn display_long(#[case] v: u8, #[case] want: &str) { let rendered = v.to_string(); assert_eq!(rendered, want); }
}
`;

test("test smells: assertion-free, near-duplicate and trivially-asserting tests (determinism checks and rstest cases excluded)", async () => {
  const { values, findings } = await run({ "src/lib.rs": TESTS });
  const smells = only(findings, "test-smell");
  const byTitle = Object.fromEntries(smells.map((f) => [f.title, f]));
  assert.deepEqual(Object.keys(byTitle).sort(), [
    "2 tests in src/lib.rs assert nothing",
    "Merge 3 near-duplicate tests in src/lib.rs",
    "Remove 3 trivial asserts in src/lib.rs",
  ]);
  const free = byTitle["2 tests in src/lib.rs assert nothing"];
  assert.match(free.detail, /smoke/);
  assert.match(free.detail, /also_nothing/);
  assert.deepEqual(free.metricEffects, { test_smells: -2 });
  assert.equal(free.effort, "small");
  assert.equal(free.confidence, 0.7);
  assert.match(byTitle["Merge 3 near-duplicate tests in src/lib.rs"].detail, /parse_a, parse_b, parse_c/);
  assert.equal(byTitle["Remove 3 trivial asserts in src/lib.rs"].effort, "trivial");
  assert.equal(values.src.test_smells, 2 + 3 + 3);
});

test("an overlong test is a smell; short tests and long case tables are not", async () => {
  const long = `#[test]\nfn long() {\n${Array.from({ length: 121 }, (_, i) => `    assert_eq!(step(${i}), ${i});`).join("\n")}\n}\n`;
  const table = `#[test]\nfn table() {\n    let cases = [\n${Array.from({ length: 121 }, (_, i) => `        (${i}, ${i}),`).join("\n")}\n    ];\n    for (input, want) in cases { assert_eq!(step(input), want); }\n}\n`;
  const { values, findings } = await run({ "tests/it.rs": long, "tests/ok.rs": "#[test]\nfn ok() { assert!(works()); }\n", "tests/table.rs": table });
  assert.deepEqual(only(findings, "test-smell").map((f) => [f.file, f.title]), [["tests/it.rs", "Split 1 overlong test in tests/it.rs"]]);
  assert.equal(values.tests.test_smells, 1);
});

test("checks through unwrap_err, assert-like builders and helpers passed by name are expectations", async () => {
  const src = `
fn run_case(c: Case) { assert_eq!(c.got(), c.want); }

#[test]
fn rejects() { parse("bad").unwrap_err(); }

#[test]
fn builder() { let assert = Harness::new().with_expected_err(E::Short).build(); assert.next_frames(); }

#[test]
fn table() { cases().into_iter().for_each(run_case); }

#[test]
fn smoke() { let _ = parse("ok"); }
`;
  const smells = only((await run({ "src/lib.rs": src })).findings, "test-smell");
  assert.deepEqual(smells.map((f) => f.title), ["1 test in src/lib.rs asserts nothing"]);
  assert.match(smells[0].detail, /Tests smoke in/);
});

test("a node named __proto__ gets its own values and never touches Object.prototype", async () => {
  const { values } = await run({ "__proto__/a.ts": "// ----------\nexport const x = 1;\n" });
  assert.equal(Object.hasOwn(values, "__proto__"), true);
  assert.equal(values["__proto__"].comment_noise, 1);
  for (const key of ["dup_lines", "comment_noise", "test_smells"]) assert.equal(Object.hasOwn(Object.prototype, key), false);
});

test("attributes before #[test] count, and asserts on distinct literals are not trivial", async () => {
  const src = `
#[should_panic]
#[test]
fn rejects_bad_input() { decode_invalid(); }

#[test]
fn aliases_differ() { let aliases = load(); assert_eq!(aliases["first"], aliases["second"]); assert_ne!(s['a'], s['b']); }
`;
  assert.deepEqual(only((await run({ "src/lib.rs": src })).findings, "test-smell"), []);
});

test("duplicate detection stays linear on highly repetitive input", async () => {
  const period = Array.from({ length: 10 }, (_, i) => `    let repeated_value_${i} = compute_expensive_thing(${i}, "constant");`);
  const file = Array.from({ length: 2000 }, () => period.join("\n")).join("\n");
  const started = performance.now();
  const { values } = await run({ "a.rs": file, "b.rs": file, "c.rs": file, "d.rs": file });
  const elapsed = performance.now() - started;
  assert.equal(values[""].dup_lines, 80000);
  assert.ok(elapsed < 3000, `80k repetitive lines took ${elapsed.toFixed(0)} ms`);
});
