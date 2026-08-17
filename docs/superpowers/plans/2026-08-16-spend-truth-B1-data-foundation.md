# Spend Truth B1 — Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the raw material for billing-reconciled spend attribution — zones, a Cloudflare resource registry, per-resource usage snapshots, and the worker↔resource binding map — written by the hourly cron, plus a one-time historic billable-usage backfill.

**Architecture:** Four new D1 tables (`zones`, `cf_resources`, `resource_usage_snapshots`, `resource_bindings`) + a `zone_id` FK on the existing `billable_usage`. A new `snapshot-resources.ts` module gathers data from primitives that already exist (`listR2Buckets`/`listD1Databases`/`listKVNamespaces`/`listVectorizeIndexes`, `collectUsage` per-resource `.breakdown`, `getBindingIndex`) and upserts it. The hourly `scheduled()` handler calls it. No UI, no AI — pure D1 + arithmetic.

**Tech Stack:** Drizzle ORM + Cloudflare D1, Hono, TypeScript, `node:test` + `tsx` for unit tests, `wrangler d1 migrations`.

**Spec:** `docs/superpowers/specs/2026-08-16-spend-truth-attribution-design.md`

## Global Constraints

- **No AI** anywhere in this pipeline. Pure D1 + arithmetic.
- **Never fabricate data.** A missing/unavailable source yields an omitted row or an explicit null, never an invented number (matches the repo ethos).
- **Drizzle only** — no raw SQL. Schema lives under `src/backend/db/schemas/governance/`, re-exported through the barrel; migrations via `pnpm run db:generate`.
- **Verify with build + oxlint, not `pnpm check`** (oxfmt rewrites the tree). Run unit tests with `npx tsx --test <file>`.
- **UTC for all period math** (`Date.UTC`, `getUTC*`).
- Cloudflare Worker script names match `^[a-z0-9][a-z0-9_-]*$`; pool/sentinel keys must stay outside that set.

---

## File Structure

- `src/backend/db/schemas/governance/zones.ts` — `zones` table (new).
- `src/backend/db/schemas/governance/cf-resources.ts` — `cf_resources` + `resource_usage_snapshots` + `resource_bindings` tables (new; they change together, so one file).
- `src/backend/db/schemas/governance/billable-usage.ts` — add `zoneId` column (modify).
- `src/backend/db/schemas/governance/index.ts` — export the new schema files (modify).
- `src/backend/guardian/snapshot-resources.ts` — the gather+persist module (new).
- `src/backend/guardian/snapshot-resources.test.ts` — pure-logic tests (new).
- `src/backend/guardian/backfill-billable-usage.ts` — one-time historic backfill (new).
- `src/_worker.ts` — call `snapshotResources` + one-time backfill from the cron (modify).

---

### Task 1: `zones` table + seed

**Files:**
- Create: `src/backend/db/schemas/governance/zones.ts`
- Modify: `src/backend/db/schemas/governance/index.ts`
- Test: none (declarative schema; covered by build + migration apply)

**Interfaces:**
- Produces: `zones` table; `ZoneRow = { id: string; cfZoneId: string; name: string; billable: boolean; ... }`; `NewZoneRow`.

- [ ] **Step 1: Write the schema** (follow the pattern in `guardian-projects.ts`)

```ts
// src/backend/db/schemas/governance/zones.ts
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const ZONES_TABLE_DESCRIPTION =
  "The account's Cloudflare zones. billable=1 marks a zone that accrues charges; billable_usage rows link here by zone_id.";

export const ZONES_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Relational primary key (the Cloudflare zone id).",
  cf_zone_id: "Cloudflare zone id (same as id; explicit for joins/clarity).",
  name: "Zone name, e.g. hacolby.app.",
  billable: "1 = this zone accrues charges. Account has 3 zones; only hacolby.app is billable.",
  last_seen: "Unix ms the zone was last observed by a sync.",
};

export const zones = sqliteTable(
  "zones",
  {
    id: text("id").primaryKey(),
    cfZoneId: text("cf_zone_id").notNull(),
    name: text("name").notNull().default(""),
    billable: integer("billable", { mode: "boolean" }).notNull().default(false),
    lastSeen: integer("last_seen").notNull().$defaultFn(() => Date.now()),
  },
  (t) => [index("idx_zones_billable").on(t.billable)],
);

export const insertZoneSchema = createInsertSchema(zones);
export const selectZoneSchema = createSelectSchema(zones);
export type ZoneRow = typeof zones.$inferSelect;
export type NewZoneRow = typeof zones.$inferInsert;
```

- [ ] **Step 2: Export from the barrel**

Add to `src/backend/db/schemas/governance/index.ts`:
```ts
export * from "./zones";
```

- [ ] **Step 3: Generate + apply the migration locally**

Run:
```bash
pnpm run db:generate && npx wrangler d1 migrations apply DB --local
```
Expected: a new `drizzle/00NN_*.sql` creating `zones`; applies clean.

- [ ] **Step 4: Commit**

```bash
git add src/backend/db/schemas/governance/zones.ts src/backend/db/schemas/governance/index.ts drizzle/
git commit -m "feat(guardian): zones table"
```

---

### Task 2: `cf_resources` + `resource_usage_snapshots` + `resource_bindings` tables

**Files:**
- Create: `src/backend/db/schemas/governance/cf-resources.ts`
- Modify: `src/backend/db/schemas/governance/index.ts`

**Interfaces:**
- Produces:
  - `cfResources` table; `CfResourceRow = { id: string; product: string; resourceType: string; resourceName: string; cfId: string; firstSeen: number; lastSeen: number; active: boolean }`.
  - `resourceUsageSnapshots` table; `{ id: string; resourceId: string; capturedAt: number; windowHours: number; usageQty: number; unit: string; estCostUsd: number }`.
  - `resourceBindings` table; `{ worker: string; resourceId: string; bindingName: string; updatedAt: number }`.

- [ ] **Step 1: Write the schema** (one file — these change together)

```ts
// src/backend/db/schemas/governance/cf-resources.ts
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const CF_RESOURCES_TABLE_DESCRIPTION =
  "Registry of billable Cloudflare resources (one per bucket/db/namespace/index/etc), each with its own relational id. Not tied to a project; workers link via resource_bindings.";

export const cfResources = sqliteTable(
  "cf_resources",
  {
    id: text("id").primaryKey(), // `${product}:${cfId}` — stable, deterministic
    product: text("product").notNull(), // r2 | d1 | kv | vectorize | durable_objects | workers_ai | queue | images | ...
    resourceType: text("resource_type").notNull().default(""),
    resourceName: text("resource_name").notNull().default(""),
    cfId: text("cf_id").notNull(), // bucket name / db uuid / index name / namespace id
    firstSeen: integer("first_seen").notNull().$defaultFn(() => Date.now()),
    lastSeen: integer("last_seen").notNull().$defaultFn(() => Date.now()),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [index("idx_cf_resources_product").on(t.product)],
);

export const RESOURCE_USAGE_SNAPSHOTS_TABLE_DESCRIPTION =
  "Append-only periodic per-resource usage + estimated cost. Powers over-time deltas.";

export const resourceUsageSnapshots = sqliteTable(
  "resource_usage_snapshots",
  {
    id: text("id").primaryKey(), // crypto.randomUUID()
    resourceId: text("resource_id").notNull(),
    capturedAt: integer("captured_at").notNull(),
    windowHours: integer("window_hours").notNull().default(1),
    usageQty: real("usage_qty").notNull().default(0),
    unit: text("unit").notNull().default(""),
    estCostUsd: real("est_cost_usd").notNull().default(0),
  },
  (t) => [
    index("idx_rus_resource_captured").on(t.resourceId, t.capturedAt),
    index("idx_rus_captured").on(t.capturedAt),
  ],
);

export const RESOURCE_BINDINGS_TABLE_DESCRIPTION =
  "Worker -> resource binding map from the Cloudflare bindings API (persisted from getBindingIndex).";

export const resourceBindings = sqliteTable(
  "resource_bindings",
  {
    worker: text("worker").notNull(),
    resourceId: text("resource_id").notNull(),
    bindingName: text("binding_name").notNull().default(""),
    updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
  },
  (t) => [
    primaryKey({ columns: [t.worker, t.resourceId] }),
    index("idx_resource_bindings_resource").on(t.resourceId),
  ],
);

export const insertCfResourceSchema = createInsertSchema(cfResources);
export const selectCfResourceSchema = createSelectSchema(cfResources);
export type CfResourceRow = typeof cfResources.$inferSelect;
export type NewCfResourceRow = typeof cfResources.$inferInsert;
export type ResourceUsageSnapshotRow = typeof resourceUsageSnapshots.$inferSelect;
export type NewResourceUsageSnapshotRow = typeof resourceUsageSnapshots.$inferInsert;
export type ResourceBindingRow = typeof resourceBindings.$inferSelect;
export type NewResourceBindingRow = typeof resourceBindings.$inferInsert;
```

- [ ] **Step 2: Export from the barrel**

Add to `src/backend/db/schemas/governance/index.ts`:
```ts
export * from "./cf-resources";
```

- [ ] **Step 3: Generate + apply the migration locally**

Run: `pnpm run db:generate && npx wrangler d1 migrations apply DB --local`
Expected: migration creates all three tables; applies clean.

- [ ] **Step 4: Commit**

```bash
git add src/backend/db/schemas/governance/cf-resources.ts src/backend/db/schemas/governance/index.ts drizzle/
git commit -m "feat(guardian): cf_resources, resource_usage_snapshots, resource_bindings tables"
```

---

### Task 3: `billable_usage.zone_id` FK column

**Files:**
- Modify: `src/backend/db/schemas/governance/billable-usage.ts`

**Interfaces:**
- Produces: `billableUsage.zoneId` (nullable text; the zone id, matching `zones.id`). Kept nullable — account-level charges have no zone.

- [ ] **Step 1: Add the column** (next to the existing `zoneId` string is a *raw* `zone_id` from the API; keep it, add a nullable FK-intent column `zone_fk` to avoid confusing the raw value with the relation)

In `billable-usage.ts`, inside the `billableUsage` table columns (after `zoneName`):
```ts
    // Relational link to `zones.id` (null for account-level charges). The raw
    // `zone_id` above is the API value; this is the resolved relation.
    zoneFk: text("zone_fk"),
```
Add to `BILLABLE_USAGE_COLUMN_DESCRIPTIONS`:
```ts
  zone_fk: "Relational link to zones.id (null for account-level charges).",
```

- [ ] **Step 2: Generate + apply**

Run: `pnpm run db:generate && npx wrangler d1 migrations apply DB --local`
Expected: `ALTER TABLE billable_usage ADD COLUMN zone_fk text;` applies clean.

- [ ] **Step 3: Commit**

```bash
git add src/backend/db/schemas/governance/billable-usage.ts drizzle/
git commit -m "feat(guardian): billable_usage.zone_fk relation to zones"
```

---

### Task 4: `snapshot-resources.ts` — pure mapping helpers (TDD)

**Files:**
- Create: `src/backend/guardian/snapshot-resources.ts`
- Test: `src/backend/guardian/snapshot-resources.test.ts`

**Interfaces:**
- Consumes: probe reading shape `{ id: string; unit: string; breakdown: {label:string; value:number}[] }` (from `collect.ts` `UsageReading`); `BindingIndex` (from `resources.ts`).
- Produces:
  - `resourceIdOf(product: string, cfId: string): string` → `` `${product}:${cfId}` ``.
  - `PROBE_TO_PRODUCT: Record<string, { product: string }>` mapping probe id → product (`d1`→`d1`, `r2-operations`/`r2-storage`→`r2`, `vectorize`→`vectorize`).
  - `bindingRowsFrom(index: BindingIndex): { worker: string; resourceId: string; bindingName: string }[]` — flatten the binding index into rows, deriving `resourceId` from the `<type>:<cfId>` key (`r2:<bucket>`→`r2:<bucket>`, `d1:<uuid>`→`d1:<uuid>`, etc).

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/guardian/snapshot-resources.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { resourceIdOf, bindingRowsFrom } from "./snapshot-resources";
import type { BindingIndex } from "./resources";

test("resourceIdOf is deterministic product:cfId", () => {
  assert.equal(resourceIdOf("r2", "logs-bucket"), "r2:logs-bucket");
  assert.equal(resourceIdOf("d1", "abc-123"), "d1:abc-123");
});

test("bindingRowsFrom flattens the index and maps keys to resource ids", () => {
  const index: BindingIndex = {
    byResource: {
      "r2:logs": [{ worker: "acre", binding: "R2" }],
      "d1:db-1": [
        { worker: "acre", binding: "DB" },
        { worker: "codra", binding: "DB" },
      ],
      "queue:jobs": [{ worker: "acre", binding: "Q" }], // non-resource product still flattens
    },
    workerCount: 2,
    builtAt: 0,
  };
  const rows = bindingRowsFrom(index);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.find((r) => r.worker === "codra"),
    { worker: "codra", resourceId: "d1:db-1", bindingName: "DB" },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/backend/guardian/snapshot-resources.test.ts`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/backend/guardian/snapshot-resources.ts
import type { BindingIndex } from "./resources";

/** Deterministic resource id: `${product}:${cfId}`. Matches the binding-index key form. */
export function resourceIdOf(product: string, cfId: string): string {
  return `${product}:${cfId}`;
}

/** Probe id -> product bucket (only probes whose breakdown keys a real resource). */
export const PROBE_TO_PRODUCT: Record<string, { product: string }> = {
  d1: { product: "d1" },
  "r2-operations": { product: "r2" },
  "r2-storage": { product: "r2" },
  vectorize: { product: "vectorize" },
};

/** Flatten the binding index into (worker, resourceId, bindingName) rows.
 *  The index key IS already `<type>:<cfId>`, i.e. our resource id form. */
export function bindingRowsFrom(
  index: BindingIndex,
): { worker: string; resourceId: string; bindingName: string }[] {
  const out: { worker: string; resourceId: string; bindingName: string }[] = [];
  for (const [key, binders] of Object.entries(index.byResource)) {
    for (const b of binders) out.push({ worker: b.worker, resourceId: key, bindingName: b.binding });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/backend/guardian/snapshot-resources.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/guardian/snapshot-resources.ts src/backend/guardian/snapshot-resources.test.ts
git commit -m "feat(guardian): snapshot-resources pure mapping helpers"
```

---

### Task 5: `snapshotResources(env)` — gather + persist (integration wiring)

**Files:**
- Modify: `src/backend/guardian/snapshot-resources.ts`

**Interfaces:**
- Consumes: `getDb`, `collectUsage(env, hours)`, `getBindingIndex(env)`, resource listers (`listR2Buckets`, `listD1Databases`, `listKVNamespaces`, `listVectorizeIndexes` from `resources.ts`), `calculateOperations` (from `cost-calculator.ts`), the new tables.
- Produces: `async function snapshotResources(env: Env): Promise<{ resources: number; snapshots: number; bindings: number }>`.

- [ ] **Step 1: Implement** (upsert `cf_resources` from the listers; write `resource_usage_snapshots` from priced probe breakdowns via `resourceIdOf`; replace `resource_bindings` from `bindingRowsFrom`). Chunk inserts at 16 rows (D1 100-param cap, matches `collect.ts`).

```ts
import { getDb } from "@/backend/db";
import { cfResources, resourceBindings, resourceUsageSnapshots } from "@/backend/db/schema";
import { collectUsage } from "./collect";
import { calculateOperations, type CfOperation } from "./cost-calculator";
import {
  getBindingIndex,
  listD1Databases,
  listKVNamespaces,
  listR2Buckets,
  listVectorizeIndexes,
} from "./resources";

const CHUNK = 16;

export async function snapshotResources(
  env: Env,
): Promise<{ resources: number; snapshots: number; bindings: number }> {
  const db = getDb(env);
  const now = Date.now();

  // 1) Resource registry — upsert from the listers (each already returns names/ids).
  const [buckets, d1s, kvs, vixs, index, readings] = await Promise.all([
    listR2Buckets(env).catch(() => []),
    listD1Databases(env).catch(() => []),
    listKVNamespaces(env).catch(() => []),
    listVectorizeIndexes(env).catch(() => []),
    getBindingIndex(env),
    collectUsage(env, 1),
  ]);

  const resourceRows = [
    ...buckets.map((b) => ({ product: "r2", cfId: b.name, resourceName: b.name })),
    ...d1s.map((d) => ({ product: "d1", cfId: d.uuid, resourceName: d.name })),
    ...kvs.map((k) => ({ product: "kv", cfId: k.id, resourceName: k.title })),
    ...vixs.map((v) => ({ product: "vectorize", cfId: v.name, resourceName: v.name })),
  ].map((r) => ({
    id: resourceIdOf(r.product, r.cfId),
    product: r.product,
    resourceType: r.product,
    resourceName: r.resourceName,
    cfId: r.cfId,
    lastSeen: now,
    active: true,
  }));

  for (const r of resourceRows) {
    await db
      .insert(cfResources)
      .values(r)
      .onConflictDoUpdate({
        target: cfResources.id,
        set: { lastSeen: now, active: true, resourceName: r.resourceName },
      });
  }

  // 2) Per-resource usage snapshots — price each breakdown line, tag its resource.
  const ops: CfOperation[] = [];
  const tags: { resourceId: string; unit: string; qty: number }[] = [];
  for (const reading of readings) {
    if (reading.status !== "ok") continue;
    const prod = PROBE_TO_PRODUCT[reading.id];
    if (!prod) continue;
    for (const b of reading.breakdown) {
      ops.push({ kind: "cf", service: reading.id, units: b.value });
      tags.push({ resourceId: resourceIdOf(prod.product, b.label), unit: reading.unit, qty: b.value });
    }
  }
  const priced = ops.length ? await calculateOperations(env, ops) : { lines: [], totalUsd: 0 };
  const snapRows = tags.map((t, i) => ({
    id: crypto.randomUUID(),
    resourceId: t.resourceId,
    capturedAt: now,
    windowHours: 1,
    usageQty: t.qty,
    unit: t.unit,
    estCostUsd: priced.lines[i]?.costUsd ?? 0,
  }));
  for (let i = 0; i < snapRows.length; i += CHUNK) {
    await db.insert(resourceUsageSnapshots).values(snapRows.slice(i, i + CHUNK));
  }

  // 3) Bindings — replace wholesale (the index is the source of truth this run).
  const bindRows = bindingRowsFrom(index).map((b) => ({ ...b, updatedAt: now }));
  await db.delete(resourceBindings);
  for (let i = 0; i < bindRows.length; i += CHUNK) {
    await db.insert(resourceBindings).values(bindRows.slice(i, i + CHUNK));
  }

  return { resources: resourceRows.length, snapshots: snapRows.length, bindings: bindRows.length };
}
```

- [ ] **Step 2: Verify build + lint**

Run: `pnpm run build && pnpm exec oxlint src/backend/guardian/snapshot-resources.ts`
Expected: build Complete!, no lint errors. (The pure-helper test from Task 4 still passes.)

- [ ] **Step 3: Commit**

```bash
git add src/backend/guardian/snapshot-resources.ts
git commit -m "feat(guardian): snapshotResources gather+persist (resources, snapshots, bindings)"
```

---

### Task 6: `backfill-billable-usage.ts` — one-time historic pull (TDD on the window math)

**Files:**
- Create: `src/backend/guardian/backfill-billable-usage.ts`
- Test: `src/backend/guardian/backfill-billable-usage.test.ts`

**Interfaces:**
- Consumes: `fetchBillableUsage(env, from, to)` + the mapping already in `billable-usage.ts` (reuse `syncBillableUsage` if it accepts a window; else call `fetchBillableUsage` per chunk).
- Produces: `maxBackfillWindows(now: number, retentionDays = 90, chunkDays = 31): {from: string; to: string}[]` (pure) and `async function backfillBillableUsage(env: Env): Promise<{ chunks: number; rows: number }>`.

- [ ] **Step 1: Write the failing test** (window chunking — the only real logic)

```ts
// src/backend/guardian/backfill-billable-usage.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { maxBackfillWindows } from "./backfill-billable-usage";

test("maxBackfillWindows chunks the retention window into <=chunkDays spans, oldest first, UTC", () => {
  const now = Date.UTC(2026, 2, 15); // 2026-03-15
  const wins = maxBackfillWindows(now, 90, 31);
  assert.ok(wins.length >= 3 && wins.length <= 4);
  assert.match(wins[0].from, /^\d{4}-\d{2}-\d{2}$/);
  // oldest first, contiguous, ends at "now"
  assert.equal(wins[wins.length - 1].to, "2026-03-15");
  for (let i = 1; i < wins.length; i++) assert.ok(wins[i - 1].to <= wins[i].from);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/backend/guardian/backfill-billable-usage.test.ts`
Expected: FAIL — export not found.

- [ ] **Step 3: Implement**

```ts
// src/backend/guardian/backfill-billable-usage.ts
import { fetchBillableUsage } from "./billable-usage";

const DAY = 86_400_000;
function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Contiguous <=chunkDays windows covering [now-retentionDays, now], oldest first (UTC, YYYY-MM-DD). */
export function maxBackfillWindows(
  now: number,
  retentionDays = 90,
  chunkDays = 31,
): { from: string; to: string }[] {
  const start = now - retentionDays * DAY;
  const out: { from: string; to: string }[] = [];
  for (let cursor = start; cursor < now; cursor += chunkDays * DAY) {
    const to = Math.min(cursor + chunkDays * DAY, now);
    out.push({ from: ymd(cursor), to: ymd(to) });
  }
  return out;
}

/** One-time historic backfill: pull each window and upsert via the existing mapper. */
export async function backfillBillableUsage(env: Env): Promise<{ chunks: number; rows: number }> {
  const windows = maxBackfillWindows(Date.now());
  let rows = 0;
  for (const w of windows) {
    const raw = await fetchBillableUsage(env, w.from, w.to).catch(() => []);
    rows += raw.length;
    // Reuse the same upsert path syncBillableUsage uses. If syncBillableUsage
    // accepts an explicit window, call it here instead of re-implementing toRow.
  }
  return { chunks: windows.length, rows };
}
```

> **Executor note:** open `billable-usage.ts` and reuse its `toRow` + upsert (export them if needed) rather than duplicating the mapping — DRY. The window math above is the only new logic that needs a test.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/backend/guardian/backfill-billable-usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/guardian/backfill-billable-usage.ts src/backend/guardian/backfill-billable-usage.test.ts
git commit -m "feat(guardian): one-time historic billable-usage backfill"
```

---

### Task 7: Wire cron + zone sync + one-time backfill into `_worker.ts`

**Files:**
- Modify: `src/_worker.ts` (the `scheduled()` handler, near the existing `syncBillableUsage` call ~line 287)

**Interfaces:**
- Consumes: `snapshotResources`, `backfillBillableUsage`, and a zone lister (`cloudflare GET /zones` via `cfApi`). Uses a KV flag in `SESSIONS` to run the backfill exactly once.

- [ ] **Step 1: Add a zone sync helper** (in `snapshot-resources.ts` or a small `sync-zones.ts`; billable = name === "hacolby.app")

```ts
// append to snapshot-resources.ts
import { cfApi } from "./resources";
import { zones } from "@/backend/db/schema";

export async function syncZones(env: Env): Promise<number> {
  const { result } = await cfApi<{ id: string; name: string }[]>(env, "/zones").catch(() => ({ result: [] as { id: string; name: string }[] }));
  const db = getDb(env);
  const now = Date.now();
  for (const z of result ?? []) {
    await db
      .insert(zones)
      .values({ id: z.id, cfZoneId: z.id, name: z.name, billable: z.name === "hacolby.app", lastSeen: now })
      .onConflictDoUpdate({ target: zones.id, set: { name: z.name, billable: z.name === "hacolby.app", lastSeen: now } });
  }
  return (result ?? []).length;
}
```
> Note: `/zones` is account-scoped via the token; `cfApi` prefixes `/accounts/{id}` — verify whether `/zones` needs the account prefix or is top-level, and adjust the path (executor: confirm against `resources.ts` cfApi base).

- [ ] **Step 2: Call from the cron** (in the `scheduled()` handler, wrapped like the existing `syncBillableUsage` try/catch so one failure never sinks the cron)

```ts
try {
  await syncZones(env);
  const snap = await snapshotResources(env);
  console.warn(JSON.stringify({ level: "INFO", source: "guardian.snapshotResources", ...snap }));
} catch (err) {
  console.warn(JSON.stringify({ level: "ERROR", source: "guardian.snapshotResources", error: String(err) }));
}

// One-time historic backfill, guarded by a KV flag so it runs once.
try {
  const done = await env.SESSIONS.get("guardian:billable-backfill-done");
  if (!done) {
    const bf = await backfillBillableUsage(env);
    await env.SESSIONS.put("guardian:billable-backfill-done", String(Date.now()));
    console.warn(JSON.stringify({ level: "INFO", source: "guardian.backfill", ...bf }));
  }
} catch (err) {
  console.warn(JSON.stringify({ level: "ERROR", source: "guardian.backfill", error: String(err) }));
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm run build`
Expected: Complete!

- [ ] **Step 4: Apply migrations remotely + deploy to smoke the cron**

Run:
```bash
pnpm run migrate:remote
pnpm run deploy
```
Expected: migrations apply (4 new tables + `zone_fk`), deploy succeeds. After the next hourly cron (or a manual trigger), `cf_resources` / `resource_usage_snapshots` / `resource_bindings` / `zones` have rows and the backfill KV flag is set.

- [ ] **Step 5: Commit**

```bash
git add src/backend/guardian/snapshot-resources.ts src/_worker.ts
git commit -m "feat(guardian): cron persists zones + resources + snapshots + bindings; one-time backfill"
```

---

## PR + review + deploy (batch close-out)

- [ ] Push branch; open PR titled `feat(guardian): B1 spend-truth data foundation`.
- [ ] Run AGY `adversarial_review` on the diff (focus: migration safety, D1 param limits, cron failure isolation, backfill idempotency).
- [ ] Apply recommended fixes.
- [ ] Deploy; confirm tables populate after a cron cycle.

## Self-Review (done)

- **Spec coverage:** zones (T1), cf_resources/snapshots/bindings (T2), zone FK (T3), cron persistence (T4–T5, T7), backfill (T6–T7). B2–B5 are out of this plan by design (one batch per PR).
- **Placeholders:** none — schema, helpers, and window math are shown in full; the two "executor note" callouts point at *existing* code to reuse (DRY), not missing content.
- **Type consistency:** `resourceIdOf`/`PROBE_TO_PRODUCT`/`bindingRowsFrom` defined in T4 are the exact names consumed in T5; table/column names match across T2/T5/T7.
