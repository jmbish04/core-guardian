# AI Router Usage-by-Project — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** aggregate `ai_router_requests` by project (cost-desc rollup + per-project model drill) via a new backend query + 2 REST routes + one frontend island on `/dashboard/ai-router`.

**Architecture:** `guardian/ai-router-usage.ts` (Drizzle groupBy) → 2 `GET` routes on the existing `ai-router` router → `AiRouterUsage.tsx` island (recharts bar + ResourceTable + drill Dialog). No schema change.

**Spec:** [2026-08-12-ai-router-3-usage-by-project-design.md](../specs/2026-08-12-ai-router-3-usage-by-project-design.md).

## Global Constraints
- Drizzle only, no raw SQL strings except `sql<number>` aggregate fragments. D1 binding `DB`.
- Verify each task `pnpm build` && `pnpm lint` (NEVER `pnpm check`).
- Frontend: import via `@/...` aliases + folder barrels; `apiGet`/`apiSend` from `@/lib/api`; `useState/useCallback/useEffect`; inline error banner (401 → sign-in notice); never `alert()`; `const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";`
- Money: round at the edge (UI/response), not in SQL.
- guardianAuth gates the new routes (reads; no audit rows).

---

### Task 1: `ai-router-usage.ts` aggregation query

**Files:** Create `src/backend/guardian/ai-router-usage.ts`

**Interfaces:** Produces `ProjectUsage`, `ModelUsage`, `usageByProject(env,start,end)`, `usageByModelForProject(env,project,start,end)`.

- [ ] **Step 1: Write the module**
```ts
/**
 * @fileoverview Aggregate ai_router_requests by project (and by model within a
 * project) so high AI spend can be attributed to the project driving it.
 * Router-only — ai_router_requests is the sole table carrying a `project` dim.
 */
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/backend/db";
import { aiRouterRequests } from "@/backend/db/schema";

export interface ProjectUsage {
  project: string; requests: number; tokensIn: number; tokensOut: number;
  costUsd: number; errors: number; breakers: number;
}
export interface ModelUsage {
  provider: string; model: string; requests: number;
  tokensIn: number; tokensOut: number; costUsd: number;
}

const n = (v: unknown) => Number(v ?? 0);

export async function usageByProject(env: Env, start: number, end: number): Promise<ProjectUsage[]> {
  const rows = await getDb(env)
    .select({
      project: aiRouterRequests.project,
      requests: sql<number>`count(*)`,
      tokensIn: sql<number>`sum(${aiRouterRequests.tokensIn})`,
      tokensOut: sql<number>`sum(${aiRouterRequests.tokensOut})`,
      costUsd: sql<number>`sum(${aiRouterRequests.costUsd})`,
      errors: sql<number>`sum(${aiRouterRequests.isError})`,
      breakers: sql<number>`sum(${aiRouterRequests.isCircuitBreaker})`,
    })
    .from(aiRouterRequests)
    .where(and(gte(aiRouterRequests.at, start), lte(aiRouterRequests.at, end)))
    .groupBy(aiRouterRequests.project)
    .orderBy(desc(sql`sum(${aiRouterRequests.costUsd})`));
  return rows.map((r) => ({
    project: r.project, requests: n(r.requests), tokensIn: n(r.tokensIn), tokensOut: n(r.tokensOut),
    costUsd: n(r.costUsd), errors: n(r.errors), breakers: n(r.breakers),
  }));
}

export async function usageByModelForProject(
  env: Env, project: string, start: number, end: number,
): Promise<ModelUsage[]> {
  const rows = await getDb(env)
    .select({
      provider: aiRouterRequests.provider,
      model: aiRouterRequests.model,
      requests: sql<number>`count(*)`,
      tokensIn: sql<number>`sum(${aiRouterRequests.tokensIn})`,
      tokensOut: sql<number>`sum(${aiRouterRequests.tokensOut})`,
      costUsd: sql<number>`sum(${aiRouterRequests.costUsd})`,
    })
    .from(aiRouterRequests)
    .where(and(eq(aiRouterRequests.project, project), gte(aiRouterRequests.at, start), lte(aiRouterRequests.at, end)))
    .groupBy(aiRouterRequests.provider, aiRouterRequests.model)
    .orderBy(desc(sql`sum(${aiRouterRequests.costUsd})`));
  return rows.map((r) => ({
    provider: r.provider, model: r.model, requests: n(r.requests),
    tokensIn: n(r.tokensIn), tokensOut: n(r.tokensOut), costUsd: n(r.costUsd),
  }));
}
```
> `isError`/`isCircuitBreaker` are `integer({mode:"boolean"})` = stored 0/1, so `sum(...)` counts them directly.

- [ ] **Step 2:** `pnpm build && pnpm lint` → exit 0.
- [ ] **Step 3:** Commit `feat(ai-router): usageByProject + usageByModelForProject aggregation`.

---

### Task 2: REST routes

**Files:** Modify `src/backend/api/routes/ai-router.ts` (append 2 GET routes)

**Interfaces:** Consumes Task 1's exports; reuses the file's existing `guardianAuth`, `createRoute`, `z`.

- [ ] **Step 1: Import + routes.** Add `import { usageByProject, usageByModelForProject } from "@/backend/guardian/ai-router-usage";`. Gate: add `aiRouterRouter.use("/usage", guardianAuth);` and `aiRouterRouter.use("/usage/*", guardianAuth);` alongside the existing `.use(...)` guards. Then:
```ts
const projectUsageSchema = z.object({
  project: z.string(), requests: z.number(), tokensIn: z.number(), tokensOut: z.number(),
  costUsd: z.number(), errors: z.number(), breakers: z.number(),
});
const modelUsageSchema = z.object({
  provider: z.string(), model: z.string(), requests: z.number(),
  tokensIn: z.number(), tokensOut: z.number(), costUsd: z.number(),
});

aiRouterRouter.openapi(createRoute({
  method: "get", path: "/usage", operationId: "aiRouterUsageByProject",
  summary: "Router usage aggregated per project over a date range",
  request: { query: z.object({ start: z.coerce.number().optional(), end: z.coerce.number().optional() }) },
  responses: { 200: { description: "Per-project usage", content: { "application/json": { schema: z.object({ projects: z.array(projectUsageSchema) }) } } } },
}), async (c) => {
  const { start, end } = c.req.valid("query");
  const e = end ?? Date.now();
  const s = start ?? e - 30 * 86_400_000;
  return c.json({ projects: await usageByProject(c.env, s, e) }, 200);
});

aiRouterRouter.openapi(createRoute({
  method: "get", path: "/usage/{project}", operationId: "aiRouterUsageByModel",
  summary: "A project's router usage broken down by provider/model",
  request: { params: z.object({ project: z.string() }), query: z.object({ start: z.coerce.number().optional(), end: z.coerce.number().optional() }) },
  responses: { 200: { description: "Per-model usage for the project", content: { "application/json": { schema: z.object({ models: z.array(modelUsageSchema) }) } } } },
}), async (c) => {
  const { project } = c.req.valid("param");
  const { start, end } = c.req.valid("query");
  const e = end ?? Date.now();
  const s = start ?? e - 30 * 86_400_000;
  return c.json({ models: await usageByModelForProject(c.env, project, s, e) }, 200);
});
```
- [ ] **Step 2:** `pnpm build && pnpm lint` → exit 0. (Routes auto-register into `/openapi.json`.)
- [ ] **Step 3:** Commit `feat(ai-router): GET /usage + /usage/{project} routes`.

---

### Task 3: `AiRouterUsage` island + mount

**Files:**
- Create `src/frontend/components/dashboard/AiRouterUsage.tsx`
- Modify `src/frontend/components/dashboard/index.ts` (barrel)
- Modify `src/frontend/pages/dashboard/ai-router.astro` (mount above `<AiRouterConsole>`)

**Interfaces:** Consumes `apiGet`/`ApiError` from `@/lib/api`; `ResourceTable`+`Column` from `@/components/storage`; `Dialog`, `Select`, `Badge` from `@/components/ui/*`; the chart primitives from `@/components/ui/chart` + `recharts`.

**Reference templates:** `src/frontend/components/dashboard/AiRouterConsole.tsx` (load/error/table/Dialog patterns from #2), any existing recharts usage (`grep -rln "recharts\|ChartContainer" src/frontend/components`) for the exact `@/components/ui/chart` API (ChartContainer/ChartConfig/ChartTooltip), and `WorkerSpendMonitor.tsx`.

- [ ] **Step 1:** `grep -rln "recharts\|ChartContainer\|ChartConfig" src/frontend/components` and read one real chart consumer + `src/frontend/components/ui/chart.tsx` to learn the exact chart API before writing.
- [ ] **Step 2:** Write `AiRouterUsage.tsx` (default export, no props) per spec §4.1:
  - Types `ProjectUsage`/`ModelUsage` (mirror Task 1).
  - Date-range `Select` (7/30/90 days, default 30); compute `start=Date.now()-days*86400000`, `end=Date.now()`.
  - `load()` → `apiGet<{projects:ProjectUsage[]}>("/ai-router/usage", { start, end })`; inline error/401 banner; loading state.
  - Cost-by-project **bar chart** (recharts via `@/components/ui/chart`), top 10 by costUsd, `--chart-*` palette.
  - Project `ResourceTable`: project, requests, tokens (in/out), costUsd ($), error% (`errors/requests`), breakers; sorted cost desc; row action/click "Models".
  - Model drill: on selecting a project, `apiGet<{models:ModelUsage[]}>("/ai-router/usage/" + encodeURIComponent(project), { start, end })` → show in a `Dialog` (provider/model, requests, tokens, cost).
  - `const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";`
- [ ] **Step 3:** Barrel-export in `dashboard/index.ts`. Mount in `ai-router.astro`: `import { AiRouterUsage, AiRouterConsole } from "@/components/dashboard"` and place `<AiRouterUsage client:load />` ABOVE `<AiRouterConsole client:load />`.
- [ ] **Step 4:** `pnpm build && pnpm lint` → exit 0 (fix a11y: label/htmlFor, button type; chart responsive container).
- [ ] **Step 5:** Commit `feat(ai-router): AiRouterUsage island (cost-by-project chart + model drill)`.

---

## Final verification
- `pnpm build` + `pnpm lint` green.
- Browser render on `/dashboard/ai-router`: usage panel renders above the console (chart + table). Full hydration may be blocked by the env's pre-existing `before-hydration.js` 404 (see #2) — SSR render + parity is the achievable bar; note it.
- Confirm `GET /api/ai-router/usage` appears in `/openapi.json` after deploy.

## Self-review
- Coverage: aggregation query (T1) · routes + openapi (T2) · chart + table + drill (T3). All spec sections mapped.
- Novel logic (the two groupBy queries) is verbatim; frontend follows #2's established island pattern.
