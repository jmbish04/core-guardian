/**
 * @fileoverview Client for the google-workspace-mcp Worker — Google Drive via a
 * shared service instead of this worker's own service-account uploads.
 *
 * Why: the direct service-account path can't write to My Drive (no quota) and
 * needs a Shared Drive. The workspace worker delegates to a real user's OAuth
 * (`as_user`), so archives land in that user's Drive with their quota.
 *
 * Auth: `Authorization: Bearer <token>` — a dedicated `GOOGLE_WORKSPACE_MCP_TOKEN`
 * Secret Store binding if present, else this worker's `WORKER_API_KEY` (the value
 * the user pointed us at). Base URL is the constant below, overridable by a
 * `GOOGLE_WORKSPACE_MCP_URL` var; the delegated user by `GUARDIAN_DRIVE_AS_USER`.
 *
 * Responses are MCP tool results: `{ content:[{type:"text",text}], isError? }`,
 * or a flat `{ id, url, content }`, or a raw string body. `pickStr`/`mcpText`
 * dig all of these, and an `isError:true` (returned with HTTP 200) is thrown.
 */

import { getSecret, getSecretStoreBinding, getWorkerApiKey } from "@/backend/utils/secrets";

const DEFAULT_BASE = "https://google-workspace-mcp.hacolby.workers.dev";
const TIMEOUT_MS = 30_000;

/** An MCP `isError:true` result (returned with a 200, so `res.ok` misses it). */
function isErr(raw: unknown): boolean {
  return !!(raw && typeof raw === "object" && (raw as { isError?: unknown }).isError);
}

/** The joined text of an MCP `content:[{text}]` payload, or undefined. */
function mcpText(raw: unknown): string | undefined {
  const c = (raw as { content?: unknown })?.content;
  if (!Array.isArray(c)) return undefined;
  const t = c.map((x) => (x as { text?: string })?.text ?? "").join("");
  return t || undefined;
}

/** First STRING value among `keys` — top-level, one wrap down, or inside an MCP
 *  text payload that is itself JSON. Type-guarded: an array/object under a key
 *  (e.g. the MCP `content` array) is skipped, never returned cast as a string. */
function pickStr(raw: unknown, keys: string[]): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === "string") return o[k] as string;
  for (const w of ["result", "data", "file"]) {
    const hit = pickStr(o[w], keys);
    if (hit !== undefined) return hit;
  }
  const t = mcpText(raw);
  if (t) {
    try {
      return pickStr(JSON.parse(t), keys);
    } catch {
      /* MCP text is the raw body, not JSON */
    }
  }
  return undefined;
}

/** POST one MCP tool with Bearer auth; returns the parsed body (JSON or string). */
async function wsCall(env: Env, tool: string, body: Record<string, unknown>): Promise<unknown> {
  const key =
    (await getSecretStoreBinding(env, "GOOGLE_WORKSPACE_MCP_TOKEN")) ??
    getSecret(env, "GOOGLE_WORKSPACE_MCP_TOKEN") ??
    (await getWorkerApiKey(env));
  if (!key) throw new Error("Missing WORKER_API_KEY / GOOGLE_WORKSPACE_MCP_TOKEN for the workspace client");
  const base = (getSecret(env, "GOOGLE_WORKSPACE_MCP_URL") ?? DEFAULT_BASE).replace(/\/+$/, "");
  const res = await fetch(`${base}/api/tools/${tool}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`workspace ${tool} ${res.status}: ${text.slice(0, 300)}`);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* raw string body */
  }
  if (isErr(parsed)) throw new Error(`workspace ${tool} error: ${mcpText(parsed) ?? text.slice(0, 300)}`);
  return parsed;
}

/** The delegated Google user for `as_user`, when configured. */
function asUser(env: Env): Record<string, string> {
  const u = getSecret(env, "GUARDIAN_DRIVE_AS_USER");
  return u ? { as_user: u } : {};
}

/** Base64-encode bytes (chunked to stay within the argument-count limit). */
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Decode a base64 string to bytes (latin1 round-trip is byte-exact). */
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type WsUpload = { id: string; name: string; url: string; folderId?: string };

/** Upload a file into Drive by folderPath (worker creates the path) or folderId. */
export async function wsUploadFile(
  env: Env,
  opts: { name: string; mimeType: string; content: string | Uint8Array; folderPath?: string; folderId?: string },
): Promise<WsUpload> {
  const bytes = typeof opts.content === "string" ? new TextEncoder().encode(opts.content) : opts.content;
  const raw = await wsCall(env, "drive_upload_file", {
    name: opts.name,
    mimeType: opts.mimeType,
    contentBase64: toBase64(bytes),
    ...(opts.folderPath ? { folderPath: opts.folderPath } : {}),
    ...(opts.folderId ? { folderId: opts.folderId } : {}),
    ...asUser(env),
  });
  const id = pickStr(raw, ["id", "fileId"]);
  if (!id) throw new Error(`workspace upload returned no file id: ${JSON.stringify(raw).slice(0, 200)}`);
  return {
    id,
    name: pickStr(raw, ["name"]) ?? opts.name,
    url: pickStr(raw, ["url", "webViewLink"]) ?? "",
    folderId: pickStr(raw, ["folderId"]),
  };
}

/** Read a Drive file's content back (the archive verify-by-redownload step).
 *  Returns the exact text uploaded — decodes `contentBase64` if the worker
 *  echoes its own encoding, so `verifyD1Archive`'s byte/hash/count still hold. */
export async function wsDownloadFile(env: Env, fileId: string): Promise<string> {
  const raw = await wsCall(env, "download_file_content", { fileId, ...asUser(env) });
  if (typeof raw === "string") return raw;
  const b64 = pickStr(raw, ["contentBase64", "dataBase64"]);
  if (b64) return new TextDecoder().decode(fromBase64(b64));
  const s = pickStr(raw, ["content", "text", "body"]) ?? mcpText(raw);
  if (s === undefined) throw new Error(`workspace download returned no content: ${JSON.stringify(raw).slice(0, 200)}`);
  return s;
}
