# AGENTS

- At the start of every turn, use the `cloudflare-docs` MCP server to verify Cloudflare assumptions, architecture, and deprecations before writing or changing code.
- Review and apply the best practices in `.agents/skills/` and `.github/skills/` before implementing changes.
- Build new views as React islands on top of the existing Astro + Shadcn foundation, using the dark/moody theme system and subtle contrast instead of heavy borders.
- Enforce Zod validation on backend endpoints, expose OpenAPI v3.1.0 at `/openapi.json`, `/swagger`, and `/scalar`, and keep endpoints strongly typed.
- Every new service or view must expose `/health` and emit structured logs/metrics into the mirrored D1 logging layer.
# Agent Workspace Overview

Welcome to the `core-template-cfw-assets-astro-shadcn` template. This is a unified full-stack template combining Cloudflare Workers (Backend & Assets) with Astro and React + Shadcn/ui (Frontend).

## Core Architecture

- **Backend:** Cloudflare Workers, Hono (Routing), D1 (Database with Drizzle ORM).
- **Frontend:** Astro (SSR/Static Hybrid), React (Interactive Islands), Tailwind CSS, Shadcn/ui.
- **Deployment:** Deployed using Cloudflare Workers Assets via `wrangler.jsonc`.

## Mandatory Agent Directives

This repository relies heavily on AI agents for rapid prototyping and feature generation. If you are an AI agent, you must strictly follow these directives:

1. **Read Startup Rules:** Immediately review `.agent/rules/startup.md` before writing any code. It contains critical instructions for your first steps.
2. **Clean State Execution:** The template's default UI has been deliberately wiped clean and replaced with a temporary template-routing warning. Build the user's requested frontend directly from `src/frontend/pages/index.astro` or the route structure you introduce, and keep the shared header available on every page.
3. **Environment Strictness:** We use `worker-configuration.d.ts` for Cloudflare types. Never manually define `interface Bindings`. Always use `Bindings: Env` on Hono applications.
4. **Runtime Baseline:** Use Node.js 22+ when working with Wrangler or regenerating `worker-configuration.d.ts`.
5. **Package Management:** Default to `pnpm` for package installation and script execution.
6. **Authentication Rule:** Use the Secrets Store binding `WORKER_API_KEY` for protected API authentication and session creation. Do not add a `users` table back into this template.
7. **Schema Layout:** Keep Drizzle tables under `db/schemas/${useCase}/${tableName}.ts` and use Drizzle-Zod for API typing where table schemas are involved.
8. **Modularization:** Keep new code modular. Split helpers, components, routes, and persistence code by concern instead of adding large multipurpose files.
9. **Template Replacement Prompt:** If the user gives you the landing-page replacement prompt, replace the starter frontend, preserve the shared header, and keep the dynamic docs pointers to `/openapi.json`, `/swagger`, and `/scaler`.
10. **Frontend Errors:** Never use Chrome/browser alerts. Route every frontend error through the centralized frontend error handling utility and keep the copy-to-clipboard success/error feedback within shadcn components.
11. **Dependency Hygiene:** Follow `.agent/rules/dependency-maintenance.md` whenever dependencies, Wrangler, or generated Cloudflare types may be stale.
12. **Architecture Rules:** Follow `.agent/rules/architecture.md` and `.agent/rules/frontend-error-handling.md` for auth, modularization, and frontend error UX conventions.
13. **CI Ownership:** If GitHub Actions or Cloudflare PR deployment checks fail because of frozen lockfiles, outdated dependencies, or stale Wrangler types, fix them in the same turn by refreshing pnpm dependencies and re-running validation before handing work back.
14. **Import Path Aliases:** ALWAYS use tsconfig path aliases (`@/backend/*`, `@/backend/db/*`, `@/backend/ai/*`, etc.) for all backend imports. Never use relative imports (`../../foo`). Run `node scripts/migrate-imports.mjs` to convert existing relative imports. See `.agent/rules/import-paths.md` for details.
15. **Comprehensive Documentation:** Every backend TypeScript file must have a file-level JSDoc comment explaining its purpose, key features, and usage. Every exported function/class must have JSDoc with `@param`, `@returns`, `@throws`, and `@example` tags where applicable. See `.agent/rules/docstrings.md` for standards.
16. **Agent Meta-Maintenance:** Update `AGENTS.md` and `.agent/rules` files when you add/modify features that future agents should know about. Keep rules concise (<12,000 chars per file), avoid duplication, and resolve conflicts. See `.agent/rules/meta-maintenance.md` for guidelines.
17. **Shared Data Toolkit:** This template ships an isomorphic data/array/object utility toolkit built on [Remeda](https://github.com/remeda/remeda). Reach for it before hand-rolling array/object plumbing. Import from `@/backend/utils/data` on the Worker side and `@/lib/data` on the frontend — both re-export the same isomorphic core at `@/shared/data-utils`. It exposes curated Remeda re-exports (`pipe`, `groupBy`, `unique`, `sortBy`, `pick`, `difference`, …), the full Remeda surface as `R`, and template helpers Remeda doesn't ship (`diffArrays`, `findWhere`, `toggleInArray`, `moveItem`, `keyBy`, `compact`, `ensureArray`, `deal`, `truncate`, `tryParseJson`). Add genuinely-shared helpers to the shared core (never duplicate per-surface). Live demo + docs at `/showcase/utilities`. See `.agent/rules/data-utilities.md`.
18. **Verify signed in:** A page is not verified until opened in a browser with a real session and seen rendering data. Bearer-token script checks bypass the session-cookie gate and do not count.
19. **No raw ids in the UI:** Resolve `databaseId`/`namespaceId`/gateway/bucket ids to names server-side before they reach a chart, badge, table, or alert. See `resolveBreakdownNames` in `api/routes/guardian.ts`.
20. **One format helper per intent** (`@/lib/format`): `formatCount` (density), `formatExact` (commas), `formatRatio` (`258×` not `25768%`), `humanSize` (bytes). No bare `Intl` at UI call sites.
21. **Alerts name resource + owner + next step.** A number without its resource, owning worker, and recommendation is telemetry, not an alert.
22. **New page ⇒ nav entry same change** (`siteConfig`, `src/frontend/lib/config.ts`). Never link a non-existent route. Template/showcase pages stay on disk but hidden from the navbar.
23. **Check `cloudflare-docs`/`cloudflare-api` MCP before assuming an API exists.** Verified-false here: no pricing-tier API; `/billing/usage` omits D1/R2/DO/AI; R2 has no last-access timestamp.
24. **Guardian plan:** `/docs/architecture` + `docs/0001_master_rebuild_plan/`. Governance = % of monthly allowance projected to period end (`guardian/allowances.ts`), not guessed thresholds.
25. **Structured model output ⇒ `json_schema`, never text-parse.** Any time a model must return JSON, call `generateStructuredOutput(env, { schema })` from `@/backend/ai/providers` — it sends `response_format: { type: "json_schema" }` and returns a Zod-validated object. NEVER call a text-generation method (`env.AI.run` for prose, any `generateText`) and then `JSON.parse` / regex-strip the reply. Banned pattern: `raw.match(/\{[\s\S]*\}/)` then `JSON.parse`. The schema is the contract and the endpoint must enforce it; a free-text reply we hope is JSON is not structured output.

## Template App Surface (reference implementation)

This template ships a real, running app so new projects inherit working patterns
(extend or delete the pieces you don't need). All of it is wired to D1 via Hono;
no mock data.

- **CRITICAL — Agents SDK islands must mount `client:only="react"`, never `client:load`.**
  Any React island using `useAgent`/`useAgentChat`/assistant-ui (the
  agents/PartySocket stack) is browser-only. `client:load` server-renders it
  first, and `useAgent`'s `useMemo` hits a null React dispatcher in the SSR
  worker → `Cannot read properties of null (reading 'useMemo')`, which fails the
  whole route. This was the original "chat not working" bug. Plain fetch-based
  islands (inbox, dashboard, tasks) may use `client:load`. Note: the `ai` binding
  is remote-only, so `wrangler.jsonc` sets `"ai": { "binding": "AI", "remote": true }`.
- **Pages** (Astro SSR + React islands, Monolith dark theme):
  - `/dashboard` — admin dashboard: radial-gauge KPIs + grouped-bar, interactive
    donut, and polished time-series recharts (all OKLCH palette via `ui/chart.tsx`)
    with search + range + status filters. Components under `components/dashboard/`.
  - `/projects`, `/tasks/board` (kanban), `/tasks` (table with **faceted
    multi-select chip filters** — `components/tasks/FacetFilter.tsx`), `/tasks/[id]`.
    Task/kanban/project cards open preview modals. Components under `components/tasks/`.
  - `/notes` — **PlateJS** rich-text editor (`components/notes/`); bodies persist as
    a versioned `{v,format:"plate",value}` JSON envelope in the team-notes `body`
    column, with legacy plain-text fallback.
  - `/inbox` — two-pane inbox backed by Cloudflare **Email Routing**: the Worker
    `email()` handler (`backend/email/inbound.ts`) stores inbound mail in the
    `email_messages` D1 table; UI under `components/inbox/`, API at `/api/inbox`.
  - `/chat` + `/showcase/{code-mode,browser-hitl,multi-agent,workflows,artifacts,
    mcp,thinking,skills,features}` — every Agents page mounts a LIVE interactive
    island (`components/showcase/`) wired to its Durable Object, not a static doc.
  - `/docs` (docs home, bound to `/api/docs/*`) + `/playbook` — documentation using
    the Shiki-backed `ui/code-block.tsx` (kibo-ui-style, base-ui, copy + tabs).
  - `/settings/{preferences,notifications,webhooks,activity,advanced}` (shared
    sub-nav) and `/notifications` (realtime). Components under `components/settings/`.
- **Schemas** live in `db/schemas/{projects,tasks,stats,settings,notifications}/`
  (drizzle-zod + `*_TABLE_DESCRIPTION`/`*_COLUMN_DESCRIPTIONS` for `/docs`).
- **APIs**: `/api/{projects,tasks,team-notes,settings,webhooks,activity,
  notifications,dashboard}` — CRUD + `?q=` search + filters + pagination. The
  dashboard exposes `/stats`, `/charts`, `/insights` (Workers AI via
  `ai/providers/ai-sdk.ts#getChatModel`).
- **Agents (Durable Objects, all bound + functional)**: `ChatBroker` (assistant-ui
  chat), `OrchestratorAgent` + `ResearcherAgent` + `CoderAgent` (real `getAgentByName`
  RPC delegation), `CodeModeAgent` (executes via `WORKER_LOADERS`), `WorkflowsAgent`
  (live progress via `setState`), `BrowserHitlAgent` (`MYBROWSER`; HITL approval gate),
  `McpAgent` (tool catalog + `callTool`), `ThinkingAgent` (streams reasoning then text),
  `SkillsAgent` (skills registry), `ArtifactAgent` (SQLite versioning), `NotificationsAgent`.
  Invoke via RPC (`getAgentByName`) or `@callable` + client `agent.call` — NEVER
  `stub.fetch`. Migrations are additive (v1→v3); never rewrite a shipped tag.
- **Realtime**: the `NotificationsAgent` Durable Object (`NOTIFICATIONS_AGENT`,
  instance `"global"`) syncs notification state over WebSocket. The client island
  is `components/NotificationsFeed.tsx` (`useAgent` + `onStateUpdate`); REST
  mutations proxy to it via `getAgentByName` (never `stub.fetch`).
- **Shared frontend helpers**: `lib/api.ts` (`apiGet`/`apiSend`/`ApiError`) and
  `lib/format.ts` (`relativeTime`/`shortDate`/`compactNumber`). Charts use the
  shadcn `ui/chart.tsx` wrapper + the OKLCH `--chart-1..5` palette in `global.css`.
- **Shared data toolkit** (isomorphic, Remeda-backed): one core at
  `shared/data-utils.ts`, re-exported by `lib/data.ts` (frontend, `@/lib/data`)
  and `backend/utils/data.ts` (`@/backend/utils/data`). Curated Remeda re-exports
  + full `R` namespace + template helpers (`diffArrays`, `findWhere`,
  `toggleInArray`, `moveItem`, `keyBy`, `compact`, `ensureArray`, `deal`,
  `truncate`, `tryParseJson`). Live demo: `/showcase/utilities`.
- **Seed demo data**: `POST /api/seed` (idempotent). Locally:
  `pnpm run migrate:local` then `curl -X POST http://localhost:8787/api/seed`.
- **SSR note**: `src/_worker.ts` exports `start(manifest)` + `createExports()`;
  page requests are rendered via `@astrojs/cloudflare/handler#handle`. Do NOT
  revert this to a bare `env.ASSETS.fetch()` fallback — that 404s every SSR page.
- **Auth**: signed session cookie only (no `users`/`sessions` table). Auth gates
  `/api/admin/*`; the feature APIs are intentionally open so the template runs
  out of the box. Tighten before production.

## Spend Offense

**Purpose**: catch runaway AI / D1 / Durable-Object / Vectorize / Browser-Rendering
spend *before* a huge bill lands. "Defense" (the local watchdog + allowances panel)
reacts to spikes after they bill; **offense** hunts the *players* — cron/agent
workers and GitHub Actions that quietly rack up spend — and files incidents.
**Hard rule: NO AI runs in this analysis.** Every classifier is a cold CF/GitHub
API query + regex + deterministic scoring in the Worker. The only AI in the loop is
**Jules** (external), which core-guardian *dispatches to* but never runs itself. It
reuses the AI Router's circuit breakers + kill switch — it does NOT build a parallel
breaker system. Full spec: `docs/architecture/spend-offense.md`.

**Phase map** (build order; auto-break first so the fastest guard ships first):
- **P1** — `circuit_break_events` table + `auto-break.ts` (2-day sustained-spend →
  incident, recommend-only; hard-ceiling → kill switch) + `GET /incidents` +
  `POST /incidents/{id}/resolve` + local-watchdog poll.
- **P2** — `scan_targets` table + `scan-workers.ts` (cron/bindings/frequency → risk),
  `guardian_registered` cross-check, `POST /scan`, `GET /targets`.
- **P3** — `scan-github.ts` (regex over `.github/workflows/*` + wrangler) → targets.
- **P4** — `jules_dispatches` table + `findings-intake.ts` (nonce-authed) + auto-act.
- **P5** — `jules-dispatch.ts` (`JULES_API_KEY`) sends uncertain targets to Jules.
- **P6 (this branch)** — the dashboard surfaces below.
- **Branch status**: `main` ships **P1–P3**; **P4–P5 land in PR #22** (`jules_dispatches`
  table, `POST /dispatch/{targetId}`, `POST /findings`, and the resolve response's
  `circuitLifted` field). Frontend must degrade gracefully where P4–P5 aren't merged.

**D1 tables** (`db/schemas/governance/offense/`):
- `circuit_break_events` — one incident per row: `id, projectIdentification(json),
  scope, reason, source(scanner|jules|auto_spend), status(active|read|erroneous),
  julesPr, actionsTaken(json {kind,detail,at}[]), recommendation(json {summary,details}),
  createdAt(ms), resolvedAt(ms)`. Active rows are live breakers until resolved.
- `scan_targets` — one player per row, upserted by `(kind,name)`: `id, kind(worker|
  github_action|local|gas), name, workerName, cronSchedules(json string[]),
  riskSignals(json {cron,browser,scraping,d1,vectorize,durableObject,ai}),
  riskScore(0–100), guardianRegistered(bool), bypass(json {isBypass,why}),
  firstSeen, lastScan`.
- `jules_dispatches` (PR #22) — capability-token auth: `id, nonce(uuid unique),
  julesSessionId, targetId, taskType('spend_audit'), status(pending|reported|failed|
  expired), dispatchedAt, reportedAt, findings(json)`.

**API surface** (`api/routes/offense.ts`, mounted `/api/guardian/offense`, all
`guardianAuth` except findings which is nonce-authed):
- `GET  /incidents?status=active|read|erroneous|all` → `{incidents[]}` newest first.
- `POST /incidents/{id}/resolve` body `{action:"read"|"erroneous"}` →
  `{incident, killSwitchLifted, circuitLifted?}`. `read` acknowledges (breaker stays
  live); `erroneous` is a false-positive that lifts any breaker this incident engaged.
- `POST /scan` → enumerate CF workers, score, upsert `scan_targets`; returns a summary.
- `POST /scan/github` → same for GitHub Actions repos (AI-using repos only).
- `GET  /targets?bypass=true|false|all&minRisk=N` → `{targets[]}` newest scan first.
- `POST /dispatch/{targetId}` (PR #22) → send an uncertain target to Jules.
- `POST /findings` (PR #22, **nonce** auth) → Jules reports; auto-acts.

**Frontend panels** (`components/dashboard/`, mounted on `pages/dashboard/guardian.astro`):
- `IncidentsPanel.tsx` — the alarm. Filter `active|read|erroneous|all`; active
  incidents render loud (destructive ring/tint). Per-incident source badge,
  reason, date-stamp, scope, `actionsTaken` badges, recommendation summary, Jules
  PR link. "Mark read" (acknowledge) and "Mark erroneous / restore" (AlertDialog-
  gated, lifts the breaker). Surfaces `killSwitchLifted`/`circuitLifted` inline.
- `RiskTargetsPanel.tsx` — the "who runs up the bill" table. Sortable (risk desc
  default) / filterable (bypass-only Switch, min-risk input) `scan_targets` table:
  risk bar, signal badges (AI/cron/D1/DurableObject/Vectorize/browser), loud BYPASS
  badge, cron schedules, guardian-registered, last scan. Per-row "Send to Jules
  audit" → `POST /dispatch/{id}`, degrades on 404 until PR #22 merges.
- Both fetch real APIs via `lib/api.ts` (`apiGet`/`apiSend`), never mock data, and
  route errors through the shared `dashboard/shared.tsx#InlineError` (which
  `console.error`s for the global ErrorLogger). Monolith dark, `ring-1 ring-border/40`.

**How to extend**:
- *Add a new scanner* (e.g. a Cloud Run / Vercel enumerator): write
  `guardian/offense/scan-<x>.ts` returning `NewScanTargetRow[]`, reuse
  `classify.ts` for signals + score, upsert into `scan_targets` with a new `kind`,
  and add a `POST /scan/<x>` route. Add the `kind` to `KIND_LABEL` in
  `RiskTargetsPanel.tsx`.
- *Add a new incident source*: extend the `source` enum on `circuit_break_events`
  (additive migration), write the row from your detector, and add its label to
  `SOURCE_LABEL` in `IncidentsPanel.tsx`.
- *Add a new risk signal* (e.g. Queues, R2): add the boolean to `RiskSignals` in
  `scan-targets.ts`, detect it in `classify.ts` (regex/binding check) and weight it
  in the score, mirror the field in `offense.ts#riskSignalsSchema`, and add a
  `[key,label]` entry to `SIGNAL_LABELS` in `RiskTargetsPanel.tsx`.
- *Add a new circuit-breaker recommendation*: emit a `recommendation.summary` (+
  optional `details`) from the writer; it renders automatically. If it takes an
  automated action, push a `{kind,detail,at}` onto `actionsTaken` and map the new
  `kind` in `IncidentsPanel.tsx#actionLabel`.
