# AI Router Jules Dispatch + Weekly Cron — P3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Scope:** the shared-file half of spec #4 — on-demand "Send to Jules" that AUTO_CREATE_PRs a right-sizing fix, + a weekly cron running the full recommendation sync. Reuses the existing Jules infra (`jules-dispatch.ts`, `offense.ts` nonce callback, `jules_sessions` lifecycle). **Coordination CLEARED** (see spec §6): guardian_projects owner + jules_dispatches/offense owner both signed off; I own the additive `right_sizing` taskType.

**Branch:** `claude/ai-router-jules-p3` off LATEST main (has #36's recs table/routes/frontend + all sibling work). **Spec:** [2026-08-14-ai-router-4-jules-recommendations-design.md](../specs/2026-08-14-ai-router-4-jules-recommendations-design.md).

## Global Constraints
- Verify each task `pnpm build` && `pnpm lint` (NEVER `pnpm check`).
- Reuse, don't rebuild: `createJulesDispatch`/`dispatchToJules`/`recordFindings` (`guardian/offense/jules-dispatch.ts`), the `offensePublicRouter` nonce pattern (`api/routes/offense.ts`), `julesSessions`/`julesDispatches` schemas. Register a `jules_sessions` row on dispatch (for the P14a `/jules` monitor + poller).
- `guardian_projects.repo`: exact `project === guardian_projects.name` match (NO normalization — do NOT mirror the offense scanner's lowercase), read the single already-resolved `repo`, null → advisory-only (no dispatch).
- Coordinate before any further offense/ edits beyond this plan.

## Reference (exact current signatures, from agy)
- `createJulesDispatch(env, { julesSessionId?, targetId? }) → { id, nonce }` (jules-dispatch.ts:86) — hardcodes `taskType:"spend_audit"` at :98.
- `dispatchToJules(env, target: ScanTargetRow) → { ok, dispatchId, julesSessionId, error? }` (:201) — prompt hardcoded via `buildAuditPrompt` at :245; Jules POST at :251-266 (`{prompt, sourceContext:{source, githubRepoContext}, automationMode:"AUTO_CREATE_PR", title}`, `X-Goog-Api-Key`).
- `jules_sessions` cols: id, sessionId, dispatchId, project, repo(notNull), status enum, sessionUrl, prUrl, createdAt, updatedAt. Insert pattern jules-dispatch.ts:300-312.
- `jules_dispatches.taskType` enum `["spend_audit"]` (jules-dispatches.ts:52) — TEXT, no CHECK → widening is TS-only, **expect no migration**.
- Nonce callback: `POST /findings` on `offensePublicRouter` (offense.ts:538, public/no-auth), validates nonce where `status="pending" AND taskType="spend_audit"` (:577).

---

### Task 1: `right_sizing` taskType (TS-only)
**Files:** Modify `src/backend/db/schemas/governance/offense/jules-dispatches.ts`
- [ ] Widen the `taskType` enum at line ~52 from `["spend_audit"]` to `["spend_audit", "right_sizing"]`.
- [ ] `pnpm run db:generate` — EXPECT "nothing to migrate" (TEXT enum, no CHECK). If it emits a migration, that's fine; apply it. Do NOT force a migration.
- [ ] `pnpm build && pnpm lint`. Commit `feat(ai-router): add right_sizing to jules_dispatches taskType`.

### Task 2: right-sizing dispatch in `jules-dispatch.ts`
**Files:** Modify `src/backend/guardian/offense/jules-dispatch.ts`
**Produces:** `buildRightSizingPrompt(args)`, `dispatchRightSizing(env, args)`.
- [ ] Add optional `taskType?: "spend_audit" | "right_sizing"` (default "spend_audit") to `createJulesDispatch`'s args; use it in the `julesDispatches` insert instead of the hardcoded literal.
- [ ] Add `buildRightSizingPrompt({ owner, repo, findingsUrl, nonce, project, currentModel, suggestedModel, rationale, samplePrompts })` — a prompt instructing Jules to: analyze the named project's AI calls, switch `currentModel`→`suggestedModel` where safe, open a PR, and POST results to `findingsUrl` with the one-time `nonce` (mirror `buildAuditPrompt`'s callback instructions but for right-sizing; callback body = `{ suggested_model, savings_usd?, pr_url?, project, nonce }`).
- [ ] Add `dispatchRightSizing(env, { repo, project, currentModel, suggestedModel, rationale, samplePrompts }): Promise<{ ok, dispatchId, julesSessionId, error? }>` — mirror `dispatchToJules` but take `repo`/`project` directly (not a ScanTargetRow): `createJulesDispatch({ taskType:"right_sizing" })` → `{id, nonce}`; build `findingsUrl = ${WORKER_BASE_URL}/api/guardian/offense/right-size-findings` (match how buildAuditPrompt builds its findings URL); `buildRightSizingPrompt(...)`; POST to Jules (reuse the exact fetch/auth/body block, sourceContext.githubRepoContext = the repo); on success register a `jules_sessions` row (id uuid, sessionId, dispatchId, project, repo, status "pending", sessionUrl) exactly like :300-312. Return the result.
- [ ] Do NOT change the existing `spend_audit` path. `pnpm build && pnpm lint`. Commit `feat(ai-router): dispatchRightSizing + buildRightSizingPrompt (reuse Jules infra)`.

### Task 3: `/right-size-findings` nonce callback
**Files:** Modify `src/backend/api/routes/offense.ts`
- [ ] Add `POST /right-size-findings` on the SAME `offensePublicRouter` (public, no guardianAuth) as `/findings`. Body schema `rightSizeFindingsSchema = z.object({ suggested_model: z.string().optional(), savings_usd: z.number().optional(), pr_url: z.string().optional(), project: z.string(), nonce: z.string() })`.
- [ ] Validate: look up `julesDispatches` where `nonce == body.nonce AND status == "pending" AND taskType == "right_sizing"`; no match → 403 (mirror the `/findings` 403).
- [ ] Intake: update the `ai_router_recommendations` row(s) linked to this dispatch's `julesSessionId` (set `status:"pr_opened"`, `prUrl: body.pr_url ?? null`, keep `julesSessionId`); mark the dispatch `status:"reported", reportedAt: Date.now()`; also update the `jules_sessions` row `status:"submitted", prUrl`. Return `{ ok: true }`.
- [ ] `pnpm build && pnpm lint`. Commit `feat(ai-router): POST /right-size-findings nonce callback`.

### Task 4: dispatch route
**Files:** Modify `src/backend/api/routes/ai-router.ts`
- [ ] `POST /api/ai-router/recommendations/{id}/dispatch-jules` (guardianAuth): load the rec by id from `ai_router_recommendations`; resolve `repo` from `guardian_projects` where `name == rec.project` (exact). If no row / null repo → `409 { error: "No repo mapping for project; advisory only." }`. Else call `dispatchRightSizing(c.env, { repo, project: rec.project, currentModel: rec.model, suggestedModel: rec.suggestedModel ?? "", rationale: rec.rationale, samplePrompts: [] })`; on ok, update the rec `status:"dispatched", julesSessionId: result.julesSessionId`; return `{ ok, julesSessionId, dispatchId }`. Audit to billing_events.
- [ ] `pnpm build && pnpm lint`. Commit `feat(ai-router): POST /recommendations/{id}/dispatch-jules`.

### Task 5: weekly cron
**Files:** Modify `src/_worker.ts` + `wrangler.jsonc`
- [ ] `wrangler.jsonc` `triggers.crons`: add `"0 8 * * 1"` (Monday 08:00 UTC) alongside the existing `"0 * * * *"`.
- [ ] `src/_worker.ts`: in `runGuardianEvaluation(env)` (the fn the scheduled handler calls), add `await maybeRunRightSizing(env);` — a new fn gated to `d.getUTCDay()===1 && d.getUTCHours()===8` that calls `syncRouterRecommendations(env)` (import from `@/backend/guardian/ai-router-usage`). Wrap in try/catch so it never breaks the hourly path.
- [ ] `pnpm build && pnpm lint`. Commit `feat(ai-router): weekly right-sizing recommendation cron`.

### Task 6: frontend "Send to Jules"
**Files:** Modify `src/frontend/components/dashboard/AiRouterRecommendations.tsx`
- [ ] Replace the `// P3:` placeholder with a "Send to Jules" button per row (only for `status==="open"`): `apiSend("POST","/ai-router/recommendations/" + encodeURIComponent(id) + "/dispatch-jules")` then reload. On a 409 (ApiError.status===409) show an inline "No repo mapping — advisory only" notice for that row instead of erroring. When `status` is `dispatched`/`pr_opened`, show a Jules badge + a PR link (`r.prUrl`) instead of the button. Keep no-`alert()`, inline errors.
- [ ] `pnpm build && pnpm lint`. Commit `feat(ai-router): Send-to-Jules dispatch button + PR link`.

---
## Final
`pnpm build`+`pnpm lint` green; `right_sizing` no-migration confirmed (or applied); routes in `/openapi.json` after deploy; agy adversarial review pre-merge (focus: the public nonce route + dispatch abuse). Browser SSR render. Then PR + merge + deploy.
