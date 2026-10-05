import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { score } from "../../src/core/pipeline.ts";
import { formatReport } from "../../src/core/report.ts";
import type { Cache, MetricPlugin } from "../../src/types.ts";
import { config, finding, fixtureRepo, LINT, LOC } from "./fixture.ts";

const cache: Cache = { get: () => undefined, set: () => {} };

const lines: MetricPlugin = {
  id: "lines",
  metrics: [LOC, LINT],
  async collect(ctx) {
    const out: Record<string, Record<string, number>> = {};
    for (const node of Object.values(ctx.tree.nodes)) {
      const text = node.files.map((f) => readFileSync(join(ctx.repoRoot, f), "utf8")).join("");
      out[node.id] = { loc: text.split("\n").length - 1, lint_warnings: (text.match(/LINT/g) ?? []).length };
    }
    return out;
  },
  async findings() {
    return [
      finding("f1", "a", { lint_warnings: -1 }, { title: "fix a lint" }),
      finding("f1", "b", { lint_warnings: -1 }, { title: "duplicate id" }),
      finding("f2", "nowhere", { lint_warnings: -1 }),
    ];
  },
};

const crates: MetricPlugin = {
  id: "crates",
  metrics: [],
  annotate(tree) {
    tree.nodes.b.kind = "crate";
    tree.nodes.b.name = "bee";
  },
  async collect() {
    return {};
  },
};

const broken: MetricPlugin = {
  id: "broken",
  metrics: [{ key: "bogus", label: "Bogus", direction: "higher_better", aggregate: "sum" }],
  annotate() {
    throw new Error("no annotate");
  },
  async collect() {
    throw new Error("no collect");
  },
  async findings() {
    throw new Error("no findings");
  },
};

test("score runs plugins, skips failures, and estimates every finding's impact", async () => {
  const root = fixtureRepo({
    "a/x.rs": "LINT\nLINT\nok\n".repeat(50),
    "b/y.rs": "ok\n".repeat(150),
    "c/z.rs": "LINT\nok\nok\nok\n".repeat(50),
  });
  const log: string[] = [];
  const result = await score({
    repoRoot: root,
    config: config({ minLoc: 100, weights: { lint_warnings: 1 } }),
    plugins: [broken, lines, crates],
    cache,
    log: (m) => log.push(m),
  });

  assert.match(result.sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(result.metricDefs.map((d) => d.key), ["loc", "lint_warnings"]);
  assert.equal(result.tree.nodes.b.kind, "crate");
  assert.equal(result.scores[""].metrics.loc.raw, 500);
  assert.deepEqual(result.findings.map((f) => f.title), ["fix a lint"]);
  assert.ok(result.impacts.f1.node > 0);
  assert.equal(log.filter((l) => l.startsWith("broken:")).length, 3);
  assert.ok(log.some((l) => l.includes("nowhere")));

  const report = formatReport(result);
  assert.match(report, /Lint warnings \[lint_warnings, lower better\]/);
  assert.match(report, /b \(crate bee\)/);
  assert.match(report, /top findings \(1 of 1\)/);
  assert.match(report, /fix a lint/);
  assert.doesNotMatch(report, /\[loc,/, "neutral metrics are not ranked");
});
