/**
 * @fileoverview D1 database archive → Google Drive, with a reconstruct script.
 *
 * Reads an arbitrary D1 database over the REST query API (so it works for any
 * database on the account, not just this worker's binding) and writes three
 * deliverables to the configured Drive folder:
 *   - `<name>-<date>.sql`   — schema CREATEs + INSERTs; reload with
 *                             `wrangler d1 execute <db> --file=<this> --remote`.
 *   - `<name>-<date>.jsonl` — line-delimited: a manifest line (schema) then one
 *                             line per row; the lossless machine reload source.
 *   - `<name>-reconstruct.py` — recreates the DB from the JSONL via the CF API.
 * It then audits that Drive received the full JSONL bytes and files a
 * human-gated action item to delete the source.
 *
 * ponytail: the JSONL is the reload source of record (line parsing can't be
 * broken by data content); the .sql is the wrangler-native convenience artifact.
 * The reconstruct script pulls Cloudflare creds via `tokens show <SECRET>
 * --value-only`, never embedding them.
 *
 * @see {@link file://src/backend/guardian/action-items.ts} for the delete gate.
 */

import { ensureArchiveFolder, uploadToDrive } from "@/backend/lib/google-drive";

import { fileActionItem } from "./action-items";
import { cfApi } from "./resources";

/** The current worker's name — drives the Drive archive parent folder name. */
export function workerName(env: Env): string {
  const base = getEnvVar(env, "WORKER_BASE_URL");
  try {
    if (base) return new URL(base).host.split(".")[0];
  } catch {
    /* fall through */
  }
  return "core-guardian";
}

function getEnvVar(env: Env, key: string): string | undefined {
  const v = (env as unknown as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/** Run one SQL statement against a specific D1 database via the REST API. */
async function d1Query<T = Record<string, unknown>>(
  env: Env,
  uuid: string,
  sql: string,
): Promise<T[]> {
  const { result } = await cfApi<{ results: T[] }[]>(env, `/d1/database/${encodeURIComponent(uuid)}/query`, {
    method: "POST",
    body: JSON.stringify({ sql }),
  });
  return result?.[0]?.results ?? [];
}

type SchemaEntry = { name: string; sql: string | null };

/** Double-quote a SQLite identifier, escaping embedded quotes. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Render one value as a SQLite literal for the .sql dump.
 *
 * @param v - a cell value from a D1 row (null, number, boolean, string, or a
 *   structured value the REST API returned for a BLOB)
 * @returns the value as a SQLite literal (`NULL`, a bare number, `0`/`1`, or a
 *   single-quoted, quote-escaped string)
 */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  // ponytail: strings and any structured value (e.g. a BLOB the REST API returns
  // as an array) become quoted text — good enough for the wrangler-native .sql
  // path; the .jsonl is the lossless source. Upgrade to X'..' hex if real BLOBs
  // start appearing.
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Build the full `.sql` dump (schema + data).
 *
 * ponytail: builds the whole dump as one in-memory string. D1's own size cap
 * keeps this well under the Worker memory limit for any realistic database;
 * switch to a streamed upload if multi-hundred-MB databases ever appear.
 *
 * @param name - the database name (used in the header + reload hint)
 * @param uuid - the database uuid (recorded in the header)
 * @param exportedAt - ISO timestamp of the export
 * @param schema - `{ name, sql }` entries from `sqlite_master`
 * @param tables - map of table name to its rows
 * @returns the complete `.sql` dump (DROP/CREATE per table, then INSERTs)
 */
export function toSqlDump(
  name: string,
  uuid: string,
  exportedAt: string,
  schema: SchemaEntry[],
  tables: Record<string, Record<string, unknown>[]>,
): string {
  const parts = [
    `-- D1 archive of "${name}" (${uuid})`,
    `-- exported ${exportedAt}`,
    `-- reload: wrangler d1 execute <db> --file=${name}-archive.sql --remote`,
    "PRAGMA foreign_keys=OFF;",
    "",
  ];
  // DROP before CREATE so the dump reloads cleanly into a database that already
  // has these tables.
  for (const t of schema) if (t.sql) parts.push(`DROP TABLE IF EXISTS ${ident(t.name)};`, `${t.sql};`);
  parts.push("");
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) {
      const cols = Object.keys(row).map(ident).join(", ");
      const vals = Object.values(row).map(sqlLiteral).join(", ");
      parts.push(`INSERT INTO ${ident(table)} (${cols}) VALUES (${vals});`);
    }
  }
  return parts.join("\n") + "\n";
}

/**
 * Build the `.jsonl` bundle: a manifest line (schema) then one line per row.
 *
 * ponytail: single in-memory string, same size ceiling as {@link toSqlDump}.
 *
 * @param name - the database name (recorded in the manifest line)
 * @param uuid - the database uuid (recorded in the manifest line)
 * @param exportedAt - ISO timestamp of the export
 * @param schema - `{ name, sql }` entries from `sqlite_master`
 * @param tables - map of table name to its rows
 * @returns the newline-terminated JSONL (`{type:"manifest",...}` then `{type:"row",...}` per row)
 */
export function toJsonl(
  name: string,
  uuid: string,
  exportedAt: string,
  schema: SchemaEntry[],
  tables: Record<string, Record<string, unknown>[]>,
): string {
  const lines = [JSON.stringify({ type: "manifest", database: name, uuid, exportedAt, schema })];
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) lines.push(JSON.stringify({ type: "row", table, row }));
  }
  return lines.join("\n") + "\n";
}

/** The Python reconstruct script shipped alongside the JSONL bundle. */
function reconstructScript(dbName: string, tokenSecret: string): string {
  return `#!/usr/bin/env python3
"""Reconstruct the D1 database "${dbName}" from its Guardian JSONL archive.

Usage:
    python3 ${dbName}-reconstruct.py ${dbName}-archive.jsonl [new-database-name]

The archive is line-delimited: the first line is a manifest holding the schema,
each remaining line is one row. Cloudflare credentials are read from your local
tokens CLI at runtime — never stored in this script or the archive:
    tokens show ${tokenSecret} --value-only
    tokens show CLOUDFLARE_ACCOUNT_ID --value-only
"""
import json, subprocess, sys, urllib.request

def tok(name):
    return subprocess.check_output(["tokens", "show", name, "--value-only"]).decode().strip()

def api(account, token, path, body):
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{account}{path}",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)

def q(name):
    """Double-quote a SQLite identifier, escaping embedded quotes."""
    return '"' + name.replace('"', '""') + '"'

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "${dbName}-archive.jsonl"
    new_name = sys.argv[2] if len(sys.argv) > 2 else "${dbName}-restored"
    token, account = tok("${tokenSecret}"), tok("CLOUDFLARE_ACCOUNT_ID")

    schema, rows = [], []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec.get("type") == "manifest":
                schema = rec.get("schema", [])
            elif rec.get("type") == "row":
                rows.append((rec["table"], rec["row"]))

    created = api(account, token, "/d1/database", {"name": new_name})
    uuid = created["result"]["uuid"]
    print(f"created {new_name} ({uuid})")

    for stmt in schema:
        if stmt.get("sql"):
            api(account, token, f"/d1/database/{uuid}/query", {"sql": stmt["sql"]})
    print(f"applied {len(schema)} schema statements")

    for table, row in rows:
        cols = ",".join(q(c) for c in row.keys())
        placeholders = ",".join("?" for _ in row)
        api(account, token, f"/d1/database/{uuid}/query",
            {"sql": f"INSERT INTO {q(table)} ({cols}) VALUES ({placeholders})",
             "params": list(row.values())})
    print(f"restored {len(rows)} rows")
    print("done")

if __name__ == "__main__":
    main()
`;
}

export type D1ArchiveResult = {
  database: string;
  uuid: string;
  tables: number;
  rows: number;
  bytes: number;
  driveUrl: string;
  verified: boolean;
  actionItemId: string;
};

/**
 * Archive one D1 database to Drive and file a deletion action item.
 *
 * @param uuid - the D1 database uuid
 * @param name - the database name (for filenames + the action item)
 * @param tokenSecret - the tokens-CLI secret name the reconstruct script reads
 */
export async function archiveD1Database(
  env: Env,
  uuid: string,
  name: string,
  tokenSecret = "CLOUDFLARE_WRANGLER_API_TOKEN",
): Promise<D1ArchiveResult> {
  // 1) Schema (user tables only; skip sqlite internal + drizzle migration meta).
  const schemaRows = await d1Query<SchemaEntry>(
    env,
    uuid,
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  );

  // 2) Every table's rows.
  const tables: Record<string, Record<string, unknown>[]> = {};
  let rowCount = 0;
  for (const t of schemaRows) {
    const rows = await d1Query<Record<string, unknown>>(env, uuid, `SELECT * FROM ${ident(t.name)}`);
    tables[t.name] = rows;
    rowCount += rows.length;
  }

  const exportedAt = new Date().toISOString();
  const schema = schemaRows.map((t) => ({ name: t.name, sql: t.sql }));
  const jsonl = toJsonl(name, uuid, exportedAt, schema, tables);
  const sqlDump = toSqlDump(name, uuid, exportedAt, schema, tables);

  // 3) Upload all three deliverables to the auto-managed <worker>/d1-archive
  //    folder (find-or-create; no hardcoded ids).
  const nowSec = Date.now() / 1000;
  const { folderId } = await ensureArchiveFolder(env, workerName(env), "d1", nowSec);
  const stamp = exportedAt.slice(0, 10);
  // Independent files, same folder — upload concurrently. The JSONL result feeds
  // the byte-count audit below.
  const [upload] = await Promise.all([
    uploadToDrive(env, folderId, `${name}-${stamp}-archive.jsonl`, jsonl, "application/x-ndjson", nowSec),
    uploadToDrive(env, folderId, `${name}-${stamp}-archive.sql`, sqlDump, "application/sql", nowSec),
    uploadToDrive(
      env,
      folderId,
      `${name}-reconstruct.py`,
      reconstructScript(name, tokenSecret),
      "text/x-python",
      nowSec,
    ),
  ]);

  // 4) Audit: Drive's reported byte count for the JSONL (the reload source of
  //    record) must match what we sent.
  const expectedBytes = new TextEncoder().encode(jsonl).length;
  const audit = {
    driveFileId: upload.id,
    driveUrl: upload.url,
    sentBytes: expectedBytes,
    driveBytes: upload.bytes,
    bytesMatch: upload.bytes === expectedBytes,
    tables: schemaRows.length,
    rows: rowCount,
  };

  // 5) File the deletion action item (only meaningful if the audit passed).
  const actionItemId = await fileActionItem(env, {
    kind: "delete-source",
    service: "d1",
    resourceType: "d1-database",
    resourceId: uuid,
    resourceName: name,
    title: `Delete archived D1 database "${name}"`,
    description: audit.bytesMatch
      ? `Archived ${rowCount} rows across ${schemaRows.length} tables to Drive (${upload.bytes} bytes JSONL, verified). Approve to delete the source database.`
      : `Archive uploaded but the byte count did NOT match (sent ${expectedBytes}, Drive ${upload.bytes}). Do not delete until re-run.`,
    audit: JSON.stringify(audit),
    driveUrl: upload.url,
  });

  return {
    database: name,
    uuid,
    tables: schemaRows.length,
    rows: rowCount,
    bytes: expectedBytes,
    driveUrl: upload.url,
    verified: audit.bytesMatch,
    actionItemId,
  };
}
