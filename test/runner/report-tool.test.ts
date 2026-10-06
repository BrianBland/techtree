import { test } from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { techtreeReportTool } from "../../src/runner/report-tool.ts";

test("scorer reports accept plugin selection and reject unknown plugins", () => {
  const schema = techtreeReportTool.parameters;
  assert.ok(Check(schema, { scorer: { plugins: ["generic", "llm-scan"], rubric: "Find bugs" } }));
  assert.ok(Check(schema, { scorer: { plugins: [] } }));
  assert.ok(!Check(schema, { scorer: { plugins: ["unknown"] } }));
});
