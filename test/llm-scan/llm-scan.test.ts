import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../../src/config.ts";
import { dbCache, openDb, suppressSqliteWarning } from "../../src/db.ts";
import type { CollectCtx, Tree } from "../../src/types.ts";
import { llmScanPlugin, scanCoverage, scanNode } from "../../src/plugins/llm-scan.ts";

suppressSqliteWarning();

const A = "src/a.ts";
const B = "src/b.ts";

const GOOD = [
  {
    title: "Unchecked index",
    detail: "Index may be out of bounds.",
    file: A,
    line: 2,
    severity: "high",
    effort: "small",
    tags: ["correctness"],
    suggestedFix: "Check the length first.",
    metricEffects: { unwrap_density: -1, review_debt: 100 },
  },
  { title: "Missing docs", detail: "Public fn lacks docs.", file: B, severity: "low", effort: "trivial", tags: ["docs"] },
];

interface Fixture {
  root: string;
  ctx: CollectCtx;
  spawns(): string[][];
}

/**
 * Temp repo with `src/a.ts` (3 lines), `src/b.ts` (2 lines), `lib/c.ts` (4 lines) and a fake pi
 * that logs its argv and prints `stdout` (exit `code`, after `delayMs`).
 */
function fixture(fake: { stdout: string; code?: number; delayMs?: number }, plugin: Record<string, unknown> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "techtree-llm-scan-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, A), "const xs = [];\nxs[5];\nexport {};\n");
  writeFileSync(join(root, B), "export function f() {}\n// end\n");
  writeFileSync(join(root, "lib/c.ts"), "1\n2\n3\n4\n");
  const log = join(root, "..", `${root.split("/").pop()}-spawns.jsonl`);
  const script = join(root, "..", `${root.split("/").pop()}-fake-pi.mjs`);
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
setTimeout(() => { process.stdout.write(${JSON.stringify(fake.stdout)}); process.exit(${fake.code ?? 0}); }, ${fake.delayMs ?? 0});
`,
  );
  const tree: Tree = {
    repoRoot: root,
    nodes: {
      "": { id: "", name: "root", kind: "dir", parent: null, children: ["src", "lib"], files: [] },
      src: { id: "src", name: "src", kind: "dir", parent: "", children: [], files: [A, B] },
      lib: { id: "lib", name: "lib", kind: "dir", parent: "", children: [], files: ["lib/c.ts"] },
    },
  };
  const config = mergeConfig({ piCommand: [process.execPath, script], plugins: { "llm-scan": plugin } });
  const ctx: CollectCtx = { repoRoot: root, tree, config, cache: dbCache(openDb(":memory:")), log() {} };
  const spawns = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as string[])
      : [];
  return { root, ctx, spawns };
}

test("scan spawns pi with the skill in print mode and stores parsed findings", async () => {
  const fx = fixture({ stdout: JSON.stringify(GOOD) });
  const result = await scanNode("src", fx.ctx);
  assert.deepEqual(result, { done: 1, total: 1, cached: 0, failed: 0, findings: 2 });

  const [argv] = fx.spawns();
  assert.ok(argv.includes("-p") && argv.includes("--no-session"));
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.ok(existsSync(join(argv[argv.indexOf("--skill") + 1], "SKILL.md")));
  const prompt = argv[argv.length - 1];
  assert.ok(prompt.startsWith("/skill:techtree-scan"));
  assert.ok(prompt.includes(`=== ${A} ===`) && prompt.includes("2: xs[5];"));
  assert.ok(!prompt.includes("lib/c.ts"));

  const findings = await llmScanPlugin.findings!(fx.ctx);
  const high = findings.find((f) => f.file === A)!;
  assert.equal(high.source, "llm-scan");
  assert.equal(high.node, "src");
  assert.equal(high.line, 2);
  assert.equal(high.severity, "high");
  assert.deepEqual(high.tags, ["correctness"]);
  assert.match(high.detail, /Check the length first/);
  assert.deepEqual(high.metricEffects, { unwrap_density: -1, review_debt: -9 });
  assert.deepEqual(findings.find((f) => f.file === B)!.metricEffects, { review_debt: -1 });
  assert.equal(new Set(findings.map((f) => f.id)).size, 2);
});

test("collect reports severity-weighted review_debt and scanned_loc only for scanned nodes", async () => {
  const fx = fixture({ stdout: JSON.stringify(GOOD) });
  assert.deepEqual(await llmScanPlugin.collect(fx.ctx), {});
  await scanNode("src", fx.ctx);
  assert.deepEqual(await llmScanPlugin.collect(fx.ctx), { src: { review_debt: 10, scanned_loc: 5 } });
  assert.equal(fx.spawns().length, 1, "scoring never spawns pi");
});

test("rescanning unchanged content is served from the cache; edited files go stale", async () => {
  const fx = fixture({ stdout: "[]" });
  await scanNode("src", fx.ctx);
  const again = await scanNode("src", fx.ctx);
  assert.equal(fx.spawns().length, 1);
  assert.deepEqual(again, { done: 1, total: 1, cached: 1, failed: 0, findings: 0 });

  writeFileSync(join(fx.root, A), "changed\n");
  assert.deepEqual(await llmScanPlugin.collect(fx.ctx), { src: { review_debt: 0, scanned_loc: 2 } });
  await scanNode("src", fx.ctx);
  assert.equal(fx.spawns().length, 2);
});

test("malformed output or a failing pi fails the batch without throwing or caching", async () => {
  for (const fake of [{ stdout: "I could not find any issues!" }, { stdout: JSON.stringify(GOOD), code: 1 }]) {
    const fx = fixture(fake);
    const result = await scanNode("src", fx.ctx);
    assert.equal(result.failed, 1);
    assert.deepEqual(await llmScanPlugin.findings!(fx.ctx), []);
    assert.deepEqual(await llmScanPlugin.collect(fx.ctx), {});
    await scanNode("src", fx.ctx);
    assert.equal(fx.spawns().length, 2, "failures are retried");
  }
});

test("partial output keeps valid items and drops malformed ones", async () => {
  const items = [
    GOOD[0],
    { ...GOOD[1], severity: "critical" },
    { ...GOOD[1], file: "src/elsewhere.ts" },
    { ...GOOD[1], title: "" },
    { ...GOOD[1], effort: undefined },
    { ...GOOD[1], line: -3 },
    "not an object",
    { ...GOOD[1], title: "Kept", tags: ["docs", 7], metricEffects: { loc: "x", todo_density: -1 } },
  ];
  const fx = fixture({ stdout: "Here you go:\n```json\n" + JSON.stringify(items) + "\n```\n" });
  const result = await scanNode("src", fx.ctx);
  assert.equal(result.findings, 2);
  const kept = (await llmScanPlugin.findings!(fx.ctx)).find((f) => f.title === "Kept")!;
  assert.deepEqual(kept.tags, ["docs"]);
  assert.deepEqual(kept.metricEffects, { todo_density: -1, review_debt: -1 });
});

test("files are capped, batched, reported via progress, and counted in coverage", async () => {
  const fx = fixture({ stdout: "[]" }, { batchFiles: 1, maxFiles: 2 });
  const progress: number[] = [];
  const result = await scanNode("", fx.ctx, { onProgress: (p) => progress.push(p.done) });
  assert.equal(result.total, 2);
  assert.deepEqual(progress, [1, 2]);
  assert.equal(fx.spawns().length, 2);
  assert.deepEqual(scanCoverage(fx.ctx), { scannedNodes: 2, totalNodes: 3, scannedLoc: 7, totalLoc: 9 });
});

test("at most `concurrency` pi children run at once", async () => {
  const fx = fixture({ stdout: "[]", delayMs: 200 }, { batchFiles: 1, concurrency: 2 });
  const started = Date.now();
  await scanNode("", fx.ctx);
  const elapsed = Date.now() - started;
  assert.equal(fx.spawns().length, 3);
  assert.ok(elapsed >= 400, `3 batches at concurrency 2 need two rounds (took ${elapsed}ms)`);
});

test("aborting kills running children and rejects", async () => {
  const fx = fixture({ stdout: "[]", delayMs: 10_000 }, { batchFiles: 1, concurrency: 1 });
  const abort = new AbortController();
  const scan = scanNode("", fx.ctx, { signal: abort.signal });
  setTimeout(() => abort.abort(), 300);
  const started = Date.now();
  await assert.rejects(scan);
  assert.ok(Date.now() - started < 5000);
  assert.ok(fx.spawns().length <= 1, "pending batches are skipped");
});
