/**
 * @fileoverview Minimal OAuth 2.1 authorization surface for the MCP server.
 *
 * Lets an MCP client (Claude, Cursor, MCP Inspector) connect to `/mcp` with
 * one-click OAuth instead of pasting a bearer token. There is no user database:
 * authentication is possession of `WORKER_API_KEY`, materialized as the same
 * signed `cr_session` cookie the dashboard already issues. The operator signs in
 * once at `/login`; the authorize step then auto-approves off that cookie.
 *
 * What's implemented (the minimum an MCP client's discovery needs):
 *   - RFC 9728 protected-resource metadata  (`.well-known/oauth-protected-resource`)
 *   - RFC 8414 authorization-server metadata (`.well-known/oauth-authorization-server`)
 *   - RFC 7591 dynamic client registration   (`POST /oauth/register`)
 *   - Authorization Code + PKCE (S256)        (`GET /oauth/authorize`, `POST /oauth/token`)
 *
 * Access tokens are self-contained: an HMAC over `{exp}` signed with the cookie
 * signing key, so verifying one needs no KV read. Registered clients and
 * single-use auth codes live in the `SESSIONS` KV namespace.
 *
 * The bearer `Authorization: Bearer <WORKER_API_KEY>` path still works for
 * scripted clients — see {@link mcpAuth}.
 */

import type { Context, Next } from "hono";

import { Hono } from "hono";

import { extractBearerToken } from "@/backend/api/lib/auth";
import { verifySessionCookie } from "@/backend/lib/cookies";
import {
  constantTimeEqual,
  decodeBase64Url,
  encodeBase64Url,
  hmacSign,
  toBase64Url,
} from "@/backend/lib/crypto";
import { getCookieSigningKey, getWorkerApiKey } from "@/backend/utils/secrets";

/** Access-token lifetime (30 days) — matches the practical session horizon. */
const ACCESS_TTL_SECONDS = 60 * 60 * 24 * 30;
/** Registered DCR clients persist for 30 days; clients re-register if evicted. */
const CLIENT_TTL_SECONDS = 60 * 60 * 24 * 30;
/** Auth codes are single-use and short-lived. */
const CODE_TTL_SECONDS = 60;

const CLIENT_PREFIX = "oauth:client:";
const CODE_PREFIX = "oauth:code:";

type StoredClient = { redirect_uris: string[]; client_name?: string };
type StoredCode = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource?: string;
};

/** Random URL-safe token of `bytes` entropy. */
function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Mints a self-contained, HMAC-signed MCP access token. */
async function issueAccessToken(env: Env): Promise<string> {
  const payload = encodeBase64Url(
    JSON.stringify({
      typ: "mcp",
      exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS,
    })
  );
  const sig = await hmacSign(await getCookieSigningKey(env), payload);
  return `${payload}.${sig}`;
}

/** Verifies an MCP access token's signature and expiry. */
async function verifyAccessToken(env: Env, token: string): Promise<boolean> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = await hmacSign(await getCookieSigningKey(env), payload);
  if (!constantTimeEqual(sig, expected)) return false;
  try {
    const { typ, exp } = JSON.parse(decodeBase64Url(payload)) as {
      typ?: string;
      exp?: number;
    };
    return typ === "mcp" && typeof exp === "number" && exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/** Base64url(SHA-256(value)) — the S256 PKCE transform. */
async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// .well-known discovery metadata (mounted at root)
// ---------------------------------------------------------------------------

export const wellKnownRouter = new Hono<{ Bindings: Env }>();

/** RFC 8414 authorization-server metadata. The `/mcp` suffix variant is served
 * identically because clients probe both the root and path-inserted forms. */
function authServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}

/** RFC 9728 protected-resource metadata pointing at this Worker as its own AS. */
function protectedResourceMetadata(origin: string) {
  return { resource: `${origin}/mcp`, authorization_servers: [origin] };
}

for (const path of ["/oauth-authorization-server", "/oauth-authorization-server/mcp"]) {
  wellKnownRouter.get(path, (c) => c.json(authServerMetadata(new URL(c.req.url).origin)));
}
for (const path of ["/oauth-protected-resource", "/oauth-protected-resource/mcp"]) {
  wellKnownRouter.get(path, (c) => c.json(protectedResourceMetadata(new URL(c.req.url).origin)));
}

// ---------------------------------------------------------------------------
// OAuth endpoints (mounted at /oauth)
// ---------------------------------------------------------------------------

export const oauthRouter = new Hono<{ Bindings: Env }>();

/** RFC 7591 Dynamic Client Registration — accepts any public client. */
oauthRouter.post("/register", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    redirect_uris?: unknown;
    client_name?: unknown;
  } | null;
  const redirectUris = body?.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every((u) => typeof u === "string")
  ) {
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description: "redirect_uris required",
      },
      400
    );
  }

  const clientId = randomToken(16);
  const stored: StoredClient = {
    redirect_uris: redirectUris as string[],
    client_name: typeof body?.client_name === "string" ? body.client_name : undefined,
  };
  await c.env.SESSIONS.put(`${CLIENT_PREFIX}${clientId}`, JSON.stringify(stored), {
    expirationTtl: CLIENT_TTL_SECONDS,
  });

  return c.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: stored.redirect_uris,
      client_name: stored.client_name,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    201
  );
});

/** Authorization endpoint. One-click: approves off the existing `cr_session`
 * cookie; when the operator isn't signed in yet, bounces through `/login`. */
oauthRouter.get("/authorize", async (c) => {
  const q = c.req.query();
  const { client_id: clientId, redirect_uri: redirectUri, state, resource } = q;
  const codeChallenge = q.code_challenge;

  // Validate the request enough to safely redirect errors back to the client.
  if (q.response_type !== "code") {
    return c.text("unsupported_response_type — only 'code' is supported", 400);
  }
  if (!clientId || !redirectUri) {
    return c.text("invalid_request — client_id and redirect_uri are required", 400);
  }
  if (!codeChallenge || q.code_challenge_method !== "S256") {
    return c.text("invalid_request — PKCE with code_challenge_method=S256 is required", 400);
  }

  const clientRaw = await c.env.SESSIONS.get(`${CLIENT_PREFIX}${clientId}`, "json");
  const client = clientRaw as StoredClient | null;
  if (!client) {
    return c.text("invalid_client — unknown client_id (register first)", 400);
  }
  // Never redirect to an unregistered URI — prevents open-redirect abuse.
  if (!client.redirect_uris.includes(redirectUri)) {
    return c.text("invalid_request — redirect_uri does not match a registered value", 400);
  }

  // One-click gate: reuse the dashboard session. Not signed in → send to /login
  // and come straight back to this exact authorize URL.
  const session = await verifySessionCookie(c.env, c.req.header("Cookie"));
  if (!session) {
    const returnTo = new URL(c.req.url).pathname + new URL(c.req.url).search;
    return c.redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  }

  const code = randomToken(32);
  const stored: StoredCode = {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    resource,
  };
  await c.env.SESSIONS.put(`${CODE_PREFIX}${code}`, JSON.stringify(stored), {
    expirationTtl: CODE_TTL_SECONDS,
  });

  const dest = new URL(redirectUri);
  dest.searchParams.set("code", code);
  if (state) dest.searchParams.set("state", state);
  return c.redirect(dest.toString());
});

/** Token endpoint — authorization_code grant with PKCE verification. */
oauthRouter.post("/token", async (c) => {
  const body = await c.req.parseBody();
  const grantType = String(body.grant_type ?? "");
  const code = String(body.code ?? "");
  const redirectUri = String(body.redirect_uri ?? "");
  const clientId = String(body.client_id ?? "");
  const codeVerifier = String(body.code_verifier ?? "");

  if (grantType !== "authorization_code") {
    return c.json({ error: "unsupported_grant_type" }, 400);
  }
  if (!code || !codeVerifier) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "code and code_verifier required",
      },
      400
    );
  }

  // Single-use: consume the code regardless of outcome.
  const key = `${CODE_PREFIX}${code}`;
  const storedRaw = await c.env.SESSIONS.get(key, "json");
  await c.env.SESSIONS.delete(key);
  const stored = storedRaw as StoredCode | null;
  if (!stored) {
    return c.json(
      {
        error: "invalid_grant",
        error_description: "code expired or already used",
      },
      400
    );
  }
  if (stored.client_id !== clientId || stored.redirect_uri !== redirectUri) {
    return c.json(
      {
        error: "invalid_grant",
        error_description: "client_id / redirect_uri mismatch",
      },
      400
    );
  }
  const challenge = await sha256Base64Url(codeVerifier);
  if (!constantTimeEqual(challenge, stored.code_challenge)) {
    return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
  }

  const accessToken = await issueAccessToken(c.env);
  return c.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    scope: "mcp",
  });
});

// ---------------------------------------------------------------------------
// MCP endpoint auth — the resource-server gate
// ---------------------------------------------------------------------------

/**
 * Auth gate for the MCP router. Accepts, in order: the signed `cr_session`
 * cookie, a bearer `WORKER_API_KEY` (scripted fallback), or an OAuth access
 * token issued above. A miss returns 401 with the `WWW-Authenticate` challenge
 * that kicks off OAuth discovery in a compliant MCP client.
 */
export async function mcpAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const session = await verifySessionCookie(c.env, c.req.header("Cookie"));
  if (session) return await next();

  const bearer = extractBearerToken(c.req.header("Authorization"));
  if (bearer) {
    // A Secrets Store hiccup on the WORKER_API_KEY fetch must not veto a valid
    // OAuth access token, so tolerate a lookup failure and fall through.
    const expected = await getWorkerApiKey(c.env).catch(() => undefined);
    if (expected && constantTimeEqual(bearer, expected)) return await next();
    if (await verifyAccessToken(c.env, bearer)) return await next();
  }

  const origin = new URL(c.req.url).origin;
  c.header(
    "WWW-Authenticate",
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
  );
  return c.json({ error: "Unauthorized" }, 401);
}
