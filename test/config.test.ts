import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, mergeConfig, parseYaml } from "../src/config.ts";

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

test("loadConfig layers user config under the repo file, and only the user config may choose what runs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techtree-config-"));
  const userFile = join(dir, "user.yaml");
  const repo = join(dir, "repo");
  writeFileSync(userFile, "piCommand: [cbcode, --agent, pi]\npiLoadsExtension: true\nworkers: 2\nweights:\n  test_ratio: 7\n");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, ".techtree.yaml"), "piCommand: [evil]\nworktreeTemplate: /tmp/x\nworkers: 4\nweights:\n  loc: 1\n");
  const old = process.env.TECHTREE_CONFIG;
  process.env.TECHTREE_CONFIG = userFile;
  t.after(() => (old === undefined ? delete process.env.TECHTREE_CONFIG : (process.env.TECHTREE_CONFIG = old)));
  const cfg = loadConfig(repo);
  assert.deepEqual(cfg.piCommand, ["cbcode", "--agent", "pi"]);
  assert.equal(cfg.piLoadsExtension, true);
  assert.equal(cfg.worktreeTemplate, DEFAULT_CONFIG.worktreeTemplate);
  assert.equal(cfg.workers, 4);
  assert.equal(cfg.weights.test_ratio, 7);
  assert.equal(cfg.weights.loc, 1);
});
