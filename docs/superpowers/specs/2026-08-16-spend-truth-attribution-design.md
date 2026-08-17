# Spend Truth & Attribution — billing-reconciled, backend-computed, real-time refresh

**Date:** 2026-08-16
**Status:** Design — awaiting review
**Companion to:** `2026-08-16-guardian-overview-redesign-design.md` (this owns the
numbers + pipeline; that owns the page layout).

## Problem

1. **The frontend freezes.** Heavy analysis runs on page load (many islands each
   fetching + some computing/rendering), locking the browser.
2. **Numbers don't match the bill.** The cockpit shows *reconstructed estimates*
   (marginal overage rates — an upper bound) as if they were spend. Example: it
   reports ~$800 that is not on the Cloudflare bill.
3. **No lane separation.** Billed, projected, and disputed figures are conflated,
   so the user can't trust any single number.

## Principles

1. **The Cloudflare Billing API is the truth.** Every displayed figure is paired
   with, or reconciled to, `billable_usage` (actual charged cost).
2. **All compute on the backend.** The frontend only reads a pre-computed cached
   rollup from D1. No fan-out, no analysis on page load.
3. **Three lanes, always labeled:** Billed · Projected/preventable · Dispute.
4. **No AI in the pipeline.** Pure D1 + arithmetic.
5. **Snapshot over time.** Cron writes periodic snapshots so we can show deltas
   ("since last login, this exploded").

## Reuse — already built, do NOT rebuild

- **`billable_usage`** table + `syncBillableUsage` — actual charged cost per
  product from the Billable Usage API (`GET /accounts/{id}/billable-usage`),
  already synced on the hourly cron (`_worker.ts`), freshness-gated.
- **Accountant reconciliation** (`offense/accountant.ts`, `AccountantView`) —
  already computes `actualUsd / estimateUsd / discrepancyUsd / discrepancyPct`
  per SKU. Lanes ① and ③ exist; they're just siloed on `/dashboard/accountant`.
- **Per-resource usage breakdown** — probes already group by `databaseId /
  bucketName / vectorizeIndexId / scriptName` (`collectUsage` `.breakdown`).
- **Binding graph** — `getBindingIndex` maps `r2:<bucket>` / `d1:<id>` /
  `vectorize:<name>` → workers (KV-cached, cron-warmed).
- **`spend-attribution.ts`** — the pooling logic (sole-owner / shared /
  unattributed), already unit-tested.
- **Pricing** — scraped overage rates (`pricing.ts`) + AI model catalog. No CF
  pricing API; this is the "billing-page scraping."
- **`WorkflowsAgent`** DO — durable multi-step execution with real-time
  WebSocket progress. The refresh reuses it; no new binding.

## Granularity reality (the crux)

The Billing API bills per **product** (Workers Paid, R2, D1, Workers AI…),
zone-scoped at most — **never per resource or per worker.** So:

- **Product level → actual is knowable.** Show `billable_usage`, matches the CF
  dashboard 1:1.
- **Resource/project level → only an estimate exists.** CF doesn't bill per
  bucket/db/worker. We therefore **allocate the product's actual across its
  resources/projects in proportion to estimated usage.** Result: per-project
  numbers that **sum to the real bill**, labeled "est. allocation of billed
  cost" — never a raw upper-bound shown alone.

## Data model (D1)

New tables (Drizzle; `pnpm db:generate`):

- **`cf_resources`** — the resource registry, one row per billable resource with
  its own relational id. Columns: `id` (relational), `product` (r2/d1/kv/
  vectorize/images/durable_objects/workers_ai/…), `resource_type`,
  `resource_name`, `cf_id` (bucket name / db uuid / index name / namespace id),
  `first_seen`, `last_seen`, `active`. Not tied to a project.
- **`resource_usage_snapshots`** — periodic per-resource usage + estimated cost:
  `resource_id` (FK), `captured_at`, `window_hours`, `usage_qty`, `unit`,
  `est_cost_usd`. Append-only → powers over-time deltas.
- **`resource_bindings`** — persisted worker↔resource map from the bindings API:
  `worker`, `resource_id` (FK), `binding_name`, `updated_at`. (Persist what
  `getBindingIndex` already builds in KV.)
- **`spend_rollup`** — the cached, frontend-facing reconciled ledger (one row per
  rebuild, or per (period, scope)): the fully-joined per-product actual +
  per-project allocation + lanes. The frontend reads THIS, nothing else.
- **`review_checkpoints`** — `user_id`/session, `reviewed_at`, and a snapshot of
  headline totals, so the next login can compute "since last login."

Existing: `guardian_projects` (projects by worker), `billable_usage` (product
actual), `daily_cost` (estimate rollup).

## The lanes

Every number the API returns is tagged `{ lane, actualUsd?, estimateUsd?,
basis }`:

1. **Billed** — `billable_usage.contractedCost` per product. Truth.
2. **Projected / preventable** — run-rate projection to period end ("do nothing →
   +$X"). Clearly a forecast, never mixed into billed.
3. **Dispute** — `actualUsd − estimateUsd` where our estimate says the bill
   should be lower (the accountant's discrepancy, surfaced).

## Compute pipeline (backend, cron)

The hourly cron already runs `collectUsage` + `syncBillableUsage`. Extend it:

1. Upsert `cf_resources` from the resource listings (`listR2Buckets`, `listD1…`
   etc. already exist).
2. Write `resource_usage_snapshots` from the probe `.breakdown` (persist what's
   currently computed in-memory).
3. Persist `resource_bindings` from `getBindingIndex`.
4. Compute the **reconciled rollup**: per-product actual (`billable_usage`) →
   allocate across resources/projects by snapshot-estimated share → join
   bindings → per-project + per-resource + shared/unattributed, with all three
   lanes → write one `spend_rollup` row.

The frontend read path becomes a single cheap `SELECT` of the latest
`spend_rollup`. **This alone fixes the freeze, the cache stampede (AGY #4), and
the month-window bleed (AGY #5)** — no live fan-out on request. The current live
`GET /guardian/projects/usage` compute endpoint is retired in favor of the
rollup read.

## On-demand refresh (queue + workflow + websocket)

A **Refresh** button on the overview:

1. Enqueues a rebuild via the existing `WorkflowsAgent` (durable execution).
2. The workflow runs the same 4 cron steps above as tracked steps.
3. Progress streams to the frontend over the `WorkflowsAgent` **WebSocket** —
   live status ("syncing billable usage… snapshotting… reconciling… done").
4. **Coalesced/debounced**: a rebuild already in flight returns the existing run
   rather than starting a second. WebSocket is open only while the app is open —
   no standing cost.

## Over-time deltas

On login, write a `review_checkpoints` row (headline totals at that moment). The
overview shows "since last login: **+$X**" and flags any resource/project whose
estimated run-rate rose > N% — the "what exploded" signal.

## Actions (the payoff)

The point is to *act*. Surface, per project/resource:
- **Set a budget** (reuse AI-Router circuit budgets, extend to resources).
- **Stop the bleeding** — reuse existing controls: R2 evict, Vectorize drop, cron
  kill; add "archive/trim D1", "disable worker cron". Each tied to the
  resource/project so the user goes from "what exploded" → one click to stop it.

## Frontend changes

- Overview summary cards read `spend_rollup`; each headline shows **Billed** with
  **Projected** paired beside it (never billed alone-looking).
- `SpendByProject` → reconciled allocation (sums to the bill), lane-labeled.
- Accountant's actual-vs-estimate surfaced as the overview's Dispute lane.
- Retire client-side heavy compute; everything is a rollup read.

## Rollout (batches → one PR each, AGY-reviewed, deployed)

- **B1** — `cf_resources` + `resource_usage_snapshots` + `resource_bindings`
  tables; cron persists them. (No UI change; data starts accumulating.)
- **B2** — `spend_rollup` reconciliation (product actual → allocation → lanes);
  read endpoint; frontend reads cache. **Kills the freeze.**
- **B3** — lanes in the UI (Billed/Projected/Dispute pairing across overview +
  SpendByProject).
- **B4** — Refresh button → WorkflowsAgent workflow → WebSocket status.
- **B5** — login deltas (`review_checkpoints`) + budgets/stop-the-bleeding
  actions.

## Testing

- Pure unit tests (node:test, no network): the **allocation** function (product
  actual splits across projects by estimated share; sums back to actual within
  rounding), the **lane tagging**, and the **delta** computation. Reuse the
  existing `poolSpend` test style.
- Rollup endpoint returns a well-formed empty ledger when nothing is billed yet.

## Out of scope / open questions

- **Zone-scoped billing rows** (`ZoneId`) — fold into product totals for now;
  per-zone view later.
- **Historic backfill** — `billable_usage` syncs a 35-day window; snapshots start
  accumulating at B1, so deltas are shallow until history builds.
- **Budget enforcement vs advisory** — B5 starts advisory (alert at threshold);
  auto-enforcement (circuit trip) is a follow-on decision.
- **CF Queues binding** — B4 starts on `WorkflowsAgent` alone; add a real Queue
  only if coalescing/backpressure needs it.
