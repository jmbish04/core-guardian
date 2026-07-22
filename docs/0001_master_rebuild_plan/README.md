# Core Guardian — Master Rebuild Plan

## Status
the Core Guardian rebuild is complete — all 21 tracked changes shipped, browse them at /changelogs.

## Context

Core Guardian is a Cloudflare spend-governance dashboard on a single Worker (Astro SSR + Hono
zod-openapi + D1/Drizzle + Agents SDK). The first build shipped panels nobody could open (verified
only via bearer-token scripts that bypass the session cookie), UUID pie charts, raw integers,
free-text destructive inputs, and an unlinked `/login`. This plan is the full rebuild.

**Living design doc already deployed** at `/docs/architecture`
(`src/frontend/pages/docs/architecture.astro`) with 7 Mermaid diagrams + prototypes. After each
phase lands, update that page — it is the documentation deliverable, not a throwaway.

**Four decisions locked this session:**
1. **Build P0 first** (polish + nav), rest follow in dependency order.
2. **MCP OAuth = discovery/DCR metadata backed by the `WORKER_API_KEY` secret** (`await
   env.WORKER_API_KEY.get()`), via Cloudflare `workers-oauth-provider` / Agents `McpAgent` — no
   user DB.
3. **R2→Drive archive = decoupled 3-phase**: compress source → `TEMP_ZIP_BUCKET` (client-zip
   stream) → upload to Drive (exact Content-Length, multipart/related) → D1 audit → cleanup. D1
   insert happens *after* Drive confirm and *before* source delete (zero data loss).
4. **Circuit breaker = two-tier**: AI Gateway native Spend Limits enforce gateway traffic; a KV
   rolling-cost counter enforces native-SDK proxy calls that bypass the gateway. **No idle DO** —
   answers the "is a DO running up charges" worry: breaker state lives in KV, not an always-on DO.

**Verified against the live Cloudflare API/docs (grounding, not assumption):** no pricing API
exists; `/billing/usage` omits D1/R2/DO/AI; R2 has no last-access timestamp (cleanup reasons on
upload age + bucket-level TTL, not read recency); `/browser-rendering/{json,markdown}` exist for
dual extraction; Workers AI per-model pricing via `/ai/models/search?format=marketplace`; AI
Gateway billing is real USD. Allowance table already curated + unit-tested in
`src/backend/guardian/allowances.ts` (D1 → 155% projection verified).

---

## What already exists (reuse, do not rebuild)

- `src/frontend/lib/format.ts` — `compactNumber`, `humanSize`, `relativeTime`, `shortDate`.
- `src/backend/guardian/resources.ts` — `cfApi`, `getBindingIndex` (BindingIndex, cached in
  SESSIONS KV 1h), `listR2Buckets`, `listR2Objects`, `listD1Databases`, `listKVNamespaces`,
  `listPipelines`, `listDataCatalogs`, `mapLimit`.
- `src/backend/guardian/allowances.ts` — `ALLOWANCES`, `allowanceStatus`, `periodElapsed`.
- `src/backend/guardian/ai-gateway.ts` — credit/limit/usage/invoice/topup billing fns.
- `src/backend/guardian/probes.ts` — 14 metered probes; `ai-gateway` probe already selects
  `cost cachedRequests erroredRequests uncachedTokensIn uncachedTokensOut`.
- `src/backend/api/routes/health.ts` — GET `/api/health`, `/latest`, POST `/run`; D1-persisted;
  descriptor-driven check list (agents + d1_roundtrip + workers_ai_binding).
- `src/backend/api/routes/mcp.ts` — 19 MCP tools, bearer-`WORKER_API_KEY` auth, JSON-RPC.
- `src/backend/api/routes/guardian.ts` — `guardianAuth` middleware, usage/cron/events/history.
- `src/backend/api/index.ts` — `/openapi.json`, `/scalar`, `/swagger` mounted at root + `/api`,
  dynamic via `app.doc` (zod-openapi). **Already dynamic — feature #2 is mostly nav wiring.**
- `src/frontend/lib/config.ts` — `siteConfig.navItems` / `navGroups` (nav source of truth).
- `MYBROWSER` (Browser Rendering), `GOOGLE_CREDS_SA_*`, `WORKER_API_KEY` bindings already in
  `wrangler.jsonc`.

---

## Roadmap (dependency-ordered)

| Phase | Deliverable | Depends |
|-------|-------------|---------|
| **P0** | Polish & nav (BUILD NOW) | — |
| P1 | Attribution graph (worker→bindings→resources) | P0 |
| P2 | Pricing catalog + scrape pipeline | P1 |
| P3 | Actionable alerts (allowance projection) | P1+P2 |
| P4 | Information architecture (3-tier drill-down) | P3 |
| P5 | R2 suite: report + TTL admin + Drive archive | P1 |
| P6 | AI proxy + two-tier circuit breaker | P2 |
| P7 | Health service + `/health` page | P0 |
| P8 | MCP-OAuth + API parity + worker/billing audit | P1 |

---

## P0 — Polish & Nav (the immediate build)

**Goal:** make the shipped surface legible and reachable. No new backend data.

- **`format.ts` — one helper per intent** (extend, keep existing):
  - `formatCount(n)` → `45.5M` (compact, density).
  - `formatExact(n, unit?)` → `1,248,879,489 rows` (commas, for standout figures).
  - `formatRatio(value, limit)` → `258× over` above 1000%, else `72%` (no `25768%`).
  - keep `humanSize` for bytes. Ban bare `Intl` at call sites.
- **Resolve every raw id → name before render.** In `UsageGrid`/`UsageTrend`/`UsageTable`, map
  `databaseId`→database name, gateway id→gateway name, bucket key→name, using
  `getBindingIndex` + the list fns. No UUID ever reaches a chart, badge, or alert.
- **Emergency controls → comboboxes** (`GuardianPanel`): replace free-text bucket/index inputs
  with shadcn `combobox` (multi where relevant) fed by `listR2Buckets` /
  `listVectorizeIndexes` (add the latter to `resources.ts`, mirrors `listR2Buckets`). A typo can
  no longer reach a destructive call.
- **Bindings 3-per-row, capped** — replace any `bindings.join(", ")` with a 3-col grid + top-N +
  "…N more" collapse (`UsageTable`, storage components).
- **Drop the outer card wrapper** on `guardian.astro` sections; sit on the background.
- **Nav (`config.ts`)**: hide the template leftovers from the navbar **without deleting code**
  (remove the Workspace group + `/showcase/*` items from `navItems`/`navGroups`; the pages/routes
  stay on disk and reachable by URL). Ensure System group links: `/dashboard/guardian`,
  `/dashboard/storage`, `/dashboard/ai-gateway`, `/dashboard/alerts`,
  `/dashboard/notifications-inbox`, `/docs`, `/docs/architecture`, `/login`, `/health` (P7),
  `/openapi.json`, `/scalar`, `/swagger`.
- **Verify signed in**: after deploy, open `/login` in the browser, authenticate with
  `WORKER_API_KEY`, screenshot the Guardian panel rendering real data. A page is not done until
  seen authenticated.

**Files:** `src/frontend/lib/format.ts`, `src/frontend/lib/config.ts`,
`src/frontend/components/dashboard/{UsageGrid,UsageTrend,UsageTable,GuardianPanel}.tsx`,
`src/frontend/pages/dashboard/guardian.astro`, `src/backend/guardian/resources.ts` (add
`listVectorizeIndexes`).

---

## P1 — Attribution graph

New D1 tables (`db/schemas/governance/`): `worker_scripts`, `worker_bindings`,
`binding_resources`. Cron turns `getBindingIndex`'s 183-worker fan-out into a **writer** (persist,
don't compute at request time). Every resource everywhere gains owning worker + binding name +
deployed URL. New `GET /api/guardian/attribution` (resource→worker, worker→resources).

## P2 — Pricing catalog + scrape pipeline

`allowances.ts` done. Add: monthly cron scrapes each `docUrl` via Browser Rendering
(`/browser-rendering/json` schema-first, fall back to `/markdown` + a Workers AI extraction pass).
D1 `scrape_runs` (url, ts, status, markdown, raw json) + `pricing_revisions` (FK→scrape_run;
product, metric, unit_price, currency, effective_from). Spend calc joins usage → latest revision;
a rate change writes a `billing_events` row. Cost-basis frontend page (prototype already on
`/docs/architecture`). Workers AI rates also from `/ai/models/search?format=marketplace`.

## P3 — Actionable alerts

`alerts` table (severity, resource, worker, cause, recommendation, est_cost_delta, snoozed_until).
Governance model = **% of monthly included allowance, projected to period end** via
`allowanceStatus` — NOT guessed absolutes (that's why the 5M/hr D1 threshold fired hourly).
Diagnosis rules map surge→cause→fix. Alert card names resource+worker, prices impact, recommends
fix, offers inspect/retune/snooze/mitigate. Retune-from-alert closes the re-fire loop.

## P4 — Information architecture

`/dashboard` = account aggregate, alerts first, spend trend, category doors (no binding names) →
`/dashboard/storage|ai|compute|network` → `/dashboard/binding/[type]/[id]` (one resource: trend,
attribution, AI insight, lifecycle actions). Bindings grouped by worker, top-3 + collapse.

## P5 — R2 suite

- **Report builder**: per bucket → name, dashboard link, total size, **worker mapping** (via
  `getBindingIndex`), **is-data-catalog** flag (via `listDataCatalogs`); collapsible appendix per
  bucket with recursive file listing (filename, size, date added, folder links); sort/filter by
  size and age.
- **Delete bucket** with shadcn `AlertDialog` type-to-confirm, recursive object delete.
- **TTL admin**: multi-autocomplete bucket picker → per-bucket policy
  `[30/60/90/120/custom/none]`, default **none**. Stored in a `bucket_ttl_policies` D1 table;
  cron enforces (applies R2 lifecycle Expire rule matching policy, merging existing rules — never
  clobbering the Default Multipart Abort rule, per the known hazard).
- **Drive archive (3-phase, decoupled)**: needs `TEMP_ZIP_BUCKET` R2 binding + `client-zip` dep +
  a Google Drive SA-JWT helper (`src/backend/lib/google-drive.ts`, mint token from
  `GOOGLE_CREDS_SA_*`, no SDK — REST multipart/related). D1 `bucket_archives` (source_bucket,
  archive_zip_name, drive_file_id, drive_url, size_bytes, archived_at). Phase1 stream-zip
  source→TEMP; Phase2 upload TEMP→Drive with exact size, write D1; Phase3 delete source + temp.
  Runs as a Queue/Workflow job, not one request. Restore path documented (pull zip from Drive →
  stand up in a Drive folder).

## P6 — AI proxy + two-tier breaker

`/api/ai/gateway/*` and `/api/ai/:provider/:model` **replicating each provider's API shape** so
existing native callers need no changes; the **caller passes its own provider key**, we relay via
the official **Google GenAI / OpenAI / Anthropic SDKs** inside the Worker. Token accounting: prefer
provider `usage.{prompt,completion}_tokens`; else **WASM tiktoken** boundary count. Price map
(`model→{in,out} rate`) in KV; rolling cost in a **KV counter**; breach → **429 Budget Exceeded**
before the provider is touched. Gateway-routed traffic additionally governed by AI Gateway native
**Spend Limits** (set/reset via API; kill-switch = `PUT rate_limiting_limit:0`). Snooze/break-glass
(`+$75` default) clears the pause and bumps the allowance. Fix the AI-cost GraphQL to select
`sum { tokensIn tokensOut cachedTokensIn cachedTokensOut cost }` (verify field names —
current probe uses `uncachedTokensIn/Out`).

## P7 — Health service + `/health` page

Expand `health.ts` descriptor list: CF REST reachability, GraphQL query, R2 access, Google Drive
connectivity (P5 helper), each pricing scrape target. Frontend `/health` page: **Run** button →
realtime results, per-check pass/fail + error text, overall health score, and for any failure a
**coding-agent fix prompt** with a shadcn copy-to-clipboard button + shadcn confirmation toast
(**never a browser alert**). Add `/health` to nav.

## P8 — MCP-OAuth + API parity + audit tools

- **OAuth-wrap MCP** (`workers-oauth-provider` / `McpAgent`): serve OAuth discovery +
  dynamic-client-registration so Claude connects one-click; back the credential with
  `await env.WORKER_API_KEY.get()`. Keep bearer as fallback.
- **Log every MCP call** to D1 `mcp_tool_calls` (tool, args hash, caller, ts, ok, ms).
- **Worker audit** tool + `GET /api/guardian/worker/:name/audit` → that worker's usage + every
  binding's usage (reuse `getBindingIndex` + probes).
- **Billing-period + freebie** tool + `GET /api/guardian/allowances` → current billing period
  (start/end), per-binding usage, included allowance, used, remaining — from `allowanceStatus`
  (`comparable:false` items return raw usage, no fabricated remaining).
- **Parity rule**: every MCP tool has a matching API route and vice-versa.

New deps across phases: `client-zip` (P5), `@dqbd/tiktoken` or `js-tiktoken` WASM (P6),
`workers-oauth-provider` (P8), provider SDKs `@google/genai` `openai` `@anthropic-ai/sdk` (P6).
New bindings: `TEMP_ZIP_BUCKET` (P5), `AI_BUDGET` KV (P6, or reuse SESSIONS). New migrations per
phase via `drizzle-kit generate` → `migrate:remote`.

---

## Verification (every phase)

1. `npx -p typescript@5.9.3 tsc --noEmit` clean (ignore known WorkflowsAgent decorator error).
2. `pnpm build` clean.
3. Deploy `wrangler deploy -c dist/server/wrangler.json`.
4. **Browser, signed in**: open the affected page via `/login`, screenshot it rendering real
   data. Bearer-token script checks do NOT count as verification.
5. Backend probes via `scripts/*.mjs` (`workerFetch`) for API shape.
6. MCP via `scripts/mcp-smoke.mjs` (initialize → tools/list → tools/call).
7. Unit self-checks for non-trivial logic (e.g. `allowances.ts` projection, tiktoken counts,
   allowance math) — assert-based, runnable.
8. Update `/docs/architecture` and the AGENTS.md / `.agent/rules` laws after the phase.

## AGENTS.md / .agent/rules updates (mandated by meta-maintenance.md, overdue)

Add laws: (1) browser-verify signed in; (2) never render a raw id where a name exists;
(3) one format helper per intent; (4) every alert names resource+owner+next-step; (5) new page ⇒
nav entry same commit; (6) check cloudflare-docs/cloudflare-api MCP before assuming an API exists;
(7) update AGENTS.md + rules when a convention is set.
