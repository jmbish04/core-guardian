/**
 * @fileoverview Pure SQL/arithmetic helpers for the LogTrimWorkflow, split out
 * so they carry no `cloudflare:workers` import and can be unit-checked under
 * plain node (see the `import.meta.main` self-check at the bottom).
 */

/** Double-quote a SQLite identifier, escaping embedded quotes. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Reference to the ordering/range column. SQLite's rowid pseudo-columns
 * (`rowid`/`_rowid_`/`oid`) must stay UNQUOTED — a double-quoted `"rowid"` that
 * matches no real column is treated as a string literal in some clauses. Real
 * columns are quoted normally.
 */
export function keyRef(col: string): string {
  return col === "rowid" || col === "_rowid_" || col === "oid" ? col : ident(col);
}

/**
 * How many oldest rows to export+delete this run: capped at `batchRows`, and
 * never enough to drop the table below `keepRows`. Zero means "nothing to do".
 */
export function computeExportCount(count: number, keepRows: number, batchRows: number): number {
  return Math.max(0, Math.min(batchRows, count - keepRows));
}

/**
 * Build the oldest-first export SELECT. The ordering/range column is aliased to
 * `__k` so the caller can read min/max keys even when `keyColumn` is `rowid`
 * (which `SELECT *` never returns). `limit` is inlined as an integer.
 */
export function buildExportSelect(table: string, keyColumn: string, limit: number): string {
  const n = Math.trunc(limit);
  const k = keyRef(keyColumn);
  return `SELECT ${k} AS __k, * FROM ${ident(table)} ORDER BY ${k} ASC LIMIT ${n}`;
}

/**
 * A subquery selecting the parent's referenced-column values for the export key
 * window — used to scope child export/delete without materializing a huge IN
 * list. e.g. `(SELECT "delivery_id" FROM "webhook_deliveries" WHERE rowid >= 1 AND rowid <= 100)`.
 */
export function parentKeySubquery(
  parentTable: string,
  parentCol: string,
  keyColumn: string,
  minKey: unknown,
  maxKey: unknown,
): string {
  const k = keyRef(keyColumn);
  return `SELECT ${ident(parentCol)} FROM ${ident(parentTable)} WHERE ${k} >= ${keyLiteral(minKey)} AND ${k} <= ${keyLiteral(maxKey)}`;
}

/** Export child rows whose FK column falls in the parent key window. */
export function buildChildExportSelect(
  childTable: string,
  childCol: string,
  parentTable: string,
  parentCol: string,
  keyColumn: string,
  minKey: unknown,
  maxKey: unknown,
): string {
  return `SELECT * FROM ${ident(childTable)} WHERE ${ident(childCol)} IN (${parentKeySubquery(parentTable, parentCol, keyColumn, minKey, maxKey)})`;
}

/** Delete child rows whose FK column falls in the parent key window (run BEFORE the parent delete). */
export function buildChildDelete(
  childTable: string,
  childCol: string,
  parentTable: string,
  parentCol: string,
  keyColumn: string,
  minKey: unknown,
  maxKey: unknown,
): string {
  return `DELETE FROM ${ident(childTable)} WHERE ${ident(childCol)} IN (${parentKeySubquery(parentTable, parentCol, keyColumn, minKey, maxKey)})`;
}

/** COUNT rows still in the key window — used for the retry-safe "range is empty" post-delete check. */
export function buildRangeCount(table: string, keyColumn: string, minKey: unknown, maxKey: unknown): string {
  const k = keyRef(keyColumn);
  return `SELECT COUNT(*) AS n FROM ${ident(table)} WHERE ${k} >= ${keyLiteral(minKey)} AND ${k} <= ${keyLiteral(maxKey)}`;
}

/**
 * Render a range-bound key as a SQL literal. The seeded targets all key on an
 * integer column (`id` / `rowid`), so numbers pass through bare; a stray
 * non-numeric key is single-quoted defensively rather than trusted raw.
 *
 * ponytail: inline literals (not bound params) because keys are integers from
 * our own COUNT/SELECT, never user input. Switch to bound params if a
 * text-keyed target is ever registered.
 */
export function keyLiteral(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "bigint") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Build the range-delete for the exported window. */
export function buildRangeDelete(
  table: string,
  keyColumn: string,
  minKey: unknown,
  maxKey: unknown,
): string {
  const k = keyRef(keyColumn);
  return `DELETE FROM ${ident(table)} WHERE ${k} >= ${keyLiteral(minKey)} AND ${k} <= ${keyLiteral(maxKey)}`;
}

// ---------------------------------------------------------------------------
// Self-check: `npx tsx src/backend/guardian/log-trim-sql.ts`
// ---------------------------------------------------------------------------
if ((import.meta as { main?: boolean }).main) {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`FAIL: ${msg}`);
  };
  assert(ident('a"b') === '"a""b"', "ident escapes quotes");
  assert(computeExportCount(100, 20, 10) === 10, "batch cap");
  assert(computeExportCount(100, 95, 10) === 5, "keep floor");
  assert(computeExportCount(100, 200, 10) === 0, "already below keep");
  assert(
    buildExportSelect("logs", "id", 5) === 'SELECT "id" AS __k, * FROM "logs" ORDER BY "id" ASC LIMIT 5',
    "select shape",
  );
  assert(
    buildExportSelect("webhook_deliveries", "rowid", 3).includes('"rowid" AS __k'),
    "rowid aliased",
  );
  assert(keyLiteral(42) === "42", "numeric literal bare");
  assert(keyLiteral("x'y") === "'x''y'", "text literal escaped");
  assert(
    buildRangeDelete("logs", "id", 1, 9) === 'DELETE FROM "logs" WHERE "id" >= 1 AND "id" <= 9',
    "range delete shape",
  );
  // rowid stays unquoted (the double-quoted-"rowid" string-literal quirk).
  assert(keyRef("rowid") === "rowid", "rowid unquoted");
  assert(keyRef("id") === '"id"', "regular key quoted");
  assert(
    buildRangeDelete("webhook_deliveries", "rowid", 1, 100) ===
      'DELETE FROM "webhook_deliveries" WHERE rowid >= 1 AND rowid <= 100',
    "rowid range delete unquoted",
  );
  assert(
    buildChildDelete("check_run", "delivery_id", "webhook_deliveries", "delivery_id", "rowid", 1, 100) ===
      'DELETE FROM "check_run" WHERE "delivery_id" IN (SELECT "delivery_id" FROM "webhook_deliveries" WHERE rowid >= 1 AND rowid <= 100)',
    "child delete subquery",
  );
  assert(
    buildRangeCount("webhook_deliveries", "rowid", 1, 100) ===
      'SELECT COUNT(*) AS n FROM "webhook_deliveries" WHERE rowid >= 1 AND rowid <= 100',
    "range count shape",
  );
  console.log("log-trim-sql: all self-checks passed");
}
