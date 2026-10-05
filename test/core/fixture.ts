import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mergeConfig } from "../../src/config.ts";
import type { Config, Finding, MetricDef } from "../../src/types.ts";

export const LOC: MetricDef = { key: "loc", label: "Lines", direction: "neutral", aggregate: "sum" };
export const LINT: MetricDef = {
  key: "lint_warnings",
  label: "Lint warnings",
  direction: "lower_better",
  aggregate: "sum",
  normalizeBy: "loc",
};
export const TEST_RATIO: MetricDef = { key: "test_ratio", label: "Test ratio", direction: "higher_better", aggregate: "mean_by_loc" };
export const MAX_FILE: MetricDef = { key: "max_file_loc", label: "Largest file", direction: "lower_better", aggregate: "max" };

export function config(over: Partial<Config> = {}): Config {
  return { ...mergeConfig({}), weights: { lint_warnings: 1, test_ratio: 1, max_file_loc: 1 }, minLoc: 100, ...over };
}

export function finding(id: string, node: string, metricEffects: Record<string, number>, over: Partial<Finding> = {}): Finding {
  return { id, node, source: "lint", title: id, detail: "", severity: "low", effort: "trivial", metricEffects, ...over };
}

/** A committed git repo in a temp dir with the given files. */
export function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "techtree-core-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return root;
}
