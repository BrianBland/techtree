import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../../src/config.ts";
import { refineText } from "../../src/backend/refine.ts";

test("refineText runs pi read-only with refineModel and returns its reply without fences", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techtree-refine-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, "pi.mjs");
  writeFileSync(fake, "const a = process.argv.slice(2); console.log('```\\n' + JSON.stringify({ tools: a[a.indexOf('--tools') + 1], model: a[a.indexOf('--model') + 1], goal: a.at(-1).includes('Project goal: be fast') }) + '\\n```');");
  const config = mergeConfig({ piCommand: [process.execPath, fake], refineModel: "p/strong", defaultModel: "p/default" });
  const reply = JSON.parse(await refineText({ kind: "rubric", text: "find slow code", name: "Perf", goal: "be fast" }, config, dir));
  assert.deepEqual(reply, { tools: "read,grep,find,ls", model: "p/strong", goal: true });
});
