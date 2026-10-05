import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listModels, parseModelList } from "../../src/backend/models.ts";

test("pi's model table becomes provider/model entries", () => {
  const table = "provider   model        context  max-out  thinking  images\nanthropic  claude-x     1M       128K     yes       yes\nlocal      llama3:8b    8K       4K       no        no\n";
  assert.deepEqual(parseModelList(table), ["anthropic/claude-x", "local/llama3:8b"]);
});

test("pi's no-models help, even with spaced install paths, is an empty listing", () => {
  const docs = "/Users/me/Application Support/pi/docs";
  const help = `No models available. Use /login to log into a provider via OAuth or API key. See:\n  ${docs}/providers.md\n  ${docs}/models.md\n`;
  assert.deepEqual(parseModelList(help), []);
  assert.deepEqual(parseModelList(""), []);
});

test("a listing that outlives its timeout and ignores SIGTERM is killed and settles empty", { timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techtree-models-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stubborn = join(dir, "stubborn.mjs");
  writeFileSync(stubborn, 'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n');
  const started = Date.now();
  assert.deepEqual(await listModels([process.execPath, stubborn], 200), []);
  assert.ok(Date.now() - started < 3_000, `settled after ${Date.now() - started} ms`);
});

test("a failing or missing pi is an empty listing", { timeout: 10_000 }, async () => {
  assert.deepEqual(await listModels([process.execPath, "-e", "process.exit(2)"]), []);
  assert.deepEqual(await listModels([join(tmpdir(), "no-such-pi-binary")]), []);
});
