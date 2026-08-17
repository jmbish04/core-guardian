/**
 * @fileoverview Log queue-consumer sink — batch-inserts queued log entries into
 * the LOGS_DB (core-guardian-logs) D1 in one `LOGS_DB.batch([...])`.
 *
 * The `/api/logs/ingest` route enqueues one {@link LogMessage} per entry to keep
 * D1 writes off the request hot path; the Worker's `queue()` handler drains a
 * batch and hands it here. LOGS_DB is a raw-SQL D1 (NOT a drizzle DB), so this
 * uses `env.LOGS_DB.prepare(...)` directly against the pre-provisioned schema:
 *   logs(id INTEGER PK AUTOINCREMENT, ts, source, level, message, fields)
 *
 * @see {@link file://src/backend/api/routes/logs.ts} for the producer.
 */

/** One log entry as carried on the ingest queue (matches the /ingest body rows). */
export type LogMessage = {
  source: string;
  ts: number;
  level?: string | null;
  message: string;
  /** Arbitrary structured context; serialized to the `fields` TEXT column. */
  fields?: unknown;
};

const INSERT_SQL =
  "INSERT INTO logs (ts, source, level, message, fields) VALUES (?, ?, ?, ?, ?)";

/**
 * Batch-insert a set of log entries into LOGS_DB as one atomic D1 batch.
 *
 * Throws on failure so the queue handler can retry the whole batch — a partial
 * insert is impossible because D1 `batch()` is transactional.
 *
 * @param env - Worker env (carries the raw LOGS_DB binding)
 * @param entries - the log messages drained from the queue
 * @returns the number of rows inserted
 */
export async function insertLogBatch(env: Env, entries: LogMessage[]): Promise<number> {
  if (entries.length === 0) return 0;
  const stmt = env.LOGS_DB.prepare(INSERT_SQL);
  const bound = entries.map((e) =>
    stmt.bind(
      // ts defaults to now if a producer omitted it (route already defaults it,
      // this is belt-and-suspenders for a hand-enqueued message).
      Number.isFinite(e.ts) ? e.ts : Date.now(),
      e.source,
      e.level ?? null,
      e.message,
      // fields is optional structured context; store JSON text or NULL.
      e.fields === undefined || e.fields === null ? null : JSON.stringify(e.fields),
    ),
  );
  await env.LOGS_DB.batch(bound);
  return bound.length;
}
