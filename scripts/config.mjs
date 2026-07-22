/**
 * @fileoverview Shared configuration + secret access for the `scripts/` tooling.
 *
 * Node-side mirror of `src/backend/utils/secrets.ts`. Backend code reads
 * secrets from Secrets Store bindings; scripts read the same secret names from
 * the local `tokens` CLI, so a script and the Worker resolve identical values.
 *
 * @example
 * ```js
 * import { API_BASE, getSecretStoreBinding, cfFetch } from "./config.mjs";
 *
 * const token = await getSecretStoreBinding("CLOUDFLARE_WRANGLER_API_TOKEN");
 * const res = await cfFetch("/r2/buckets");
 * ```
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Public origin of the deployed Worker. Mirrors the `WORKER_BASE_URL` var in
 * `wrangler.jsonc` — keep the two in sync.
 */
export const API_BASE = process.env.WORKER_BASE_URL ?? "https://core-guardian.hacolby.workers.dev";

/** Cloudflare REST API root. */
export const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** Cloudflare GraphQL Analytics endpoint. */
export const CF_GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** Cache so repeated lookups in one script do not re-shell out. */
const cache = new Map();

/**
 * Reads a secret by the same binding name the Worker uses, via `tokens show`.
 *
 * @param {string} name - Secret name (e.g. `CLOUDFLARE_WRANGLER_API_TOKEN`)
 * @returns {Promise<string|undefined>} The secret value, or `undefined` if unset
 */
export async function getSecretStoreBinding(name) {
  if (cache.has(name)) return cache.get(name);
  try {
    const { stdout } = await run("tokens", ["show", name, "--value-only"]);
    const value = stdout.trim() || undefined;
    cache.set(name, value);
    return value;
  } catch {
    cache.set(name, undefined);
    return undefined;
  }
}

/**
 * Reads a plain environment variable (the local-dev fallback path).
 *
 * @param {string} name - Env var name
 * @returns {string|undefined}
 */
export function getSecret(name) {
  const value = process.env[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Resolves a secret: `tokens` CLI first, plain env var as fallback.
 *
 * @param {string} name - Secret name
 * @returns {Promise<string|undefined>}
 */
export async function resolveSecret(name) {
  return (await getSecretStoreBinding(name)) ?? getSecret(name);
}

/** Convenience accessors for the credentials every script needs. */
export const getCloudflareAccountId = () => resolveSecret("CLOUDFLARE_ACCOUNT_ID");
export const getCloudflareApiToken = () => resolveSecret("CLOUDFLARE_WRANGLER_API_TOKEN");
export const getWorkerApiKey = () => resolveSecret("WORKER_API_KEY");

/**
 * Calls the Cloudflare REST API, account-scoped.
 *
 * @param {string} path - Path under `/accounts/{account_id}` (e.g. `/r2/buckets`)
 * @param {RequestInit} [init] - Fetch init; `Authorization` is injected
 * @returns {Promise<any>} Parsed Cloudflare envelope
 * @throws {Error} On missing credentials or a non-success envelope
 */
export async function cfFetch(path, init = {}) {
  const [accountId, token] = await Promise.all([getCloudflareAccountId(), getCloudflareApiToken()]);
  if (!accountId || !token) {
    throw new Error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_WRANGLER_API_TOKEN.");
  }

  const res = await fetch(`${CF_API_BASE}/accounts/${accountId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const detail = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API error: ${detail}`);
  }
  return body;
}

/**
 * Runs a GraphQL document against the Cloudflare Analytics API.
 *
 * @param {string} query - GraphQL document
 * @param {Record<string, unknown>} [variables] - Variables; `accountTag` injected
 * @returns {Promise<any>} The `data` object
 * @throws {Error} On missing credentials or GraphQL errors
 */
export async function cfGraphQL(query, variables = {}) {
  const [accountId, token] = await Promise.all([getCloudflareAccountId(), getCloudflareApiToken()]);
  if (!accountId || !token) {
    throw new Error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_WRANGLER_API_TOKEN.");
  }

  const res = await fetch(CF_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { accountTag: accountId, ...variables } }),
  });
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  return body.data;
}

/**
 * Calls this Worker's own API with the WORKER_API_KEY bearer token.
 *
 * @param {string} path - Path under the Worker origin (e.g. `/api/guardian/usage`)
 * @param {RequestInit} [init] - Fetch init
 * @returns {Promise<any>} Parsed JSON response
 */
export async function workerFetch(path, init = {}) {
  const key = await getWorkerApiKey();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return body;
}
