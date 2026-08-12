# Spec #3 — AI Router: Usage-by-Project (design)

**Status:** design approved 2026-08-12; branch `claude/ai-router-usage-by-project` off merged main (specs #1 + #2 landed).
**Umbrella:** [2026-08-10-ai-router-overview.md](./2026-08-10-ai-router-overview.md).
**Scope:** aggregate the `ai_router_requests` D1 table by project so an operator can see which project drives AI spend, with a per-project model drill-down. New backend query + 2 REST routes + one frontend island added to the existing `/dashboard/ai-router` page.

---

## 1. Goal & non-goals
**Goal:** answer "why is usage high — which project?" — a cost-descending rollup of router traffic per project (cost, tokens, requests, error %, breaker count) with click-through to that project's top models.
**Non-goals:** Jules recommendations (#4); changing metering/routing (#1); non-router traffic (only `ai_router_requests` carries a `project` dimension — this view is router-only, which is correct for per-project attribution).

## 2. Data source
`ai_router_requests` (spec #1, migration 0020) — indexed on `(project)`, `(model)`, `(at)`. Columns used: `at, project, provider, model, costUsd, tokensIn, tokensOut, isError, isCircuitBreaker`. Aggregation via Drizzle `.groupBy()` + `sql<number>\`sum(...)\`` (pattern from `guardian/billable-usage.ts:276`).

## 3. Backend

### 3.1 `src/backend/guardian/ai-router-usage.ts`
```ts
export interface ProjectUsage {
  project: string; requests: number; tokensIn: number; tokensOut: number;
  costUsd: number; errors: number; breakers: number;
}
export interface ModelUsage {
  provider: string; model: string; requests: number;
  tokensIn: number; tokensOut: number; costUsd: number;
}
// group ai_router_requests by project over [start,end], sorted costUsd desc
export function usageByProject(env: Env, start: number, end: number): Promise<ProjectUsage[]>;
// group one project's rows by (provider, model), sorted costUsd desc
export function usageByModelForProject(env: Env, project: string, start: number, end: number): Promise<ModelUsage[]>;
```
Implementation: `getDb(env).select({...aggregates}).from(aiRouterRequests).where(and(gte(at,start), lte(at,end)[, eq(project,…)])).groupBy(project | provider,model).orderBy(desc(costSum))`. `errors`/`breakers` = `sum(case when is_error then 1 else 0)` via `sql<number>\`sum(${aiRouterRequests.isError})\`` (boolean stored as 0/1 int, so `sum` works directly). Round money at the edge, not in SQL.

### 3.2 REST (append to `src/backend/api/routes/ai-router.ts`, guardianAuth)
- `GET /api/ai-router/usage?start&end` → `{ projects: ProjectUsage[] }`. `start`/`end` Unix ms (coerced); default `end=now`, `start=now-30d` when omitted.
- `GET /api/ai-router/usage/{project}?start&end` → `{ models: ModelUsage[] }` for the drill-down.
Both `guardianAuth`-gated (same as the other management routes), audited only if mutating — these are reads, no audit.

## 4. Frontend

### 4.1 `src/frontend/components/dashboard/AiRouterUsage.tsx` (new island)
A separate island (AiRouterConsole is already large) mounted ABOVE `<AiRouterConsole>` on `ai-router.astro`. Sections in one `PANEL`:
- **Date-range selector:** `Select` 7 / 30 / 90 days (default 30). On change → refetch.
- **Cost-by-project bar chart:** recharts (via `@/components/ui/chart`) horizontal bar, top ~10 projects by `costUsd`, using the OKLCH `--chart-*` palette. Header "Spend by project (last N days)".
- **Project table** (`ResourceTable`): columns project, requests, tokensIn/out, costUsd, error % (`errors/requests`), breakers. Sorted cost desc. Row click → expand/opens the model drill.
- **Model drill:** on selecting a project, fetch `GET /usage/{project}` and show its `ModelUsage[]` in a sub-table or `Dialog` (provider/model, requests, tokens, cost). Keep it a `Dialog` for simplicity.
Data: `apiGet<{projects:ProjectUsage[]}>("/ai-router/usage", { start, end })`; same `useState/useCallback/useEffect` + inline-error-banner + 401 sign-in pattern as `AiRouterConsole`/`AiGatewayBilling`. `const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";`

### 4.2 `ai-router.astro`
Add `<AiRouterUsage client:load />` above `<AiRouterConsole client:load />` (import from `@/components/dashboard`; barrel-export the new island). Nav entry already exists (#2).

## 5. Verification
`pnpm build` + `pnpm lint` green. Browser render check on `/dashboard/ai-router` (env's pre-existing hydration bug noted in #2 may block full interactivity — SSR render + parity is the achievable bar). Backend: the aggregation is a pure D1 read; a `GET /usage` curl with a session/`WORKER_API_KEY` returns the rollup.

## 6. File list
- Create `src/backend/guardian/ai-router-usage.ts`
- Modify `src/backend/api/routes/ai-router.ts` (+2 GET routes)
- Create `src/frontend/components/dashboard/AiRouterUsage.tsx`
- Modify `src/frontend/components/dashboard/index.ts` (barrel)
- Modify `src/frontend/pages/dashboard/ai-router.astro` (mount)

## 7. Diagram
```mermaid
flowchart TD
  Page["dashboard/ai-router.astro"] --> U["AiRouterUsage island"]
  Page --> C["AiRouterConsole island (spec #2)"]
  U -->|GET /ai-router/usage?start&end| Q["usageByProject() — groupBy project"]
  U -->|GET /ai-router/usage/{project}| M["usageByModelForProject() — groupBy provider,model"]
  Q --> D1[("ai_router_requests (idx: project, model, at)")]
  M --> D1
  U --> Chart["recharts bar: cost by project"]
  U --> Tbl["ResourceTable: per-project rollup"]
  Tbl -->|row click| Drill["Dialog: project's top models"]
```
