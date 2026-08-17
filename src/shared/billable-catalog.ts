/**
 * @fileoverview Billable catalog — what each Cloudflare bill line actually
 * measures and which worker ACTION drives it.
 *
 * Static reference (source of truth for both the billing UI annotations and the
 * generated docs/architecture/billable-catalog.md). The bill tells you a SKU
 * cost; this tells you the metric, its unit, and the concrete thing your code
 * does that increments it — so a climbing line points at a fixable action.
 *
 * Keyed by a matcher on the raw `service_name` (Cloudflare appends the included
 * allowance to the name, e.g. "D1 - Rows Read (first 25 billion included)").
 * `category` aligns with the spend-rollup categories.
 *
 * Imported by both backend and frontend via `@/shared/billable-catalog`.
 */

export type BillableCategory =
  | "ai"
  | "compute"
  | "d1"
  | "r2"
  | "kv"
  | "vectorize"
  | "do"
  | "browser"
  | "queues"
  | "containers"
  | "images"
  | "stream"
  | "observability"
  | "builds"
  | "other";

export type BillableCatalogEntry = {
  /** Matches the raw service_name (case-insensitive substring / pattern). */
  match: RegExp;
  /** Rollup category. */
  category: BillableCategory;
  /** Human metric name. */
  metric: string;
  /** Billing unit. */
  unit: string;
  /** The concrete worker action(s) that increment this line. */
  action: string;
  /** One lever to reduce it. */
  lever: string;
};

/**
 * Order matters — first match wins, so put specific patterns before generic
 * family catch-alls.
 */
export const BILLABLE_CATALOG: BillableCatalogEntry[] = [
  // --- Workers AI --------------------------------------------------------
  {
    match: /neuron/i,
    category: "ai",
    metric: "Workers AI neurons",
    unit: "neurons",
    action: "Every model inference through Workers AI (`env.AI.run` / the AI Router). Cost scales with model size × tokens.",
    lever: "Route to a cheaper model for low-importance calls; cache/dedupe prompts; cap via the AI-Router budget.",
  },
  // --- D1 ----------------------------------------------------------------
  {
    match: /d1.*rows?\s*read/i,
    category: "d1",
    metric: "D1 rows read",
    unit: "rows",
    action: "Every row a `SELECT` scans (not returned — scanned). A query without an index scans the whole table.",
    lever: "Add indexes so queries seek instead of scan; avoid `SELECT *` on hot paths.",
  },
  {
    match: /d1.*rows?\s*written/i,
    category: "d1",
    metric: "D1 rows written",
    unit: "rows",
    action: "Every row an `INSERT`/`UPDATE`/`DELETE` writes, plus index-row writes.",
    lever: "Batch writes; drop unused indexes (each adds a write per row).",
  },
  {
    match: /d1.*storage/i,
    category: "d1",
    metric: "D1 storage",
    unit: "GB-months",
    action: "Total database size held over time (rows + indexes).",
    lever: "Archive/trim old rows; drop unused tables and indexes.",
  },
  // --- Durable Objects ---------------------------------------------------
  {
    match: /durable objects compute (duration|request)/i,
    category: "do",
    metric: "Durable Object compute",
    unit: "GB-seconds / requests",
    action: "Wall-clock time a DO is active × its memory, plus each request/alarm that wakes it.",
    lever: "Let DOs hibernate (WebSocket hibernation); coalesce work; avoid tight alarm loops.",
  },
  {
    match: /durable objects storage rows read/i,
    category: "do",
    metric: "DO SQL rows read",
    unit: "rows",
    action: "Every row a DO SQLite `SELECT` scans.",
    lever: "Index DO SQL queries; read less per request.",
  },
  {
    match: /durable objects storage rows written/i,
    category: "do",
    metric: "DO SQL rows written",
    unit: "rows",
    action: "Every row a DO SQLite write touches.",
    lever: "Batch DO writes; prune DO state.",
  },
  {
    match: /durable objects (sql )?storage/i,
    category: "do",
    metric: "DO storage",
    unit: "GB-months",
    action: "DO SQLite / KV storage held over time.",
    lever: "Delete stale DO state; compact.",
  },
  // --- R2 ----------------------------------------------------------------
  {
    match: /r2.*class a/i,
    category: "r2",
    metric: "R2 Class A operations",
    unit: "requests",
    action: "Mutating/listing calls: `put`, `delete`, `list`, multipart uploads.",
    lever: "Batch uploads; avoid frequent full `list()`s.",
  },
  {
    match: /r2.*class b/i,
    category: "r2",
    metric: "R2 Class B operations",
    unit: "requests",
    action: "Read calls: `get`, `head`.",
    lever: "Cache reads at the edge; avoid re-fetching unchanged objects.",
  },
  {
    match: /r2.*(data )?storage/i,
    category: "r2",
    metric: "R2 storage",
    unit: "GB-months",
    action: "Bytes stored across buckets over time.",
    lever: "Lifecycle-expire old objects; the Guardian R2 eviction control does this.",
  },
  // --- KV ----------------------------------------------------------------
  {
    match: /kv (read|write|list|delete)/i,
    category: "kv",
    metric: "KV operations",
    unit: "operations",
    action: "`KV.get` (read), `put` (write), `list`, `delete` — one op each.",
    lever: "Cache hot KV in memory per request; batch; widen `cacheTtl`.",
  },
  {
    match: /kv storage/i,
    category: "kv",
    metric: "KV storage",
    unit: "GB-months",
    action: "Total KV value bytes stored over time.",
    lever: "Set TTLs; delete stale keys.",
  },
  // --- Vectorize ---------------------------------------------------------
  {
    match: /vectorize.*queried/i,
    category: "vectorize",
    metric: "Vectorize queried dimensions",
    unit: "dimension-queries",
    action: "Each `query()` × the index dimensionality × topK.",
    lever: "Lower dimensions/topK; cache frequent queries.",
  },
  {
    match: /vectorize.*stored/i,
    category: "vectorize",
    metric: "Vectorize stored dimensions",
    unit: "dimension-months",
    action: "Vectors held × their dimensionality over time.",
    lever: "Prune stale vectors; the Guardian Vectorize-drop control clears an index.",
  },
  // --- Observability / Logpush (before Workers, so "Logpush Enabled Workers
  //     Requests" isn't shadowed by the generic workers-requests matcher) -----
  {
    match: /observability|logpush|logs/i,
    category: "observability",
    metric: "Observability / Logpush",
    unit: "requests / logs",
    action: "Log volume pushed/retained; per-request observability events.",
    lever: "Sample logs; narrow Logpush filters.",
  },
  // --- Workers compute ---------------------------------------------------
  {
    match: /workers standard requests|workers.*requests/i,
    category: "compute",
    metric: "Workers requests",
    unit: "requests",
    action: "Every invocation of a Worker (fetch, cron, queue consumer, RPC).",
    lever: "Cut noisy crons; cache to skip invocations; coalesce subrequests.",
  },
  {
    match: /workers cpu/i,
    category: "compute",
    metric: "Workers CPU time",
    unit: "ms",
    action: "CPU milliseconds burned per invocation (not wall time).",
    lever: "Optimize hot loops; move heavy work off the request path.",
  },
  {
    match: /worker build/i,
    category: "builds",
    metric: "Workers Build minutes",
    unit: "minutes",
    action: "CI build minutes on Workers Builds per deploy.",
    lever: "Cache deps; deploy less often; trim the build.",
  },
  // --- Misc --------------------------------------------------------------
  {
    match: /browser (run|rendering)/i,
    category: "browser",
    metric: "Browser Rendering",
    unit: "hours / concurrent browsers",
    action: "Puppeteer session time and concurrent browser count.",
    lever: "Close sessions promptly; reuse; cap concurrency.",
  },
  {
    match: /queues/i,
    category: "queues",
    metric: "Queue operations",
    unit: "operations",
    action: "Each message write, read, and delete (retries re-charge).",
    lever: "Batch messages; fix consumers that retry-loop.",
  },
  {
    match: /container/i,
    category: "containers",
    metric: "Containers",
    unit: "vCPU-s / GiB-s / GB egress",
    action: "Container vCPU, memory, disk, and egress while running.",
    lever: "Scale to zero when idle; right-size the container.",
  },
  {
    // Before Images: "Stream Bundle Basic Images Delivered" must not match /image/.
    match: /stream/i,
    category: "stream",
    metric: "Stream",
    unit: "minutes / images",
    action: "Video minutes stored/delivered.",
    lever: "Delete unused assets.",
  },
  {
    match: /image/i,
    category: "images",
    metric: "Images",
    unit: "images",
    action: "Each transform / stored image / delivery.",
    lever: "Cache variants; limit transform permutations.",
  },
  {
    match: /dynamic workers/i,
    category: "compute",
    metric: "Dynamic Workers",
    unit: "workers",
    action: "Each dynamically-created Worker isolate (Code Mode / dynamic dispatch).",
    lever: "Reuse isolates; cap dynamic creation.",
  },
];

/** Look up the catalog entry driving a raw billable service_name, or null. */
export function lookupBillable(serviceName: string): BillableCatalogEntry | null {
  for (const e of BILLABLE_CATALOG) if (e.match.test(serviceName)) return e;
  return null;
}
