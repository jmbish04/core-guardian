/**
 * @fileoverview Google Drive access via a service-account JWT — no SDK.
 *
 * Mints an RS256 JWT signed with the service-account private key (split across
 * two Secrets Store bindings), exchanges it for an OAuth access token, and wraps
 * the couple of Drive REST calls Guardian needs: read a folder's metadata (to
 * validate the SA can actually see a folder before we save it) and, for the R2
 * archive, resumable/multipart upload of a file into a folder.
 *
 * WebCrypto (`crypto.subtle`) does the RS256 signing, so there is no dependency
 * and it runs inside the Worker.
 *
 * @see {@link file://src/backend/api/routes/drive-config.ts} for the validate/save flow.
 */

import { getSecret, getSecretStoreBinding } from "@/backend/utils/secrets";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/**
 * The Workspace user the service account impersonates via domain-wide
 * delegation. Impersonation (rather than acting as the SA itself) is what lets
 * archives land in a normal My Drive folder — service accounts have no My Drive
 * quota of their own. Override with the GOOGLE_IMPERSONATE_SUBJECT var.
 */
function impersonateSubject(env: Env): string {
  return getSecret(env, "GOOGLE_IMPERSONATE_SUBJECT") || "justin@126colby.com";
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

/** Resolve the SA private key (two-part) and client email from the env. */
async function serviceAccount(env: Env): Promise<{ email: string; pem: string }> {
  const [p1, p2, email] = await Promise.all([
    getSecretStoreBinding(env, "GOOGLE_CREDS_SA_PRIVATE_KEY_PT_1").then(
      (v) => v ?? getSecret(env, "GOOGLE_CREDS_SA_PRIVATE_KEY_PT_1"),
    ),
    getSecretStoreBinding(env, "GOOGLE_CREDS_SA_PRIVATE_KEY_PT_2").then(
      (v) => v ?? getSecret(env, "GOOGLE_CREDS_SA_PRIVATE_KEY_PT_2"),
    ),
    getSecretStoreBinding(env, "GOOGLE_CREDS_SA_CLIENT_EMAIL").then(
      (v) => v ?? getSecret(env, "GOOGLE_CREDS_SA_CLIENT_EMAIL"),
    ),
  ]);
  if (!p1 || !email) throw new Error("Google service-account credentials are not configured.");
  // The private key is split to fit Secrets Store limits; concatenate and
  // normalize escaped newlines back to real ones.
  const pem = `${p1}${p2 ?? ""}`.replace(/\\n/g, "\n");
  return { email, pem };
}

/** Import a PKCS#8 PEM private key for RS256 signing. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Exchange a signed SA JWT for a Drive access token.
 *
 * @param nowSec - current time in seconds (passed in so callers stay testable /
 *   deterministic; the Worker passes `Date.now()/1000`)
 */
export async function getDriveAccessToken(env: Env, nowSec: number): Promise<string> {
  const { email, pem } = await serviceAccount(env);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email,
    // Domain-wide delegation: act AS this Workspace user, so uploads land in a
    // real My Drive with real quota rather than the SA's (non-existent) quota.
    sub: impersonateSubject(env),
    scope: DRIVE_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: Math.floor(nowSec),
    exp: Math.floor(nowSec) + 3600,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claim)}`;
  const key = await importPrivateKey(pem);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const assertion = `${signingInput}.${b64url(sig)}`;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Google token exchange failed: ${json.error_description ?? res.status}`);
  }
  return json.access_token;
}

export type DriveFolder = {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
};

/**
 * Read a folder/file's metadata as the service account. Returns null when the
 * SA cannot see it (404/403) — the caller treats that as "not accessible".
 */
export async function getDriveFolder(
  env: Env,
  folderId: string,
  nowSec: number,
): Promise<DriveFolder | null> {
  const token = await getDriveAccessToken(env, nowSec);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const f = (await res.json()) as { id: string; name: string; mimeType: string };
  return { id: f.id, name: f.name, mimeType: f.mimeType, isFolder: f.mimeType === "application/vnd.google-apps.folder" };
}

export type SharedDrive = { id: string; name: string };
export type DriveChild = { id: string; name: string; isFolder: boolean };

/** List the Shared Drives the service account is a member of. */
export async function listSharedDrives(env: Env, nowSec: number): Promise<SharedDrive[]> {
  const token = await getDriveAccessToken(env, nowSec);
  const res = await fetch("https://www.googleapis.com/drive/v3/drives?pageSize=100", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { drives?: { id: string; name: string }[] };
  return (json.drives ?? []).map((d) => ({ id: d.id, name: d.name }));
}

/**
 * List folders/files directly under a Drive or folder. Pass a Shared Drive id
 * (or any folder id) as `parentId`; works across Shared Drives.
 */
export async function listDriveChildren(
  env: Env,
  parentId: string,
  nowSec: number,
): Promise<DriveChild[]> {
  const token = await getDriveAccessToken(env, nowSec);
  const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  const json = (await res.json()) as { files?: { id: string; name: string; mimeType: string }[] };
  return (json.files ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    isFolder: f.mimeType === "application/vnd.google-apps.folder",
  }));
}

/** Create a folder (optionally under a parent; null parent = the user's root). */
export async function createDriveFolder(
  env: Env,
  parentId: string | null,
  name: string,
  nowSec: number,
): Promise<string> {
  const token = await getDriveAccessToken(env, nowSec);
  const body: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
  if (parentId) body.parents = [parentId];
  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !json.id) throw new Error(`Create folder failed: ${json.error?.message ?? res.status}`);
  return json.id;
}

/**
 * Find a folder by name that the impersonated user can see (owned OR shared with
 * them), optionally under a specific parent. Returns the first match id or null.
 */
export async function findFolder(
  env: Env,
  name: string,
  parentId: string | null,
  nowSec: number,
): Promise<string | null> {
  const token = await getDriveAccessToken(env, nowSec);
  const esc = name.replace(/'/g, "\\'");
  const clauses = [`name = '${esc}'`, `mimeType = '${FOLDER_MIME}'`, "trashed = false"];
  if (parentId) clauses.push(`'${parentId}' in parents`);
  const q = encodeURIComponent(clauses.join(" and "));
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=10`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { files?: { id: string }[] };
  return json.files?.[0]?.id ?? null;
}

/** Find a folder by name (owned or shared), creating it if absent. */
export async function findOrCreateFolder(
  env: Env,
  name: string,
  parentId: string | null,
  nowSec: number,
): Promise<string> {
  const existing = await findFolder(env, name, parentId, nowSec);
  return existing ?? (await createDriveFolder(env, parentId, name, nowSec));
}

/**
 * Resolve (find-or-create) the archive destination for one purpose:
 *   <workerName>/<purpose>-archive
 * The worker-named parent may be owned by the user or merely shared with them
 * (e.g. a folder shared from a personal account with lots of quota); either way
 * we reuse it, and only create what is missing. No hardcoded folder ids, no
 * operator setup — the system manages its own Drive tree.
 *
 * @param workerName - the current worker's name (drives the parent folder name)
 * @param purpose - r2 | d1 | cf-image | …
 */
export async function ensureArchiveFolder(
  env: Env,
  workerName: string,
  purpose: string,
  nowSec: number,
): Promise<{ parentId: string; folderId: string }> {
  const parentId = await findOrCreateFolder(env, workerName, null, nowSec);
  const folderId = await findOrCreateFolder(env, `${purpose}-archive`, parentId, nowSec);
  return { parentId, folderId };
}

export type DriveUpload = { id: string; url: string; bytes: number; name: string };

/**
 * Upload a file into a Drive folder via multipart/related, then read it back to
 * confirm the byte count landed — the caller uses that as the archive audit.
 *
 * @param content - the file bytes (string is UTF-8 encoded)
 */
export async function uploadToDrive(
  env: Env,
  folderId: string,
  filename: string,
  content: string | Uint8Array,
  mimeType: string,
  nowSec: number,
): Promise<DriveUpload> {
  const token = await getDriveAccessToken(env, nowSec);
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;

  const boundary = `guardian-${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    size?: string;
    error?: { message?: string };
  };
  if (!res.ok || !json.id) {
    throw new Error(`Drive upload failed: ${json.error?.message ?? res.status}`);
  }
  return {
    id: json.id,
    name: json.name ?? filename,
    bytes: json.size ? Number(json.size) : bytes.length,
    url: `https://drive.google.com/file/d/${json.id}/view`,
  };
}

/**
 * Extract a Drive folder/file id from a pasted URL or a bare id.
 *
 * Handles /folders/<id>, /d/<id>, ?id=<id>, and a raw id. Returns null if
 * nothing id-shaped is present.
 */
export function extractDriveId(input: string): string | null {
  const s = input.trim();
  const patterns = [/\/folders\/([a-zA-Z0-9_-]+)/, /\/d\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  // Bare id: Drive ids are ~25-44 chars of [A-Za-z0-9_-].
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  return null;
}
