# Core Guardian — Roadmap & Status

Living status of Core Guardian: a Cloudflare spend-governance cockpit that
watches account-wide usage, attributes cost to real resources, halts runaway
spend, and archives/trims bloated data. Deployed as a single Worker
(`core-guardian.hacolby.workers.dev`) — Hono + zod-openapi → D1 + Drizzle →
Astro SSR + shadcn/ReUI → Agents SDK + AI Gateway.

Legend: ✅ shipped & deployed · 🔄 running autonomously · 🔜 next · 💤 backlog

---

## Why this exists

A recurring ~$600/mo Cloudflare bill. Root cause: **Workers-AI neurons** — the
"Regular Twitch Neurons" SKU at ~$588/90d. Two hard truths that shaped the product:

1. **Cloudflare bills every Workers-AI model as ONE lumped SKU.** The billing API
   gives no per-model breakdown. Only the **AI Gateway** logs attribute by model —
   and only for calls routed *through* the gateway.
2. **~90% of the neuron spend bypassed the gateway** (direct `env.AI.run`), so it
   was unattributable by any data source. The heavy burn cratered 99.5% on
   2026-08-13 when a local runaway scraper was killed.

North star: **route all AI through one monitored ingress, and make every SKU
trace back to the resource that drove it.**

---

## ✅ Shipped & live (by domain, with PRs)

### Foundation
- **Core Guardian rebuild** — governance, archives, AI breaker, global chart pieces (#1).
- **Per-worker spend monitor** + codra dashboard (#3).
- **Free vs paid plan awareness** — cost-based alert severity (#7).

### Usage & cost tracking
- **AI Gateway actual-cost tracking**, drift check + gateway CRUD (#5); request-log
  tracing of external AI usage (#8); default-gateway rebuilt for tracking/gating (#9).
- **AI model pricing catalog + advisor** — weekly scrape cron, API + MCP (#4).
- **Manual AI usage registration** + trace log (#10).
- **Daily cost tracker**, usage attribution, cost-calculator API, D1 indexes (#11).
- **Billable Usage API** — actual billed cost + estimate reconciliation (#14). This
  fixed the "$9 when it's ~$500" undercount: headline = `max(actual, estimate)` so a
  billing-lagged spike is never hidden (#24).
- **Billable catalog** — what action causes each bill line (#54).
- **Cost-trace mind map** (mindmapcn) (#9).

### External-provider billing
- **Anthropic / OpenAI / Cursor / Gemini** billing monitoring (#33), with token
  non-enumerability so keys are `console.log`/`util.inspect`-safe (#34).
- Gemini billing wired to the **cloud-billing scope** (not readonly) + billing-account
  id from `GCP_BILLING_ACCOUNT_ID` (#44, #48).
- Cursor: enabled then **dropped** — no billing API on individual plans (#47, #35, #61).

### AI Router (the monitored ingress) — spec #1–#4
- **Routing Core** (#17): `POST /api/ai-router/run` — gateway routing + circuit
  breakers + global kill switch, scoped `project:X` / `model:X/Y` / global.
- **Admin frontend** (#18): circuits, kill switch, recent requests.
- **Usage-by-project** (#20): aggregation, routes, chart + model drill.
- **Right-sizing recommendations** (#36) + **Jules right-sizing dispatch** + weekly
  cron (#45).
- **P12 smart proxy** (#40, #41): `{project, importance, budget}` → dynamic model
  pick + `model_substitutions` translation rule (swap a model at the router, no code
  change) with CRUD + UI.
- Fixed 3 latent bugs that meant `/run` had **never** served Workers-AI: missing
  `workers-ai` provider-key mapping (#55), model never injected into the upstream
  body → 400 (#57); the real path is `/api/ai-router/run` (the `/api/guardian/*`
  prefix is admin-gated).
- **codex-routines** now routes ALL its AI through `/run` → monitored, budgetable,
  remote kill switch (429 = disabled) + local `GUARDIAN_AI_ENABLED` off-switch.

### Spend Offense (zero-AI analysis; reuses AI Router breakers)
- **P1–P3** (#19): circuit-break events + auto-break (2-day spend > $35/day →
  incident + alarm), worker scanner (cron/bindings/freq/risk), GitHub-action scanner,
  exact billed-model classification.
- **P4+P5** (#22): Jules audit loop — nonce-authed findings intake + unattended
  dispatch (opens PRs, never merges); operator override restores the broken circuit.
- **P6** (#23): billing-anomaly dashboard — incidents + risk targets.
- **P9a** (#25): nuclear total-budget breaker + non-AI infra-spike guard.

### Accountant & attribution
- **P9c accountant** (#29, #30): actual-billed CF SKU ranking + est-vs-actual
  discrepancy flags ("math isn't mathing" dispute evidence) + AI attribution (by
  model / by project) + projection.
- **Spend rollup reconciliation** (#49) — kills the freeze; NaN-guard for stale cache
  (#63); **Billed / Projected / Dispute lanes** B3 (#62), on-demand refresh +
  since-last-review delta B4/B5 (#64).
- **Per-resource cost attribution** (#50): SKU rows expand to real drivers —
  **Durable Objects by script** (wall-time = GB-s, with a long-lived-DO smell flag,
  e.g. `dopamine` ~335s/request) and **Workers-AI gateway-coverage gap** (model mix +
  a loud unattributable-direct-AI line for the ~90% the gateway can't see).
- Dedup: DO attribution consolidated via #50 drivers, dead `/usage` dropped (#59).
- Spend attribution + header alerts/config + Billing settings (#39).

### AI recommendations — P11
- **Model-savings recommendations** (#37) + one-click Jules **switch-model** action,
  capability-gated so a swap never downgrades; **frontend** `/dashboard/ai-recommendations` (#38).

### Projects & Jules control plane — P14
- **Backend** (#27): `guardian_projects` + `jules_sessions` tables, nightly worker
  sync, hourly Jules poller (captures PR URLs), per-project control APIs
  (delete-worker, disable-crons). **Frontend** (#28): `/projects`, `/projects/[name]`,
  `/jules`. Pagination hardened (#43).

### Log pipeline + universal trimmer
- **Ingest** (#69): `POST /api/logs/ingest` → Queue `core-guardian-log-ingest` →
  consumer batch-inserts into a **separate D1** `core-guardian-logs` (`LOGS_DB`).
- **codex-routines ships ALL its logs** (`logging` records + raw `print()`/stderr via
  a stdout tee) to the ingest endpoint — batched, fail-soft, toggleable.
- **Universal trim** (#69): `trim_targets` registry + hourly cron → `LogTrimWorkflow`
  (durable): count → discover FK children → export parent+children to Drive →
  **verify** (read-back bytes == JSON bytes) → **truncate** (children-first, FK-safe)
  → finalize. Verify gates truncate — nothing deletes without a verified archive.
  FK-cascade + rowid-safe deletes (#72); a runnable `node:test` guards the SQL builders (#75).
- Drive layout: `d1 archives/<dbName>/<YYYY>/<MM>/<ISO>_<table>_export.json`.
- Live-verified on `webhook_deliveries`: 100 parent + 99 child rows archived +
  deleted, **0 orphans**.

### D1 archive & hygiene
- **Archive UI** + SQL/JSONL/py export + verified-gated cleanup (#16); per-table
  archive → verify → trim (#74).
- D1 read-cost cuts: freshness-probe index (#21), batch billable upserts (#65).

### Dashboard / UI
- Allowance display: compact numbers, D1 shows name not binding id,
  current-vs-projected, bullet bar (#26).
- **ReUI**: sidebar shell + data-grid anomalies + favicon (#51), tables onto ReUI Pro
  DataGrid (#66), review fixes + `REUI_LICENSE_KEY` binding (#71), page-shell chrome
  around dashboard grids (#73).

### Client SDK & MCP
- **Guardian Client SDK** — vendorable client + integration endpoint/tool + template
  auto-pull (#31); Python + Google Apps Script clients (#32); docs + v1.0.0 pinning (#60).
- **One-click MCP OAuth** — discovery + DCR + PKCE (#12).

### The cost fix
- **Killed the bleed** (#42): Core Guardian's own `MODEL_CHAT`/`EXTRACT`/`DRAFT` were
  `@cf/openai/gpt-oss-120b`; swapped to `llama-3.3-70b-fp8-fast` + killed the hardcoded
  gpt-oss fallbacks. (#58: `llama-3.1-8b` was CF-deprecated → 410, moved draft to 70b.)

### Infra resilience
- snapshotResources resilience + diagnostics when infra tables are empty (#67, #70);
  dedupe resource_bindings composite key (#76); snapshot chunk 16→12 for the D1 param
  limit (#78); zones sync uses the top-level `/zones` endpoint (#79); CI actions on
  Node 24 (#77).

---

## 🔄 Running autonomously (no action needed)

- **webhooks trim**: `webhook_deliveries` (~89k rows) trims ~10k/hour on the cron down
  to the 20k keep-window (~7 ticks), each batch archived to Drive first.
- **logs-table trim target**: seeds on the next cron tick; no-op until `logs` grows
  past the 50k threshold.
- **Hourly cron**: guardian usage evaluation, Jules poller, worker/binding sync,
  trim-target dispatch. **Weekly cron**: pricing-catalog scrape, right-sizing recs.

---

## 🔜 Next

- **Logs & trim dashboard page** — the whole log pipeline is currently headless.
  A page to view `LOGS_DB` (filter by source/level/time) and the `trim_targets`
  registry (threshold, keep-window, last run, last export path, last error,
  enable/disable, "run now"). Today this data is only reachable by querying D1 by hand.
- **Push codex-routines branches** — `feat/scraper-pipeline-resilience` (log shipper
  `975cac4` + stdout shim `b0b698b`) + earlier AI-routing commits are committed locally
  but unpushed. One commit swept in unrelated changes via `git add -A`; review + split
  before pushing.
- **Mandate the gateway for all Workers-AI** — a guard that rejects/flags any direct
  `env.AI.run` across projects, so neuron spend can never again be unattributable. The
  strategic endgame the attribution work points at.

---

## 💤 Backlog

- **P10 dashboard IA** — overview-of-overviews + per-billable drill pages (the original
  "hard to read" complaint).
- **D1 strategy page** — archive/index/cleanup surface with Jules buttons (index
  installs + cleanup) gated on archive-to-Drive. (Actual D1 overage is only ~$3.92/90d
  — hygiene, not urgent; the trim workflow now covers part of this.)
- **P13 Codra integration** — Codra reports its AI usage, pulls savings recs, enforces
  routing through Core Guardian. Backend API ready; needs a session driven in the codra
  repo.
- **P7 local-audit tunnel bridge** — local Python watchdog (`~/bin/guardian-watchdog.py`,
  zero-AI) served over a Cloudflare Tunnel + Access so Guardian can run on-demand local
  launchd/proc audits.
- **DLQ** for `core-guardian-log-ingest` — poison messages retry `max_retries: 3` then
  drop (no dead-letter queue).

---

## Known gotchas (reference)

- **`/run` path**: the AI Router ingress is `/api/ai-router/run`, NOT
  `/api/guardian/ai-router/*` (that prefix is guardianAuth-gated → 404 for a valid
  admin token, 401 otherwise). Log ingest mirrors this at `/api/logs`.
- **Ingress token** = Secret Store `CLOUDFLARE_AI_GATEWAY_TOKEN` — dual-purpose: also
  the `cf-aig-authorization` header for real gateway calls. Do NOT overwrite blindly.
  codex resolves it via `tokens show CLOUDFLARE_AI_GATEWAY_TOKEN --value-only`.
- **SQLite `"rowid"` quirk**: a double-quoted `"rowid"` is a string literal in a
  WHERE/DELETE and matches 0 rows. `keyRef()` leaves rowid/_rowid_/oid unquoted.
- **FK-cascade trim**: `webhook_deliveries.delivery_id` is referenced by 13 child
  tables (ON DELETE NO ACTION) — a parent DELETE dies on `FOREIGN KEY constraint
  failed`. The workflow discovers children via PRAGMA and deletes them first via a
  parent-window subquery (no giant IN-list).
- **Separate LOGS_DB is raw SQL**, not drizzle (drizzle-kit is bound to the main DB
  only). Schema changes there go through `wrangler d1 execute`.
- **Migration ledger** collides across parallel worktrees — always `db:generate`
  against the latest main and renumber if a peer took your number.
- **`pnpm check` reformats** the whole tree (oxfmt) — verify with build + oxlint, not
  `pnpm check`.
- **`astro dev` breaks island hydration** (before-hydration.js 404) — verify UI via SSR
  render or a preview deploy, not dev.
- **Deploy** runs `migrate:remote` then `wrangler deploy`. Nothing is live until
  `pnpm run deploy`.
