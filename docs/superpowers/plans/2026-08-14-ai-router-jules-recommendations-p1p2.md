# AI Router Recommendations — P1+P2 Implementation Plan (isolated; no shared-file edits)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Scope:** the CONFLICT-FREE half of spec #4 — a working per-project right-sizing recommendations feature that populates on demand (a `refresh` route), storing to a NEW `ai_router_recommendations` table, surfaced in a frontend section. **Deferred to P3 (needs cousin coordination):** the weekly cron (`_worker.ts`/wrangler) and the Jules auto-PR dispatch (`jules-dispatch.ts`/`offense.ts`/`jules_dispatches` enum). See spec §6.

**Spec:** [2026-08-14-ai-router-4-jules-recommendations-design.md](../specs/2026-08-14-ai-router-4-jules-recommendations-design.md).

## Global Constraints
- Drizzle only; D1 binding `DB`; migrations via `pnpm run db:generate` then `migrate:local`.
- Verify each task `pnpm build` && `pnpm lint` (NEVER `pnpm check`).
- Frontend: `@/` aliases + barrels; `apiGet`/`apiSend`; inline error (401→sign-in); never `alert()`; `const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";`
- Reuse `getRecommendations` (`model-recommendations.ts`) — the ONLY semi-shared file we touch, and only additively (new optional param + export a type). Do NOT touch `jules-dispatch.ts`, `offense.ts`, `_worker.ts`, `jules_dispatches`, `guardian_projects`.

---

### Task 1: `ai_router_recommendations` table + migration
**Files:** Create `src/backend/db/schemas/governance/ai-router-recommendations.ts`; modify `schemas/governance/index.ts` (export).
- [ ] Write the schema (follow the `ai-router-requests.ts` convention: doc constants + insert/select schemas + Row types):
```ts
export const aiRouterRecommendations = sqliteTable("ai_router_recommendations", {
  id: text("id").primaryKey(),
  at: integer("at").notNull(),
  project: text("project").notNull(),
  provider: text("provider").notNull(),          // current provider
  model: text("model").notNull(),                // current model
  suggestedProvider: text("suggested_provider"),
  suggestedModel: text("suggested_model"),
  rationale: text("rationale").notNull().default(""),
  estMonthlySavingsUsd: real("est_monthly_savings_usd").notNull().default(0),
  source: text("source", { enum: ["local", "jules"] }).notNull().default("local"),
  julesSessionId: text("jules_session_id"),
  prUrl: text("pr_url"),
  status: text("status", { enum: ["open", "dispatched", "pr_opened", "dismissed"] }).notNull().default("open"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
}, (t) => [index("idx_ai_router_rec_project").on(t.project), index("idx_ai_router_rec_at").on(t.at)]);
```
Dedup key for upsert: `id = "${project}:${provider}:${model}"` (one open rec per project+current-model; refresh overwrites).
- [ ] `pnpm run db:generate` → `pnpm run migrate:local`. `pnpm build && pnpm lint`. Commit `feat(ai-router): ai_router_recommendations table + migration`.

---

### Task 2: recommender seam (P2, additive)
**Files:** Modify `src/backend/guardian/model-recommendations.ts`
- [ ] Export the `ObservedModel` type (add `export` to its declaration if not already).
- [ ] Add an optional `observed?: ObservedModel[]` to `getRecommendations`'s options; at line ~215 change `observedUsage(env, days)` to `(opts.observed ?? await observedUsage(env, days))`. Everything else unchanged. (When callers pass `observed`, the DB fetch is skipped.)
- [ ] `pnpm build && pnpm lint`. Commit `feat(ai-router): getRecommendations accepts an injected observed[] (seam)`.

---

### Task 3: per-project derivation + sync
**Files:** Modify `src/backend/guardian/ai-router-usage.ts`
- [ ] Add `observedForProject(env, project, start, end): Promise<ObservedModel[]>` — group `ai_router_requests` by (provider, model) for that project over the window, summing requests/tokensIn/tokensOut/costUsd, shaped to `ObservedModel` (import the type from `model-recommendations`). Reuse the existing groupBy pattern in this file.
- [ ] Add `syncRouterRecommendations(env, days = 30): Promise<number>` — for each project in `usageByProject(env, start, end)`, derive `observedForProject`, call `getRecommendations(env, { observed, days, minSavingsUsd: 1 })`, and for each returned recommendation upsert an `ai_router_recommendations` row (`id = project:currentProvider:currentModel`, source "local", status "open", est savings + rationale + suggested model). `onConflictDoUpdate` the mutable fields. Returns rows written. Skip `classifyPrompts` (tier-based only in P1).
- [ ] `pnpm build && pnpm lint`. Commit `feat(ai-router): observedForProject + syncRouterRecommendations`.

---

### Task 4: routes
**Files:** Modify `src/backend/api/routes/ai-router.ts` (append; reuse guardianAuth/createRoute/z)
- [ ] `aiRouterRouter.use("/recommendations", guardianAuth)` + `.use("/recommendations/*", guardianAuth)`.
- [ ] `GET /recommendations?project?` → `{ recommendations: <rows> }` (from `ai_router_recommendations`, newest first, optional project filter, status != "dismissed" by default).
- [ ] `POST /recommendations/refresh` → runs `syncRouterRecommendations(c.env)`; returns `{ written }`. (Manual populate — stands in for the deferred weekly cron.)
- [ ] `POST /recommendations/{id}/dismiss` → set status "dismissed"; `{ ok: true }`. Audit to `billing_events` (mutation).
- [ ] `pnpm build && pnpm lint`. Commit `feat(ai-router): recommendations routes (list, refresh, dismiss)`.

---

### Task 5: frontend recommendations island
**Files:** Create `src/frontend/components/dashboard/AiRouterRecommendations.tsx`; modify `dashboard/index.ts` (barrel) + `pages/dashboard/ai-router.astro` (mount BELOW `<AiRouterConsole>`).
- [ ] Island (default export): `apiGet<{recommendations:Rec[]}>("/ai-router/recommendations")` on mount; a **"Refresh"** button → `apiSend("POST","/ai-router/recommendations/refresh")` then reload; a `ResourceTable` (project, current model → suggested model, est. monthly savings $, rationale, source badge, status); a **Dismiss** action per row → `apiSend("POST", "/ai-router/recommendations/" + id + "/dismiss")` then reload. Empty state "No recommendations yet — Refresh to analyze." Inline error/401. Model `PANEL` + the #2/#3 island pattern. (The "Send to Jules" button is P3 — omit for now; leave a `// P3:` note.)
- [ ] Barrel export; mount `<AiRouterRecommendations client:load />` below the console in `ai-router.astro`.
- [ ] `pnpm build && pnpm lint`. Commit `feat(ai-router): AiRouterRecommendations island`.

---

## Final (P1+P2)
- `pnpm build`+`pnpm lint` green; migration applies; `GET /api/ai-router/recommendations` + `/recommendations/refresh` in `/openapi.json`.
- Browser SSR render on `/dashboard/ai-router` (env hydration caveat). agy review pre-merge.
- Leaves P3 (weekly cron + Jules auto-PR) cleanly separable, to build after cousin coordination.
