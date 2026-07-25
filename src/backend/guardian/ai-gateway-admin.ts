/**
 * @fileoverview AI Gateway CRUD — thin wrappers over the Cloudflare AI Gateway
 * REST API so a coding agent (via API or MCP) can list, inspect, create, update,
 * and delete gateways without hand-editing the dashboard.
 *
 * Create requires several fields; sensible defaults are filled so an agent can
 * create a gateway with just an id. Every mutation is auditable by the caller.
 *
 * @see the config surface at
 *   https://developers.cloudflare.com/api/ (ai-gateway/gateways).
 */

import { cfApi } from "./resources";

export type Gateway = Record<string, unknown> & { id: string };

/** Config an agent may pass. `id` is required for create; the rest default. */
export type GatewayConfig = {
  id: string;
  cache_ttl?: number;
  cache_invalidate_on_update?: boolean;
  collect_logs?: boolean;
  rate_limiting_interval?: number;
  rate_limiting_limit?: number;
  rate_limiting_technique?: "fixed" | "sliding";
  authentication?: boolean;
  log_management?: number;
  log_management_strategy?: "STOP_INSERTING" | "DELETE_OLDEST";
  logpush?: boolean;
  retry_backoff?: "constant" | "linear" | "exponential";
  retry_delay?: number;
  retry_max_attempts?: number;
  zdr?: boolean;
};

/** Fill the API's required fields with safe defaults. */
function withDefaults(cfg: GatewayConfig): Record<string, unknown> {
  return {
    id: cfg.id,
    cache_ttl: cfg.cache_ttl ?? 0, // 0 = caching off by default
    cache_invalidate_on_update: cfg.cache_invalidate_on_update ?? false,
    collect_logs: cfg.collect_logs ?? true,
    rate_limiting_interval: cfg.rate_limiting_interval ?? 0, // 0 = no rate limit
    rate_limiting_limit: cfg.rate_limiting_limit ?? 0,
    ...(cfg.rate_limiting_technique ? { rate_limiting_technique: cfg.rate_limiting_technique } : {}),
    ...(cfg.authentication !== undefined ? { authentication: cfg.authentication } : {}),
    ...(cfg.log_management !== undefined ? { log_management: cfg.log_management } : {}),
    ...(cfg.log_management_strategy ? { log_management_strategy: cfg.log_management_strategy } : {}),
    ...(cfg.logpush !== undefined ? { logpush: cfg.logpush } : {}),
    ...(cfg.retry_backoff ? { retry_backoff: cfg.retry_backoff } : {}),
    ...(cfg.retry_delay !== undefined ? { retry_delay: cfg.retry_delay } : {}),
    ...(cfg.retry_max_attempts !== undefined ? { retry_max_attempts: cfg.retry_max_attempts } : {}),
    ...(cfg.zdr !== undefined ? { zdr: cfg.zdr } : {}),
  };
}

export async function listGateways(env: Env): Promise<Gateway[]> {
  const { result } = await cfApi<Gateway[]>(env, "/ai-gateway/gateways?per_page=100");
  return result ?? [];
}

export async function getGateway(env: Env, id: string): Promise<Gateway> {
  const { result } = await cfApi<Gateway>(env, `/ai-gateway/gateways/${encodeURIComponent(id)}`);
  return result;
}

export async function createGateway(env: Env, cfg: GatewayConfig): Promise<Gateway> {
  const { result } = await cfApi<Gateway>(env, "/ai-gateway/gateways", {
    method: "POST",
    body: JSON.stringify(withDefaults(cfg)),
  });
  return result;
}

/** Read-only fields the API returns but rejects on write. */
const READONLY = new Set(["created_at", "modified_at", "account_id", "account_tag", "internal_id"]);

/**
 * Update: the PUT replaces the whole config, so send the FULL current gateway
 * (minus server-managed read-only fields) with the patch applied — never a
 * partial, which would reset unspecified settings to defaults.
 */
export async function updateGateway(env: Env, id: string, patch: Partial<GatewayConfig>): Promise<Gateway> {
  const current = await getGateway(env, id);
  const merged: Record<string, unknown> = { ...current, ...patch, id };
  for (const k of READONLY) delete merged[k];
  const { result } = await cfApi<Gateway>(env, `/ai-gateway/gateways/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(merged),
  });
  return result;
}

export async function deleteGateway(env: Env, id: string): Promise<void> {
  await cfApi(env, `/ai-gateway/gateways/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * One AI Gateway request log — the ONLY place to trace who/what made a call
 * that didn't originate from an attributable worker (e.g. a local script hitting
 * the REST API). Carries the prompt, the caller's user-agent + location, and any
 * custom metadata, so external/direct usage can be traced by content or origin.
 */
export type GatewayLog = {
  id: string;
  createdAt: string;
  provider: string;
  model: string;
  requestType: string;
  success: boolean;
  cached: boolean;
  statusCode: number | null;
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  /** Caller's user-agent — a clue for external (non-worker) traffic. */
  userAgent: string | null;
  /** Caller geo/location — another origin clue. */
  location: string | null;
  /** Custom metadata attached via the cf-aig-metadata header (tag your source!). */
  metadata: Record<string, unknown> | null;
  /** The prompt(s), truncated — trace by content when origin is unknown. */
  prompt: string | null;
};

function truncate(v: unknown, n = 500): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Format the geo `location` object into a readable "city, region, country". */
function formatLocation(loc: unknown): string | null {
  if (!loc) return null;
  if (typeof loc === "string") return loc;
  if (typeof loc === "object") {
    const o = loc as Record<string, unknown>;
    // Real logs carry either caller geo {city,region,country} (external/local
    // scripts) or the CF datacenter {region,colo} (worker traffic) — surface both.
    const parts = [o.city, o.region, o.country, o.colo].filter((x) => typeof x === "string");
    return parts.length ? parts.join(", ") : truncate(o, 80);
  }
  return String(loc);
}

/**
 * Fetch recent request logs for a gateway. `search` filters by prompt/metadata
 * substring server-side where supported; otherwise it's applied client-side.
 */
export async function getGatewayLogs(
  env: Env,
  gatewayId: string,
  perPage = 50,
): Promise<GatewayLog[]> {
  const { result } = await cfApi<any[]>(
    env,
    `/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/logs?per_page=${Math.min(perPage, 100)}`,
  );
  return (result ?? []).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    provider: r.provider,
    model: r.model,
    requestType: r.request_type,
    success: Boolean(r.success),
    cached: Boolean(r.cached),
    statusCode: r.status_code ?? null,
    durationMs: r.duration ?? null,
    tokensIn: r.tokens_in ?? 0,
    tokensOut: r.tokens_out ?? 0,
    cost: r.cost ?? 0,
    userAgent: r.user_agent ?? null,
    location: formatLocation(r.location),
    metadata: r.metadata ?? null,
    prompt: truncate(r.prompts ?? r.request),
  }));
}
