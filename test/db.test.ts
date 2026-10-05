import { test } from "node:test";
import assert from "node:assert/strict";
import { dbCache, openDb, suppressSqliteWarning } from "../src/db.ts";

suppressSqliteWarning();

test("cache round-trips JSON values and overwrites", () => {
  const cache = dbCache(openDb(":memory:"));
  assert.equal(cache.get("clippy", "k"), undefined);
  cache.set("clippy", "k", { n: 1 });
  cache.set("clippy", "k", { n: 2 });
  assert.deepEqual(cache.get("clippy", "k"), { n: 2 });
});
