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

import { and, desc, eq, gte, lt, sql } from "drizzle-orm";

import { getDb } from "@/backend/db";
import {
  aiRouterRequests,
  billableUsage,
  cfResources,
  dailyCost,
  guardianProjects,
  resourceBindings,
  resourceUsageSnapshots,
  spendRollup,
} from "@/backend/db/schema";

import { getDoComputeDrivers } from "./resource-attribution";

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
/** daily_cost.service (a probe id) → category, for the like-for-like dispute. */
const SERVICE_TO_CATEGORY: Record<string, string> = {
  "workers-ai": "ai",
  "ai-gateway": "ai",
  d1: "d1",
  "r2-operations": "r2",
  "r2-storage": "r2",
  vectorize: "vectorize",
  kv: "kv",
  "durable-objects-requests": "do",
  "durable-objects-cpu": "do",
  workers: "compute",
};

/** Categories with a real per-project estimate basis (else the family is pooled).
 *  `do` attributes via #50's per-script DO wall-time drivers; `compute`/`other`
 *  have no per-project basis yet → pooled unattributed. */
const ATTRIBUTABLE = new Set(["ai", "d1", "r2", "vectorize", "do"]);
/** Infra categories attributed through the resource/binding graph (not ai). */
const INFRA_CATEGORIES = ["d1", "r2", "vectorize"];

export type RollupPayload = {
  window: { start: number; end: number; elapsedFraction: number };
  billed: { family: string; category: string; actualUsd: number; projectedUsd: number }[];
  totalActualUsd: number;
  totalProjectedUsd: number;
  /** Reconstructed marginal-rate estimate over the cycle (daily_cost). */
  estimateUsd: number;
  /** Billed − estimate (signed). >0 = billed above our reconstruction → worth a look. */
  disputeUsd: number;
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

/**
 * PURE: like-for-like dispute. Compares billed actual to reconstructed estimate
 * PER CATEGORY, and only where an estimate exists (est > 0) — so a category that
 * is billed but unpriceable (DO has no overage rate) never counts as a dispute.
 *
 * @returns `estimateUsd` (priceable estimate total) and `disputeUsd`
 *   (Σ actual − estimate over priceable categories; >0 = billed above estimate).
 */
export function likeForLikeDispute(
  actualByCategory: Map<string, number>,
  estimateByCategory: Map<string, number>,
): { estimateUsd: number; disputeUsd: number } {
  let estimateUsd = 0;
  let disputeUsd = 0;
  for (const [cat, est] of estimateByCategory) {
    if (!(est > 0)) continue;
    estimateUsd += est;
    disputeUsd += (actualByCategory.get(cat) ?? 0) - est;
  }
  return { estimateUsd, disputeUsd };
}

/** UTC start-of-month fallback when no billing period is recorded yet. */
function cycleStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Build + persist the reconciled rollup for the current billing cycle. */
export async function buildSpendRollup(env: Env): Promise<RollupPayload> {
  const db = getDb(env);
  const now = Date.now();

  // The billing cycle is CF's actual period (offset from the calendar month —
  // e.g. Jul 19–Aug 18), keyed off billable_usage.billing_period_start so the
  // Billed total ties to the bill exactly. Fall back to the calendar month when
  // no period is recorded yet.
  const [{ period } = { period: null }] = await db
    .select({ period: sql<string | null>`max(${billableUsage.billingPeriodStart})` })
    .from(billableUsage);
  const start = period ? Date.parse(period) : cycleStartMs(now);
  const startD = new Date(start);
  const end = Date.UTC(startD.getUTCFullYear(), startD.getUTCMonth() + 1, startD.getUTCDate());
  const dayFrac = 86_400_000 / (end - start);
  const elapsedFraction = Math.min(1, Math.max((now - start) / (end - start), dayFrac));

  // --- Billed lane: actual by family for THIS billing period (ground truth) ---
  const familyRows = await db
    .select({
      family: billableUsage.serviceFamily,
      usd: sql<number>`sum(${billableUsage.contractedCost})`,
    })
    .from(billableUsage)
    .where(period ? eq(billableUsage.billingPeriodStart, period) : gte(billableUsage.dayStart, start))
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

  // ai: weight = per-project ai_router cost over THIS billing period.
  const aiRows = await db
    .select({ project: aiRouterRequests.project, w: sql<number>`sum(${aiRouterRequests.costUsd})` })
    .from(aiRouterRequests)
    .where(and(gte(aiRouterRequests.at, start), lt(aiRouterRequests.at, end)))
    .groupBy(aiRouterRequests.project);
  const weightsByCategory = new Map<string, { key: string; weight: number }[]>();
  weightsByCategory.set(
    "ai",
    aiRows.filter((r) => r.project).map((r) => ({ key: r.project as string, weight: Number(r.w ?? 0) })),
  );

  // infra (d1/r2/vectorize): weight = CUMULATIVE est cost over the whole cycle
  // per resource (not a single instant — a resource that spiked mid-cycle then
  // went idle must still carry its share), routed to the owning project via
  // bindings. Sole-owner → that project; multi-owner → SHARED; none → UNATTRIBUTED.
  const snaps = await db
    .select({
      resourceId: resourceUsageSnapshots.resourceId,
      product: cfResources.product,
      usd: sql<number>`sum(${resourceUsageSnapshots.estCostUsd})`,
    })
    .from(resourceUsageSnapshots)
    .innerJoin(cfResources, eq(resourceUsageSnapshots.resourceId, cfResources.id))
    .where(and(gte(resourceUsageSnapshots.capturedAt, start), lt(resourceUsageSnapshots.capturedAt, end)))
    .groupBy(resourceUsageSnapshots.resourceId, cfResources.product);
  const binds = await db.select().from(resourceBindings);
  const ownersOf = new Map<string, string[]>();
  for (const b of binds) {
    const arr = ownersOf.get(b.resourceId) ?? [];
    if (!arr.includes(b.worker)) arr.push(b.worker);
    ownersOf.set(b.resourceId, arr);
  }
  for (const cat of INFRA_CATEGORIES) {
    const w: { key: string; weight: number }[] = [];
    for (const s of snaps) {
      const usdv = Number(s.usd ?? 0);
      if (s.product !== cat || !(usdv > 0)) continue;
      const owners = ownersOf.get(s.resourceId) ?? [];
      const key = owners.length === 1 ? owners[0] : owners.length > 1 ? SHARED : UNATTRIBUTED;
      w.push({ key, weight: usdv });
    }
    weightsByCategory.set(cat, w);
  }

  // do: allocate the DO family by per-script COMPUTE wall-time share (reuses
  // #50's driver — the one dataset that knows which script burned the lumped DO
  // SKU). scriptName == worker == project. Approximate for the storage sub-lines
  // (not wall-time-driven); the Billed lane still shows the true DO total.
  // getDoComputeDrivers truncates to the top-N scripts, so the untruncated tail
  // + any unknown-script time must POOL — never inflate the named scripts.
  const cycleDays = Math.max(1, Math.ceil((now - start) / 86_400_000));
  const doDrivers = await getDoComputeDrivers(env, cycleDays).catch(() => null);
  const doWeights: { key: string; weight: number }[] = [];
  if (doDrivers) {
    let named = 0;
    for (const s of doDrivers.scripts) {
      if (!s.scriptName || s.scriptName === "(unknown)") continue; // pooled via remainder
      doWeights.push({ key: s.scriptName, weight: s.wallTime });
      named += s.wallTime;
    }
    const remainder = Math.max(0, doDrivers.totalWallTime - named);
    if (remainder > 0) doWeights.push({ key: UNATTRIBUTED, weight: remainder });
  }
  weightsByCategory.set("do", doWeights);

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
    if (actual === 0) continue;
    // Non-attributable families (do/other/compute) AND any credit/adjustment
    // (negative contracted_cost) can't be split by usage share — pool them so
    // the ledger still ties exactly to the billed total.
    if (!ATTRIBUTABLE.has(cat) || actual < 0) {
      poolAcc.set(UNATTRIBUTED, (poolAcc.get(UNATTRIBUTED) ?? 0) + actual);
      continue;
    }
    const allocated = allocateActual(actual, weightsByCategory.get(cat) ?? []);
    for (const a of allocated) bump(a.key, cat, a.usd);
  }

  const projects = [...projectAcc.entries()]
    .map(([name, v]) => ({ name, kind: v.kind, totalUsd: v.total, byCategory: v.byCategory }))
    .sort((a, b) => b.totalUsd - a.totalUsd);
  const pools = [...poolAcc.entries()]
    .filter(([, usd]) => Math.abs(usd) > 0.005) // keep credits (negative) so the ledger ties
    .map(([name, usd]) => ({ name: name === SHARED ? "shared" : "unattributed", totalUsd: usd }));

  const totalActualUsd = billed.reduce((s, b) => s + b.actualUsd, 0);
  const totalProjectedUsd = billed.reduce((s, b) => s + b.projectedUsd, 0);

  // Dispute lane: our reconstructed marginal-rate estimate (daily_cost service
  // headlines) vs the billed actual — but LIKE-FOR-LIKE only. daily_cost.cost_usd
  // is NULL for services with no known overage rate (e.g. Durable Objects), so a
  // naive total(actual) − total(estimate) would count billed-but-unestimated
  // spend as a dispute. Compare per category, and only where an estimate exists
  // on BOTH sides. Signed: >0 = billed above our estimate → review on Accountant.
  const estRows = await db
    .select({ service: dailyCost.service, est: sql<number | null>`sum(${dailyCost.costUsd})` })
    .from(dailyCost)
    .where(and(gte(dailyCost.dayStart, start), lt(dailyCost.dayStart, end), eq(dailyCost.dimension, "")))
    .groupBy(dailyCost.service);
  const estimateByCategory = new Map<string, number>();
  for (const r of estRows) {
    const cat = SERVICE_TO_CATEGORY[r.service] ?? "other";
    estimateByCategory.set(cat, (estimateByCategory.get(cat) ?? 0) + Number(r.est ?? 0));
  }
  const { estimateUsd, disputeUsd } = likeForLikeDispute(actualByCategory, estimateByCategory);

  // Reconciliation invariant: every billed dollar lands in exactly one project or
  // pool. If this ever drifts > 1¢, the allocation dropped or double-counted —
  // surface it loudly rather than ship a ledger that doesn't tie to the bill.
  // Sum the UNFILTERED accumulators — `pools` drops sub-cent rows for display,
  // which must not fool the reconciliation check.
  const allocatedUsd =
    projects.reduce((s, p) => s + p.totalUsd, 0) +
    [...poolAcc.values()].reduce((s, u) => s + u, 0);
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
    estimateUsd,
    disputeUsd,
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
