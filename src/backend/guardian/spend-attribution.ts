/**
 * @fileoverview Per-project spend attribution — joins the Worker→resource
 * binding graph (`getBindingIndex`) to per-resource usage cost so the cockpit
 * can answer "which project is burning the R2/D1/Vectorize allowance", not just
 * "which bucket".
 *
 * The honest split rule (Cloudflare meters per *resource*, never per *caller*):
 *   - resource bound to exactly ONE worker  → credited to that worker's project
 *   - resource bound to MANY workers         → pooled into `__shared__` (unsplit)
 *   - resource bound to NO tracked worker    → pooled into `__unattributed__`
 *   - compute (`workersInvocationsAdaptive` by scriptName) → always per-worker
 *   - AI (`ai_router_requests.cost_usd` by project)       → always per-project
 *
 * Only categories with a real per-resource (or per-worker) breakdown are
 * attributed: compute, r2, d1, vectorize, ai. KV meters by action-type (not
 * namespace) and Durable Objects aren't in the binding graph, so neither is
 * attributed here — we pool honestly rather than fabricate a per-project number.
 *
 * @see {@link file://src/backend/guardian/resources.ts} getBindingIndex
 * @see {@link file://src/backend/guardian/collect.ts} collectUsage (per-resource breakdown)
 * @see {@link file://src/backend/guardian/cost-calculator.ts} calculateOperations
 */

import { gte, sql } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { aiRouterRequests, guardianProjects } from "@/backend/db/schema";

import { collectUsage } from "./collect";
import { calculateOperations, type CfOperation } from "./cost-calculator";
import { getBindingIndex, type BindingIndex } from "./resources";

export const SPEND_CATEGORIES = ["compute", "r2", "d1", "vectorize", "ai"] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

/**
 * Pooled pseudo-owners for spend that cannot be honestly assigned to one project.
 * The leading `*` is invalid in a Cloudflare Worker script name, so these can
 * never collide with a real project row in the accumulator.
 */
export const SHARED = "*shared";
export const UNATTRIBUTED = "*unattributed";

/** Probe id → the category it rolls into + how its breakdown label becomes a binding key. */
const RESOURCE_PROBES: Record<string, { category: SpendCategory; key: (label: string) => string }> = {
  d1: { category: "d1", key: (id) => `d1:${id}` },
  "r2-operations": { category: "r2", key: (name) => `r2:${name}` },
  "r2-storage": { category: "r2", key: (name) => `r2:${name}` },
  vectorize: { category: "vectorize", key: (id) => `vectorize:${id}` },
};

export type CategoryBucket = Record<SpendCategory, number>;
const emptyBucket = (): CategoryBucket => ({ compute: 0, r2: 0, d1: 0, vectorize: 0, ai: 0 });

export type ProjectSpend = {
  name: string;
  /** worker | ai_project | py | gas | other | shared | unattributed */
  kind: string;
  criticality: string | null;
  totalUsd: number;
  byCategory: CategoryBucket;
};

export type AttributionResult = {
  windowHours: number;
  builtAt: number;
  categories: readonly SpendCategory[];
  totalUsd: number;
  /** Account composition: summed cost per category across every owner (incl. pools). */
  byCategory: CategoryBucket;
  /** Every owner, spend desc. Pools (`__shared__`, `__unattributed__`) carry the special kinds. */
  projects: ProjectSpend[];
};

/** One priced unit of spend, tagged with how it should be attributed. */
export type PricedLine =
  | { kind: "resource"; key: string; category: SpendCategory; usd: number }
  | { kind: "compute"; worker: string; usd: number }
  | { kind: "ai"; project: string; usd: number };

/**
 * PURE core: fold priced lines into per-owner buckets, applying the shared /
 * unattributed pooling rule. No I/O — unit-tested directly.
 */
export function poolSpend(
  lines: PricedLine[],
  index: BindingIndex,
  meta: Map<string, { kind: string; criticality: string | null }>,
): AttributionResult["projects"] {
  const acc = new Map<string, ProjectSpend>();
  const bump = (name: string, kind: string, cat: SpendCategory, usd: number) => {
    let p = acc.get(name);
    if (!p) {
      p = { name, kind, criticality: meta.get(name)?.criticality ?? null, totalUsd: 0, byCategory: emptyBucket() };
      acc.set(name, p);
    }
    p.byCategory[cat] += usd;
    p.totalUsd += usd;
  };

  for (const line of lines) {
    if (!(line.usd > 0)) continue;
    if (line.kind === "ai") {
      bump(line.project, meta.get(line.project)?.kind ?? "ai_project", "ai", line.usd);
    } else if (line.kind === "compute") {
      bump(line.worker, meta.get(line.worker)?.kind ?? "worker", "compute", line.usd);
    } else {
      const owners = [...new Set((index.byResource[line.key] ?? []).map((w) => w.worker))];
      if (owners.length === 1) {
        bump(owners[0], meta.get(owners[0])?.kind ?? "worker", line.category, line.usd);
      } else if (owners.length > 1) {
        bump(SHARED, "shared", line.category, line.usd);
      } else {
        bump(UNATTRIBUTED, "unattributed", line.category, line.usd);
      }
    }
  }

  return [...acc.values()].sort((a, b) => b.totalUsd - a.totalUsd);
}

/** UTC start-of-month in ms. */
function monthStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Whole hours elapsed this month, clamped to the 31-day GraphQL retention window. */
export function hoursThisMonth(now = Date.now()): number {
  const h = Math.ceil((now - monthStartMs(now)) / 3_600_000);
  return Math.min(744, Math.max(1, h));
}

/**
 * Gather every input (usage breakdown, binding graph, AI spend, project meta),
 * price it, and pool it into a per-project category ledger for the month.
 *
 * @param env - Worker env (Secrets Store CF creds + DB + SESSIONS)
 * @param hours - trailing window for infra usage; defaults to month-to-date
 */
export async function attributeSpendByProject(
  env: Env,
  hours = hoursThisMonth(),
): Promise<AttributionResult> {
  const db = getDb(env);

  const [readings, index, projectRows, aiRows] = await Promise.all([
    collectUsage(env, hours),
    getBindingIndex(env),
    db
      .select({
        name: guardianProjects.name,
        kind: guardianProjects.kind,
        criticality: guardianProjects.criticality,
      })
      .from(guardianProjects),
    db
      .select({ project: aiRouterRequests.project, total: sql<number>`sum(${aiRouterRequests.costUsd})` })
      .from(aiRouterRequests)
      .where(gte(aiRouterRequests.at, monthStartMs()))
      .groupBy(aiRouterRequests.project),
  ]);

  const meta = new Map(projectRows.map((r) => [r.name, { kind: r.kind, criticality: r.criticality }]));

  // Build the priceable op list from the per-resource / per-worker breakdowns,
  // carrying a parallel tag array so we can re-attach attribution after pricing.
  const ops: CfOperation[] = [];
  const tags: (
    | { kind: "compute"; worker: string }
    | { kind: "resource"; key: string; category: SpendCategory }
  )[] = [];
  for (const r of readings) {
    if (r.status !== "ok" || r.breakdown.length === 0) continue;
    if (r.id === "workers") {
      for (const b of r.breakdown) {
        ops.push({ kind: "cf", service: "workers", units: b.value });
        tags.push({ kind: "compute", worker: b.label });
      }
      continue;
    }
    const probe = RESOURCE_PROBES[r.id];
    if (!probe) continue;
    for (const b of r.breakdown) {
      ops.push({ kind: "cf", service: r.id, units: b.value });
      tags.push({ kind: "resource", key: probe.key(b.label), category: probe.category });
    }
  }

  // calculateOperations maps `operations` 1:1 in input order (no drop/reorder),
  // so priced.lines[i] corresponds to tags[i]. Guard the invariant explicitly.
  const priced = ops.length ? await calculateOperations(env, ops) : { lines: [], totalUsd: 0 };
  if (priced.lines.length !== ops.length) {
    throw new Error(
      `attribution pricing length mismatch: ${priced.lines.length} priced vs ${ops.length} ops`,
    );
  }
  const lines: PricedLine[] = priced.lines.map((l, i) => ({ ...tags[i], usd: l.costUsd ?? 0 }) as PricedLine);

  for (const a of aiRows) {
    if (a.project) lines.push({ kind: "ai", project: a.project, usd: Number(a.total ?? 0) });
  }

  const projects = poolSpend(lines, index, meta);

  const byCategory = emptyBucket();
  let totalUsd = 0;
  for (const p of projects) {
    for (const cat of SPEND_CATEGORIES) byCategory[cat] += p.byCategory[cat];
    totalUsd += p.totalUsd;
  }

  return { windowHours: hours, builtAt: Date.now(), categories: SPEND_CATEGORIES, totalUsd, byCategory, projects };
}
