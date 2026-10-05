import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../../src/config.ts";
import { commandPlugin } from "../../src/plugins/command.ts";
import type { CollectCtx } from "../../src/types.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a timed-out command stops its subprocesses too and fails within the kill grace", { timeout: 15_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techtree-command-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "bench.pid");
  const wrapper = join(dir, "wrapper.mjs");
  writeFileSync(
    wrapper,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const bench = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: "inherit" });
writeFileSync(${JSON.stringify(pidFile)}, String(bench.pid));
bench.on("exit", () => process.exit(0));
`,
  );
  const ctx = {
    repoRoot: dir,
    tree: { repoRoot: dir, nodes: { "": { id: "", name: "r", kind: "dir", parent: null, children: [], files: [] } } },
    config: mergeConfig({ plugins: { command: { timeoutMs: 500 } } }),
    cache: { get: () => undefined, set: () => {} },
    log: () => {},
  } satisfies CollectCtx;

  const started = Date.now();
  await assert.rejects(commandPlugin("perf", [process.execPath, wrapper]).collect(ctx), /timed out after 500ms/);
  assert.ok(Date.now() - started < 2500, `settled after ${Date.now() - started}ms`);
  assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "the benchmark the wrapper started is gone");
});
