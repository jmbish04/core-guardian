# Spec #4 — AI Router: Jules Right-Sizing Recommendations (design)

**Status:** designed 2026-08-14; branch `claude/ai-router-jules-recommendations` off main (#1–3 merged+deployed). **Coordination-gated** — see §6.
**Umbrella:** [2026-08-10-ai-router-overview.md](./2026-08-10-ai-router-overview.md).
**Scope (approved "Both"):** (A) a weekly local recommender feed over AI Router per-project usage → a NEW `ai_router_recommendations` table; (B) an on-demand "Send to Jules" dispatch that AUTO_CREATE_PRs a right-sizing fix in the project's repo (reusing the existing Jules infra + its nonce callback); (C) a frontend recommendations section.

---

## 1. Key finding — most of this already exists (reuse, don't rebuild)
- **`guardian/offense/jules-dispatch.ts`** — full Jules session integration. `createJulesDispatch(env,{julesSessionId?,targetId?}) → {id,nonce}`; `dispatchToJules(env, target: ScanTargetRow) → DispatchResult`; `recordFindings(env, dispatch, findings)`. Prompt is hardcoded via `buildAuditPrompt` (jules-dispatch.ts:138); the **authless callback is already secured** — a one-time `nonce` in `jules_dispatches`, validated at `POST /findings` on `offensePublicRouter` (offense.ts:538). **The "riskiest surface" is a solved pattern.**
- **`guardian/model-recommendations.ts`** — `getRecommendations(env,{days,classifyPrompts,minSavingsUsd}) → RecommendationReport` already does local "model X overkill → cheaper Y" (Workers-AI min-tier classify), but usage is hardcoded to `aiGatewayCosts`+`aiUsageRegistrations` via `observedUsage()`. `syncRecommendationAlerts(env)` writes to the shared `alerts` table.
- **`guardian_projects.repo`** (owner/repo, nullable) — the project→repo mapping. **Owned by cousin sessions** (§6). Read-only for #4.
- **`_worker.ts scheduled()`** (line 414) runs `runGuardianEvaluation(env)` unconditionally every fire; weekly tasks self-gate by `Date`.

## 2. Seams (minimal, additive edits)
| Seam | File | Change |
|---|---|---|
| Pass AI-Router usage to the recommender | `model-recommendations.ts:207` | add optional `observed?: ObservedModel[]` to `getRecommendations`; when present, skip `observedUsage()` and run the math on it. |
| Custom Jules prompt/payload | `jules-dispatch.ts` (`dispatchToJules`) | add optional `taskType`/`promptOverride`; branch to a new `buildRightSizingPrompt` + right-sizing REST payload. |
| Right-sizing task type | `jules_dispatches` schema enum | add `"right_sizing"` to `taskType`. |
| Right-sizing callback | `offense.ts` `offensePublicRouter` | NEW `POST /right-size-findings` + `rightSizingBodySchema` (suggested_model, savings_usd, pr_url, nonce) + a new intake writing to `ai_router_recommendations`. |
| Weekly run | `_worker.ts` `runGuardianEvaluation` | add `maybeRunRightSizing(env)` gated to Monday 08:00 UTC. |

## 3. New data + routes (isolated — no conflict)
- **New table `ai_router_recommendations`** (`schemas/governance/ai-router-recommendations.ts`, migration 0021+): `id, at, project, provider, model (current), suggestedProvider, suggestedModel, rationale, estMonthlySavingsUsd, source ("local"|"jules"), julesSessionId (null), prUrl (null), status ("open"|"dispatched"|"pr_opened"|"dismissed"), createdAt`. Indexes `(project)`, `(at)`.
- **`guardian/ai-router-usage.ts`** (#3) → add `observedForRecommender(env,start,end): ObservedModel[]` deriving per-(provider,model) usage across all router projects (+ per-project variant), shaped to what `getRecommendations({observed})` wants.
- **REST (ai-router.ts, guardianAuth):**
  - `GET /api/ai-router/recommendations?project?` → `{ recommendations: [...] }`.
  - `POST /api/ai-router/recommendations/{id}/dispatch-jules` → resolve the rec's `project → guardian_projects.repo`; if repo present, `dispatchToJules(right_sizing)` with a prompt built from the project's per-model usage + sampled prompts (PROMPTS KV) + the suggested model; set the rec `source/status`, link `julesSessionId`. If repo null → 409 "no repo mapping; advisory only".
  - `POST /api/ai-router/recommendations/{id}/dismiss`.

## 4. Weekly local feed (A)
`maybeRunRightSizing(env)` (Monday 08:00): build `observedForRecommender` over the trailing 30d → `getRecommendations(env,{observed, classifyPrompts:true, minSavingsUsd:1})` → upsert each into `ai_router_recommendations` (source "local", status "open"). Idempotent by `(project,provider,model)` for the current period.

## 5. Frontend (C)
`AiRouterRecommendations.tsx` island on the AI Router page (below the usage panel): table of open recs (project, current→suggested model, est. monthly savings, rationale, source), a per-row **"Send to Jules"** button (calls the dispatch route; disabled + tooltip "no repo mapping" when the project has no repo), a **"Dismiss"** action, and a Jules session/PR-link badge once dispatched. Follows the #2/#3 island pattern (`apiGet`/`apiSend`, inline error, `PANEL`).

## 6. ⚠️ Coordination gate (multi-session)
#4's §2 seams touch files **other running core-guardian sessions own**:
- `local_d50b373b` ("scan-workers / guardian_projects reconciler") — actively editing `offense/` + reconciling `guardian_projects.repo`. **Coordination message sent** asking for the project→repo join key + schema stability.
- `local_da1b5a76` ("$600 bill investigation") — created `guardian_projects` + `jules_sessions` migrations; may still be editing governance schemas (incl. `jules_dispatches`).

**Build order to avoid conflicts:**
1. **Isolated first (no shared-file edits):** the new `ai_router_recommendations` table + migration, `observedForRecommender`, the `GET /recommendations` + dismiss routes, the frontend island. These touch only new files + `ai-router.ts` (ours) + `ai-router-usage.ts` (ours).
2. **Recommender seam** (`model-recommendations.ts` optional `observed?`) — additive, low conflict; confirm no cousin is mid-edit.
3. **Shared/deferred until cousins confirm:** the `jules-dispatch.ts` `taskType` seam, the `jules_dispatches` enum add, the `offense.ts` `/right-size-findings` route, and the `_worker.ts` weekly gate. Do these only after `d50b373b`/`da1b5a76` confirm the schema + offense files are stable (or after their branches merge), to avoid merge hell.

## 7. Verification
`pnpm build` + `pnpm lint`; migration applies; `GET /api/ai-router/recommendations` in `/openapi.json` after deploy; a dispatch against a repo-mapped project opens a Jules session row. Frontend SSR render (env hydration caveat per #2/#3). agy adversarial review pre-merge.

## 8. File list
New: `schemas/governance/ai-router-recommendations.ts`, `components/dashboard/AiRouterRecommendations.tsx`.
Modify (ours): `guardian/ai-router-usage.ts`, `api/routes/ai-router.ts`, `components/dashboard/index.ts`, `pages/dashboard/ai-router.astro`.
Modify (SHARED — coordinate): `guardian/model-recommendations.ts`, `guardian/offense/jules-dispatch.ts`, `api/routes/offense.ts`, `schemas/governance/offense/jules-dispatches.ts`, `_worker.ts`, `wrangler.jsonc` (weekly cron).
