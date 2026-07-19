/**
 * @fileoverview Cloudflare storage-resource inventory for the Data Storage
 * console — R2 buckets, D1 databases, KV namespaces, pipelines, data catalogs,
 * plus the Worker→resource binding index used for attribution.
 *
 * Every list here comes from the Cloudflare REST API using the account
 * credentials in the Secrets Store. Sizes come from the per-product endpoint
 * that actually reports them:
 *  - R2  → `/r2/buckets/{name}/usage` (exact payloadSize + objectCount)
 *  - D1  → `file_size` on the list response
 *  - KV  → not exposed by any Cloudflare API; reported as `null`, never faked
 *
 * @remarks The binding index fans out one request per Worker script (183 on
 * this account), so it is cached in KV for an hour. Everything else is cheap
 * enough to fetch per request.
 */

import { getCloudflareAccountId, getCloudflareApiToken } from "@/backend/utils/secrets";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** Cache key + TTL for the Worker binding index. */
const BINDINGS_CACHE_KEY = "guardian:worker-bindings";
const BINDINGS_CACHE_TTL_SECONDS = 3600;

/** Max concurrent Cloudflare API calls when fanning out. */
const FANOUT = 12;

/**
 * Calls the account-scoped Cloudflare REST API.
 *
 * @param env - Worker env carrying the Secrets Store bindings
 * @param path - Path under `/accounts/{account_id}`
 * @param init - Fetch init; `Authorization` is injected
 * @returns The parsed Cloudflare envelope
 * @throws Error on missing credentials or a non-success envelope
 */
export async function cfApi<T = unknown>(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<{ result: T; result_info?: Record<string, unknown> }> {
  const [accountId, token] = await Promise.all([
    getCloudflareAccountId(env),
    getCloudflareApiToken(env),
  ]);
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

  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: { message: string }[];
    result?: T;
    result_info?: Record<string, unknown>;
  };

  if (!res.ok || body.success === false) {
    const detail = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API error: ${detail}`);
  }
  return { result: body.result as T, result_info: body.result_info };
}

/** Runs `work` over `items` with bounded concurrency. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Worker binding index (attribution)
// ---------------------------------------------------------------------------

/** Maps a resource identifier to the Workers bound to it. */
export type BindingIndex = {
  /** `d1:<database_id>` / `kv:<namespace_id>` / `r2:<bucket_name>` → worker names. */
  byResource: Record<string, { worker: string; binding: string }[]>;
  workerCount: number;
  builtAt: number;
};

/** Normalizes one Worker binding into an index key, or null if not a resource. */
function bindingKey(binding: Record<string, any>): string | null {
  switch (binding.type) {
    case "d1":
      return `d1:${binding.database_id ?? binding.id}`;
    case "kv_namespace":
      return `kv:${binding.namespace_id}`;
    case "r2_bucket":
      return `r2:${binding.bucket_name}`;
    case "vectorize":
      return `vectorize:${binding.index_name}`;
    case "queue":
      return `queue:${binding.queue_name}`;
    case "hyperdrive":
      return `hyperdrive:${binding.id}`;
    default:
      return null;
  }
}

/**
 * Builds (or reads from cache) the Worker→resource binding index.
 *
 * @param env - Worker env
 * @param refresh - Skip the cache and rebuild
 * @returns The binding index
 *
 * @remarks One subrequest per Worker script. Cached in the `SESSIONS` KV
 * namespace for an hour because it is stable and expensive.
 */
export async function getBindingIndex(env: Env, refresh = false): Promise<BindingIndex> {
  if (!refresh) {
    const cached = await env.SESSIONS.get(BINDINGS_CACHE_KEY, "json");
    if (cached) return cached as BindingIndex;
  }

  const { result: scripts } = await cfApi<{ id: string }[]>(env, "/workers/scripts");
  const byResource: BindingIndex["byResource"] = {};

  await mapLimit(scripts ?? [], FANOUT, async (script) => {
    try {
      const { result: bindings } = await cfApi<Record<string, any>[]>(
        env,
        `/workers/scripts/${encodeURIComponent(script.id)}/bindings`,
      );
      for (const binding of bindings ?? []) {
        const key = bindingKey(binding);
        if (!key) continue;
        (byResource[key] ??= []).push({ worker: script.id, binding: binding.name });
      }
    } catch {
      // A single unreadable script must not sink the whole index.
    }
  });

  const index: BindingIndex = {
    byResource,
    workerCount: scripts?.length ?? 0,
    builtAt: Date.now(),
  };
  await env.SESSIONS.put(BINDINGS_CACHE_KEY, JSON.stringify(index), {
    expirationTtl: BINDINGS_CACHE_TTL_SECONDS,
  });
  return index;
}

/** Looks up the Workers bound to one resource. */
function attribution(index: BindingIndex, key: string) {
  return index.byResource[key] ?? [];
}

// ---------------------------------------------------------------------------
// Resource listings
// ---------------------------------------------------------------------------

export type R2Bucket = {
  name: string;
  createdAt: string | null;
  location: string | null;
  storageClass: string | null;
  sizeBytes: number;
  objectCount: number;
  workers: { worker: string; binding: string }[];
};

/**
 * Lists R2 buckets with exact size and object counts.
 *
 * @param env - Worker env
 * @returns Buckets sorted by size, largest first
 */
export async function listR2Buckets(env: Env): Promise<R2Bucket[]> {
  const [{ result }, index] = await Promise.all([
    cfApi<{
      buckets: {
        name: string;
        creation_date?: string;
        location?: string;
        storage_class?: string;
      }[];
    }>(env, "/r2/buckets"),
    getBindingIndex(env),
  ]);

  const buckets = await mapLimit(result.buckets ?? [], FANOUT, async (bucket) => {
    let sizeBytes = 0;
    let objectCount = 0;
    try {
      const { result: usage } = await cfApi<{ payloadSize?: string; objectCount?: string }>(
        env,
        `/r2/buckets/${encodeURIComponent(bucket.name)}/usage`,
      );
      sizeBytes = Number(usage?.payloadSize ?? 0);
      objectCount = Number(usage?.objectCount ?? 0);
    } catch {
      // Usage unavailable — report zero rather than dropping the bucket.
    }
    return {
      name: bucket.name,
      createdAt: bucket.creation_date ?? null,
      location: bucket.location ?? null,
      storageClass: bucket.storage_class ?? null,
      sizeBytes,
      objectCount,
      workers: attribution(index, `r2:${bucket.name}`),
    };
  });

  return buckets.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

export type R2Object = {
  key: string;
  size: number;
  lastModified: string | null;
  storageClass: string | null;
};

/**
 * Lists objects inside one bucket, one page at a time.
 *
 * @param env - Worker env
 * @param bucket - Bucket name
 * @param cursor - Opaque cursor from a previous page
 * @param perPage - Page size (Cloudflare caps this)
 * @returns The page plus the next cursor, if any
 */
export async function listR2Objects(
  env: Env,
  bucket: string,
  cursor?: string,
  perPage = 100,
): Promise<{ objects: R2Object[]; cursor: string | null; truncated: boolean }> {
  const params = new URLSearchParams({ per_page: String(perPage) });
  if (cursor) params.set("cursor", cursor);

  const { result, result_info } = await cfApi<
    { key: string; size?: number; last_modified?: string; storage_class?: string }[]
  >(env, `/r2/buckets/${encodeURIComponent(bucket)}/objects?${params}`);

  return {
    objects: (result ?? []).map((o) => ({
      key: o.key,
      size: o.size ?? 0,
      lastModified: o.last_modified ?? null,
      storageClass: o.storage_class ?? null,
    })),
    cursor: (result_info?.cursor as string) ?? null,
    truncated: Boolean(result_info?.is_truncated),
  };
}

export type D1Database = {
  uuid: string;
  name: string;
  createdAt: string | null;
  numTables: number;
  sizeBytes: number;
  workers: { worker: string; binding: string }[];
};

/**
 * Lists D1 databases with file sizes, largest first.
 *
 * @param env - Worker env
 * @returns Databases sorted by size, largest first
 */
export async function listD1Databases(env: Env): Promise<D1Database[]> {
  const [{ result }, index] = await Promise.all([
    cfApi<
      { uuid: string; name: string; created_at?: string; num_tables?: number; file_size?: number }[]
    >(env, "/d1/database?per_page=1000"),
    getBindingIndex(env),
  ]);

  return (result ?? [])
    .map((db) => ({
      uuid: db.uuid,
      name: db.name,
      createdAt: db.created_at ?? null,
      numTables: db.num_tables ?? 0,
      sizeBytes: db.file_size ?? 0,
      workers: attribution(index, `d1:${db.uuid}`),
    }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}

export type KVNamespace = {
  id: string;
  title: string;
  /** Cloudflare exposes no stored-size API for KV — never fabricate a number. */
  sizeBytes: null;
  workers: { worker: string; binding: string }[];
};

/**
 * Lists KV namespaces.
 *
 * @param env - Worker env
 * @returns Namespaces sorted by title
 */
export async function listKVNamespaces(env: Env): Promise<KVNamespace[]> {
  const [{ result }, index] = await Promise.all([
    cfApi<{ id: string; title: string }[]>(env, "/storage/kv/namespaces?per_page=1000"),
    getBindingIndex(env),
  ]);

  return (result ?? [])
    .map((ns) => ({
      id: ns.id,
      title: ns.title,
      sizeBytes: null as null,
      workers: attribution(index, `kv:${ns.id}`),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export type Pipeline = {
  id: string;
  name: string;
  status: string | null;
  sql: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
};

/**
 * Lists Pipelines.
 *
 * @param env - Worker env
 * @returns Pipelines sorted by name
 */
export async function listPipelines(env: Env): Promise<Pipeline[]> {
  const { result } = await cfApi<
    {
      id: string;
      name: string;
      status?: string;
      sql?: string;
      created_at?: string;
      modified_at?: string;
    }[]
  >(env, "/pipelines/v1/pipelines");

  return (result ?? [])
    .map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status ?? null,
      sql: p.sql ?? null,
      createdAt: p.created_at ?? null,
      modifiedAt: p.modified_at ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type DataCatalog = {
  bucket: string;
  enabled: boolean;
  detail: Record<string, unknown> | null;
};

/**
 * Lists R2 Data Catalogs by probing each bucket's warehouse.
 *
 * @param env - Worker env
 * @param buckets - Bucket names to probe
 * @returns Only the buckets that actually have a catalog
 *
 * @remarks There is no account-wide catalog list endpoint; `/r2-catalog/{bucket}`
 * returns "Warehouse not found" for buckets without one.
 */
export async function listDataCatalogs(env: Env, buckets: string[]): Promise<DataCatalog[]> {
  const probed = await mapLimit<string, DataCatalog | null>(buckets, FANOUT, async (bucket) => {
    try {
      const { result } = await cfApi<Record<string, unknown>>(
        env,
        `/r2-catalog/${encodeURIComponent(bucket)}`,
      );
      return { bucket, enabled: true, detail: result ?? null };
    } catch {
      return null;
    }
  });
  return probed.filter((c): c is DataCatalog => c !== null);
}
