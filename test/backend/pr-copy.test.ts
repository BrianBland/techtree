import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../../src/config.ts";
import { combinedPrText } from "../../src/backend/refine.ts";

const evidence = {
  changes: [
    { id: "c1", title: "Fold stateful attribute tests into cases", node: "crates/consensus", findings: ["Four near-identical tests"], summary: "Use rstest cases", commits: "refactor: parameterize stateful attribute tests" },
    { id: "c2", title: "Cover invalid attribute combinations", node: "crates/consensus", findings: [], summary: "Add invalid combination cases", commits: "test: cover invalid attribute combinations" },
  ],
  stat: "stateful.rs | 40 +++++-----", diff: "- four duplicated tests\n+ #[rstest]\n+ #[case]",
};
const reply = { title: "refactor: consolidate stateful attribute validation tests", summary: "Parameterize repeated stateful attribute tests and cover invalid combinations.", changes: [{ id: "c2", text: "Add cases for invalid attribute combinations." }, { id: "c1", text: "Replace four near-identical tests with rstest cases." }] };

function fake(t: TestContext, output: string, exit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "pr-copy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "pi.mjs");
  const log = join(dir, "input.json");
  writeFileSync(script, `import {writeFileSync} from 'node:fs'; let input=''; for await (const c of process.stdin) input+=c; writeFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),input})); console.log(${JSON.stringify(output)}); process.exit(${exit});`);
  return { dir, log, config: mergeConfig({ piCommand: [process.execPath, script], titleModel: "p/cheap", defaultModel: "p/default" }) };
}

test("combined PR text uses actual change evidence, one cheap no-tools call and host-ordered bullets", async (t) => {
  const { dir, log, config } = fake(t, "```json\n" + JSON.stringify(reply) + "\n```");
  const text = await combinedPrText(evidence, config, dir);
  assert.deepEqual(text, { title: reply.title, summary: reply.summary, changes: [reply.changes[1].text, reply.changes[0].text] });
  const sent = JSON.parse(readFileSync(log, "utf8"));
  assert.ok(sent.args.includes("--no-tools"));
  assert.equal(sent.args[sent.args.indexOf("--model") + 1], "p/cheap");
  assert.match(sent.input, /untrusted data/i);
  assert.match(sent.input, /Do not.*generator/);
  assert.match(sent.input, /Do not invent test results/);
  assert.match(sent.input, /#\[rstest\]/);
  assert.match(sent.input, /invalid attribute combinations/);
  assert.ok(!sent.args.some((arg: string) => arg.includes("rstest")), "evidence is piped via stdin");
});

test("the default model remains the fallback and genuine techtree component names are allowed", async (t) => {
  const valid = { ...reply, title: "fix: refresh techtree grouping after publication" };
  const { dir, log, config } = fake(t, JSON.stringify(valid));
  config.titleModel = undefined;
  assert.equal((await combinedPrText(evidence, config, dir))!.title, valid.title);
  const sent = JSON.parse(readFileSync(log, "utf8"));
  assert.equal(sent.args[sent.args.indexOf("--model") + 1], "p/default");
});

test("malformed, incomplete, oversized and boilerplate metadata fails closed to the caller's clean fallback", async (t) => {
  for (const output of [
    "just a title", JSON.stringify({ ...reply, title: "x".repeat(73) }),
    JSON.stringify({ ...reply, title: "title\nsecond line" }), JSON.stringify({ ...reply, summary: "" }),
    JSON.stringify({ ...reply, changes: [reply.changes[0]] }),
    JSON.stringify({ ...reply, changes: [reply.changes[0], reply.changes[0]] }),
    JSON.stringify({ ...reply, changes: [{ id: "other", text: "Unknown change" }, reply.changes[0]] }),
    JSON.stringify({ ...reply, extra: "ignored" }),
    JSON.stringify({ ...reply, summary: "Combined techtree changes" }), "x".repeat(20_000),
  ]) {
    const { dir, config } = fake(t, output);
    assert.equal(await combinedPrText(evidence, config, dir), undefined, output.slice(0, 90));
  }
  const failed = fake(t, JSON.stringify(reply), 1);
  assert.equal(await combinedPrText(evidence, failed.config, failed.dir), undefined);
});

test("metadata stays bounded and cancellation is not hidden as successful model output", async (t) => {
  const { dir, log, config } = fake(t, JSON.stringify(reply));
  assert.equal(await combinedPrText({ ...evidence, diff: "x".repeat(40_000) }, config, dir), undefined);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(log), false, "oversized input costs no model call");
  const stop = new AbortController(); stop.abort(new Error("server stopped"));
  assert.equal(await combinedPrText(evidence, config, dir, stop.signal), undefined);
  assert.equal(existsSync(log), false);
});
