/**
 * @fileoverview Per-table D1 archive → verify → trim.
 *
 * The safe "shrink a bloated database" loop the whole-DB {@link archiveD1Database}
 * doesn't do: target the biggest TABLE, export just the rows you mean to drop,
 * prove they landed in Drive by re-downloading and counting, log that to D1, and
 * only then delete them. A trim is gated on a `verified` archive row.
 *
 * D1 has no `dbstat`, so table size is estimated by sampling rows and measuring
 * their serialized bytes — a ranking, not an exact figure. The archive scope and
 * the trim scope are ONE WHERE clause, so what's deleted is exactly what was
 * verified in Drive.
 *
 * @see {@link file://src/backend/db/schemas/governance/d1-table-archives.ts}
 */

import { desc, eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { d1TableArchives, type D1TableArchiveRow } from "@/backend/db/schema";
import {
  downloadDriveFile,
  ensureArchiveFolder,
  uploadToDrive,
} from "@/backend/lib/google-drive";

import { toJsonl, workerName } from "./d1-archive";
import { cfApi } from "./resources";

/** Double-quote a SQLite identifier, escaping embedded quotes. Guards injection. */
function ident(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Run one SQL statement against a specific D1 database via the REST query API. */
async function d1Query<T = Record<string, unknown>>(env: Env, uuid: string, sql: string): Promise<T[]> {
  const { result } = await cfApi<{ results: T[] }[]>(
    env,
    `/d1/database/${encodeURIComponent(uuid)}/query`,
    { method: "POST", body: JSON.stringify({ sql }) },
  );
  return result?.[0]?.results ?? [];
}

/** A cutoff scope: rows where `timeColumn < cutoff`. Omit for a whole-table op. */
export type TableScope = { timeColumn?: string; cutoff?: number | string };

/** Render the scope as a SQL WHERE fragment (no leading WHERE), or "" for all rows. */
function scopeWhere(scope?: TableScope): string {
  if (!scope?.timeColumn || scope.cutoff === undefined || scope.cutoff === "") return "";
  const lit =
    typeof scope.cutoff === "number"
      ? String(scope.cutoff)
      : `'${String(scope.cutoff).replace(/'/g, "''")}'`;
  return `${ident(scope.timeColumn)} < ${lit}`;
}

export type D1TableInfo = { name: string; rows: number; estBytes: number; columns: string[] };

/**
 * List a database's user tables with row counts + a SAMPLED byte estimate,
 * ranked biggest-first, so the UI can point at what's massive.
 */
export async function listD1Tables(env: Env, uuid: string): Promise<D1TableInfo[]> {
  const names = (
    await d1Query<{ name: string }>(
      env,
      uuid,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_migrations'",
    )
  ).map((r) => r.name);

  const out: D1TableInfo[] = [];
  for (const name of names) {
    const [{ c: rows = 0 } = { c: 0 }] = await d1Query<{ c: number }>(
      env,
      uuid,
      `SELECT COUNT(*) AS c FROM ${ident(name)}`,
    );
    // Sample up to 50 rows; measure their JSON bytes; extrapolate to all rows.
    const sample = await d1Query<Record<string, unknown>>(env, uuid, `SELECT * FROM ${ident(name)} LIMIT 50`);
    const sampleBytes = sample.reduce((s, r) => s + new TextEncoder().encode(JSON.stringify(r)).length, 0);
    const avg = sample.length ? sampleBytes / sample.length : 0;
    out.push({
      name,
      rows: Number(rows),
      estBytes: Math.round(avg * Number(rows)),
      columns: sample.length ? Object.keys(sample[0]) : [],
    });
  }
  return out.sort((a, b) => b.estBytes - a.estBytes);
}

/**
 * Archive one table (or its scoped subset) to Drive as JSONL and log the row
 * (verified=0). Returns the archive record.
 */
export async function archiveD1Table(
  env: Env,
  opts: { uuid: string; databaseName: string; table: string; scope?: TableScope },
): Promise<D1TableArchiveRow> {
  const { uuid, databaseName, table, scope } = opts;
  const where = scopeWhere(scope);
  const whereSql = where ? ` WHERE ${where}` : "";

  const schema = await d1Query<{ name: string; sql: string | null }>(
    env,
    uuid,
    `SELECT name, sql FROM sqlite_master WHERE type='table' AND name = ${`'${table.replace(/'/g, "''")}'`}`,
  );
  const rows = await d1Query<Record<string, unknown>>(env, uuid, `SELECT * FROM ${ident(table)}${whereSql}`);
  const exportedAt = new Date().toISOString();
  const jsonl = toJsonl(databaseName, uuid, exportedAt, schema, { [table]: rows });
  const bytes = new TextEncoder().encode(jsonl).length;

  const { folderId } = await ensureArchiveFolder(env, workerName(env), "d1", Math.floor(Date.now() / 1000));
  const stamp = exportedAt.slice(0, 19).replace(/[:T]/g, "-");
  const upload = await uploadToDrive(
    env,
    folderId,
    `${databaseName}.${table}.${stamp}.jsonl`,
    jsonl,
    "application/x-ndjson",
    Math.floor(Date.now() / 1000),
  );

  const db = getDb(env);
  const rec: typeof d1TableArchives.$inferInsert = {
    id: crypto.randomUUID(),
    databaseUuid: uuid,
    databaseName,
    tableName: table,
    timeColumn: scope?.timeColumn ?? "",
    scopeSql: where, // the exact fragment; trim reuses it verbatim
    archivedRows: rows.length,
    driveFileId: upload.id,
    driveUrl: upload.url,
    bytes,
    verified: false,
  };
  await db.insert(d1TableArchives).values(rec);
  const [saved] = await db.select().from(d1TableArchives).where(eq(d1TableArchives.id, rec.id));
  return saved;
}

/**
 * Verify by re-download: pull the Drive file back, count its `row` lines, and
 * compare to what we archived. Records verified=1 + the counted rows on match.
 */
export async function verifyD1Archive(env: Env, archiveId: string): Promise<D1TableArchiveRow> {
  const db = getDb(env);
  const [rec] = await db.select().from(d1TableArchives).where(eq(d1TableArchives.id, archiveId));
  if (!rec) throw new Error(`archive ${archiveId} not found`);

  const content = await downloadDriveFile(env, rec.driveFileId, Math.floor(Date.now() / 1000));
  // Count JSONL rows (type:"row") — the manifest line is excluded.
  let driveRows = 0;
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      if ((JSON.parse(line) as { type?: string }).type === "row") driveRows++;
    } catch {
      /* a corrupt line means the archive is NOT trustworthy — leave verified=0 */
    }
  }
  const verified = driveRows === rec.archivedRows && rec.archivedRows >= 0;
  await db
    .update(d1TableArchives)
    .set({ verified, verifiedRows: driveRows, verifiedAt: Date.now() })
    .where(eq(d1TableArchives.id, archiveId));
  return { ...rec, verified, verifiedRows: driveRows, verifiedAt: Date.now() };
}

/**
 * Trim: delete the archived scope from the live table — GATED on a verified
 * archive. Deletes EXACTLY the scope that was archived (same WHERE), records the
 * deleted count. Never deletes when unverified or already trimmed.
 */
export async function trimD1Table(env: Env, archiveId: string): Promise<D1TableArchiveRow> {
  const db = getDb(env);
  const [rec] = await db.select().from(d1TableArchives).where(eq(d1TableArchives.id, archiveId));
  if (!rec) throw new Error(`archive ${archiveId} not found`);
  if (!rec.verified) throw new Error("refusing to trim: archive is not verified");
  if (rec.trimmed) throw new Error("already trimmed");

  // Reuse the EXACT archived scope — never re-derive (a re-derivation that
  // dropped a string cutoff would delete the whole table).
  const whereSql = rec.scopeSql ? ` WHERE ${rec.scopeSql}` : "";
  // Count first (audit), then delete the same scope.
  const [{ c: before = 0 } = { c: 0 }] = await d1Query<{ c: number }>(
    env,
    rec.databaseUuid,
    `SELECT COUNT(*) AS c FROM ${ident(rec.tableName)}${whereSql}`,
  );
  await d1Query(env, rec.databaseUuid, `DELETE FROM ${ident(rec.tableName)}${whereSql}`);
  const reclaimed = rec.bytes; // archived bytes ≈ the on-disk bulk removed

  await db
    .update(d1TableArchives)
    .set({ trimmed: true, trimmedRows: Number(before), trimmedAt: Date.now(), reclaimedBytes: reclaimed })
    .where(eq(d1TableArchives.id, archiveId));
  return { ...rec, trimmed: true, trimmedRows: Number(before), trimmedAt: Date.now(), reclaimedBytes: reclaimed };
}

/** Recent archive/trim records for one database, newest first. */
export async function listD1TableArchives(env: Env, uuid: string): Promise<D1TableArchiveRow[]> {
  return getDb(env)
    .select()
    .from(d1TableArchives)
    .where(eq(d1TableArchives.databaseUuid, uuid))
    .orderBy(desc(d1TableArchives.createdAt))
    .limit(50);
}
