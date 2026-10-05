import type { Db } from "../db.ts";
import type { Finding, HistoryPoint, MetricScore, NodeId, ScoreResult } from "../types.ts";

/** Insert a snapshot of every node's score; returns the snapshot id. */
export function saveSnapshot(db: Db, result: ScoreResult): number {
  return transaction(db, () => {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO snapshots (sha, created_at) VALUES (?, ?)")
      .run(result.sha, result.createdAt);
    const insert = db.prepare("INSERT INTO node_scores (snapshot_id, node, quality, metrics) VALUES (?, ?, ?, ?)");
    for (const s of Object.values(result.scores)) insert.run(lastInsertRowid, s.node, s.quality, JSON.stringify(s.metrics));
    return Number(lastInsertRowid);
  });
}

/**
 * Upsert findings seen at `now`. With `full`, every unresolved finding not in this run is
 * marked resolved.
 */
export function recordFindings(db: Db, findings: Finding[], now: string, full: boolean): void {
  transaction(db, () => {
    const upsert = db.prepare(
      "INSERT INTO findings (id, node, source, data, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET node = excluded.node, source = excluded.source, data = excluded.data, " +
        "last_seen = excluded.last_seen, resolved_at = NULL",
    );
    for (const f of findings) upsert.run(f.id, f.node, f.source, JSON.stringify(f), now, now);
    if (full) {
      db.prepare("UPDATE findings SET resolved_at = ? WHERE resolved_at IS NULL AND last_seen <> ?").run(now, now);
    }
  });
}

/** Score history of a node, oldest first. */
export function nodeHistory(db: Db, node: NodeId): HistoryPoint[] {
  const rows = db
    .prepare(
      "SELECT s.sha, s.created_at, n.quality, n.metrics FROM node_scores n " +
        "JOIN snapshots s ON s.id = n.snapshot_id WHERE n.node = ? ORDER BY s.id",
    )
    .all(node) as { sha: string; created_at: string; quality: number | null; metrics: string }[];
  return rows.map((r) => ({
    sha: r.sha,
    createdAt: r.created_at,
    quality: r.quality,
    metrics: Object.fromEntries(
      Object.entries(JSON.parse(r.metrics) as Record<string, MetricScore>).map(([k, m]) => [k, m.pct]),
    ),
  }));
}

function transaction<T>(db: Db, run: () => T): T {
  db.exec("BEGIN");
  try {
    const out = run();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
