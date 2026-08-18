/**
 * Data-safety checks for the trim SQL builders. No network, no DB.
 * These guard the two bugs that bit the live trim run:
 *   - a double-quoted "rowid" becomes a string literal and matches 0 rows;
 *   - a parent DELETE must scope children by a subquery (FK order).
 * Run: npx tsx --test src/backend/guardian/log-trim-sql.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildChildDelete,
  buildChildExportSelect,
  buildExportSelect,
  buildRangeCount,
  buildRangeDelete,
  computeExportCount,
  ident,
  keyLiteral,
  keyRef,
} from "./log-trim-sql";

test("ident double-quotes and escapes embedded quotes", () => {
  assert.equal(ident("logs"), '"logs"');
  assert.equal(ident('a"b'), '"a""b"');
});

test("keyRef leaves rowid pseudo-columns UNQUOTED, quotes real columns", () => {
  // The load-bearing fix: '"rowid"' is a string literal in a WHERE clause.
  assert.equal(keyRef("rowid"), "rowid");
  assert.equal(keyRef("_rowid_"), "_rowid_");
  assert.equal(keyRef("oid"), "oid");
  assert.equal(keyRef("id"), '"id"');
  assert.equal(keyRef("delivery_id"), '"delivery_id"');
});

test("computeExportCount: batch-capped, never drops below keepRows, floors at 0", () => {
  assert.equal(computeExportCount(100, 20, 10), 10); // batch cap
  assert.equal(computeExportCount(100, 95, 10), 5); // keep floor
  assert.equal(computeExportCount(100, 200, 10), 0); // already below keep
  assert.equal(computeExportCount(20000, 20000, 10000), 0); // exactly at keep
});

test("keyLiteral: integer keys bare, stray text single-quoted + escaped", () => {
  assert.equal(keyLiteral(42), "42");
  assert.equal(keyLiteral(0), "0");
  assert.equal(keyLiteral("x'y"), "'x''y'");
});

test("buildExportSelect: oldest-first, aliases key as __k, rowid unquoted", () => {
  assert.equal(
    buildExportSelect("logs", "id", 5),
    'SELECT "id" AS __k, * FROM "logs" ORDER BY "id" ASC LIMIT 5',
  );
  assert.equal(
    buildExportSelect("webhook_deliveries", "rowid", 100),
    'SELECT rowid AS __k, * FROM "webhook_deliveries" ORDER BY rowid ASC LIMIT 100',
  );
});

test("buildRangeDelete: exact key window; rowid stays unquoted so it matches rows", () => {
  assert.equal(
    buildRangeDelete("logs", "id", 1, 9),
    'DELETE FROM "logs" WHERE "id" >= 1 AND "id" <= 9',
  );
  assert.equal(
    buildRangeDelete("webhook_deliveries", "rowid", 1, 100),
    'DELETE FROM "webhook_deliveries" WHERE rowid >= 1 AND rowid <= 100',
  );
});

test("buildChildDelete/Export scope children by a parent-window subquery (FK-safe, no IN-list)", () => {
  const sub = '(SELECT "delivery_id" FROM "webhook_deliveries" WHERE rowid >= 1 AND rowid <= 100)';
  assert.equal(
    buildChildDelete("check_run", "delivery_id", "webhook_deliveries", "delivery_id", "rowid", 1, 100),
    `DELETE FROM "check_run" WHERE "delivery_id" IN ${sub}`,
  );
  assert.equal(
    buildChildExportSelect("push", "delivery_id", "webhook_deliveries", "delivery_id", "rowid", 1, 100),
    `SELECT * FROM "push" WHERE "delivery_id" IN ${sub}`,
  );
});

test("buildRangeCount: the retry-safe post-delete 'window is empty' check", () => {
  assert.equal(
    buildRangeCount("webhook_deliveries", "rowid", 1, 100),
    "SELECT COUNT(*) AS n FROM \"webhook_deliveries\" WHERE rowid >= 1 AND rowid <= 100",
  );
});
