/**
 * @fileoverview LogTrimWorkflow — durable export→verify→truncate for oversized
 * log/webhook tables, driven by the `trim_targets` registry.
 *
 * The Worker's hourly cron calls {@link dispatchTrimTargets}, which seeds the
 * default targets, counts each enabled target's table over the D1 REST API, and
 * fires a `TRIM_WORKFLOW` instance for any table past its `thresholdRows`. Each
 * instance runs the stages below, one per `step.do(...)` so that a truncate
 * retry never re-exports:
 *
 *   1. count      — load the target row, COUNT(*) the table. ≤ threshold ⇒ done.
 *   2. export     — SELECT the oldest window, build the JSON bundle, walk/create
 *                   the Drive folder tree `<dbName>/<YYYY>/<MM>/`, upload.
 *   3. verify     — re-fetch the Drive file (exists) and assert the read-back
 *                   byte count equals the JSON byte length. Fail ⇒ NO truncate.
 *   4. truncate   — range-DELETE exactly the exported key window; assert the
 *                   delete changed exactly `rowCount` rows.
 *   5. finalize   — stamp trim_targets (lastRunAt / lastExportPath /
 *                   lastRowsExported), clear lastError.
 *
 * The target table can live in ANY D1 on the account: reads and deletes go
 * through `cfApi` + the `/d1/database/{uuid}/query` REST endpoint, never a
 * binding. The main registry (`trim_targets`) is the only drizzle DB touched.
 *
 * @see {@link file://src/backend/guardian/log-trim-sql.ts} for the pure helpers.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { driveFolders, trimTargets, type TrimTargetRow } from "@/backend/db/schema";
import { findOrCreateFolder, getDriveFolder, uploadToDrive } from "@/backend/lib/google-drive";

import { cfApi } from "./resources";
import {
  buildChildDelete,
  buildChildExportSelect,
  buildExportSelect,
  buildRangeCount,
  buildRangeDelete,
  computeExportCount,
} from "./log-trim-sql";

/** Fallback "d1 archives" folder id when drive_folders has no purpose='d1' row. */
const DEFAULT_D1_FOLDER_ID = "1obQXC7aeHRhzvPayQoZSTvzMgfZ_Hea-";

/** Stable seed ids so ensureDefaultTrimTargets is idempotent (INSERT OR IGNORE). */
const SEED_LOGS_ID = "seed:core-guardian-logs:logs";
const SEED_WEBHOOKS_ID = "seed:core-github-api-webhooks:webhook_deliveries";

/** Skip re-dispatching a target whose last run is newer than this (anti-stacking). */
const MIN_DISPATCH_GAP_MS = 10 * 60_000;

export type TrimParams = { targetId: string };

// ---------------------------------------------------------------------------
// D1 REST helpers (arbitrary database by uuid)
// ---------------------------------------------------------------------------

type D1Result = { rows: Record<string, unknown>[]; changes: number };

/** Run one SQL statement against a D1 database by uuid; returns rows + change count. */
async function d1(env: Env, uuid: string, sql: string): Promise<D1Result> {
  const { result } = await cfApi<{ results?: Record<string, unknown>[]; meta?: { changes?: number } }[]>(
    env,
    `/d1/database/${encodeURIComponent(uuid)}/query`,
    { method: "POST", body: JSON.stringify({ sql }) },
  );
  const first = result?.[0];
  return { rows: first?.results ?? [], changes: Number(first?.meta?.changes ?? 0) };
}

/** COUNT(*) a table in a given database. */
async function countRows(env: Env, uuid: string, table: string): Promise<number> {
  const { rows } = await d1(env, uuid, `SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}"`);
  return Number(rows[0]?.n ?? 0);
}

/** A child table with a foreign key onto the trim target. */
type FkChild = { childTable: string; childCol: string; parentCol: string };

/**
 * Discover every table whose foreign key references `parentTable`, so the trim
 * can delete children before the parent (FK order) instead of dying on a
 * `FOREIGN KEY constraint failed`. Generic across any D1 via PRAGMA — e.g.
 * webhook_deliveries.delivery_id is referenced by check_run/pull_request/… .
 * Returns [] for a table with no children (the plain log-table case).
 */
async function discoverFkChildren(env: Env, uuid: string, parentTable: string): Promise<FkChild[]> {
  const { rows: tables } = await d1(
    env,
    uuid,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  );
  const children: FkChild[] = [];
  for (const t of tables) {
    const childTable = String(t.name);
    if (childTable === parentTable) continue;
    const { rows: fks } = await d1(env, uuid, `PRAGMA foreign_key_list("${childTable.replace(/"/g, '""')}")`);
    for (const fk of fks) {
      if (String(fk.table) === parentTable) {
        children.push({ childTable, childCol: String(fk.from), parentCol: String(fk.to) });
      }
    }
  }
  return children;
}

/** Resolve the base "d1 archives" Drive folder for a target (row override → drive_folders → fallback). */
async function resolveBaseFolder(env: Env, target: TrimTargetRow): Promise<string> {
  if (target.driveFolderId) return target.driveFolderId;
  const [row] = await getDb(env)
    .select({ folderId: driveFolders.folderId })
    .from(driveFolders)
    .where(eq(driveFolders.purpose, "d1"))
    .limit(1);
  return row?.folderId ?? DEFAULT_D1_FOLDER_ID;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export class LogTrimWorkflow extends WorkflowEntrypoint<Env, TrimParams> {
  async run(event: WorkflowEvent<TrimParams>, step: WorkflowStep): Promise<{ trimmed: boolean; rows: number }> {
    const { targetId } = event.payload;
    const env = this.env;

    try {
      // Stage 1: load the target + count the table.
      const plan = await step.do("count", async () => {
        const [t] = await getDb(env).select().from(trimTargets).where(eq(trimTargets.id, targetId)).limit(1);
        if (!t) throw new Error(`trim target ${targetId} not found`);
        const count = await countRows(env, t.dbUuid, t.tableName);
        return { target: t, count };
      });

      const t = plan.target;
      const exportCount = computeExportCount(plan.count, t.keepRows, t.batchRows);

      // Under threshold (or nothing eligible to export) → record the run and stop.
      if (plan.count <= t.thresholdRows || exportCount <= 0) {
        await step.do("noop", async () => {
          await getDb(env)
            .update(trimTargets)
            .set({ lastRunAt: Date.now(), lastError: null, updatedAt: Date.now() })
            .where(eq(trimTargets.id, targetId));
        });
        return { trimmed: false, rows: 0 };
      }

      // Stage 2: export the oldest window to Drive (SELECT → build → upload), all
      // inside one step so the (potentially large) rows array never crosses a
      // step boundary. Returns only small metadata.
      // Discover FK children ONCE (memoized) so the export bundles them and the
      // truncate can delete them before the parent (FK-safe order).
      const fkChildren = await step.do("discover-fk", async () =>
        discoverFkChildren(env, t.dbUuid, t.tableName),
      );

      const exported = await step.do("export", async () => {
        const { rows } = await d1(env, t.dbUuid, buildExportSelect(t.tableName, t.keyColumn, exportCount));
        if (rows.length === 0) return null;

        const minKey = rows[0].__k as number;
        const maxKey = rows[rows.length - 1].__k as number;
        // Strip the synthetic key alias from the exported payload rows.
        const cleaned = rows.map(({ __k, ...rest }) => rest);

        // Pull the child rows referencing this parent key window, so the archive
        // is complete and the cascade delete has a verified backup of everything
        // it removes.
        const children: Record<string, Record<string, unknown>[]> = {};
        let childRowCount = 0;
        for (const c of fkChildren) {
          const { rows: crows } = await d1(
            env,
            t.dbUuid,
            buildChildExportSelect(c.childTable, c.childCol, t.tableName, c.parentCol, t.keyColumn, minKey, maxKey),
          );
          if (crows.length > 0) {
            children[c.childTable] = crows;
            childRowCount += crows.length;
          }
        }

        const exportedAt = new Date().toISOString().slice(0, 19); // 2026-08-17T12:30:00
        const yyyy = exportedAt.slice(0, 4);
        const mm = exportedAt.slice(5, 7);
        const bundle = JSON.stringify({
          meta: { dbName: t.dbName, tableName: t.tableName, exportedAt, rowCount: cleaned.length, childRowCount, minKey, maxKey },
          rows: cleaned,
          children,
        });
        const expectedBytes = new TextEncoder().encode(bundle).length;

        // Walk/create the Drive tree: <base>/<dbName>/<YYYY>/<MM>/.
        const nowSec = Date.now() / 1000;
        const base = await resolveBaseFolder(env, t);
        const dbFolder = await findOrCreateFolder(env, t.dbName, base, nowSec);
        const yearFolder = await findOrCreateFolder(env, yyyy, dbFolder, nowSec);
        const monthFolder = await findOrCreateFolder(env, mm, yearFolder, nowSec);

        const filename = `${exportedAt}_${t.tableName}_export.json`;
        const upload = await uploadToDrive(env, monthFolder, filename, bundle, "application/json", nowSec);

        return {
          minKey,
          maxKey,
          rowCount: cleaned.length,
          childRowCount,
          expectedBytes,
          driveBytes: upload.bytes,
          driveFileId: upload.id,
          logicalPath: `${t.dbName}/${yyyy}/${mm}/${filename}`,
        };
      });

      if (!exported) {
        await step.do("noop-empty", async () => {
          await getDb(env)
            .update(trimTargets)
            .set({ lastRunAt: Date.now(), lastError: null, updatedAt: Date.now() })
            .where(eq(trimTargets.id, targetId));
        });
        return { trimmed: false, rows: 0 };
      }

      // Stage 3: verify BEFORE any delete. The file must exist AND the Drive
      // read-back byte count must equal the JSON byte length. A throw here retries
      // the workflow without ever truncating.
      await step.do("verify", async () => {
        const meta = await getDriveFolder(env, exported.driveFileId, Date.now() / 1000);
        if (!meta) throw new Error(`verify: uploaded file ${exported.driveFileId} not found in Drive`);
        if (exported.driveBytes !== exported.expectedBytes) {
          throw new Error(`verify: byte mismatch (sent ${exported.expectedBytes}, Drive ${exported.driveBytes})`);
        }
        return { verified: true };
      });

      // Stage 4: truncate the exported key window, FK-safe: delete child rows
      // (referencing the parent window) BEFORE the parent rows, else a
      // NO ACTION foreign key aborts the delete. Idempotent + retry-safe — the
      // post-check is "the parent window is now empty" (a range DELETE can't
      // over-delete, and a retry after a partial delete simply finds fewer rows),
      // NOT an exact changes count (which a retry would fail).
      await step.do("truncate", async () => {
        for (const c of fkChildren) {
          await d1(
            env,
            t.dbUuid,
            buildChildDelete(c.childTable, c.childCol, t.tableName, c.parentCol, t.keyColumn, exported.minKey, exported.maxKey),
          );
        }
        await d1(env, t.dbUuid, buildRangeDelete(t.tableName, t.keyColumn, exported.minKey, exported.maxKey));
        const { rows } = await d1(env, t.dbUuid, buildRangeCount(t.tableName, t.keyColumn, exported.minKey, exported.maxKey));
        const remaining = Number(rows[0]?.n ?? -1);
        if (remaining !== 0) {
          throw new Error(`truncate: parent window not empty after delete (${remaining} rows remain)`);
        }
        return { parentDeleted: exported.rowCount, childDeleted: exported.childRowCount };
      });

      // Stage 5: stamp the registry.
      await step.do("finalize", async () => {
        await getDb(env)
          .update(trimTargets)
          .set({
            lastRunAt: Date.now(),
            lastExportPath: exported.logicalPath,
            lastRowsExported: exported.rowCount,
            lastError: null,
            updatedAt: Date.now(),
          })
          .where(eq(trimTargets.id, targetId));
      });

      return { trimmed: true, rows: exported.rowCount };
    } catch (err) {
      // Terminal error path: best-effort record on the registry, then rethrow so
      // the workflow surfaces as failed / retries. Not wrapped in a step (a step
      // that records-then-throws would memoize the record and swallow the retry).
      const message = err instanceof Error ? err.message : String(err);
      await getDb(env)
        .update(trimTargets)
        .set({ lastError: message, updatedAt: Date.now() })
        .where(eq(trimTargets.id, targetId))
        .catch(() => {});
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Seed + dispatch (called from the hourly cron)
// ---------------------------------------------------------------------------

/**
 * Install the default trim targets idempotently (INSERT OR IGNORE by stable id).
 *
 *  - core-guardian-logs.logs           — integer PK `id`.
 *  - core-github-api-webhooks.webhook_deliveries — PK is a TEXT uuid, so trim by
 *    `rowid` (SQLite's implicit monotonic insert order) for chronological
 *    oldest-first export.
 */
export async function ensureDefaultTrimTargets(env: Env): Promise<void> {
  const now = Date.now();
  await getDb(env)
    .insert(trimTargets)
    .values([
      {
        id: SEED_LOGS_ID,
        dbUuid: "4c116ac2-0c5a-49c8-a00b-05adfd394c6f",
        dbName: "core-guardian-logs",
        tableName: "logs",
        keyColumn: "id",
        updatedAt: now,
      },
      {
        id: SEED_WEBHOOKS_ID,
        dbUuid: "df714884-593d-45da-9c7f-9f67903c4fca",
        dbName: "core-github-api-webhooks",
        tableName: "webhook_deliveries",
        keyColumn: "rowid",
        updatedAt: now,
      },
    ])
    .onConflictDoNothing({ target: trimTargets.id });
}

/**
 * Seed defaults, then fire a LogTrimWorkflow instance for each enabled target
 * whose table is over threshold. Skips a target run < ~10 min old so back-to-back
 * cron ticks don't stack instances on the same table.
 *
 * @returns the number of workflow instances created
 */
export async function dispatchTrimTargets(env: Env): Promise<number> {
  await ensureDefaultTrimTargets(env);
  const targets = await getDb(env).select().from(trimTargets).where(eq(trimTargets.enabled, true));

  const now = Date.now();
  let created = 0;
  for (const t of targets) {
    if (t.lastRunAt && now - t.lastRunAt < MIN_DISPATCH_GAP_MS) continue;
    let count: number;
    try {
      count = await countRows(env, t.dbUuid, t.tableName);
    } catch (err) {
      console.error(JSON.stringify({ level: "ERROR", source: "guardian.trim.count", target: t.id, error: String(err) }));
      continue;
    }
    if (count <= t.thresholdRows) continue;
    try {
      await env.TRIM_WORKFLOW.create({ params: { targetId: t.id } });
      created++;
    } catch (err) {
      console.error(JSON.stringify({ level: "ERROR", source: "guardian.trim.dispatch", target: t.id, error: String(err) }));
    }
  }
  return created;
}
