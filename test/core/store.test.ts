import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, suppressSqliteWarning } from "../../src/db.ts";
import { nodeHistory, recordFindings, saveSnapshot } from "../../src/core/store.ts";
import { treeFromFiles } from "../../src/core/tree.ts";
import type { ScoreResult } from "../../src/types.ts";
import { finding } from "./fixture.ts";

suppressSqliteWarning();

function result(sha: string, quality: number): ScoreResult {
  return {
    sha,
    createdAt: `2025-01-0${quality}T00:00:00Z`,
    tree: treeFromFiles("/r", ["a/f"]),
    metricDefs: [],
    own: {},
    scores: {
      "": { node: "", quality: null, metrics: {} },
      a: { node: "a", quality, metrics: { lint_warnings: { raw: 2, value: 1, pct: quality * 10 }, loc: { raw: 9, value: 9, pct: null } } },
    },
    findings: [],
    impacts: {},
  };
}

test("snapshots round-trip as node history, oldest first", () => {
  const db = openDb(":memory:");
  saveSnapshot(db, result("s1", 1));
  saveSnapshot(db, result("s2", 2));
  assert.deepEqual(nodeHistory(db, "a"), [
    { sha: "s1", createdAt: "2025-01-01T00:00:00Z", quality: 1, metrics: { lint_warnings: 10, loc: null } },
    { sha: "s2", createdAt: "2025-01-02T00:00:00Z", quality: 2, metrics: { lint_warnings: 20, loc: null } },
  ]);
  assert.deepEqual(nodeHistory(db, "missing"), []);
});

test("findings keep first_seen, resolve when absent from a full run, and reopen when seen again", () => {
  const db = openDb(":memory:");
  const rows = () =>
    db.prepare("SELECT id, first_seen, last_seen, resolved_at FROM findings ORDER BY id").all().map((r) => ({ ...r }));
  const a = finding("a", "x", {});
  const b = finding("b", "x", {});
  recordFindings(db, [a, b], "t1", true);
  recordFindings(db, [a], "t2", false);
  assert.deepEqual(rows(), [
    { id: "a", first_seen: "t1", last_seen: "t2", resolved_at: null },
    { id: "b", first_seen: "t1", last_seen: "t1", resolved_at: null },
  ], "a partial run resolves nothing");
  recordFindings(db, [a], "t3", true);
  assert.equal((rows()[1] as { resolved_at: string }).resolved_at, "t3");
  recordFindings(db, [a, { ...b, title: "changed" }], "t4", true);
  assert.deepEqual(rows()[1], { id: "b", first_seen: "t1", last_seen: "t4", resolved_at: null });
  recordFindings(db, [a], "t4", true);
  assert.equal((rows()[1] as { resolved_at: string }).resolved_at, "t4", "resolution does not depend on a fresh timestamp");
  const data = db.prepare("SELECT data FROM findings WHERE id = 'b'").get() as { data: string };
  assert.equal(JSON.parse(data.data).title, "changed");
});
