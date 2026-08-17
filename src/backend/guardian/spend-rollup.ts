/**
 * @fileoverview buildSpendRollup — reconciles the Cloudflare billing ACTUAL to
 * per-project spend and caches it in `spend_rollup` for the frontend to read.
 *
 * Ground truth = `billable_usage` (the Billable Usage API), grouped by
 * `service_family`. That is the Billed lane — it matches the Cloudflare bill
 * 1:1. Cloudflare never bills per-resource/per-project, so per-project numbers
 * are the family ACTUAL *allocated* across projects by their estimated share:
 *   - ai   → share = per-project `ai_router_requests.cost_usd`
 *   - infra (d1/r2/vectorize/compute) → share = per-project estimated cost from
 *     `resource_usage_snapshots` joined through `resource_bindings`
 *   - do / other → no per-project basis → pooled `unattributed`
 * so every project's total sums back to the real bill. No AI, pure arithmetic.
 */

import { desc, eq, gte, lt, sql } from "drizzle-orm";

import { getDb } from "@/backend/db";
import {
  aiRouterRequests,
  billableUsage,
  cfResources,
  guardianProjects,
  resourceBindings,
  resourceUsageSnapshots,
  spendRollup,
} from "@/backend/db/schema";

export const UNATTRIBUTED = "__unattributed__";
export const SHARED = "__shared__";

/** service_family → our category (the allocation basis differs per category). */
const FAMILY_TO_CATEGORY: Record<string, string> = {
  "Workers AI": "ai",
  D1: "d1",
  R2: "r2",
  Vectorize: "vectorize",
  Workers: "compute",
  "Durable Objects": "do",
};
function categoryOf(family: string): string {
  return FAMILY_TO_CATEGORY[family] ?? "other";
}
/** Categories with a real per-project estimate basis (else the family is pooled). */
const ATTRIBUTABLE = new Set(["ai", "d1", "r2", "vectorize", "compute"]);
/** Infra categories attributed through the resource/binding graph (not ai/compute). */
const INFRA_PROBE_CATEGORY: Record<string, string> = { d1: "d1", r2: "r2", vectorize: "vectorize" };

export type RollupPayload = {
  window: { start: number; end: number; elapsedFraction: number };
  billed: { family: string; category: string; actualUsd: number; projectedUsd: number }[];
  totalActualUsd: number;
  totalProjectedUsd: number;
  projects: { name: string; kind: string; totalUsd: number; byCategory: Record<string, number> }[];
  pools: { name: string; totalUsd: number }[];
};

/**
 * PURE: distribute `actualUsd` across `shares` in proportion to weight; the
 * parts sum back to `actualUsd` (rounding drift folded into the first). No usable
 * weight → the whole amount pools to `__unattributed__`.
 */
export function allocateActual(
  actualUsd: number,
  shares: { key: string; weight: number }[],
): { key: string; usd: number }[] {
  const total = shares.reduce((s, x) => s + Math.max(0, x.weight), 0);
  if (!(total > 0) || !(actualUsd > 0)) return [{ key: UNATTRIBUTED, usd: actualUsd }];
  const out = shares
    .filter((s) => s.weight > 0)
    .map((s) => ({ key: s.key, usd: (s.weight / total) * actualUsd }));
  const drift = actualUsd - out.reduce((s, o) => s + o.usd, 0);
  if (out.length) out[0].usd += drift;
  return out;
}

/** UTC start-of-month (the billing cycle we reconcile). */
function cycleStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function cycleEndMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Build + persist the reconciled rollup for the current cycle. */
export async function buildSpendRollup(env: Env): Promise<RollupPayload> {
  const db = getDb(env);
  const now = Date.now();
  const start = cycleStartMs(now);
  const end = cycleEndMs(now);
  const elapsedFraction = Math.min(1, Math.max((now - start) / (end - start), 1e-6));

  // --- Billed lane: actual by family (ground truth, mirrors the CF bill) ------
  const familyRows = await db
    .select({
      family: billableUsage.serviceFamily,
      usd: sql<number>`sum(${billableUsage.contractedCost})`,
    })
    .from(billableUsage)
    .where(gte(billableUsage.dayStart, start))
    .groupBy(billableUsage.serviceFamily);

  const billed = familyRows
    .map((r) => {
      const actualUsd = Number(r.usd ?? 0);
      return {
        family: r.family || "Other",
        category: categoryOf(r.family || ""),
        actualUsd,
        projectedUsd: actualUsd / elapsedFraction,
      };
    })
    .sort((a, b) => b.actualUsd - a.actualUsd);

  // Actual $ per category (sum families that map to the same category).
  const actualByCategory = new Map<string, number>();
  for (const b of billed) actualByCategory.set(b.category, (actualByCategory.get(b.category) ?? 0) + b.actualUsd);

  // --- Estimate weights per project, per category -----------------------------
  const projectRows = await db
    .select({ name: guardianProjects.name, kind: guardianProjects.kind })
    .from(guardianProjects);
  const kindOf = new Map(projectRows.map((p) => [p.name, p.kind]));

  // ai: weight = per-project ai_router cost this cycle.
  const aiRows = await db
    .select({ project: aiRouterRequests.project, w: sql<number>`sum(${aiRouterRequests.costUsd})` })
    .from(aiRouterRequests)
    .where(gte(aiRouterRequests.at, start))
    .groupBy(aiRouterRequests.project);
  const weightsByCategory = new Map<string, { key: string; weight: number }[]>();
  weightsByCategory.set(
    "ai",
    aiRows.filter((r) => r.project).map((r) => ({ key: r.project as string, weight: Number(r.w ?? 0) })),
  );

  // infra (d1/r2/vectorize): weight = latest per-resource est cost → owning project.
  // Sole-owner binding → that project; multi-owner → SHARED; none → UNATTRIBUTED.
  const snaps = await db
    .select({
      resourceId: resourceUsageSnapshots.resourceId,
      product: cfResources.product,
      usd: resourceUsageSnapshots.estCostUsd,
      capturedAt: resourceUsageSnapshots.capturedAt,
    })
    .from(resourceUsageSnapshots)
    .innerJoin(cfResources, eq(resourceUsageSnapshots.resourceId, cfResources.id))
    .where(gte(resourceUsageSnapshots.capturedAt, now - 3 * 60 * 60 * 1000)); // last few hours = "current"
  const binds = await db.select().from(resourceBindings);
  const ownersOf = new Map<string, string[]>();
  for (const b of binds) {
    const arr = ownersOf.get(b.resourceId) ?? [];
    if (!arr.includes(b.worker)) arr.push(b.worker);
    ownersOf.set(b.resourceId, arr);
  }
  // Keep only the newest snapshot per (resource) as the current estimate weight.
  const latestByResource = new Map<string, { product: string; usd: number; at: number }>();
  for (const s of snaps) {
    const prev = latestByResource.get(s.resourceId);
    if (!prev || s.capturedAt > prev.at)
      latestByResource.set(s.resourceId, { product: s.product, usd: Number(s.usd ?? 0), at: s.capturedAt });
  }
  for (const cat of Object.keys(INFRA_PROBE_CATEGORY)) {
    const w: { key: string; weight: number }[] = [];
    for (const [resourceId, v] of latestByResource) {
      if (v.product !== cat || !(v.usd > 0)) continue;
      const owners = ownersOf.get(resourceId) ?? [];
      const key = owners.length === 1 ? owners[0] : owners.length > 1 ? SHARED : UNATTRIBUTED;
      w.push({ key, weight: v.usd });
    }
    weightsByCategory.set(cat, w);
  }

  // compute: weight = per-worker snapshot est cost isn't captured (workers probe
  // isn't a resource); attribute compute wholly unattributed for now.
  weightsByCategory.set("compute", []);

  // --- Allocate each category's actual across its weights ----------------------
  const projectAcc = new Map<string, { kind: string; total: number; byCategory: Record<string, number> }>();
  const poolAcc = new Map<string, number>();
  const bump = (key: string, cat: string, usd: number) => {
    if (key === UNATTRIBUTED || key === SHARED) {
      poolAcc.set(key, (poolAcc.get(key) ?? 0) + usd);
      return;
    }
    let p = projectAcc.get(key);
    if (!p) {
      p = { kind: kindOf.get(key) ?? "worker", total: 0, byCategory: {} };
      projectAcc.set(key, p);
    }
    p.byCategory[cat] = (p.byCategory[cat] ?? 0) + usd;
    p.total += usd;
  };

  for (const [cat, actual] of actualByCategory) {
    if (!(actual > 0)) continue;
    if (!ATTRIBUTABLE.has(cat)) {
      poolAcc.set(UNATTRIBUTED, (poolAcc.get(UNATTRIBUTED) ?? 0) + actual); // do / other
      continue;
    }
    const allocated = allocateActual(actual, weightsByCategory.get(cat) ?? []);
    for (const a of allocated) bump(a.key, cat, a.usd);
  }

  const projects = [...projectAcc.entries()]
    .map(([name, v]) => ({ name, kind: v.kind, totalUsd: v.total, byCategory: v.byCategory }))
    .sort((a, b) => b.totalUsd - a.totalUsd);
  const pools = [...poolAcc.entries()]
    .filter(([, usd]) => usd > 0)
    .map(([name, usd]) => ({ name: name === SHARED ? "shared" : "unattributed", totalUsd: usd }));

  const totalActualUsd = billed.reduce((s, b) => s + b.actualUsd, 0);
  const totalProjectedUsd = billed.reduce((s, b) => s + b.projectedUsd, 0);

  // Reconciliation invariant: every billed dollar lands in exactly one project or
  // pool. If this ever drifts > 1¢, the allocation dropped or double-counted —
  // surface it loudly rather than ship a ledger that doesn't tie to the bill.
  const allocatedUsd =
    projects.reduce((s, p) => s + p.totalUsd, 0) + pools.reduce((s, p) => s + p.totalUsd, 0);
  if (Math.abs(allocatedUsd - totalActualUsd) > 0.01) {
    console.warn(
      JSON.stringify({
        level: "WARN",
        source: "guardian.spendRollup.reconcile",
        msg: "allocated total does not tie to billed actual",
        allocatedUsd,
        totalActualUsd,
      }),
    );
  }

  const payload: RollupPayload = {
    window: { start, end, elapsedFraction },
    billed,
    totalActualUsd,
    totalProjectedUsd,
    projects,
    pools,
  };

  // Persist; keep only the newest handful of rebuilds.
  await db.insert(spendRollup).values({
    id: crypto.randomUUID(),
    builtAt: now,
    windowStart: start,
    windowEnd: end,
    totalActualUsd,
    payload: JSON.stringify(payload),
  });
  const keep = await db
    .select({ builtAt: spendRollup.builtAt })
    .from(spendRollup)
    .orderBy(desc(spendRollup.builtAt))
    .limit(50);
  if (keep.length === 50) {
    await db.delete(spendRollup).where(lt(spendRollup.builtAt, keep[keep.length - 1].builtAt));
  }

  return payload;
}

/** Read the latest cached rollup, or null when none built yet. */
export async function latestSpendRollup(env: Env): Promise<RollupPayload | null> {
  const [row] = await getDb(env)
    .select({ payload: spendRollup.payload })
    .from(spendRollup)
    .orderBy(desc(spendRollup.builtAt))
    .limit(1);
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as RollupPayload;
  } catch {
    return null;
  }
}
