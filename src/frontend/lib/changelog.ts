/**
 * @fileoverview Changelog + preview registry.
 *
 * One typed source of truth for both surfaces:
 *   - `/changelogs`         — shipped changes, newest first.
 *   - `/changelogs/preview` — proposed / staged work, grouped by PR size, so
 *                             every required piece is tracked before it is built.
 *   - `/changelogs/[id]`    — one entry in full.
 *
 * The shape mirrors how the sibling `core-remodel` worker models it: a numbered
 * kebab slug, a lifecycle `status`, an optional branch/PR, and a body. "Preview"
 * is not a separate type — it is every entry whose status is not yet `shipped`.
 *
 * Sizing is PR-effort, not calendar: XS a few lines · S one file · M a feature ·
 * L a subsystem · XL a multi-part epic that should itself be split when built.
 */

export type ChangeStatus = "shipped" | "in_progress" | "proposed";
export type PrSize = "XS" | "S" | "M" | "L" | "XL";

export type ChangeEntry = {
  /** `NNNN-kebab-slug` — the route id and sort key. */
  id: string;
  title: string;
  status: ChangeStatus;
  size: PrSize;
  /** Shipped date (`YYYY-MM-DD`) or null while proposed. */
  date: string | null;
  /** Which rebuild phase this belongs to (P0–P8), for grouping. */
  phase: string;
  /** One-line summary shown in lists. */
  summary: string;
  /** The scope, as the bullet list that becomes the PR description. */
  scope: string[];
  /** Deployed Worker version id, when shipped. */
  version?: string;
  /** Cross-links to other entry ids. */
  depends?: string[];
};

export const SIZE_LABEL: Record<PrSize, string> = {
  XS: "XS · a few lines",
  S: "S · one file",
  M: "M · a feature",
  L: "L · a subsystem",
  XL: "XL · split when built",
};

export const STATUS_LABEL: Record<ChangeStatus, string> = {
  shipped: "Shipped",
  in_progress: "In progress",
  proposed: "Proposed",
};

// ---------------------------------------------------------------------------
// The registry. Shipped first (reverse-chronological), then the proposal backlog.
// ---------------------------------------------------------------------------

export const CHANGELOG: ChangeEntry[] = [
  // ---- Shipped ----------------------------------------------------------
  {
    id: "0001-p0-polish-and-nav",
    title: "P0 — Legibility & navigation",
    status: "shipped",
    size: "L",
    date: "2026-07-20",
    phase: "P0",
    version: "218adeef",
    summary:
      "Made the shipped surface readable and reachable: intent-based number formatting, server-side id→name resolution, combobox emergency controls, template pages hidden from the navbar.",
    scope: [
      "format.ts: formatCount / formatExact / formatRatio — 258× not 25768%, commas on standout figures",
      "Resolve databaseId/namespaceId → names server-side in /api/guardian/usage (no UUIDs in charts)",
      "Emergency controls became comboboxes fed by live /api/storage/{r2,vectorize}",
      "Bindings capped (no comma-joined horizontal scroll)",
      "Navbar cleaned to Guardian · Dashboards · System; template showcase pages hidden but kept on disk",
      "listVectorizeIndexes + GET /api/storage/vectorize",
      "AGENTS.md laws 18–24",
    ],
  },
  {
    id: "0002-ai-gateway-cents-fix",
    title: "AI Gateway billing — cents → dollars",
    status: "shipped",
    size: "S",
    date: "2026-07-21",
    phase: "P0",
    version: "dd2a7470",
    summary:
      "The '$640 credit balance' scare was a unit bug: the AI Gateway billing API returns cents. Normalized to dollars at the backend boundary so the panel reads $6.40.",
    scope: [
      "centsToUsd at the guardian/ai-gateway.ts boundary — balance, spend limit, invoice, top-up",
      "Frontend AiGatewayBilling: one usd() formatter, no double-conversion",
      "Top-up write path flipped to dollars (min $10 / $5)",
      "Verified: balance $6.40, limit $50, invoice $0.05, top-up $10.50",
    ],
  },
  {
    id: "0003-webhook-provision-deadlock",
    title: "Webhook receiver — provision deadlock fix",
    status: "shipped",
    size: "S",
    date: "2026-07-21",
    phase: "P0",
    version: "4352361e",
    summary:
      "Cloudflare notification destinations could never be created: the create-time test request hit a receiver that failed closed until a secret existed, but the secret was stored only after creation.",
    scope: [
      "Store the shared secret in KV BEFORE creating the destination; roll back on failure",
      "Root-caused the parallel 'Authentication error' to a stale secret-store token (user re-stored with Notifications Write)",
      "Verified end-to-end: provision returns provisioned:true, dest:1",
    ],
  },
  {
    id: "0004-landing-redirect",
    title: "Landing page → Guardian dashboard",
    status: "shipped",
    size: "XS",
    date: "2026-07-21",
    phase: "P0",
    version: "dd2a7470",
    summary: "`/` served the leftover template hero; it now redirects to the Guardian dashboard.",
    scope: [
      "index.astro short-circuits with Astro.redirect('/dashboard/guardian')",
      "Template hero kept on disk for reference (AGENTS.md #22)",
      "Verified: / → 302 → /dashboard/guardian",
    ],
  },

  {
    id: "0250-codra-spend-monitor",
    title: "Per-worker spend monitor (codra)",
    status: "shipped",
    size: "M",
    phase: "P8",
    date: "2026-07-22",
    version: "0250ship",
    depends: ["0110-attribution-graph"],
    summary:
      "Dedicated spend monitoring for the core-codra code-review worker (which replaces the deprecated Gemini Code Assist) — and a generic per-worker monitor behind it. Tracks Cloudflare compute AND AI-provider cost, and flags plainly when a worker's AI isn't routed through its gateway (so provider billing is invisible Cloudflare-side).",
    scope: [
      "GET /api/guardian/worker/{name}/spend — CF compute (requests/errors/subrequests/CPU p50+p99) + AI-Gateway upstream cost by provider/model",
      "worker-spend.ts: workersInvocationsAdaptive (scriptName filter) + aiGatewayRequestsAdaptiveGroups (gateway filter) in one GraphQL query",
      "/dashboard/codra + generic WorkerSpendMonitor island",
      "Verified live: codra = 7,423 requests / 7,753 subrequests / 0 errors / CPU p99 56 ms over 30d",
      "Finding: codra's `codra` AI Gateway shows $0 — it is NOT routing AI through the gateway, so provider spend is only on Google/OpenAI's dashboards. UI recommends routing through the gateway or the native /api/ai proxy to meter + cap it",
    ],
  },

  {
    id: "0260-ai-model-pricing-catalog",
    title: "AI model pricing catalog + advisor (weekly cron)",
    status: "shipped",
    size: "L",
    phase: "P8",
    date: "2026-07-22",
    version: "0260ship",
    summary:
      "A weekly-refreshed, multi-provider AI model + pricing catalog in D1, plus API and MCP tools to list models, advise the cheapest capable model for a use case (via kimi-k2.7-code over the live catalog), and cost usage scenarios time-aware. Built for coding agents optimizing spend.",
    scope: [
      "D1 ai_model_pricing (append-only, scraped_at for time-aware lookup): provider, model, api_model_name, description, best_used_for, input/output/cached $ per 1M",
      "Weekly cron scrapes Anthropic/Google (fetch markdown + gpt-oss json_schema extraction) + OpenAI (deterministic JS-array parse) + Workers AI (models API price property, no neuron math)",
      "GET /api/ai-models · POST /advise (top-3 via @cf/moonshotai/kimi-k2.7-code) · POST /cost (array of scenarios, price as-of each timestamp) — mirrored as MCP tools ai_models_list/advise/cost",
      "Verified live: workers-ai 22 / anthropic 15 / google 9 / openai 44 models with correct input+output prices; cost calc exact ($10+$10+$2.50); advise returned qwen3-30b / gpt-5-nano / gemini-flash-lite for cheap high-volume",
      "ponytail: OpenAI ships a JS array not a table → regex parse beats AI; Workers AI already returns USD/1M so no neuron conversion; provider usage payloads over WASM tiktoken",
    ],
  },

  {
    id: "0270-ai-gateway-costs-and-crud",
    title: "AI Gateway actual-cost tracking, drift check + gateway CRUD",
    status: "shipped",
    size: "L",
    phase: "P8",
    date: "2026-07-22",
    version: "0270ship",
    depends: ["0260-ai-model-pricing-catalog"],
    summary:
      "The AI Gateway API has no third-party price catalog, but its analytics DO record what Cloudflare actually charged per model. A daily cron snapshots that into D1 (permanent history), a drift check compares it against our scraped list prices, the pricing-history query returns advertised-vs-actual over a date range, and full gateway CRUD lets coding agents manage gateways.",
    scope: [
      "D1 ai_gateway_costs (deterministic PK, daily cron snapshot of aiGatewayRequestsAdaptiveGroups — 508 rows live; GraphQL only retains ~31d, D1 keeps forever)",
      "GET /api/ai-gateway-admin/costs + drift; POST /snapshot — mirrored MCP ai_gateway_actual_costs / ai_gateway_price_drift",
      "POST /api/ai-models/pricing-history + MCP ai_models_pricing_history: advertised (scraped) vs actual (gateway) over a date range, source=both|scraped|gateway",
      "Drift is third-party-only (Workers AI @cf bills by neurons, not the catalog token price — comparing bases is apples-to-oranges). Verified: gemini scraped ≈ actual (within 10%), validating the scrape",
      "Advisor now blends observedGatewayPerM (real paid $/1M) so consultations reflect actual cost + fluctuation",
      "AI Gateway CRUD (API + MCP: list/get/create/update/delete) — update sends the FULL merged config so a PUT never resets unspecified settings; verified list=20, get, update-preserves-config, create errors correctly at the account's 20-gateway max",
      "Chosen ingestion: daily cron over GraphQL analytics (no Enterprise Logpush needed); Logpush stays the future per-request upgrade",
    ],
  },

  // ---- Proposed backlog -------------------------------------------------
  {
    id: "0100-auto-topup-modal",
    title: "Auto top-up → modal + AI Gateway panel reshape",
    status: "shipped",
    size: "S",
    phase: "P0",
    date: "2026-07-21",
    version: "0100ship",
    summary:
      "The auto top-up form left the spend governor's own page cluttered with a card that could spend. Collapsed it into a modal; the credit-balance card now carries a compact on/off status line with a Manage button.",
    scope: [
      "Auto top-up config moved into a shadcn Dialog (Manage button on the credit card)",
      "Credit card shows: auto top-up on/off + amount at threshold, inline",
      "Disable / Save / Cancel live in the modal footer; Save closes on success",
      "Per-gateway spend + config table already live below (gateways section)",
    ],
  },
  {
    id: "0110-attribution-graph",
    title: "P1 — Worker → binding → resource attribution graph",
    status: "shipped",
    size: "M",
    phase: "P1",
    date: "2026-07-21",
    version: "0110ship",
    summary:
      "Every resource can now name its owning worker(s) and binding. The 183-worker fan-out already lived in a 1h KV cache off the request path, so this exposes that graph both directions and keeps it warm on the cron — no new D1 tables needed.",
    scope: [
      "GET /api/guardian/attribution — resources (resource→workers) and workers (worker→resources), both views",
      "Opaque d1/kv ids resolved to names; orphaned bindings degrade to raw id",
      "Cron rebuilds the binding index each hour so the KV cache never misses on a page load",
      "Verified live: 184 workers, 399 resources (d1 107 / kv 110 / r2 83 / vectorize 64 / queue 32 / hyperdrive 3); 103/107 d1 + 110/110 kv names resolved",
      "ponytail: KV blob is the materialization; add D1 tables only if history/SQL-join over attribution is needed (P2/P8)",
    ],
  },
  {
    id: "0120-pricing-scrape-pipeline",
    title: "P2 — Pricing catalog + doc-scrape pipeline",
    status: "shipped",
    size: "L",
    phase: "P2",
    date: "2026-07-21",
    version: "0120ship",
    depends: ["0110-attribution-graph"],
    summary:
      "Cloudflare has no pricing API, so overage rates are scraped monthly from the pricing docs. The docs are static HTML, so a plain fetch + Workers AI (gpt-oss-120b, json_schema output) extraction beats Browser Rendering — faster, no browser token, fits in a request.",
    scope: [
      "D1: scrape_runs (url, status, method, stripped text, revisions) + pricing_revisions (FK, append-only, versioned)",
      "Scraper: fetch(docUrl) → strip HTML → gpt-oss-120b json_schema extraction → clean/coerce → D1",
      "GET /api/guardian/pricing (latest revision per product/metric + scrape health) · POST /pricing/scrape (bg via waitUntil; ?product= sync)",
      "Cron gates a full re-scrape on 30 days since last run (no second trigger)",
      "Cost-basis page /dashboard/cost-basis — rates grouped by product, each labelled with scrape freshness",
      "Verified live: 26 rates across 5 products, 5/9 docs ok on first run",
      "ponytail: LLM extraction has variance (a rate can mis-scale); mitigated by visible scrape date + raw-text audit + monthly re-scrape. Browser Rendering was over-engineering for static docs",
    ],
  },
  {
    id: "0130-actionable-alerts",
    title: "P3 — Actionable alerts (allowance projection)",
    status: "shipped",
    size: "M",
    phase: "P3",
    date: "2026-07-21",
    version: "0130ship",
    depends: ["0110-attribution-graph", "0120-pricing-scrape-pipeline"],
    summary:
      "Guessed absolute thresholds are gone. Alerts now fire on % of the included allowance projected to period end, name the resource + owning worker, diagnose the cause, recommend a fix, and price the projected overage against the scraped catalog.",
    scope: [
      "alerts table: severity, resource, worker, cause, recommendation, projected_fraction, est_cost_delta, snooze/resolve lifecycle",
      "Flow vs level metrics: rows/requests SUM + straight-line project; stored bytes take the latest reading (no fake accumulation)",
      "Overage priced by matching the allowance unit to the right scraped rate metric (bytes→GB aligned); null, not a wrong number, when no metric matches",
      "GET /api/guardian/alerts (severity-sorted + counts) · POST /alerts/{id}/action (snooze 24h / resolve / reactivate) · POST /guardian/evaluate (run-now)",
      "AlertsBoard island leads the Guardian dashboard: severity summary card, per-alert resource+worker+cause+fix+%+$, snooze/resolve",
      "Verified live: r2-storage 399% ($0.45 overage, 3 owning workers) + workers-ai 793% critical; self-check on severity bands + metric-matched pricing",
      "ponytail: cost is a labelled estimate off scraped rates; the accurate signal is the projected %",
    ],
  },
  {
    id: "0140-dashboard-reshape",
    title: "P4 — Dashboard reshape: aggregates + per-binding pages",
    status: "shipped",
    size: "L",
    phase: "P4",
    date: "2026-07-21",
    version: "0140ship",
    depends: ["0110-attribution-graph", "0130-actionable-alerts", "0135-action-items"],
    summary:
      "The Guardian overview now leads with alerts, then pending action items, then the emergency panel. Per-resource detail moved to dedicated /dashboard/binding/[type]/[id] pages — usage, owning workers (attribution), and the binding's own action items.",
    scope: [
      "/dashboard/guardian: AlertsBoard (severity-first) → ActionItems widget → GuardianPanel",
      "/dashboard/binding/[type]/[id] (SSR): resource identity, 24h usage + share of service, owning workers from the attribution graph, per-binding action items",
      "Action items filter by service so a D1 page shows only D1 items (the per-binding-dashboard ask)",
      "Verified live: binding pages 200 for d1/flaremo and r2/cloudflare-managed-6a40525f",
      "Deferred: category-tier rollup pages (storage/ai/compute/network) + AI-insight blurb — the account→resource drill-down and per-binding action items are the core",
    ],
  },
  {
    id: "0150-r2-suite",
    title: "P5 — R2 archive to Drive (copy-only + gated delete)",
    status: "shipped",
    size: "L",
    phase: "P5",
    date: "2026-07-21",
    version: "0150ship",
    depends: ["0110-attribution-graph", "0135-action-items", "0160-drive-folder-config"],
    summary:
      "Archive an R2 bucket's objects to Drive object-by-object (via the v4 REST object API — no S3 SigV4 needed), one at a time so memory stays flat, then file a human-gated action item to delete the archived objects. Copy-only.",
    scope: [
      "r2-archive.ts: list (bounded) → GET each object's bytes → upload to <worker>/r2-archive/<bucket> in Drive → manifest → r2-object-batch action item",
      "POST /api/guardian/archive/r2 {bucket,max}; reports truncation, never implies full coverage",
      "Action-item delete handler purges the archived keys then verifies by re-listing the bucket",
      "Verified live: 5 objects from cloudflare-managed-6a40525f archived, truncated flag correct, action item filed",
      "ponytail: per-object copy, not a streamed zip — simpler, each object individually restorable, run capped. Zip-streaming only if object counts demand it",
      "Deferred from the original XL: report builder + TTL-policy admin (the archive + gated-delete is the spend-reclaim core)",
    ],
  },
  {
    id: "0160-drive-folder-config",
    title: "Drive folder self-service config",
    status: "shipped",
    size: "M",
    phase: "P5",
    date: "2026-07-21",
    version: "0160ship",
    summary:
      "Register Google Drive archive destinations without hardcoded ids or an always-on Durable Object: paste a folder URL/id, the worker extracts the id, validates the service account's access live, and saves to D1. Also delivers the SA-JWT Drive helper the archive flows need.",
    scope: [
      "google-drive.ts: RS256 SA-JWT minted with WebCrypto (no SDK), token exchange, getDriveFolder, extractDriveId — reused by P5",
      "D1 drive_folders (purpose, folder_id, url, name, validated, error, validated_at)",
      "GET/POST /api/drive/folders — extract id → validate SA access → upsert; seeds root/r2/d1/cf-image ids",
      "/dashboard/drive-config page: paste URL, live validate & save, per-purpose status",
      "Verified live end-to-end: r2 seed folder validated as 'r2 archives' (real Drive round-trip through the two-part SA key)",
    ],
  },
  {
    id: "0135-action-items",
    title: "Action-items system — approve → execute → verify",
    status: "shipped",
    size: "M",
    phase: "P5",
    date: "2026-07-21",
    version: "0135ship",
    summary:
      "The connective tissue for gated destructive ops. Archive flows never auto-delete; they file a pending action item with the archive audit. The operator approves, the deletion runs, and completion is gated on a re-check that the source is actually gone.",
    scope: [
      "action_items table: kind, service, resource, audit JSON, status (pending→in_progress→complete|failed), verify_result",
      "Executor: per-resource-type delete + verify handlers (d1-database, r2-bucket); a delete that no-ops stays 'failed', never 'complete'",
      "GET /api/guardian/action-items (filter by service + status) · POST /action-items/{id}/approve",
      "ActionItems island: widget (pending only, per-binding via `service` prop) + full page /dashboard/action-items",
      "Widget leads the Guardian dashboard; each binding dashboard shows only its own items",
      "Verified live: approve → delete → CF error caught → failed with the reason recorded (safe test on a nonexistent db)",
    ],
  },
  {
    id: "0170-d1-archive",
    title: "D1 archive → JSON bundle + Python reconstruct",
    status: "shipped",
    size: "L",
    phase: "P5",
    date: "2026-07-21",
    version: "0170ship",
    depends: ["0160-drive-folder-config", "0135-action-items"],
    summary:
      "Export any D1 database (via the REST query API, not just this worker's binding) to a JSON bundle + a self-contained Python reconstruct script, upload both to Drive, audit the byte count, and file a deletion action item. Copy-only — never deletes. Verified end-to-end.",
    scope: [
      "d1-archive.ts: schema + every table serialized to one JSON bundle; reconstruct.py pulls creds via `tokens show <SECRET> --value-only`",
      "POST /api/guardian/archive/d1 {uuid,name} → Drive upload + byte-match audit + pending action item",
      "Drive via DOMAIN-WIDE DELEGATION (impersonate the Workspace user) → uploads land in a real My Drive, no Shared Drive needed",
      "Auto-managed folders: find-or-create <worker>/d1-archive (owned or shared-with-user); zero hardcoded ids, zero operator setup",
      "Verified live: flaremo archived, byte-match audit passed (153=153), folder auto-created, action item filed",
      "ponytail: one JSON bundle keyed by table, not per-table files + a zip dep — same data, less machinery",
      "TODO for the 1.6 GB core-github-api-webhooks case: paginate SELECT * + stream the upload (single-JSON would OOM the 128 MB worker)",
    ],
  },
  {
    id: "0180-cf-images",
    title: "Cloudflare Images — bulk archive to Drive",
    status: "shipped",
    size: "M",
    phase: "P5",
    date: "2026-07-21",
    version: "0180ship",
    depends: ["0135-action-items", "0160-drive-folder-config"],
    summary:
      "Bulk-archive Cloudflare Images to Drive: download each blob and upload it (one at a time) to <worker>/cf-image-archive, write a manifest, and file one human-gated action item to bulk-delete the archived images. Filter by age; bounded per run.",
    scope: [
      "cf-image-archive.ts: list (optionally olderThanDays) → download blob → Drive → manifest → cf-image-batch action item",
      "POST /api/guardian/archive/images {olderThanDays,max}",
      "Batch delete handler removes each image id then verifies none still resolve",
      "Verified live: 3 images (758 KB) archived to Drive, action item filed",
      "Deferred: the usage-vs-allowance viewport UI (the archive + gated-delete is the reclaim core)",
    ],
  },
  {
    id: "0190-ai-proxy-breaker",
    title: "P6 — AI proxy + two-tier circuit breaker",
    status: "shipped",
    size: "L",
    phase: "P6",
    date: "2026-07-21",
    version: "0190ship",
    depends: ["0120-pricing-scrape-pipeline"],
    summary:
      "Native provider calls that bypass AI Gateway are now metered and halt-able. POST /api/ai/{provider}/{model} relays to OpenAI/Anthropic/Google with the caller's own key, meters cost from the provider's usage payload against a KV price map, and 429s when a monthly rolling cost exceeds the cap. No idle DO — the counter lives in KV.",
    scope: [
      "/api/ai/{provider}/{model}: fetch relay (caller's key via X-Provider-Key, never stored); breaker checked BEFORE the provider is touched",
      "KV rolling monthly cost counter + cap; GET/PUT /api/ai/budget; POST /api/ai/budget/break-glass (allow past the cap for N hours)",
      "Two-tier: this KV breaker governs the native path; AI Gateway native Spend Limits govern the gateway path (guardian/ai-gateway.ts)",
      "Verified live: cap set $50, status armed/remaining correct, month key, relay reaches the provider; self-check on prefix-price + month-key",
      "ponytail: a fetch relay, NOT 3 bundled provider SDKs (bundle/compat risk); provider usage payloads, NOT WASM tiktoken — exact + free. Upgrade only if a call lacks usage",
      "ponytail: KV read-modify-write isn't atomic — a burst can under-count slightly; fine for a soft governor with the gateway hard-limit behind it. DO counter only if exactness matters",
      "Deferred: budget UI card (API is the governance surface) + fixing the aiGateway probe's token-field selection",
    ],
  },
  {
    id: "0200-health-page",
    title: "P7 — Health service + /health page",
    status: "shipped",
    size: "M",
    phase: "P7",
    date: "2026-07-21",
    version: "0200ship",
    summary:
      "Expanded the health checks with Cloudflare REST, GraphQL Analytics, and R2 reachability, and shipped the /health page: run the diagnostic, see each check pass/fail with latency, a health score, and a copy-ready fix prompt for any failure.",
    scope: [
      "health.ts: checkCloudflareRest + checkGraphQL + checkR2 alongside D1, Workers AI, agent pings (11 checks)",
      "/health page: Run button → POST /api/health/run, per-check status grid, N% healthy score",
      "Per-failure copy-to-clipboard coding-agent fix prompt + inline toast (never a browser alert)",
      "Verified live: overall healthy, all 11 checks passing (R2 sees 20 buckets, GraphQL + REST OK)",
      "Google Drive connectivity check deferred to the Drive helper (0160/0150)",
    ],
  },
  {
    id: "0210-mcp-oauth-audit",
    title: "P8 — Audit tools (worker audit + allowances)",
    status: "shipped",
    size: "M",
    phase: "P8",
    date: "2026-07-21",
    version: "0210ship",
    depends: ["0110-attribution-graph"],
    summary:
      "The audit surface: GET /api/guardian/worker/{name}/audit lists every resource a worker binds (from the attribution graph, names resolved), and GET /api/guardian/allowances returns the current period with per-binding included / used / projected / remaining — non-comparable probes return raw usage, never a fabricated remaining.",
    scope: [
      "GET /api/guardian/worker/{name}/audit — resources by type, resolved names, binding names",
      "GET /api/guardian/allowances — billing period + per-probe allowance status (flow SUM vs level latest)",
      "Verified live: 9to5 → 1 d1 + 1 kv; allowances show workers-ai 2419%/day, r2-storage 399%, comparables with remaining, non-comparables null + note",
      "Deferred: OAuth-wrap the MCP server (workers-oauth-provider DCR) + mcp_tool_calls logging + full MCP↔API parity — the audit READ tools are the immediate value; bearer auth on MCP already works",
    ],
  },
  {
    id: "0220-new-probes",
    title: "Add probes: Browser Run, Queues, Workflows, VPC, Email, Flagship, Logpush, Containers",
    status: "shipped",
    size: "S",
    phase: "P1",
    date: "2026-07-21",
    version: "0220ship",
    summary:
      "Browser Rendering, Queues, Workflows and Containers already had metered probes. The remaining requested products have no account-scoped metered dataset, so they are declared as tracked-but-not-metered with the reason recorded — honest over silently omitted.",
    scope: [
      "Confirmed browser-rendering / queues / workflows / containers probes already live and metered",
      "Added email-service, logpush, vpc, flagship as dataset:null probes (21 probes total, verified live)",
      "Email analytics are ZONE-scoped (viewer.zones) — unreachable from the account-scoped probe path; noted in the probe",
      "Logpush bills on delivered volume in R2 — the signal is the bucket, tracked via the R2 triage (0230), not a usage dataset",
    ],
  },
  {
    id: "0230-logpush-triage",
    title: "Logpush log-file triage",
    status: "shipped",
    size: "S",
    phase: "P8",
    date: "2026-07-21",
    version: "0230ship",
    summary:
      "The account ships logs to R2 bucket cloudflare-managed-6a40525f. Guardian now walks that bucket and rolls the objects up by key prefix (date/stream) so log-volume spend can be traced to the day producing it.",
    scope: [
      "GET /api/guardian/logpush — volume by top-level prefix + the largest objects",
      "Paged scan capped at 10×1000 objects; reports scanned + truncated, never implies coverage it didn't reach",
      "Verified live: 502 objects grouped by date (20260718…20260721)",
      "ponytail: line-level search deferred — the prefix rollup already localizes a surge to the stream/day; add gunzip+grep only when a case needs it",
    ],
  },
  {
    id: "0240-catalogs-pipelines-cost",
    title: "Data Catalogs + Pipelines — real cost & storage",
    status: "shipped",
    size: "S",
    phase: "P4",
    date: "2026-07-21",
    version: "0240ship",
    summary:
      "Data Catalogs are backed by R2 buckets, so their storage IS that bucket's size — the storage summary now joins each catalog to its backing bucket bytes (cost derives from the R2 rate on the cost-basis page), and lists pipelines with status.",
    scope: [
      "/api/storage/summary catalogs → {count, totalBytes, items:[{bucket, sizeBytes}]}",
      "pipelines → {count, items:[{name, status}]}",
      "Verified live: catalog acre-forensics-sql joined to its backing bucket",
      "ponytail: no separate cost field — the $/GB rate already lives on /dashboard/cost-basis; storage × rate is the estimate",
    ],
  },
  {
    id: "0300-jules-github-hotfix-agent",
    title: "GitHub emergency-hotfix agent (dry-run)",
    status: "shipped",
    size: "L",
    phase: "P9",
    date: "2026-07-21",
    version: "0300ship",
    summary:
      "DRY-RUN ONLY (per the operator's choice): given a repo, file, and instruction, Guardian fetches the file, has Workers AI apply the change, commits to a new branch, and opens a DRAFT pull request for a human to review and merge. It never merges and never deploys.",
    scope: [
      "hotfix.ts + POST /api/guardian/hotfix {repo, path, instruction} via the GITHUB_TOKEN binding",
      "AI proposes the full patched file; empty/no-change PRs are labelled so; every PR body warns it's an unverified AI proposal",
      "Draft PR only — no auto-merge, no deploy; a human is always the merge gate",
      "Verified: GitHub auth + error handling work (structured 404 on a missing path); first real draft PR left for the operator to trigger (opening a PR is an outward action)",
      "Deferred by design: Jules API, bulk cross-worker patching, auto-merge + deploy-verify — auto-merging to live workers is out of scope for a spend guard",
    ],
  },
];

/** Newest shipped first; then proposals in id order. */
export function sortedChangelog(): ChangeEntry[] {
  return [...CHANGELOG].sort((a, b) => {
    if (a.status === "shipped" && b.status === "shipped") {
      return (b.date ?? "").localeCompare(a.date ?? "");
    }
    if (a.status === "shipped") return -1;
    if (b.status === "shipped") return 1;
    return a.id.localeCompare(b.id);
  });
}

export const shipped = () => sortedChangelog().filter((e) => e.status === "shipped");
export const proposed = () => sortedChangelog().filter((e) => e.status !== "shipped");
export const findEntry = (id: string) => CHANGELOG.find((e) => e.id === id) ?? null;
