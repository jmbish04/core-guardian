/**
 * @fileoverview Minimal client for the Cloudflare GraphQL Analytics API.
 *
 * Used by the Core Guardian usage probes to read per-product consumption
 * (D1 rows, R2 operations, Durable Object CPU, Workers AI inferences, …).
 * Authenticates with the same Secrets Store credentials as the eviction
 * routes: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_WRANGLER_API_TOKEN`.
 *
 * @remarks The token must carry **Account Analytics: Read**. Without it every
 * probe fails authorization and the Guardian panel renders each card as
 * unavailable rather than showing wrong numbers.
 */

import { getCloudflareAccountId, getCloudflareApiToken } from "@/backend/utils/secrets";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** Thrown when the GraphQL endpoint rejects a document or reports errors. */
export class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphQLError";
  }
}

/**
 * Executes a GraphQL document against the Cloudflare Analytics API.
 *
 * @param env - Worker env carrying the Secrets Store bindings
 * @param query - GraphQL document
 * @param variables - Query variables (`accountTag` is injected automatically)
 * @returns The `data.viewer.accounts[0]` object for the bound account
 * @throws {@link GraphQLError} on missing credentials, HTTP failure, or any
 *   GraphQL error entry (an unknown field rejects the whole document, which is
 *   why each probe issues its own request)
 */
export async function queryAccountAnalytics<T = Record<string, unknown>>(
  env: Env,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const [accountId, token] = await Promise.all([
    getCloudflareAccountId(env),
    getCloudflareApiToken(env),
  ]);
  if (!accountId || !token) {
    throw new GraphQLError(
      "Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_WRANGLER_API_TOKEN in the Secrets Store.",
    );
  }

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { accountTag: accountId, ...variables } }),
  });

  if (!res.ok) {
    throw new GraphQLError(`GraphQL HTTP ${res.status}`);
  }

  const body = (await res.json()) as {
    data?: { viewer?: { accounts?: T[] } };
    errors?: { message: string }[] | null;
  };

  if (body.errors?.length) {
    throw new GraphQLError(body.errors.map((e) => e.message).join("; "));
  }

  const account = body.data?.viewer?.accounts?.[0];
  if (!account) {
    throw new GraphQLError("GraphQL response contained no account data.");
  }
  return account;
}
