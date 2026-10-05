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

test("command findings without effects take an even share of their path's lower_better values", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techtree-command-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = {
    metrics: [
      { key: "dups", label: "duplicates", direction: "lower_better" },
      { key: "cases", label: "cases", direction: "higher_better" },
    ],
    values: { "src/a.rs": { dups: 6, cases: 3 } },
    findings: [
      { file: "src/a.rs", title: "one", severity: "low" },
      { file: "src/a.rs", title: "two", severity: "low" },
      { file: "src/a.rs", title: "own", severity: "low", metricEffects: { cases: 2, bogus: 1 } },
      { file: "src/b.rs", title: "unvalued", severity: "low" },
    ],
  };
  const script = join(dir, "score.mjs");
  writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify(output))})`);
  const src = { id: "src", name: "src", kind: "dir" as const, parent: "", children: [] as string[], files: ["src/a.rs", "src/b.rs"] };
  const ctx = {
    repoRoot: dir,
    tree: { repoRoot: dir, nodes: { "": { id: "", name: "r", kind: "dir", parent: null, children: ["src"], files: [] }, src } },
    config: mergeConfig({}),
    cache: { get: () => undefined, set: () => {} },
    log: () => {},
  } satisfies CollectCtx;
  const findings = await commandPlugin("p", [process.execPath, script]).findings!(ctx);
  assert.deepEqual(
    findings.map((f) => [f.title, f.metricEffects]),
    [["one", { dups: -2 }], ["two", { dups: -2 }], ["own", { cases: 2 }], ["unvalued", {}]],
  );
});
