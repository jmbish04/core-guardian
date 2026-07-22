/**
 * @fileoverview D1 database archive → Google Drive, with a reconstruct script.
 *
 * Reads an arbitrary D1 database over the REST query API (so it works for any
 * database on the account, not just this worker's binding), serializes its
 * schema + every table's rows into one JSON bundle, generates a self-contained
 * Python reconstruct script, uploads both to the configured Drive folder, audits
 * that Drive received the full bytes, and files a human-gated action item to
 * delete the source.
 *
 * ponytail: one JSON bundle keyed by table name, not one file per table + a zip
 * dependency — identical data, far less machinery. The reconstruct script pulls
 * Cloudflare creds via `tokens show <SECRET> --value-only`, never embedding them.
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

/** The Python reconstruct script shipped alongside the JSON bundle. */
function reconstructScript(dbName: string, tokenSecret: string): string {
  return `#!/usr/bin/env python3
"""Reconstruct the D1 database "${dbName}" from its Guardian JSON archive.

Usage:
    python3 reconstruct.py ${dbName}-archive.json [new-database-name]

Cloudflare credentials are read from your local tokens CLI at runtime — never
stored in this script or the archive:
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

def main():
    archive = sys.argv[1] if len(sys.argv) > 1 else "${dbName}-archive.json"
    new_name = sys.argv[2] if len(sys.argv) > 2 else "${dbName}-restored"
    data = json.load(open(archive))
    token, account = tok("${tokenSecret}"), tok("CLOUDFLARE_ACCOUNT_ID")

    created = api(account, token, "/d1/database", {"name": new_name})
    uuid = created["result"]["uuid"]
    print(f"created {new_name} ({uuid})")

    for stmt in data["schema"]:
        if stmt["sql"]:
            api(account, token, f"/d1/database/{uuid}/query", {"sql": stmt["sql"]})
    print(f"applied {len(data['schema'])} schema statements")

    for table, rows in data["tables"].items():
        for row in rows:
            cols = ",".join(row.keys())
            placeholders = ",".join("?" for _ in row)
            api(account, token, f"/d1/database/{uuid}/query",
                {"sql": f"INSERT INTO {table} ({cols}) VALUES ({placeholders})",
                 "params": list(row.values())})
        print(f"restored {len(rows)} rows into {table}")
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
  const schemaRows = await d1Query<{ name: string; sql: string | null }>(
    env,
    uuid,
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  );

  // 2) Every table's rows.
  const tables: Record<string, unknown[]> = {};
  let rowCount = 0;
  for (const t of schemaRows) {
    const rows = await d1Query(env, uuid, `SELECT * FROM "${t.name}"`);
    tables[t.name] = rows;
    rowCount += rows.length;
  }

  const bundle = {
    database: name,
    uuid,
    exportedAt: new Date().toISOString(),
    schema: schemaRows.map((t) => ({ name: t.name, sql: t.sql })),
    tables,
  };
  const bundleJson = JSON.stringify(bundle, null, 2);

  // 3) Upload the bundle + the reconstruct script to the auto-managed
  //    <worker>/d1-archive folder (find-or-create; no hardcoded ids).
  const nowSec = Date.now() / 1000;
  const { folderId } = await ensureArchiveFolder(env, workerName(env), "d1", nowSec);
  const stamp = new Date().toISOString().slice(0, 10);
  const upload = await uploadToDrive(
    env,
    folderId,
    `${name}-${stamp}-archive.json`,
    bundleJson,
    "application/json",
    nowSec,
  );
  await uploadToDrive(
    env,
    folderId,
    `${name}-reconstruct.py`,
    reconstructScript(name, tokenSecret),
    "text/x-python",
    nowSec,
  );

  // 4) Audit: Drive's reported byte count must match what we sent.
  const expectedBytes = new TextEncoder().encode(bundleJson).length;
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
      ? `Archived ${rowCount} rows across ${schemaRows.length} tables to Drive (${upload.bytes} bytes, verified). Approve to delete the source database.`
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
    actionItemId,
  };
}
