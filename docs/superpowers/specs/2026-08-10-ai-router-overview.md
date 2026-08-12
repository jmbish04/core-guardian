# AI Router — umbrella design & shared context

**Status:** in design (2026-08-10). Spec #1 (Routing Core) being brainstormed; #2–4 skeletons below.
**Goal:** make this Worker the single ingress for **all** AI processing across projects. Every call routes through Cloudflare AI Gateway (falling back to `default-gateway`) for spend limits, caching, logging, and attribution — with per-project circuit breakers, a global kill switch, per-request metadata capture, and weekly Jules-driven right-sizing recommendations.

This doc is the **shared context** so each sub-spec spin-up doesn't re-derive the landscape. Read this first, then the sub-spec.

---

## Existing code to REUSE (do not reinvent)

| Concern | Existing asset | Reuse / change |
|---|---|---|
| Native-provider relay + KV monthly budget breaker + break-glass + prefix-price map | `src/backend/guardian/ai-proxy.ts` | Reuse breaker/pricing bones. **New ingress routes through AI Gateway** (this file routes direct-to-provider). Decide: deprecate `proxyCall` or keep for BYO-key direct path. |
| Per-call usage writer → `ai_gateway_costs` + `ai_usage_registrations` (accumulating roll-up + append-only trace w/ worker/operationId/sourceIp) | `src/backend/guardian/register-usage.ts` | Extend/complement. New per-request table carries fields the roll-up can't (project, importance, isCircuitBreaker, payloadJson). Still feed the roll-up so existing cost/drift/pricing queries keep working. |
| Actual per-gateway/model cost from GraphQL snapshots; drift vs scraped price | `src/backend/guardian/ai-gateway-costs.ts` | Reuse `queryGatewayCosts`; add a `project` dimension source (our new D1 table) for spec #3. |
| Declarative rule table (`alert_rules`): comparator/threshold/severity/action, `armed`/`enabled`, hourly cron eval | `src/backend/db/schemas/governance/alert-rules.ts` + `guardian/rules.ts` | Circuit breakers overlap but need **hot-path KV** (read on every request), not hourly cron. Keep `alert_rules` for slow alerts; breakers live in dedicated KV per user. |
| AI Gateway CRUD + per-gateway logs (prompt/UA/geo/metadata) | `src/backend/guardian/ai-gateway-admin.ts` | Reuse for admin views. |
| Billing/gateway/costs REST routes, all `guardianAuth`-gated | `src/backend/api/routes/ai-gateway*.ts`, `ai-models.ts` | Follow pattern (OpenAPIHono + zod). New router `ai-router`. |
| MCP tool registry pattern (kill-switch-via-MCP, cost tools) | `src/backend/api/routes/mcp.ts` | Add kill-switch + circuit tools here. |
| Frontend usage/cost components | `src/frontend/components/storage/AiGatewayBilling.tsx`, `dashboard/WorkerSpendMonitor.tsx`, `CostTraceIsland.tsx`, `cost-trace-builders.ts` | Extend for project dimension (spec #3). |
| Cloudflare live account access (this session) | MCP server `05d884d8-…__execute` / `__search` / `__docs`; account `b3304b14848de15c72c24a14b0cd187d` | GraphQL `aiGatewayRequestsAdaptiveGroups` (dims gateway/provider/model/date). See [[cloudflare-api-mcp-access]] memory. |

**Bindings already present** (`wrangler.jsonc`): `AI_GATEWAY_ID="default-gateway"`, secrets `CLOUDFLARE_ACCOUNT_ID`, `WORKER_API_KEY`, `CLOUDFLARE_AI_GATEWAY_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`; KV `SESSIONS` (Astro — leave alone); `AI` binding; D1.
**To add for #1:** two new KV namespaces `PROMPTS` + `CIRCUITS`. Provider-key secrets already exist. Possible `CLOUDFLARE_API_TOKEN` only if the CF AI REST API rejects the gateway token (verify at build).
**To add for #4:** `JULES_API_KEY` secret.

**Conventions:** cloudflare-jedi stack (Hono + zod-openapi → D1 + Drizzle → Astro SSR + shadcn). Verify with build + oxlint, **never `pnpm check`** (oxfmt rewrites tree — see [[pnpm-check-reformats]]). Edit worktree-relative paths (see [[worktree-vs-main-checkout-paths]]).

---

## Spec #1 — Routing Core (DESIGNED — see [2026-08-11-ai-router-1-routing-core-design.md](./2026-08-11-ai-router-1-routing-core-design.md))

The request path everything else reads. **Decisions locked:**
- 6-mode taxonomy: `gateway` (default) · `gateway-custom` · `provider-sdk-gateway` · `openai-compat` (CF AI REST API) · `native` · `gemini-native`. Caller picks `mode` + optional `transport`.
- **Default gateway = `ai-bridge`** (CREATED 2026-08-11 on the live account; `acre-forensics` gateway deleted to free the 20/20 slot). Worker's own internal calls stay on `default-gateway`.
- **All Gemini forced to `gemini-native`** (Gemini SDK, self-metered) — AIG can't proxy the interactions API the user standardizes on.
- **Compat** modeled as the Cloudflare AI REST API (`/ai/v1/chat/completions`), per user, distinct from classic gateway passthrough.
- Ingress auth = single `CLOUDFLARE_AI_GATEWAY_TOKEN` bearer. Provider keys: caller override else secret-store fallback.
- Circuit breakers hierarchical (kill switch → global total → provider → model → project); criteria + fast counters in dedicated `CIRCUITS` KV, durable trail in new D1 `ai_router_requests`; prompts in `PROMPTS` KV.

**Fixed requirements from user:**
- Ingress authenticates via secret `CLOUDFLARE_AI_GATEWAY_TOKEN`.
- Required request fields: `project` (invoking app), `importance` (low|medium|high), + auth.
- Route to AI Gateway regardless of whether `ai-gateway-id` in payload; fall back to `default-gateway`.
- Generate `request_uuid`. Store **prompt in KV** keyed by request_uuid. Store metadata in **D1** keyed by same request_uuid: timestamp, tokens_in, tokens_out, provider, model, tokens_in_cost, tokens_out_cost, isError, errorMessage, isCircuitBreaker, circuitBrokenMessage, payloadJson (extra non-required fields), + project + importance.
- **Circuit breakers** in dedicated KV: budgets + rules scoped by project, and global by provider/model. When tripped, reject future calls and record the rejection in D1 (isCircuitBreaker + circuitBrokenMessage).
- **Kill switch**: global; toggleable from frontend, MCP tool, or API. While active, reject ALL AI ops (stop billable bleeding).
- **Global circuits**: max billable by provider/model and by project; once reached, block further calls to that scope.
- Management surface: circuit CRUD + kill-switch toggle via API + MCP (frontend in #2).

---

## Spec #2 — Admin frontend (SKELETON)

Astro SSR + shadcn page(s) to manage what #1 stores in KV/D1.
- Circuit-definition CRUD: scope (project | provider/model | global), budget amount, window, enabled — reads/writes #1's circuit API.
- Kill-switch toggle with clear ON/OFF state + confirmation (irreversible-ish; stops all AI).
- Show currently-tripped circuits + break-glass control.
- Depends on: #1 circuit API + KV schema. Follows existing dashboard component patterns.

## Spec #3 — Usage enrichment frontend (SKELETON)

Enrich existing usage breakdown so high usage points to the **project** driving it.
- Add `project` (and importance) dimension to the cost views — sourced from #1's D1 per-request table joined/aggregated, alongside existing `queryGatewayCosts` gateway/provider/model dims.
- Likely new aggregate query `usageByProject(start,end)` + REST route + component extending `WorkerSpendMonitor`/`AiGatewayBilling`.
- Depends on: #1 D1 table populated with project/importance.

## Spec #4 — Jules recommendations (SKELETON)

Weekly cron → Jules analysis → stored recommendations surfaced in frontend.
- Cron (add to existing scheduled handler) runs weekly.
- Calls Jules via **jules-sdk**, secret `JULES_API_KEY`. **UNKNOWN: jules-sdk interface — must confirm before designing #4.**
- Passes Jules: all model names + info, plus an **authless curl command** letting Jules sample prompts + token counts + billable amounts for every prompt in the review window (implies a scoped, time-boxed, unauthenticated sampling endpoint — security-review this: signed/expiring URL, not a standing open endpoint).
- Jules returns per-project + global recommendations (e.g. "prompt X on gpt-oss-120b → right-size to cheaper capable model Y").
- Store recommendations (new D1 table) + surface on a frontend recommendations page.
- Depends on: #1 (prompt KV + D1 metadata to sample), #3 (project dimension). Open security question: the authless sampling endpoint is the riskiest surface in the whole system.

---

## Build order

#1 Routing Core → #2 Admin frontend → #3 Usage enrichment → #4 Jules. Each: brainstorm → design doc → writing-plans → build. This overlay doc updated as decisions land.
