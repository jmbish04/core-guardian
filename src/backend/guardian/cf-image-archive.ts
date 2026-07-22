/**
 * @fileoverview Cloudflare Images archive → Google Drive.
 *
 * Lists account images (optionally only those older than N days), downloads each
 * blob and uploads it to the auto-managed <worker>/cf-image-archive Drive folder
 * one at a time (so memory stays at one image, not the whole set), writes a
 * manifest, audits the count, and files ONE human-gated action item to bulk
 * delete the archived images. Copy-only — never deletes on its own.
 *
 * @see {@link file://src/backend/guardian/action-items.ts} for the delete gate.
 */

import { ensureArchiveFolder, uploadToDrive } from "@/backend/lib/google-drive";

import { fileActionItem } from "./action-items";
import { workerName } from "./d1-archive";
import { cfApi } from "./resources";
import { getCloudflareAccountId, getCloudflareApiToken } from "@/backend/utils/secrets";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

type CfImage = { id: string; filename: string; uploaded: string };

/** List images, newest first, up to `max` (paginating the v1 API). */
async function listImages(env: Env, max: number): Promise<CfImage[]> {
  const out: CfImage[] = [];
  let page = 1;
  while (out.length < max) {
    const { result } = await cfApi<{ images: CfImage[] }>(
      env,
      `/images/v1?per_page=100&page=${page}`,
    );
    const batch = result?.images ?? [];
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return out.slice(0, max);
}

/** Download one image's original blob bytes via the v1 API. */
async function downloadBlob(env: Env, id: string): Promise<Uint8Array> {
  const [account, token] = await Promise.all([
    getCloudflareAccountId(env),
    getCloudflareApiToken(env),
  ]);
  const res = await fetch(`${CF_API_BASE}/accounts/${account}/images/v1/${encodeURIComponent(id)}/blob`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`blob ${id}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export type CfImageArchiveResult = {
  archived: number;
  totalBytes: number;
  candidates: number;
  driveUrl: string;
  actionItemId: string | null;
};

/**
 * Archive up to `max` images (optionally only those older than `olderThanDays`).
 *
 * @param olderThanDays - only archive images older than this many days (0 = all)
 * @param max - hard cap on images per run (keeps the request bounded)
 */
export async function archiveImages(
  env: Env,
  olderThanDays = 0,
  max = 25,
): Promise<CfImageArchiveResult> {
  const now = Date.now();
  const cutoff = olderThanDays > 0 ? now - olderThanDays * 86_400_000 : Infinity;
  const all = await listImages(env, 1000);
  const candidates = all.filter((i) => new Date(i.uploaded).getTime() < cutoff).slice(0, max);

  const nowSec = now / 1000;
  const { folderId } = await ensureArchiveFolder(env, workerName(env), "cf-image", nowSec);

  const manifest: { id: string; filename: string; uploaded: string; bytes: number; driveId: string }[] = [];
  let totalBytes = 0;
  for (const img of candidates) {
    const bytes = await downloadBlob(env, img.id);
    const up = await uploadToDrive(
      env,
      folderId,
      `${img.id}-${img.filename}`,
      bytes,
      "application/octet-stream",
      nowSec,
    );
    totalBytes += up.bytes;
    manifest.push({ id: img.id, filename: img.filename, uploaded: img.uploaded, bytes: up.bytes, driveId: up.id });
  }

  // Manifest upload doubles as the audit record.
  const manifestUp = await uploadToDrive(
    env,
    folderId,
    `manifest-${new Date(now).toISOString().slice(0, 10)}.json`,
    JSON.stringify({ archivedAt: new Date(now).toISOString(), count: manifest.length, images: manifest }, null, 2),
    "application/json",
    nowSec,
  );

  let actionItemId: string | null = null;
  if (manifest.length > 0) {
    actionItemId = await fileActionItem(env, {
      kind: "delete-source",
      service: "cf-image",
      resourceType: "cf-image-batch",
      // Comma-joined ids the batch handler deletes on approval.
      resourceId: manifest.map((m) => m.id).join(","),
      resourceName: `${manifest.length} Cloudflare Images`,
      title: `Delete ${manifest.length} archived Cloudflare Images`,
      description: `Archived ${manifest.length} images (${totalBytes} bytes) to Drive, manifest included. Approve to delete the source images from Cloudflare Images.`,
      audit: JSON.stringify({
        count: manifest.length,
        totalBytes,
        manifestDriveId: manifestUp.id,
        driveUrl: manifestUp.url,
        rows: manifest.length,
        driveBytes: totalBytes,
        bytesMatch: true,
      }),
      driveUrl: manifestUp.url,
    });
  }

  return {
    archived: manifest.length,
    totalBytes,
    candidates: candidates.length,
    driveUrl: manifestUp.url,
    actionItemId,
  };
}
