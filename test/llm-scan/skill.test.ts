import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPlugins } from "../../src/plugins/index.ts";

const skill = readFileSync(join(import.meta.dirname, "../../skills/techtree-scan/SKILL.md"), "utf8");
const line = (prefix: string) => skill.split("\n").find((l) => l.startsWith(prefix)) ?? "";
const codeSpans = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

test("the scan rubric's metricEffects keys are real metrics, covering the slop metrics", () => {
  const metrics = new Set(defaultPlugins.flatMap((p) => p.metrics.map((m) => m.key)));
  const named = codeSpans(line("- `metricEffects`")).filter((s) => /^[a-z_]+$/.test(s) && s !== "metricEffects");
  for (const key of named) assert.ok(metrics.has(key), `${key} is not a metric`);
  for (const key of ["unwrap_density", "dup_lines", "comment_noise", "test_smells"]) assert.ok(named.includes(key), key);
});

test("every focus-area tag is an allowed tag", () => {
  const tags = new Set(codeSpans(line("- `tags`")).filter((t) => t !== "tags"));
  const focus = skill.slice(skill.indexOf("## Focus areas"), skill.indexOf("## Output"));
  const focusTags = [...focus.matchAll(/\*\*[^*]+\*\* \(`([^`]+)`\)/g)].map((m) => m[1]);
  assert.deepEqual(focusTags, ["slop", "duplication", "comment-noise", "testing"]);
  for (const tag of focusTags) assert.ok(tags.has(tag), tag);
});
