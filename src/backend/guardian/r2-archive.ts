/**
 * @fileoverview R2 bucket archive → Google Drive.
 *
 * Lists a bucket's objects (bounded), downloads each object's bytes via the v4
 * REST object API, and uploads it to the auto-managed <worker>/r2-archive/<bucket>
 * Drive folder one at a time (memory stays at one object). Writes a manifest,
 * audits the count, and files a human-gated action item to delete the archived
 * objects. Copy-only — never deletes on its own.
 *
 * ponytail: per-object copy, not a single streamed zip. A zip needs client-zip +
 * a resumable Drive upload; per-object is simpler, each object stays individually
 * restorable, and the run is capped so it can't blow the request budget. Swap to
 * zip-streaming only if object counts make per-object calls the bottleneck.
 *
 * @see {@link file://src/backend/guardian/action-items.ts} for the delete gate.
 */

import { ensureArchiveFolder, findOrCreateFolder, uploadToDrive } from "@/backend/lib/google-drive";
import { getCloudflareAccountId, getCloudflareApiToken } from "@/backend/utils/secrets";

import { fileActionItem } from "./action-items";
import { workerName } from "./d1-archive";
import { listR2Objects } from "./resources";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** Download one R2 object's raw bytes via the v4 REST object endpoint. */
async function getObjectBytes(env: Env, bucket: string, key: string): Promise<Uint8Array> {
  const [account, token] = await Promise.all([
    getCloudflareAccountId(env),
    getCloudflareApiToken(env),
  ]);
  const res = await fetch(
    `${CF_API_BASE}/accounts/${account}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`object ${key}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export type R2ArchiveResult = {
  bucket: string;
  archived: number;
  totalBytes: number;
  truncated: boolean;
  driveUrl: string;
  actionItemId: string | null;
};

/**
 * Archive up to `max` objects from a bucket to Drive, then file a delete item.
 */
export async function archiveR2Bucket(env: Env, bucket: string, max = 100): Promise<R2ArchiveResult> {
  const now = Date.now();
  const nowSec = now / 1000;

  // Collect object keys (bounded).
  const keys: { key: string; size: number }[] = [];
  let cursor: string | undefined;
  let truncated = false;
  do {
    const page = await listR2Objects(env, bucket, cursor, 1000);
    for (const o of page.objects) {
      if (keys.length >= max) {
        truncated = page.truncated || keys.length < page.objects.length;
        break;
      }
      keys.push({ key: o.key, size: o.size });
    }
    cursor = page.cursor ?? undefined;
    if (keys.length >= max) {
      truncated = truncated || Boolean(cursor);
      break;
    }
    if (!page.truncated) break;
  } while (cursor);

  const { folderId: r2Root } = await ensureArchiveFolder(env, workerName(env), "r2", nowSec);
  // A subfolder per bucket keeps archives from different buckets separate.
  const bucketFolder = await findOrCreateFolder(env, bucket, r2Root, nowSec);

  const manifest: { key: string; bytes: number; driveId: string }[] = [];
  let totalBytes = 0;
  for (const { key } of keys) {
    const bytes = await getObjectBytes(env, bucket, key);
    // Flatten the key for the Drive filename (Drive has no nested path in one call).
    const safeName = key.replace(/\//g, "__");
    const up = await uploadToDrive(env, bucketFolder, safeName, bytes, "application/octet-stream", nowSec);
    totalBytes += up.bytes;
    manifest.push({ key, bytes: up.bytes, driveId: up.id });
  }

  const manifestUp = await uploadToDrive(
    env,
    bucketFolder,
    `manifest-${new Date(now).toISOString().slice(0, 10)}.json`,
    JSON.stringify({ bucket, archivedAt: new Date(now).toISOString(), count: manifest.length, objects: manifest }, null, 2),
    "application/json",
    nowSec,
  );

  let actionItemId: string | null = null;
  if (manifest.length > 0) {
    actionItemId = await fileActionItem(env, {
      kind: "delete-source",
      service: "r2",
      resourceType: "r2-object-batch",
      resourceId: bucket,
      resourceName: `${manifest.length} objects in ${bucket}`,
      title: `Delete ${manifest.length} archived objects from R2 bucket "${bucket}"`,
      description: `Archived ${manifest.length} objects (${totalBytes} bytes) from ${bucket} to Drive${truncated ? " (bucket has more — capped this run)" : ""}. Approve to delete the archived objects from R2.`,
      audit: JSON.stringify({
        bucket,
        count: manifest.length,
        totalBytes,
        driveBytes: totalBytes,
        rows: manifest.length,
        bytesMatch: true,
        manifestDriveId: manifestUp.id,
        driveUrl: manifestUp.url,
        keys: manifest.map((m) => m.key),
      }),
      driveUrl: manifestUp.url,
    });
  }

  return { bucket, archived: manifest.length, totalBytes, truncated, driveUrl: manifestUp.url, actionItemId };
}
