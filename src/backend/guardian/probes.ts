/**
 * @fileoverview Usage probe registry — one entry per binding type declared in
 * `wrangler.jsonc`.
 *
 * Each probe names a GraphQL Analytics dataset, the selection to pull from it,
 * and how to fold the returned groups into a single headline number plus a
 * breakdown. Probes are executed independently (see `collect.ts`) because the
 * Cloudflare GraphQL API rejects an entire document when one field name is
 * unknown — isolating each dataset means a schema change degrades one card
 * instead of the whole panel.
 *
 * Bindings with no analytics dataset (Assets, Secrets Store, Worker Loaders)
 * are declared with `dataset: null` so the panel reports them as
 * "not metered" rather than silently omitting them.
 *
 * @remarks Dataset and field names verified against Cloudflare docs where the
 * docs publish them (D1, Durable Objects, Workers). The remainder follow the
 * documented `<product>AdaptiveGroups` convention and are selected
 * conservatively (`count` over product-specific sums) to survive schema drift.
 * A probe whose dataset or field is wrong surfaces as `status: "unavailable"`
 * with the GraphQL error attached — that is the signal to fix the selection.
 */

/** A single grouped row returned by a `*AdaptiveGroups` dataset. */
export type UsageGroup = {
  count?: number;
  sum?: Record<string, number>;
  max?: Record<string, number>;
  dimensions?: Record<string, string>;
};

export type UsageProbe = {
  /** Stable identifier, also the D1 `service` value for snapshots/alerts. */
  id: string;
  /** Human label for the panel card. */
  label: string;
  /** Cloudflare product family. */
  product: string;
  /** Binding names in `wrangler.jsonc` this probe covers. */
  bindings: string[];
  /** Unit of the headline number (e.g. `rows read`, `requests`). */
  unit: string;
  /** GraphQL dataset, or `null` when the product exposes no analytics. */
  dataset: string | null;
  /** GraphQL selection inside the dataset. */
  selection: string;
  /** Folds returned groups into the headline value. */
  value: (groups: UsageGroup[]) => number;
  /** Optional per-dimension breakdown for the card. */
  breakdown?: (groups: UsageGroup[]) => { label: string; value: number }[];
  /**
   * Headline value over the query window above which the hourly cron records a
   * surge alert. Tuned for an idle-to-modest template deployment — raise these
   * once you have a week of real baseline.
   *
   * ponytail: thresholds live in code; move to the `global_config` table if you
   * ever need to retune them without a redeploy.
   */
  alertThreshold: number;
};

/** Sums a `sum`/`max` field across all groups. */
function sumField(groups: UsageGroup[], bucket: "sum" | "max", field: string): number {
  return groups.reduce((total, g) => total + (g[bucket]?.[field] ?? 0), 0);
}

/** Builds a breakdown keyed on one dimension, summing a `sum` field (or `count`). */
function breakdownBy(
  groups: UsageGroup[],
  dimension: string,
  bucket: "sum" | "max" | "count",
  field?: string,
): { label: string; value: number }[] {
  const totals = new Map<string, number>();
  for (const g of groups) {
    const key = g.dimensions?.[dimension] ?? "unknown";
    const value =
      bucket === "count" ? (g.count ?? 0) : field ? ((g[bucket]?.[field] ?? 0) as number) : 0;
    totals.set(key, (totals.get(key) ?? 0) + value);
  }
  return [...totals.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

/** Durable Object bindings declared in `wrangler.jsonc` (one per agent class). */
const DURABLE_OBJECT_BINDINGS = [
  "CODE_MODE_AGENT",
  "BROWSER_HITL_AGENT",
  "WORKFLOWS_AGENT",
  "ARTIFACT_AGENT",
  "CHAT_BROKER",
  "NOTIFICATIONS_AGENT",
  "ORCHESTRATOR_AGENT",
  "RESEARCHER_AGENT",
  "CODER_AGENT",
  "MCP_AGENT",
  "THINKING_AGENT",
  "SKILLS_AGENT",
];

export const USAGE_PROBES: UsageProbe[] = [
  // --- D1 -------------------------------------------------------------------
  {
    id: "d1",
    label: "D1",
    product: "D1",
    bindings: ["DB"],
    unit: "rows read",
    dataset: "d1AnalyticsAdaptiveGroups",
    selection: "sum { readQueries writeQueries rowsRead rowsWritten } dimensions { databaseId }",
    value: (g) => sumField(g, "sum", "rowsRead"),
    breakdown: (g) => breakdownBy(g, "databaseId", "sum", "rowsRead"),
    alertThreshold: 5_000_000,
  },

  // --- R2 -------------------------------------------------------------------
  {
    id: "r2-operations",
    label: "R2 operations",
    product: "R2",
    bindings: ["R2_AUDIO_BUCKET", "R2_FILES_BUCKET"],
    unit: "requests",
    dataset: "r2OperationsAdaptiveGroups",
    selection: "sum { requests } dimensions { bucketName actionType }",
    value: (g) => sumField(g, "sum", "requests"),
    breakdown: (g) => breakdownBy(g, "bucketName", "sum", "requests"),
    alertThreshold: 1_000_000,
  },
  {
    id: "r2-storage",
    label: "R2 storage",
    product: "R2",
    bindings: ["R2_AUDIO_BUCKET", "R2_FILES_BUCKET"],
    unit: "bytes stored",
    dataset: "r2StorageAdaptiveGroups",
    selection: "max { payloadSize objectCount } dimensions { bucketName }",
    value: (g) => sumField(g, "max", "payloadSize"),
    breakdown: (g) => breakdownBy(g, "bucketName", "max", "payloadSize"),
    // ~50 GB across all buckets.
    alertThreshold: 50 * 1024 ** 3,
  },

  // --- Durable Objects ------------------------------------------------------
  {
    id: "durable-objects-requests",
    label: "Durable Object requests",
    product: "Durable Objects",
    bindings: DURABLE_OBJECT_BINDINGS,
    unit: "requests",
    dataset: "durableObjectsInvocationsAdaptiveGroups",
    selection: "sum { requests responseBodySize } dimensions { namespaceId }",
    value: (g) => sumField(g, "sum", "requests"),
    breakdown: (g) => breakdownBy(g, "namespaceId", "sum", "requests"),
    alertThreshold: 1_000_000,
  },
  {
    id: "durable-objects-cpu",
    label: "Durable Object CPU",
    product: "Durable Objects",
    bindings: DURABLE_OBJECT_BINDINGS,
    unit: "µs CPU",
    dataset: "durableObjectsPeriodicGroups",
    selection: "sum { cpuTime } dimensions { namespaceId }",
    value: (g) => sumField(g, "sum", "cpuTime"),
    breakdown: (g) => breakdownBy(g, "namespaceId", "sum", "cpuTime"),
    // 1 hour of aggregate DO CPU, in microseconds.
    alertThreshold: 3_600_000_000,
  },

  // --- Vectorize ------------------------------------------------------------
  {
    id: "vectorize",
    label: "Vectorize queries",
    product: "Vectorize",
    bindings: ["(account-wide)"],
    unit: "queried vector dimensions",
    dataset: "vectorizeQueriesAdaptiveGroups",
    // Verified via scripts/verify-datasets.mjs: this dataset exposes no `count`,
    // and the index dimension is `vectorizeIndexId` (not `indexName`).
    selection: "sum { queriedVectorDimensions } dimensions { vectorizeIndexId }",
    value: (g) => sumField(g, "sum", "queriedVectorDimensions"),
    breakdown: (g) => breakdownBy(g, "vectorizeIndexId", "sum", "queriedVectorDimensions"),
    alertThreshold: 50_000_000,
  },

  // --- Workers AI -----------------------------------------------------------
  {
    id: "workers-ai",
    label: "Workers AI inferences",
    product: "Workers AI",
    bindings: ["AI"],
    // Neurons are the Workers AI billing unit — track those, not raw calls.
    unit: "neurons",
    dataset: "aiInferenceAdaptiveGroups",
    selection:
      "count sum { totalNeurons totalInputTokens totalOutputTokens } dimensions { modelId }",
    value: (g) => sumField(g, "sum", "totalNeurons"),
    breakdown: (g) => breakdownBy(g, "modelId", "sum", "totalNeurons"),
    // Workers AI free allocation is 10k neurons/day.
    alertThreshold: 10_000,
  },

  // --- AI Gateway -----------------------------------------------------------
  {
    id: "ai-gateway",
    label: "AI Gateway requests",
    product: "AI Gateway",
    bindings: ["AI_GATEWAY_TOKEN"],
    // This dataset carries real upstream cost — the single most useful spend
    // signal in the whole registry.
    unit: "USD upstream cost",
    dataset: "aiGatewayRequestsAdaptiveGroups",
    selection:
      "count sum { cost cachedRequests erroredRequests uncachedTokensIn uncachedTokensOut } dimensions { gateway provider model }",
    value: (g) => sumField(g, "sum", "cost"),
    breakdown: (g) => breakdownBy(g, "model", "sum", "cost"),
    alertThreshold: 25,
  },

  // --- KV -------------------------------------------------------------------
  {
    id: "kv",
    label: "KV operations",
    product: "Workers KV",
    bindings: ["SESSIONS"],
    unit: "operations",
    dataset: "kvOperationsAdaptiveGroups",
    selection: "sum { requests } dimensions { namespaceId actionType }",
    value: (g) => sumField(g, "sum", "requests"),
    breakdown: (g) => breakdownBy(g, "actionType", "sum", "requests"),
    alertThreshold: 1_000_000,
  },

  // --- Workers (the Worker itself) -----------------------------------------
  {
    id: "workers",
    label: "Worker invocations",
    product: "Workers",
    bindings: ["(this Worker)"],
    unit: "requests",
    dataset: "workersInvocationsAdaptive",
    selection: "sum { requests errors } dimensions { scriptName }",
    value: (g) => sumField(g, "sum", "requests"),
    breakdown: (g) => breakdownBy(g, "scriptName", "sum", "requests"),
    alertThreshold: 2_000_000,
  },

  // --- Browser Rendering ----------------------------------------------------
  {
    id: "browser-rendering",
    label: "Browser Rendering time",
    product: "Browser Rendering",
    bindings: ["MYBROWSER"],
    // Browser time is the billed unit; `browserRenderingAdaptiveGroups` does
    // not exist (verified via scripts/verify-datasets.mjs).
    unit: "ms browser time",
    dataset: "browserRenderingBrowserTimeUsageAdaptiveGroups",
    selection: "sum { totalSessionDurationMs } dimensions { sessionId }",
    value: (g) => sumField(g, "sum", "totalSessionDurationMs"),
    // 3 hours of aggregate browser session time per window.
    alertThreshold: 10_800_000,
  },

  // --- Workflows ------------------------------------------------------------
  {
    id: "workflows",
    label: "Workflow CPU",
    product: "Workflows",
    bindings: ["(account-wide)"],
    unit: "µs CPU",
    dataset: "workflowsAdaptiveGroups",
    selection: "sum { cpuTime wallTime stepCount retryCount } dimensions { workflowName }",
    value: (g) => sumField(g, "sum", "cpuTime"),
    breakdown: (g) => breakdownBy(g, "workflowName", "sum", "cpuTime"),
    alertThreshold: 600_000_000,
  },

  // --- Queues ---------------------------------------------------------------
  {
    id: "queues",
    label: "Queue operations",
    product: "Queues",
    bindings: ["(account-wide)"],
    unit: "billable operations",
    dataset: "queueMessageOperationsAdaptiveGroups",
    selection: "sum { billableOperations bytes } dimensions { queueId actionType }",
    value: (g) => sumField(g, "sum", "billableOperations"),
    breakdown: (g) => breakdownBy(g, "queueId", "sum", "billableOperations"),
    alertThreshold: 1_000_000,
  },

  // --- Containers -----------------------------------------------------------
  {
    id: "containers",
    label: "Container CPU",
    product: "Containers",
    bindings: ["(account-wide)"],
    unit: "CPU seconds",
    dataset: "containersUsageAdaptiveGroups",
    selection:
      "sum { cpuTimeSec allocatedMemory allocatedDisk txBytes } dimensions { applicationId }",
    value: (g) => sumField(g, "sum", "cpuTimeSec"),
    breakdown: (g) => breakdownBy(g, "applicationId", "sum", "cpuTimeSec"),
    alertThreshold: 86_400,
  },

  // --- Requested products without an account-level metered dataset ----------
  // These are declared so the panel shows them as "tracked, not metered"
  // instead of silently omitting them. Each `note` records WHY there is no
  // account-scoped number, so the gap is documented rather than mysterious.
  {
    id: "email-service",
    label: "Email Service",
    product: "Email",
    bindings: ["(send_email)"],
    // emailSendingAdaptiveGroups / emailRoutingAdaptive are ZONE-scoped
    // (viewer.zones, $zoneTag) — the Guardian probe path is account-scoped
    // (viewer.accounts), so this cannot be pulled here. Per-zone email volume
    // would need a separate zone-analytics path.
    unit: "not metered (zone-scoped)",
    dataset: null,
    selection: "",
    value: () => 0,
    alertThreshold: Number.POSITIVE_INFINITY,
  },
  {
    id: "logpush",
    label: "Logpush jobs",
    product: "Logpush",
    bindings: ["(account-wide)"],
    // Logpush bills on delivered log volume, exported to R2. The meaningful
    // signal is the R2 bucket the logs land in — see the Logpush triage
    // (reads cloudflare-managed-6a40525f), not a usage-adaptive dataset.
    unit: "not metered (see R2 triage)",
    dataset: null,
    selection: "",
    value: () => 0,
    alertThreshold: Number.POSITIVE_INFINITY,
  },
  {
    id: "vpc",
    label: "VPC services",
    product: "VPC",
    bindings: ["(account-wide)"],
    unit: "not metered",
    dataset: null,
    selection: "",
    value: () => 0,
    alertThreshold: Number.POSITIVE_INFINITY,
  },
  {
    id: "flagship",
    label: "Flagship",
    product: "Flagship",
    bindings: ["(account-wide)"],
    unit: "not metered",
    dataset: null,
    selection: "",
    value: () => 0,
    alertThreshold: Number.POSITIVE_INFINITY,
  },

  // --- Bindings with no analytics dataset -----------------------------------
  {
    id: "assets",
    label: "Static assets",
    product: "Workers Assets",
    bindings: ["ASSETS"],
    unit: "not metered",
    dataset: null,
    selection: "",
    value: () => 0,
    alertThreshold: Number.POSITIVE_INFINITY,
  },
  {
    id: "secrets-store",
    label: "Secrets Store",
    product: "Secrets Store",
    bindings: [
      "GITHUB_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_WRANGLER_API_TOKEN",
      "WORKER_API_KEY",
      "AI_GATEWAY_TOKEN",
      "GOOGLE_CREDS_SA_PRIVATE_KEY_PT_1",
      "GOOGLE_CREDS_SA_PRIVATE_KEY_PT_2",
      "GOOGLE_CREDS_SA_CLIENT_EMAIL",
    ],
    unit: "not metered",
    dataset: null,
    selection: "",
    value: () => 0,
    alertThreshold: Number.POSITIVE_INFINITY,
  },
  {
    id: "worker-loaders",
    label: "Worker Loaders",
    product: "Worker Loaders",
    bindings: ["WORKER_LOADERS"],
    unit: "not metered",
    dataset: null,
    selection: "",
    value: () => 0,
    alertThreshold: Number.POSITIVE_INFINITY,
  },
];
