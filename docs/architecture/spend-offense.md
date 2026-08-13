# Spend Offense — the welfare-queen catcher

**Status**: PLANNED (2026-08-12). Extends the AI Router (spec #1 BUILT) — reuses its
circuit breakers + kill switch, does NOT build a parallel breaker system.

**Hard constraint**: NO AI is used anywhere in this analysis on core-guardian. Every
classifier is a cold API query + regex + deterministic scoring in the Worker. The only
AI in the loop is Jules (external), which core-guardian *dispatches to* but never runs
itself.

---

## Problem

Autonomous agents on cron/launchd hammer Workers AI (and D1 / Durable Objects /
Vectorize / Browser Rendering) and run up the bill. Confirmed: `@cf/openai/gpt-oss-120b`
≈ $18/day. Defense (the local watchdog) catches spikes *after* they bill. Offense catches
the *players* before they rack it up.

## Reused primitives (already in the repo)

| Primitive | Location | Role in offense |
|---|---|---|
| `cfApi` / `cfFetch` | `guardian/resources.ts`, `routes/guardian.ts` | List workers, cron schedules, bindings |
| `getBindingIndex` | `guardian/resources.ts` | Worker→resource binding map (D1/Vectorize/DO/AI/browser) |
| `queryAccountAnalytics` | `lib/cloudflare-graphql.ts` | Per-worker invocation frequency |
| `setCircuit`/`deleteCircuit`/`getKillSwitch` | `guardian/ai-router/circuits.ts` | Flip breaker at scope `project:Z` |
| `evaluateBreakers` | `guardian/ai-router/circuits.ts` | Already gates `/ai-router/run` |
| `project` field on `/ai-router/run` | `routes/ai-router.ts` | The core-guardian-project-identification key |
| `billingEvents`, `alerts` | `db/schemas/governance/` | Audit trail |
| `NotificationsAgent` DO | `ai/agents/NotificationsAgent` | Frontend incident surface |
| daily-cost report | `guardian/daily-cost.ts` | 2-day sustained-spend auto-break trigger |

## New D1 tables (`db/schemas/governance/offense/`)

1. **`scan_targets`** — enumerated players (workers + GH repos).
   `id, kind(worker|github_action|local|gas), name, worker_name, cron_schedules(json),
   risk_signals(json: {cron,browser,scraping,d1,vectorize,durableObject,ai}), risk_score,
   guardian_registered(bool), bypass(json), first_seen, last_scan`.
2. **`jules_dispatches`** — the capability-token auth.
   `id, nonce(uuid, unique), jules_session_id, target_id, task_type('spend_audit'),
   status(pending|reported|failed|expired), dispatched_at, reported_at, findings(json)`.
3. **`circuit_break_events`** — incidents.
   `id, project_identification(json), scope, reason, source(scanner|jules|auto_spend),
   status(active|read|erroneous), jules_pr, actions_taken(json), recommendation(json),
   created_at, resolved_at`.

## New backend modules (`guardian/offense/` — zero AI)

- `classify.ts` — regex signal library + risk scoring (shared by both scanners).
  - AI signals: `gateway.ai.cloudflare.com`, `@cf/`, `env.AI`/`.AI.run(`, provider hosts,
    `*.hacolby.workers.dev`. Guardian-routed signal: `core-guardian` / `/api/guardian` /
    `/ai-router/run`. Billable signals: cron cadence, browser rendering binding, D1/Vectorize/DO
    bindings, invocation frequency from analytics.
- `scan-workers.ts` — `cfApi /workers/scripts` → per script `/schedules` (cron) + `/bindings`
  + `queryAccountAnalytics` (freq). Score. Cross-check `guardian_registered`: does the project
  have rows in AI-usage-registration / ai-router-requests D1? If cron+AI-signal and NOT
  registered → **bypass** flag.
- `scan-github.ts` — GH REST (`GH_TOKEN`) list repos → fetch `.github/workflows/*` + wrangler →
  regex for the AI/gateway/`hacolby.workers.dev` signals. Log as `scan_targets` kind=github_action.
- `jules-dispatch.ts` — for uncertain (AI-signal + cron, registration unknown) targets: mint
  `crypto.randomUUID()` nonce, insert `jules_dispatches` (pending) with jules_session_id, call
  Jules API (`JULES_API_KEY`) with a self-contained instruction (see below).
- `findings-intake.ts` — verify nonce against PENDING dispatches of task_type spend_audit; on
  match record findings + auto-act.
- `auto-break.ts` — daily cron: if `totalByDay` > threshold two consecutive days → incident +
  `setCircuit` + notify. Also fires if Jules fails but guardian already has enough signal.

## Jules instruction contract (what core-guardian sends Jules)

Jules is given a full self-contained brief + the exact reporting `curl` (URL + payload template
carrying its nonce). Jules is told **not** to reference the reporting URL anywhere in the PR.

Jules checks (and auto-disables by commenting out on hit):
- Is the cron schedule driving an AI operation? (billable blast radius)
- Is the AI integration bypassing the core-guardian AI endpoint?
  - If via AI Gateway: are `cf-aig-metadata` tags present so core-guardian can attribute it?
  - If via raw CF AI / provider-native API: is usage reported to core-guardian at all?

On any violation Jules comments the code out (disable), opens a PR, then curls the findings API:
```
repo, repo_type(github_action|worker|py|gas|…), worker_name(from wrangler.jsonc),
cron_audit_findings[], ai_audit_findings[], pr_number,
actions_taken[], circuit_breaker_recommendation[],
core_guardian_project_identification: {projectName, projectType, …},  // from config/metadata
nonce   // the capability token
```

## Findings auth (nonce capability token)

`POST /api/guardian/offense/findings` is unauthenticated by header, authenticated by **nonce**:
look up PENDING `jules_dispatches` of task_type `spend_audit`; the presented nonce must match a
row. Match → mark reported, store findings, auto-act. No match → 403. Unguessable per-dispatch
UUID = no self-DoS.

## Auto-action (no AI)

If Jules' `circuit_breaker_recommendation` is within guardian's control:
- Recommendation "disable core-guardian access for project" → `setCircuit("project:<id>",
  {enabled:true, budgetUsd:0})` keyed by `core_guardian_project_identification`.
- If AI-Gateway metadata matches the project identification → isolate/block those gateway calls,
  or (drastic) disable the gateway.
Every action writes a `circuit_break_events` row (source=jules) + `billingEvents` audit + notifies.

Guardian short-circuits Jules entirely when it already has cause: spend over the dollar threshold
two days running → immediate incident + breaker.

## Incident surface

- **Frontend** (`/admin/incidents` or dashboard banner): live `circuit_break_events` where
  status=active. User can **mark erroneous** (lift breaker: deleteCircuit/disable + status=erroneous)
  or **mark read** (status=read, but stays visible as a live breaker until cleared).
- **Local watchdog**: `~/bin/guardian-watchdog.py` adds a poll of
  `GET /api/guardian/offense/incidents?status=active` on its 2×/day run → existing alarm fires.
  No push infra needed.

## Routes (`routes/offense.ts`, mount `/api/guardian/offense`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/scan` | guardianAuth | Run CF + GH scan, upsert `scan_targets` |
| GET | `/targets` | guardianAuth | List players + risk |
| POST | `/dispatch/{targetId}` | guardianAuth | Send an uncertain target to Jules |
| POST | `/findings` | **nonce** | Jules reports; auto-acts |
| GET | `/incidents` | guardianAuth* | Active incidents (polled by watchdog + frontend) |
| POST | `/incidents/{id}/resolve` | guardianAuth | Mark read / erroneous(lift) |

## Phases (build order — reordered 2026-08-12: auto-break FIRST)

- **P1 (NOW)** — `circuit_break_events` table + `auto-break` on 2-day sustained spend +
  `GET /incidents` + `POST /incidents/{id}/resolve` + watchdog incidents poll. Fastest guard,
  reuses daily-cost data already present. No scanners needed.
- **P2** — `scan_targets` table + `scan-workers` (cron/bindings/freq/risk) + guardian_registered
  cross-check + `/scan` + `/targets`.
- **P3** — `scan-github` (regex) → targets.
- **P4** — `jules_dispatches` table + `findings-intake` (nonce auth) + auto-act → `setCircuit`.
- **P5** — `jules-dispatch` (`JULES_API_KEY`).
- **P6** — billing + incident frontend on the core-guardian dashboard via the **Claude AI Design
  loop** (one readable surface). Includes:
  - Live incidents banner (active events; mark read / erroneous(lift)).
  - **Fix the cost-trace headline bug**: `buildAccountTree` labels *overage-above-allowance*
    (`overageCostUsd` sum, e.g. $36.74) as "Account billables — paid plan". That is the wrong
    metric as the headline and it buries the real surge (workers-ai projected 21471% of allowance).
    Headline must be **true MTD metered spend** (sum of `daily-cost.totalByDay[].costUsd`), with
    overage/projection shown as secondary.
  - **Badge counter** — total billables MTD (grows visibly).
  - **Line chart** — billable usage over time (`daily-cost.totalByDay`) with a dashed
    **projected-month** continuation (run-rate × days remaining).
  - **Bullet/bar** — billables added each day + projected-if-no-action overlay.
  - **Alerts**: always date-stamped; show "overage this day", "overage this month (total)", and
    "projected month spend if no action". Not static once raised — they update each cron.
- **P7 — Local-audit tunnel bridge.** The local python (`~/bin/guardian-watchdog.py`, still zero
  AI) also runs a small HTTP server exposed via **Cloudflare Tunnel**, fronted by **Cloudflare
  Access with a service token**. core-guardian holds the service token (Secrets Store) and calls
  the tunnel hostname to run on-demand local audits (launchd/cron/proc/direct-AI scan). The python
  additionally self-schedules audits and POSTs findings up to a local-ingest endpoint
  (`POST /api/guardian/offense/local-findings`, shared-token auth). **Security: never a raw public
  hostname — Access service-token only; the endpoint runs read-only audits, never arbitrary shell.**

## Auto-break safety (P1 decision)

Sustained spend is account-wide, not project-scoped. To avoid an automated account-wide AI outage
from a false positive:
- `spend > threshold` two consecutive days → **incident (active) + local alarm + frontend banner**.
  Recommend-only; does NOT auto-cut.
- `spend > hard_ceiling` (separate, higher config, default OFF) → additionally `setKillSwitch(true)`.
Both thresholds live in `global-config` (env-overridable). The incident's resolve flow lets the
user flip the kill switch or lift it.

## P8 — Actionable Insights (the accumulation + one-click-action layer)

**Why:** the v1 dashboard showed per-day model cost (`gpt-oss-120b $22`) with no date, no
accumulation, and no "since last visit" — so a recurring $22/day drip read as a static bug, not
"5 days running = $110." The owner found the $600 on Cloudflare's dashboard, not ours. Fix: make the
recurrence + accumulation the loudest thing, attribute it to a project, and put the fix one click away.
Zero AI in the analysis.

### Insight layer (all from data we already have — daily_cost, workersAiModels, ai_router_requests)
- **Period accumulation**: headline = MTD running total (not a per-day figure).
- **Since-last-visit delta**: a visit log (KV `SESSIONS`, key `dashboard:last-visit` → `{at, mtdUsd}`).
  On load, record the visit and show "up $X since your last visit N days ago" under the headline.
- **Recurrence/anomaly detection** (`GET /api/guardian/offense/insights`, deterministic):
  per model + per project, walk the daily series → consecutive-days-in-a-row, accumulated total over
  the streak, cadence class (hourly/daily/weekly from call timestamps), call count, neurons/day.
  Emit ranked anomalies: "model X · N days running · $Y total · daily · project Z · K calls".
  Attribution + call counts + (where stored) prompt come from `ai_router_requests` / PROMPTS KV.

### Action layer (surface the fix next to the problem — "end the bleeding")
`POST /api/guardian/offense/controls/*`, guardianAuth, each wrapping an existing capability:
- **project-circuit**: set/lower budget · lock-for-month (`setCircuit budget 0 window month`) ·
  freeze-permanent (sticky enabled, budget 0) · unfreeze (deleteCircuit / restore). AI bleed → stopped.
- **kill-cron**: delete a worker's cron trigger via `cfApi DELETE /workers/scripts/{name}/schedules`.
- **archive-r2**: hand off to guardian's existing R2 archive/action-item flow.
- **code-fix**: Jules dispatch (P5) for a real change, or a hardcoded OctoKit surgical edit
  (comment out a cron in wrangler.jsonc / disable a DO) → PR → deploy. (later)

**No migration** — visit log in KV, everything else reads existing tables / wraps existing helpers.
Build order: insight layer first (the failure), then project-circuit controls, then cron/R2/code.

## New secrets (wrangler.jsonc Secrets Store)

`JULES_API_KEY` (Jules dispatch), `GH_TOKEN` (GitHub scan), `LOCAL_AUDIT_ACCESS_TOKEN` +
`LOCAL_AUDIT_INGEST_TOKEN` (P7 tunnel bridge). Run `pnpm run types` after each binding change.
