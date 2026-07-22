/**
 * @fileoverview Secret + signing-key helpers for the template.
 *
 * Two primitives sit at the bottom of this module:
 *  - {@link getSecretStoreBinding} — reads a Secrets Store binding (async `.get()`)
 *  - {@link getSecret} — reads a plain env var / `vars` entry (sync)
 *
 * Every named accessor below is `getSecretStoreBinding(...) ?? getSecret(...)`:
 * Secrets Store wins, plain env vars are the local-dev fallback. Bindings are
 * declared in `wrangler.jsonc` under `secrets_store_secrets`.
 */

/**
 * Reads a Secrets Store binding by name.
 *
 * @param env - Worker env carrying the Secrets Store bindings
 * @param binding - Binding name as declared in `wrangler.jsonc` (e.g. `CLOUDFLARE_ACCOUNT_ID`)
 * @returns The secret value, or `undefined` when the binding is absent or is
 *   not a Secrets Store binding (e.g. a plain string in local dev)
 *
 * @example
 * ```typescript
 * const token = await getSecretStoreBinding(env, "CLOUDFLARE_WRANGLER_API_TOKEN");
 * ```
 */
export async function getSecretStoreBinding(
  env: Env,
  binding: string,
): Promise<string | undefined> {
  const value = (env as Record<string, any>)[binding];
  if (value && typeof value.get === "function") {
    return await value.get();
  }
  return undefined;
}

/**
 * Reads a plain env var / `vars` entry by name (no Secrets Store round-trip).
 *
 * @param env - Worker env
 * @param binding - Env var name
 * @returns The string value, or `undefined` when unset or not a string
 *
 * @example
 * ```typescript
 * const accountId = getSecret(env, "CLOUDFLARE_ACCOUNT_ID");
 * ```
 */
export function getSecret(env: Env, binding: string): string | undefined {
  const value = (env as Record<string, any>)[binding];
  return typeof value === "string" ? value : undefined;
}

/**
 * Fetch the WORKER_API_KEY (used for the single-user login + GitHub webhook
 * signature verification).
 */
export async function getWorkerApiKey(env: Env): Promise<string | undefined> {
  return (await getSecretStoreBinding(env, "WORKER_API_KEY")) ?? getSecret(env, "WORKER_API_KEY");
}

/** Fetch the Cloudflare API token (Wrangler / provisioning operations). */
export async function getCloudflareApiToken(env: Env): Promise<string | undefined> {
  return (
    (await getSecretStoreBinding(env, "CLOUDFLARE_WRANGLER_API_TOKEN")) ??
    getSecret(env, "CLOUDFLARE_WRANGLER_API_TOKEN")
  );
}

/** Fetch the Cloudflare account id. */
export async function getCloudflareAccountId(env: Env): Promise<string | undefined> {
  return (
    (await getSecretStoreBinding(env, "CLOUDFLARE_ACCOUNT_ID")) ??
    getSecret(env, "CLOUDFLARE_ACCOUNT_ID")
  );
}

/**
 * HMAC key used to sign the session cookie.
 *
 * Stored in the `SESSIONS` KV namespace (not the Secrets Store) so it can be
 * rotated at runtime without a redeploy. Auto-provisions a random key on first
 * use, with a dev fallback if KV is unavailable.
 */
export async function getCookieSigningKey(env: Env): Promise<string> {
  try {
    let key = await env.SESSIONS.get("COOKIE_SIGNING_KEY");
    if (key) return key;

    key = crypto.randomUUID();
    await env.SESSIONS.put("COOKIE_SIGNING_KEY", key);
    return key;
  } catch (e) {
    console.warn("Failed to read/write COOKIE_SIGNING_KEY from KV", e);
    return "default_dev_key_fallback";
  }
}

/**
 * GitHub webhook secret. Maps to WORKER_API_KEY in this template.
 */
export async function getGitHubWebhookSecret(env: Env): Promise<string> {
  const secret = await getWorkerApiKey(env);
  if (!secret) {
    throw new Error("Missing WORKER_API_KEY in Secrets Store");
  }
  return secret;
}
