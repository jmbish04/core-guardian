/**
 * @fileoverview Per-table D1 archive → verify → trim.
 *
 * The safe "shrink a bloated database" loop the whole-DB {@link archiveD1Database}
 * doesn't do: target the biggest TABLE, export the rows you mean to drop, PROVE
 * they landed in Drive (row count + byte length + SHA-256 all match on
 * re-download), log it, and only then delete them.
 *
 * Safety, because this deletes production rows:
 *  - A trim is gated on a `verified` archive + a type-to-confirm barrier.
 *  - Export captures `MAX(rowid)`; both export and delete are bounded
 *    `… AND rowid <= max`, so rows created after the archive can never be
 *    deleted un-archived, and clock-skew backfills can't sneak into the delete.
 *  - Before deleting, the live scope is re-counted and MUST equal what was
 *    archived — a truncated/short export aborts instead of over-deleting.
 *  - Scope is stored structurally (column + typed cutoff), never as raw SQL.
 *  - A scope estimated over {@link MAX_ARCHIVE_BYTES} is refused (it won't fit in
 *    Worker memory / one D1 response) — narrow the cutoff and shrink in chunks.
 *
 * D1 has no `dbstat`, so table size is a sampled estimate — a ranking.
 */

import { desc, eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { d1TableArchives, type D1TableArchiveRow } from "@/backend/db/schema";
import { downloadDriveFile, ensureArchiveFolder, uploadToDrive } from "@/backend/lib/google-drive";

import { toJsonl, workerName } from "./d1-archive";
import { cfApi } from "./resources";

/** One export must fit in Worker memory + one D1 response + one Drive upload. */
export const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024; // 40 MB

/** Double-quote a SQLite identifier, escaping embedded quotes. Guards injection. */
function ident(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function d1Query<T = Record<string, unknown>>(env: Env, uuid: string, sql: string): Promise<T[]> {
  const { result } = await cfApi<{ results: T[] }[]>(
    env,
    `/d1/database/${encodeURIComponent(uuid)}/query`,
    { method: "POST", body: JSON.stringify({ sql }) },
  );
  return result?.[0]?.results ?? [];
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A cutoff scope: rows where `timeColumn < cutoff`. Omit for a whole-table op. */
export type TableScope = { timeColumn?: string; cutoff?: number | string };

/** Render a structural scope as a SQL WHERE fragment, or "" for all rows. */
function renderScope(timeColumn: string, cutoffValue: string, isNum: boolean): string {
  if (!timeColumn || cutoffValue === "") return "";
  const lit = isNum ? String(Number(cutoffValue)) : `'${cutoffValue.replace(/'/g, "''")}'`;
  return `${ident(timeColumn)} < ${lit}`;
}

export type D1TableInfo = { name: string; rows: number; estBytes: number; columns: string[] };

/** List user tables with row counts + a SAMPLED byte estimate, biggest-first. */
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
    const [{ c: rows = 0 } = { c: 0 }] = await d1Query<{ c: number }>(env, uuid, `SELECT COUNT(*) AS c FROM ${ident(name)}`);
    const sample = await d1Query<Record<string, unknown>>(env, uuid, `SELECT * FROM ${ident(name)} LIMIT 50`);
    const sampleBytes = sample.reduce((s, r) => s + new TextEncoder().encode(JSON.stringify(r)).length, 0);
    const avg = sample.length ? sampleBytes / sample.length : 0;
    out.push({ name, rows: Number(rows), estBytes: Math.round(avg * Number(rows)), columns: sample.length ? Object.keys(sample[0]) : [] });
  }
  return out.sort((a, b) => b.estBytes - a.estBytes);
}

/** Archive one table (or its scoped subset) to Drive as JSONL; log verified=0. */
export async function archiveD1Table(
  env: Env,
  opts: { uuid: string; databaseName: string; table: string; scope?: TableScope },
): Promise<D1TableArchiveRow> {
  const { uuid, databaseName, table, scope } = opts;

  // Validate the table exists (never trust a caller-supplied name into SQL scope).
  const schema = await d1Query<{ name: string; sql: string | null }>(
    env,
    uuid,
    `SELECT name, sql FROM sqlite_master WHERE type='table' AND name = '${table.replace(/'/g, "''")}'`,
  );
  if (schema.length === 0) throw new Error(`no such table: ${table}`);

  // Normalize + validate the scope.
  const timeColumn = scope?.timeColumn ?? "";
  const rawCutoff = scope?.cutoff;
  if (timeColumn && (rawCutoff === undefined || rawCutoff === "")) {
    throw new Error("a time column requires a cutoff (refusing to scope-collapse to the whole table)");
  }
  const isNum = typeof rawCutoff === "number";
  if (isNum && !Number.isFinite(rawCutoff as number)) throw new Error("cutoff is not a finite number");
  const cutoffValue = rawCutoff === undefined ? "" : String(rawCutoff);
  const where = renderScope(timeColumn, cutoffValue, isNum);
  const whereSql = where ? ` WHERE ${where}` : "";

  // Size guard — refuse a scope too big to hold in memory / one response.
  const [{ c: scopeRows = 0 } = { c: 0 }] = await d1Query<{ c: number }>(env, uuid, `SELECT COUNT(*) AS c FROM ${ident(table)}${whereSql}`);
  const sample = await d1Query<Record<string, unknown>>(env, uuid, `SELECT * FROM ${ident(table)}${whereSql} LIMIT 50`);
  const avg = sample.length ? sample.reduce((s, r) => s + new TextEncoder().encode(JSON.stringify(r)).length, 0) / sample.length : 0;
  const estBytes = avg * Number(scopeRows);
  if (estBytes > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `scope is ~${Math.round(estBytes / 1024 / 1024)}MB (> ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB cap). Narrow the cutoff and shrink in chunks.`,
    );
  }

  // Capture the rowid ceiling, then export exactly the rows at/below it in scope.
  const [{ m: maxRowid = 0 } = { m: 0 }] = await d1Query<{ m: number }>(env, uuid, `SELECT MAX(rowid) AS m FROM ${ident(table)}${whereSql}`);
  const boundSql = where ? ` WHERE ${where} AND rowid <= ${Number(maxRowid)}` : ` WHERE rowid <= ${Number(maxRowid)}`;
  const rows = await d1Query<Record<string, unknown>>(env, uuid, `SELECT * FROM ${ident(table)}${boundSql}`);

  const exportedAt = new Date().toISOString();
  const jsonl = toJsonl(databaseName, uuid, exportedAt, schema, { [table]: rows });
  const bytes = new TextEncoder().encode(jsonl).length;
  const contentHash = await sha256Hex(jsonl);

  const { folderId } = await ensureArchiveFolder(env, workerName(env), "d1", Math.floor(Date.now() / 1000));
  const stamp = exportedAt.slice(0, 19).replace(/[:T]/g, "-");
  const upload = await uploadToDrive(env, folderId, `${databaseName}.${table}.${stamp}.jsonl`, jsonl, "application/x-ndjson", Math.floor(Date.now() / 1000));

  const db = getDb(env);
  const rec: typeof d1TableArchives.$inferInsert = {
    id: crypto.randomUUID(),
    databaseUuid: uuid,
    databaseName,
    tableName: table,
    timeColumn,
    cutoffValue,
    cutoffIsNum: isNum,
    maxRowid: Number(maxRowid),
    archivedRows: rows.length,
    driveFileId: upload.id,
    driveUrl: upload.url,
    bytes,
    contentHash,
    verified: false,
  };
  await db.insert(d1TableArchives).values(rec);
  const [saved] = await db.select().from(d1TableArchives).where(eq(d1TableArchives.id, rec.id));
  return saved;
}

/** Verify by re-download: row count AND byte length AND SHA-256 must all match. */
export async function verifyD1Archive(env: Env, archiveId: string): Promise<D1TableArchiveRow> {
  const db = getDb(env);
  const [rec] = await db.select().from(d1TableArchives).where(eq(d1TableArchives.id, archiveId));
  if (!rec) throw new Error(`archive ${archiveId} not found`);

  const content = await downloadDriveFile(env, rec.driveFileId, Math.floor(Date.now() / 1000));
  const bytes = new TextEncoder().encode(content).length;
  const hash = await sha256Hex(content);
  let driveRows = 0;
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      if ((JSON.parse(line) as { type?: string }).type === "row") driveRows++;
    } catch {
      driveRows = -1; // a corrupt line poisons verification
      break;
    }
  }
  const verified =
    rec.archivedRows > 0 && driveRows === rec.archivedRows && bytes === rec.bytes && hash === rec.contentHash;
  await db.update(d1TableArchives).set({ verified, verifiedRows: Math.max(0, driveRows), verifiedAt: Date.now() }).where(eq(d1TableArchives.id, archiveId));
  return { ...rec, verified, verifiedRows: Math.max(0, driveRows), verifiedAt: Date.now() };
}

/** Trim: delete the archived scope — GATED on verified + a live-count match. */
export async function trimD1Table(env: Env, archiveId: string): Promise<D1TableArchiveRow> {
  const db = getDb(env);
  const [rec] = await db.select().from(d1TableArchives).where(eq(d1TableArchives.id, archiveId));
  if (!rec) throw new Error(`archive ${archiveId} not found`);
  if (!rec.verified) throw new Error("refusing to trim: archive is not verified");
  if (rec.trimmed) throw new Error("already trimmed");
  if (rec.archivedRows <= 0) throw new Error("refusing to trim an empty archive");

  const where = renderScope(rec.timeColumn, rec.cutoffValue, rec.cutoffIsNum);
  const whereSql = where
    ? ` WHERE ${where} AND rowid <= ${rec.maxRowid}`
    : ` WHERE rowid <= ${rec.maxRowid}`;

  // The live scope MUST equal what we archived, or the export was short/drifted.
  const [{ c: liveRows = 0 } = { c: 0 }] = await d1Query<{ c: number }>(env, rec.databaseUuid, `SELECT COUNT(*) AS c FROM ${ident(rec.tableName)}${whereSql}`);
  if (Number(liveRows) !== rec.archivedRows) {
    throw new Error(`refusing to trim: live scope has ${liveRows} rows, archived ${rec.archivedRows} — re-archive first`);
  }
  await d1Query(env, rec.databaseUuid, `DELETE FROM ${ident(rec.tableName)}${whereSql}`);

  await db
    .update(d1TableArchives)
    .set({ trimmed: true, trimmedRows: Number(liveRows), trimmedAt: Date.now(), reclaimedBytes: rec.bytes })
    .where(eq(d1TableArchives.id, archiveId));
  return { ...rec, trimmed: true, trimmedRows: Number(liveRows), trimmedAt: Date.now(), reclaimedBytes: rec.bytes };
}

/** Recent archive/trim records for one database, newest first. */
export async function listD1TableArchives(env: Env, uuid: string): Promise<D1TableArchiveRow[]> {
  return getDb(env).select().from(d1TableArchives).where(eq(d1TableArchives.databaseUuid, uuid)).orderBy(desc(d1TableArchives.createdAt)).limit(50);
}
