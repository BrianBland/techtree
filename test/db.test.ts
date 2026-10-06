import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mergeConfig } from "../src/config.ts";
import { deleteProjectRows, getProject, listProjects, saveProject, scorerParts } from "../src/core/projects.ts";
import { nodeHistory } from "../src/core/store.ts";
import { dbCache, openDb, suppressSqliteWarning } from "../src/db.ts";
import { TaskRunner } from "../src/runner/runner.ts";

suppressSqliteWarning();

test("cache round-trips JSON values and overwrites", () => {
  const cache = dbCache(openDb(":memory:"));
  assert.equal(cache.get("clippy", "k"), undefined);
  cache.set("clippy", "k", { n: 1 });
  cache.set("clippy", "k", { n: 2 });
  assert.deepEqual(cache.get("clippy", "k"), { n: 2 });
});

test("opening a pre-projects database makes its snapshots, findings and tasks Quality's", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techtree-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = new DatabaseSync(join(dir, "techtree.db"));
  old.exec(`
    CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, sha TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE node_scores (snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, node TEXT NOT NULL,
      quality REAL, metrics TEXT NOT NULL, PRIMARY KEY (snapshot_id, node));
    CREATE TABLE findings (id TEXT PRIMARY KEY, node TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, resolved_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, node TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO snapshots (sha, created_at) VALUES ('abc', '2025-01-01');
    INSERT INTO node_scores VALUES (1, 'src', 42, '{}');
    INSERT INTO findings VALUES ('f1', 'src', 'todo', '{}', '2025-01-01', '2025-01-01', NULL);
  `);
  const oldTask = { id: "t1", node: "src", title: "t", prompt: "", findingIds: [], state: "review", manualReview: true,
    plannedFrom: 0, plannedTo: 0, checklist: [], phase: "edit", createdAt: "2025-01-01", updatedAt: "2025-01-01" };
  old.prepare("INSERT INTO tasks VALUES ('t1', 'src', 'review', ?, '2025-01-01')").run(JSON.stringify(oldTask));
  old.close();

  const db = openDb(dir);
  assert.deepEqual(listProjects(db).map((p) => p.id), ["quality"]);
  assert.deepEqual(nodeHistory(db, "src").map((h) => h.quality), [42]);
  assert.deepEqual(db.prepare("SELECT project FROM findings UNION SELECT project FROM tasks").all().map((r) => r.project), ["quality"]);
  const runner = new TaskRunner({ db, config: mergeConfig({}), repoRoot: dir, cacheDir: dir, url: "", token: "" });
  assert.equal(runner.get("t1")?.project, "quality");
});

test("Quality migration preserves settings and history, and deletion survives reopening", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techtree-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(dir);
  const legacy = { ...getProject(db, "quality")!, name: "My quality", goal: "less debt", scorer: { plugins: ["generic"], rubric: "errors" }, builtin: true };
  saveProject(db, legacy);
  db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
  db.prepare("INSERT INTO snapshots (sha, created_at, project) VALUES ('abc', '2025-01-01', 'quality')").run();
  db.close();
  const migrated = openDb(dir);
  const { builtin, ...expected } = legacy;
  assert.deepEqual(getProject(migrated, "quality"), expected);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM snapshots").get()!.n, 1);
  migrated.close();
  const reopened = openDb(dir);
  assert.deepEqual(getProject(reopened, "quality"), expected);
  deleteProjectRows(reopened, "quality");
  reopened.close();
  const deleted = openDb(dir);
  assert.equal(getProject(deleted, "quality"), undefined);
  deleted.close();
});

test("scorer parts validate plugin selection and permit complete replacement", () => {
  assert.deepEqual(scorerParts({ plugins: ["generic", "llm-scan"], rubric: " errors " }), { plugins: ["generic", "llm-scan"], rubric: "errors" });
  assert.deepEqual(scorerParts({ plugins: [], rubric: "", command: [], plan: false }), {});
  assert.equal(typeof scorerParts({ plugins: "generic" }), "string");
  assert.equal(typeof scorerParts({ plugins: ["unknown"] }), "string");
  assert.equal(typeof scorerParts({ plugins: [42] }), "string");
  assert.equal(typeof scorerParts({ plugins: ["slop"] }), "string", "slop needs Rust test counts for normalization");
  assert.deepEqual(scorerParts({ plugins: ["rust", "slop"] }), { plugins: ["rust", "slop"] });
});
