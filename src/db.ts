import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { createRequire } from "node:module";
import type { Cache } from "./types.ts";

export type Db = DatabaseSyncType;

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS node_scores (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  node TEXT NOT NULL,
  quality REAL,
  metrics TEXT NOT NULL, -- JSON Record<string, MetricScore>
  PRIMARY KEY (snapshot_id, node)
);
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  node TEXT NOT NULL,
  source TEXT NOT NULL,
  data TEXT NOT NULL, -- JSON Finding
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS findings_node ON findings(node);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  node TEXT NOT NULL,
  state TEXT NOT NULL,
  data TEXT NOT NULL, -- JSON Task
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prs (
  number INTEGER PRIMARY KEY,
  data TEXT NOT NULL, -- JSON PrState
  fix_attempts INTEGER NOT NULL DEFAULT 0,
  last_progress_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cache (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);
`;

/** Open (and migrate) `<cacheDir>/techtree.db`. Pass ":memory:" for tests. */
export function openDb(dirOrMemory: string): Db {
  // Loaded lazily so importing this module does not trigger node:sqlite's experimental warning early.
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dirOrMemory === ":memory:" ? ":memory:" : join(dirOrMemory, "techtree.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  return db;
}

export function dbCache(db: Db): Cache {
  const get = db.prepare("SELECT value FROM cache WHERE kind = ? AND key = ?");
  const set = db.prepare(
    "INSERT INTO cache (kind, key, value, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (kind, key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at",
  );
  return {
    get<T>(kind: string, key: string): T | undefined {
      const row = get.get(kind, key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : undefined;
    },
    set(kind: string, key: string, value: unknown) {
      set.run(kind, key, JSON.stringify(value), new Date().toISOString());
    },
  };
}

/** Silence node:sqlite's ExperimentalWarning; call once at process start. */
export function suppressSqliteWarning(): void {
  const emit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === "string" ? warning : warning.message;
    if (msg.includes("SQLite")) return;
    return (emit as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
