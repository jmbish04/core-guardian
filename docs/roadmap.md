# Core Guardian — Roadmap & Status

Living status of Core Guardian: a Cloudflare spend-governance cockpit that
watches account-wide usage, attributes cost to real resources, halts runaway
spend, and archives/trims bloated data. Deployed as a single Worker
(`core-guardian.hacolby.workers.dev`).

Legend: ✅ shipped & deployed · 🔄 running autonomously · 🔜 next · 💤 backlog

---

## Why this exists

A recurring ~$600/mo Cloudflare bill. Root cause turned out to be **Workers-AI
neurons** — the "Regular Twitch Neurons" SKU at ~$588/90d. Two hard truths that
shaped the whole product:

1. **Cloudflare bills every Workers-AI model as ONE lumped SKU.** The billing API
   gives no per-model breakdown. Only the **AI Gateway** logs attribute by model —
   and only for calls that go *through* the gateway.
2. **~90% of the neuron spend bypassed the gateway** (direct `env.AI.run`), so it
   was unattributable by any data source. The heavy burn cratered 99.5% on
   2026-08-13 when a local runaway scraper was killed.

The product's north star follows from that: **route all AI through one monitored
ingress, and make every SKU trace back to the resource that drove it.**

---

## ✅ Shipped & live

### Cost control
- **Killed the bleed** (#42): Core Guardian's own `MODEL_CHAT`/`EXTRACT`/`DRAFT`
  were `@cf/openai/gpt-oss-120b` (120B, the neuron driver). Swapped to
  `llama-3.3-70b-fp8-fast`; killed the hardcoded gpt-oss fallbacks so an unset env
  can't revert. (#58: `llama-3.1-8b` was CF-deprecated → 410, moved draft to 70b too.)
- **Spend Offense** layer (zero-AI analysis): auto-break circuit events, worker +
  GitHub-action scanners for AI "welfare-queen" cost-drivers, nuclear total-budget
  breaker, non-AI infra-spike guard, Jules dispatch (nonce-authed findings callback).
- **Accountant**: Layer 1 = actual-billed CF SKU lines matching the official bill;
  Layer 2 = est-vs-actual discrepancy flags + AI attribution + projection.

### AI Router (the monitored ingress)
- `POST /api/ai-router/run` — one door for all AI: substitution rule → dynamic
  model pick (`{project, importance, budget}`) → passthrough. Circuit breakers +
  global kill switch, all scoped per-project/model.
- **P12 smart proxy**: `model_substitutions` table + CRUD + UI — swap a model at
  the router with no code change in the caller.
- Fixed 3 latent bugs that meant `/run` had **never** served Workers-AI: missing
  `workers-ai` provider-key mapping (#55), model never injected into the upstream
  body (#57), and the real path is `/api/ai-router/run` (the `/api/guardian/*`
  prefix is admin-gated).
- **codex-routines** now routes ALL its AI through `/run` → monitored, budgetable,
  remote kill switch (429 = disabled) + local `GUARDIAN_AI_ENABLED` off-switch.

### Per-resource attribution (#50)
- Accountant SKU rows expand to their real drivers, from cold CF GraphQL:
  - **Durable Objects** → by script (`durableObjectsInvocationsAdaptiveGroups`,
    wall-time = GB-s basis) with a long-lived-DO smell flag (e.g. `dopamine`
    burned ~335s/request).
  - **Workers-AI** → gateway model mix + a loud **unattributable direct-AI** line
    (the ~90% the gateway can't see).

### Log pipeline + universal trimmer (#69, #72, #75)
- **Ingest**: `POST /api/logs/ingest` (ingress-token auth) → Queue
  `core-guardian-log-ingest` → consumer batch-inserts into a **separate D1**
  `core-guardian-logs` (`LOGS_DB`). No D1 write on the request hot path.
- **codex-routines ships ALL its logs** (`logging` records + raw `print()`/stderr
  via a stdout tee) to the ingest endpoint — batched, fail-soft, toggleable.
- **Universal trim**: `trim_targets` registry + hourly cron → `LogTrimWorkflow`
  (durable): count → discover FK children → export parent+children to Drive →
  **verify** (file exists + read-back bytes == JSON bytes) → **truncate**
  (children-first, FK-safe) → finalize. Verify gates truncate; nothing deletes
  without a verified archive.
- Drive layout: `d1 archives/<dbName>/<YYYY>/<MM>/<ISO>_<table>_export.json`.
- Live-verified on `core-github-api-webhooks/webhook_deliveries`: 100 parent + 99
  child rows archived + deleted, **0 orphans**.

### Dashboard
- Nav: Guardian, Accountant, Projects, Jules Sessions, AI Recommendations, AI
  Router, and more. Compact number formatting, D1 shows name not binding id,
  AllowanceBar bullet charts, model-savings recommendations with one-click Jules
  "switch model" action (#37/#38).

### Projects & Jules control plane (#27/#28)
- `guardian_projects` + `jules_sessions` tables, nightly worker sync, hourly Jules
  poller (captures PR URLs), per-project viewport (spend/circuits/sessions/delete-
  worker/disable-crons).

---

## 🔄 Running autonomously (no action needed)

- **webhooks trim**: `webhook_deliveries` (~89k rows) trims ~10k/hour on the cron
  down to the 20k keep-window (~7 ticks), each batch archived to Drive first.
- **logs-table trim target**: seeds on the next cron tick; a no-op until `logs`
  grows past the 50k threshold.
- **Jules poller / worker sync / spend evaluation**: hourly cron.

---

## 🔜 Next

- **Logs & trim dashboard page** — the whole log pipeline is currently headless.
  Build a page to view `LOGS_DB` (filter by source/level/time) and the
  `trim_targets` registry (threshold, keep-window, last run, last export path,
  last error, enable/disable, "run now"). Right now this data is only reachable by
  querying D1 by hand.
- **Push codex-routines branches** — `feat/scraper-pipeline-resilience` (log
  shipper `975cac4` + stdout shim `b0b698b`) plus the earlier AI-routing commits
  are committed locally but unpushed. One commit swept in unrelated working-tree
  changes via `git add -A`; review + split before pushing.
- **Mandate the gateway for all Workers-AI** — a guard that rejects/flags any
  direct `env.AI.run` across projects, so neuron spend can never again be
  unattributable. This is the strategic endgame the attribution work points at.

---

## 💤 Backlog

- **P10 dashboard IA** — overview-of-overviews + per-billable drill pages (the
  original "hard to read" complaint).
- **D1 strategy page** — archive/index/cleanup surface with Jules buttons for
  index installs + cleanup, gated on archive-to-Drive. (Note: actual D1 overage is
  only ~$3.92/90d — hygiene, not urgent. The trim workflow now covers part of this.)
- **P13 Codra integration** — Codra reports its AI usage, pulls savings recs, and
  enforces routing through Core Guardian. Backend API is ready; needs a session
  driven in the codra repo.
- **ReUI all-dashboard-tables migration** — one deliberate surface-mode pass to
  move every dashboard table to ReUI DataGrid.
- **Dead-letter queue** for `core-guardian-log-ingest` — poison log messages
  currently retry `max_retries: 3` then drop (no DLQ).

---

## Known gotchas (reference)

- **`/run` path**: the AI Router ingress is `/api/ai-router/run`, NOT
  `/api/guardian/ai-router/*` (that prefix is guardianAuth-gated → 404 for a valid
  admin token, 401 otherwise). Log ingest mirrors this at `/api/logs`.
- **Ingress token** = Secret Store `CLOUDFLARE_AI_GATEWAY_TOKEN` — dual-purpose:
  it's also the `cf-aig-authorization` header for real gateway calls. Do NOT
  overwrite it blindly. codex-routines resolves it via `tokens show
  CLOUDFLARE_AI_GATEWAY_TOKEN --value-only`.
- **SQLite `"rowid"` quirk**: a double-quoted `"rowid"` is a string literal in a
  WHERE/DELETE and matches 0 rows. `keyRef()` leaves rowid/_rowid_/oid unquoted.
- **FK-cascade trim**: `webhook_deliveries.delivery_id` is referenced by 13 child
  tables (ON DELETE NO ACTION) — a parent DELETE dies on `FOREIGN KEY constraint
  failed`. The workflow discovers children via PRAGMA and deletes them first via a
  parent-window subquery (no giant IN-list).
- **Separate LOGS_DB is raw SQL**, not drizzle — drizzle-kit is bound to the main
  DB only. Schema changes there go through `wrangler d1 execute`.
- **Migration ledger** collides across parallel worktrees — always `db:generate`
  against the latest main and renumber if a peer took your number.
- **Deploy** runs `migrate:remote` then `wrangler deploy`. Nothing is live until
  `pnpm run deploy`.
