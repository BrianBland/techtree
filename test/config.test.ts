import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, mergeConfig, parseYaml } from "../src/config.ts";

test("parseYaml handles nested maps, lists, flow lists, scalars and comments", () => {
  const doc = parseYaml(`
# comment
workers: 5
minLoc: 50   # trailing
weights:
  test_ratio: 4
  loc: 0.5
ignore:
  - target
  - "vendor"
plugins:
  rust:
    clippy: false
    features: [a, b]
`);
  assert.deepEqual(doc, {
    workers: 5,
    minLoc: 50,
    weights: { test_ratio: 4, loc: 0.5 },
    ignore: ["target", "vendor"],
    plugins: { rust: { clippy: false, features: ["a", "b"] } },
  });
});

test("mergeConfig overlays user weights on defaults", () => {
  const cfg = mergeConfig({ weights: { test_ratio: 9 }, workers: 1 });
  assert.equal(cfg.weights.test_ratio, 9);
  assert.equal(cfg.weights.lint_warnings, DEFAULT_CONFIG.weights.lint_warnings);
  assert.equal(cfg.workers, 1);
  assert.equal(cfg.minLoc, DEFAULT_CONFIG.minLoc);
});
