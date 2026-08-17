# Spend Truth B2 — Rollup Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Materialize a cached `spend_rollup` that reconciles the Cloudflare billing actual to per-project spend, so the frontend reads ONE cheap D1 row instead of computing on load (kills the freeze), and every number carries its lane (Billed / Projected / Dispute).

**Architecture:** A cron-built rollup joins `billable_usage` (product ACTUAL, ground truth — verified 1,603 rows, `service_family` is the clean category key) to per-project estimated shares (`ai_router_requests` for AI; `resource_usage_snapshots` + `resource_bindings` for infra), allocating each family's actual across projects by estimated share so per-project sums to the real bill. Stored as a JSON payload row; the frontend reads the latest.

**Tech Stack:** Drizzle + D1, Hono, TS, node:test.

**Spec:** `docs/superpowers/specs/2026-08-16-spend-truth-attribution-design.md`
**Depends on:** B1 (PR #46) — `cf_resources`, `resource_usage_snapshots`, `resource_bindings`, `zones`.

## Global Constraints

- No AI in the pipeline. Pure D1 + arithmetic.
- Never fabricate: a family with no estimate basis is pooled as `unattributed`, never split by a guess.
- Billed = `billable_usage.contractedCost` (truth). Per-project = actual allocated by estimated share (labeled as allocation, never raw estimate).
- Verify with build + oxlint; tests via `npx tsx --test`.
- UTC period math.

## Category map (`service_family` → category)

`Workers AI`→`ai`, `D1`→`d1`, `R2`→`r2`, `Vectorize`→`vectorize`, `Workers`→`compute`, `Durable Objects`→`do` (NO per-project basis yet — pooled unattributed; flagged), everything else (`Workers KV`, `Browser Rendering`, `Stream`, `Queues`, `Containers`, …)→`other` (pooled).

## File Structure

- `src/backend/db/schemas/governance/spend-rollup.ts` — `spend_rollup` table (new).
- `src/backend/guardian/spend-rollup.ts` — `buildSpendRollup` + pure `allocateActual` (new).
- `src/backend/guardian/spend-rollup.test.ts` — allocation + lane math (new).
- `src/backend/api/routes/guardian.ts` — add `GET /spend-rollup` read route (modify).
- `src/_worker.ts` — cron builds the rollup after snapshots (modify).
- `src/frontend/components/dashboard/SpendByProject.tsx` — read rollup, reconciled allocation (modify).

---

### Task 1: `spend_rollup` table

**Files:** Create `spend-rollup.ts` schema; export from governance barrel.

**Interfaces:** Produces `spendRollup` — `{ id: string; builtAt: number; windowStart: number; windowEnd: number; totalActualUsd: number; payload: string /* JSON */ }`.

- [ ] **Step 1: Schema** (JSON-blob cache row; read latest by builtAt)

```ts
// src/backend/db/schemas/governance/spend-rollup.ts
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const SPEND_ROLLUP_TABLE_DESCRIPTION =
  "Cached reconciled spend ledger (one row per cron rebuild). payload is the full JSON the frontend renders: billed-by-family + per-project allocation + lanes. Read the newest by built_at.";

export const spendRollup = sqliteTable(
  "spend_rollup",
  {
    id: text("id").primaryKey(), // crypto.randomUUID()
    builtAt: integer("built_at").notNull(),
    windowStart: integer("window_start").notNull(),
    windowEnd: integer("window_end").notNull(),
    totalActualUsd: real("total_actual_usd").notNull().default(0),
    payload: text("payload").notNull(), // JSON string
  },
  (t) => [index("idx_spend_rollup_built").on(t.builtAt)],
);

export const insertSpendRollupSchema = createInsertSchema(spendRollup);
export const selectSpendRollupSchema = createSelectSchema(spendRollup);
export type SpendRollupRow = typeof spendRollup.$inferSelect;
export type NewSpendRollupRow = typeof spendRollup.$inferInsert;
```

- [ ] **Step 2:** `export * from "./spend-rollup";` in the governance barrel.
- [ ] **Step 3:** `pnpm run db:generate && npx wrangler d1 migrations apply DB --local`.
- [ ] **Step 4:** Commit.

---

### Task 2: pure `allocateActual` (TDD)

**Files:** Create `spend-rollup.ts` (helpers first); Test `spend-rollup.test.ts`.

**Interfaces:** Produces
`allocateActual(actualUsd: number, shares: { key: string; weight: number }[]): { key: string; usd: number }[]`
— distributes `actualUsd` across `shares` in proportion to `weight`; sums back to `actualUsd` (within rounding); all-zero weights → single `{ key: "__unattributed__", usd: actualUsd }`.

- [ ] **Step 1: Failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateActual } from "./spend-rollup";

test("allocateActual splits by weight and sums back to the actual", () => {
  const out = allocateActual(100, [{ key: "a", weight: 3 }, { key: "b", weight: 1 }]);
  assert.equal(out.find((o) => o.key === "a")!.usd, 75);
  assert.equal(out.find((o) => o.key === "b")!.usd, 25);
  assert.equal(out.reduce((s, o) => s + o.usd, 0), 100);
});

test("allocateActual with no weight basis pools to unattributed", () => {
  const out = allocateActual(42, [{ key: "a", weight: 0 }]);
  assert.deepEqual(out, [{ key: "__unattributed__", usd: 42 }]);
});
```

- [ ] **Step 2:** Run — FAIL (no export).
- [ ] **Step 3: Implement**

```ts
// src/backend/guardian/spend-rollup.ts (helpers)
export const UNATTRIBUTED = "__unattributed__";

export function allocateActual(
  actualUsd: number,
  shares: { key: string; weight: number }[],
): { key: string; usd: number }[] {
  const total = shares.reduce((s, x) => s + Math.max(0, x.weight), 0);
  if (!(total > 0) || !(actualUsd > 0)) return [{ key: UNATTRIBUTED, usd: actualUsd }];
  const out = shares
    .filter((s) => s.weight > 0)
    .map((s) => ({ key: s.key, usd: (s.weight / total) * actualUsd }));
  // Correct rounding drift so the parts sum to the whole.
  const drift = actualUsd - out.reduce((s, o) => s + o.usd, 0);
  if (out.length) out[0].usd += drift;
  return out;
}
```

- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit.

---

### Task 3: `buildSpendRollup` (integration)

**Files:** Modify `spend-rollup.ts`.

**Interfaces:** Consumes `billable_usage` (grouped by `service_family` over the cycle), `ai_router_requests` (per-project cost this cycle), `resource_usage_snapshots` + `resource_bindings` (per-project infra est share). Produces
`buildSpendRollup(env): Promise<{ id, builtAt, ... , payload }>` and writes one `spend_rollup` row.

Payload shape (what the frontend renders):
```ts
type RollupPayload = {
  window: { start: number; end: number; elapsedFraction: number };
  billed: { family: string; category: string; actualUsd: number; projectedUsd: number }[]; // mirrors CF bill
  totalActualUsd: number;
  totalProjectedUsd: number;
  projects: { name: string; kind: string; totalUsd: number; byCategory: Record<string, number> }[]; // allocation, sums to billed
  pools: { name: "unattributed" | "shared"; totalUsd: number }[];
};
```

- [ ] **Step 1: Implement** (per-family actual → allocate by category basis)

Key logic:
1. `billed`: `SELECT service_family, SUM(contracted_cost)` over the cycle → map family→category. `projectedUsd = actualUsd / elapsedFraction`.
2. Per-category project weights:
   - `ai`: `ai_router_requests` grouped by project, `SUM(cost_usd)` → weights.
   - `d1|r2|vectorize|compute`: `resource_usage_snapshots` latest per (resource,metric) → join `resource_bindings` → sum est_cost per owning project (sole-owner) / shared pool; weight = that est cost. (Reuse the B1 attribution shape.)
   - `do|other`: no basis → whole family actual → `unattributed`.
3. `allocateActual(familyActual, weights)` per category; accumulate into `projects[].byCategory` + `pools`.
4. Write the `spend_rollup` row (prune older than N rebuilds).

- [ ] **Step 2:** build + oxlint.
- [ ] **Step 3:** Commit.

---

### Task 4: `GET /api/guardian/spend-rollup` read route

**Files:** Modify `guardian.ts` (add route, guardianAuth already applied).

**Interfaces:** Returns the latest `spend_rollup` payload (parsed), or a 200 empty-shape when none built yet. `?rebuild=1` triggers a fresh `buildSpendRollup` (bounded; the cron is primary).

- [ ] **Step 1:** Add the OpenAPI route: read newest `spend_rollup` by `built_at desc limit 1`, `JSON.parse(payload)`, return. Empty payload `{ billed: [], projects: [], pools: [], totalActualUsd: 0, ... }` when the table is empty.
- [ ] **Step 2:** build.
- [ ] **Step 3:** Commit.

---

### Task 5: cron builds the rollup

**Files:** Modify `src/_worker.ts` (after the `snapshotResources` step).

- [ ] **Step 1:** Add a try/catch step calling `buildSpendRollup(env)` after snapshots + billable sync (so it reconciles the freshest data). Non-fatal.
- [ ] **Step 2:** build.
- [ ] **Step 3:** Commit.

---

### Task 6: SpendByProject reads the rollup

**Files:** Modify `SpendByProject.tsx`.

- [ ] **Step 1:** Switch the fetch from `/guardian/projects/usage` (live compute) to `/guardian/spend-rollup` (cached). Render `projects` (already reconciled, sums to bill), category bar from `billed` families, and show `pools` (unattributed/shared) honestly. Headline flips from "Projected · est." to **Billed** with Projected paired beside it.
- [ ] **Step 2:** build + the existing frontend build check.
- [ ] **Step 3:** Commit.

---

## PR + review + deploy

- [ ] Push `feat/spend-truth-b2`; PR titled `feat(guardian): B2 — spend rollup reconciliation` (base = feat/spend-truth-b1 while B1 is open, else main).
- [ ] AGY `adversarial_review` on the diff (focus: allocation correctness, sums-to-actual, rounding, empty-basis pooling, D1 read-path cost, payload size).
- [ ] Apply fixes; deploy; confirm the overview reads the cached rollup (no freeze) and Billed totals match the Cloudflare bill.

## Self-Review (done)

- Spec coverage: rollup table (T1), allocation (T2), reconciliation+lanes (T3), read endpoint (T4), cron (T5), frontend-reads-cache (T6). DO-attribution gap noted (pooled; a B2.1 enhancement — DO namespace→worker mapping).
- Placeholders: allocation + schema shown in full; T3's queries are described with exact tables/columns (reuse B1 shapes).
- Types: `allocateActual`, `RollupPayload`, `spendRollup` names consistent across tasks.
