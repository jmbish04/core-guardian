/**
 * @fileoverview Client for the google-workspace-mcp Worker — Google Drive via a
 * shared service instead of this worker's own service-account uploads.
 *
 * Why: the direct service-account path can't write to My Drive (no quota) and
 * needs a Shared Drive. The workspace worker delegates to a real user's OAuth
 * (`as_user`), so archives land in that user's Drive with their quota.
 *
 * Auth: `Authorization: Bearer <WORKER_API_KEY>` (the same Secret Store binding
 * this worker already carries). Base URL is the constant below, overridable by a
 * `GOOGLE_WORKSPACE_MCP_URL` var; the delegated user by `GUARDIAN_DRIVE_AS_USER`.
 *
 * The tool responses are JSON; their exact envelope is dug for defensively
 * (`dig`) so a top-level or nested `{ id, url, content }` both work.
 */

import { getSecret, getWorkerApiKey } from "@/backend/utils/secrets";

const DEFAULT_BASE = "https://google-workspace-mcp.hacolby.workers.dev";

/** POST one MCP tool with Bearer auth; returns the parsed JSON body. */
async function wsCall(env: Env, tool: string, body: Record<string, unknown>): Promise<unknown> {
  const key = await getWorkerApiKey(env);
  if (!key) throw new Error("Missing WORKER_API_KEY for the workspace client");
  const base = (getSecret(env, "GOOGLE_WORKSPACE_MCP_URL") ?? DEFAULT_BASE).replace(/\/+$/, "");
  const res = await fetch(`${base}/api/tools/${tool}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`workspace ${tool} ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The delegated Google user for `as_user`, when configured. */
function asUser(env: Env): Record<string, string> {
  const u = getSecret(env, "GUARDIAN_DRIVE_AS_USER");
  return u ? { as_user: u } : {};
}

/** Find the first value for any of `keys`, at the top level or one nesting down
 *  (MCP tool results sometimes wrap the payload in `result`/`data`/`content`). */
function dig<T = unknown>(obj: unknown, keys: string[]): T | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) if (o[k] !== undefined) return o[k] as T;
  for (const wrap of ["result", "data", "content", "file", "tool_result"]) {
    const inner = o[wrap];
    if (inner && typeof inner === "object") {
      const hit = dig<T>(inner, keys);
      if (hit !== undefined) return hit;
    }
    // MCP content arrays: [{ type:"text", text:"<json>" }]
    if (Array.isArray(inner)) {
      for (const item of inner) {
        const t = (item as { text?: string })?.text;
        if (typeof t === "string") {
          try {
            const hit = dig<T>(JSON.parse(t), keys);
            if (hit !== undefined) return hit;
          } catch {
            /* not json */
          }
        }
      }
    }
  }
  return undefined;
}

/** Base64-encode bytes (chunked to avoid a huge spread into fromCharCode). */
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
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
  const id = dig<string>(raw, ["id", "fileId"]);
  if (!id) throw new Error(`workspace upload returned no file id: ${JSON.stringify(raw).slice(0, 200)}`);
  return {
    id,
    name: dig<string>(raw, ["name"]) ?? opts.name,
    url: dig<string>(raw, ["url", "webViewLink"]) ?? "",
    folderId: dig<string>(raw, ["folderId"]),
  };
}

/** Read a Drive file's raw content back (the archive verify-by-redownload step). */
export async function wsDownloadFile(env: Env, fileId: string): Promise<string> {
  const raw = await wsCall(env, "download_file_content", { fileId, ...asUser(env) });
  const content = dig<string>(raw, ["content", "text", "body"]);
  if (content == null) throw new Error(`workspace download returned no content: ${JSON.stringify(raw).slice(0, 200)}`);
  return content;
}
