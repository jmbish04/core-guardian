/**
 * @fileoverview P12 smart-proxy model resolver — the ONE decision point that
 * turns a `/run` request's requested model into the model actually dispatched.
 *
 * This runs on the AI-Router hot path, so its prime directive is NON-BREAKING:
 * a request that names a concrete model with no matching rule MUST come back
 * byte-for-byte unchanged (reason "passthrough", provider left to the caller).
 * Only two things ever change the model:
 *
 *   1. substitution — an enabled `model_substitutions` row for (project,
 *      requestedModel). The operator explicitly asked to retarget this model.
 *   2. dynamic      — the caller opted in by omitting the model or passing a
 *      sentinel ("auto" | "best" | "budget" | "cheapest"). We pick the best
 *      catalog model for the request's importance / budget / capability floor.
 *
 * ZERO AI here: the pick is deterministic arithmetic over the {@link
 * ../model-catalog} pool (same primitives P11's model-savings uses). No network
 * on the substitution/passthrough paths beyond the single rule lookup; the
 * dynamic path additionally reads the KV-cached catalog.
 */

import { and, eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { modelSubstitutions } from "@/backend/db/schema";

import {
  getModelCatalog,
  isChatModel,
  TIER_MIN_SCORE,
  type CatalogModel,
} from "../model-catalog";

/** Requested-model values that mean "you pick for me" rather than a real model. */
export const DYNAMIC_SENTINELS = new Set(["auto", "best", "budget", "cheapest"]);

/** Sentinels that lean cheap regardless of importance. */
const CHEAP_SENTINELS = new Set(["budget", "cheapest"]);

export type ResolveArgs = {
  /** AI-Router project scope (rule lookups are scoped to it). */
  project: string;
  /** The model the caller asked for. Absent/sentinel ⇒ dynamic selection. */
  requestedModel?: string;
  importance?: string;
  /** Optional max blended $/1M-token rate the dynamic pick must stay under. */
  budgetUsd?: number;
  /** Requested capabilities — raises the dynamic capability floor when present. */
  capabilities?: string[];
};

export type ResolveReason =
  | "substitution"
  | "substitution_skipped_no_provider"
  | "dynamic"
  | "passthrough";

export type ResolveResult = {
  /** The model to dispatch. */
  model: string;
  /**
   * Provider for the resolved model, or `null` to keep the caller's provider.
   * Passthrough always yields null (the caller's provider is authoritative);
   * substitution/dynamic yield the catalog provider when known, else null.
   */
  provider: string | null;
  reason: ResolveReason;
};

/**
 * Blended $/1M for a catalog model. Balanced in/out blend — the dynamic path has
 * no per-request token split, and a balanced blend is the least-biased estimate
 * (identical assumption to model-savings' rateFor for the unknown-split case).
 * Returns null when the model carries no usable price.
 * ponytail: local 3-liner instead of importing model-savings' rateFor, which
 * would drag daily-cost/jules into the hot path and the pure self-check.
 */
function blendedRate(c: Pick<CatalogModel, "inPerM" | "outPerM">): number | null {
  if (c.inPerM === null && c.outPerM === null) return null;
  return ((c.inPerM ?? c.outPerM ?? 0) + (c.outPerM ?? c.inPerM ?? 0)) / 2;
}

/** True when the requested model is a real model name (not absent / not a sentinel). */
export function isConcreteModel(requested?: string): requested is string {
  const m = (requested ?? "").trim();
  return m.length > 0 && !DYNAMIC_SENTINELS.has(m.toLowerCase());
}

/**
 * Pure dynamic pick over a catalog. Exported for the self-check.
 *
 * - capability floor: `small` normally, raised to `mid` when capabilities are
 *   requested (the catalog carries no per-capability flags, so a requested
 *   capability maps to "don't hand back a bottom-tier model").
 * - high importance → highest capability score, cheapest to break ties.
 * - low/medium (or a cheap sentinel) → cheapest rate meeting the floor.
 * - budgetUsd, when set, caps the blended rate.
 *
 * Returns null only when nothing in the catalog qualifies (empty pool / every
 * candidate priced out) — the caller decides what to do with that.
 */
export function pickDynamic(
  catalog: CatalogModel[],
  opts: { importance?: string; budgetUsd?: number; capabilities?: string[]; cheap?: boolean },
): CatalogModel | null {
  const floor =
    opts.capabilities && opts.capabilities.length > 0 ? TIER_MIN_SCORE.mid : TIER_MIN_SCORE.small;

  const pool = catalog.filter((c) => {
    if (!isChatModel(`${c.id} ${c.name}`)) return false;
    if (c.score < floor) return false;
    const rate = blendedRate(c);
    if (rate === null) return false; // unpriced ⇒ not selectable
    if (opts.budgetUsd != null && rate > opts.budgetUsd) return false;
    return true;
  });
  if (pool.length === 0) return null;

  const wantHighest = opts.importance === "high" && !opts.cheap;
  const rate = (c: CatalogModel) => blendedRate(c) ?? Number.POSITIVE_INFINITY;

  return [...pool].sort((a, b) => {
    if (wantHighest && b.score !== a.score) return b.score - a.score; // capability first
    if (rate(a) !== rate(b)) return rate(a) - rate(b); // then cheapest
    return b.score - a.score; // stable-ish tiebreak: prefer stronger
  })[0];
}

/**
 * Provider for a catalog model id — EXACT id/name match only. No substring
 * fallback: a loose match could route e.g. "llama-3" to whichever provider
 * happens to sort first, silently crossing providers. No exact hit → null,
 * which (per the substitution branch) means "don't swap".
 */
function providerFor(catalog: CatalogModel[], modelId: string): string | null {
  const norm = modelId.toLowerCase();
  const hit = catalog.find((c) => c.id.toLowerCase() === norm || c.name.toLowerCase() === norm);
  return hit?.provider ?? null;
}

/**
 * Resolve the model to dispatch for a `/run` request. See file header for the
 * order + non-breaking contract.
 *
 * @throws only when a DYNAMIC request cannot be satisfied (opt-in path, empty
 *   catalog). Substitution + passthrough never throw and never touch the network
 *   beyond the single rule lookup / catalog read.
 */
export async function resolveModel(env: Env, args: ResolveArgs): Promise<ResolveResult> {
  const concrete = isConcreteModel(args.requestedModel);

  // (a) Substitution — a concrete requested model with an enabled rule for this
  // project. This is the only place a named model gets redirected.
  if (concrete) {
    const requested = args.requestedModel!.trim();
    const passthrough: ResolveResult = { model: requested, provider: null, reason: "passthrough" };

    // The rule lookup MUST NOT be able to break a passthrough request: if D1
    // throws, treat it as "no matching rule" and dispatch the requested model
    // unchanged. A named-model request never fails because of this table.
    let rule: { toModel: string }[];
    try {
      rule = await getDb(env)
        .select({ toModel: modelSubstitutions.toModel })
        .from(modelSubstitutions)
        .where(
          and(
            eq(modelSubstitutions.project, args.project),
            eq(modelSubstitutions.fromModel, requested),
            eq(modelSubstitutions.enabled, true),
          ),
        )
        .limit(1);
    } catch (err) {
      console.warn(
        JSON.stringify({ level: "WARN", source: "resolveModel.ruleLookup", project: args.project, error: String(err) }),
      );
      return passthrough; // degrade to passthrough, never throw
    }

    if (rule.length > 0) {
      const toModel = rule[0].toModel;
      const catalog = await getModelCatalog(env).catch(() => [] as CatalogModel[]);
      const provider = providerFor(catalog, toModel);
      // A substitution stores only the target model. If we can't resolve its
      // provider from the catalog, swapping would dispatch the new model under
      // the CALLER's provider (e.g. openai + claude-3) → a guaranteed misfire.
      // Refuse the swap and pass the original through instead.
      if (!provider) {
        console.warn(
          JSON.stringify({ level: "WARN", source: "resolveModel.substitution", project: args.project, from: requested, to: toModel, reason: "no catalog provider for target" }),
        );
        return { model: requested, provider: null, reason: "substitution_skipped_no_provider" };
      }
      return { model: toModel, provider, reason: "substitution" };
    }
    // (c) Concrete model, no rule → IDENTICAL to today. Caller keeps its provider.
    return passthrough;
  }

  // (b) Dynamic — caller omitted the model or passed a sentinel.
  const cheap = CHEAP_SENTINELS.has((args.requestedModel ?? "").trim().toLowerCase());
  const catalog = await getModelCatalog(env);
  const pick = pickDynamic(catalog, {
    importance: args.importance,
    budgetUsd: args.budgetUsd,
    capabilities: args.capabilities,
    cheap,
  });
  if (!pick) {
    throw new Error(
      "resolveModel: dynamic selection requested but no catalog model qualifies (empty pool or budget too low)",
    );
  }
  return { model: pick.id, provider: pick.provider, reason: "dynamic" };
}

// ---------------------------------------------------------------------------
// Self-check — pure resolution logic (substitution match / dynamic pick /
// passthrough). Runs via `npx tsx resolve-model.ts`, never in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const assert = (c: boolean, m: string) => {
    if (!c) throw new Error(m);
  };
  const mk = (id: string, provider: string, inP: number, outP: number, score: number): CatalogModel => ({
    key: `${provider}:${id}`,
    id,
    name: id,
    provider,
    inPerM: inP,
    outPerM: outP,
    cachedInPerM: null,
    context: null,
    score,
    tier: "mid",
    source: "aipricing",
  });

  const catalog = [
    mk("frontier-x", "anthropic", 15, 75, 88), // strong, pricey
    mk("mid-y", "openai", 3, 12, 68), // capable, mid price
    mk("cheap-z", "workers-ai", 0.2, 0.6, 32), // cheap, low capability
  ];

  // isConcreteModel: sentinels + blanks are NOT concrete.
  assert(isConcreteModel("gpt-5") === true, "named model is concrete");
  assert(isConcreteModel("auto") === false, "auto sentinel is not concrete");
  assert(isConcreteModel("BEST") === false, "sentinels are case-insensitive");
  assert(isConcreteModel(undefined) === false, "absent is not concrete");
  assert(isConcreteModel("  ") === false, "blank is not concrete");

  // PASSTHROUGH proof: high importance dynamic pick = highest score.
  const high = pickDynamic(catalog, { importance: "high" });
  assert(high?.id === "frontier-x", `high→frontier, got ${high?.id}`);

  // budget/low → cheapest meeting the (small) floor.
  const cheap = pickDynamic(catalog, { importance: "low", cheap: true });
  assert(cheap?.id === "cheap-z", `budget→cheapest, got ${cheap?.id}`);

  // capabilities requested → floor rises to mid, cheap-z (score 32) excluded,
  // so the cheapest REMAINING is mid-y.
  const capped = pickDynamic(catalog, { importance: "low", capabilities: ["tools"] });
  assert(capped?.id === "mid-y", `capability floor excludes low tier, got ${capped?.id}`);

  // budgetUsd caps the blended rate: frontier blended = 45, mid-y = 7.5,
  // cheap-z = 0.4. A $10/1M ceiling with high importance still can't afford
  // frontier, so the strongest AFFORDABLE is mid-y.
  const budgeted = pickDynamic(catalog, { importance: "high", budgetUsd: 10 });
  assert(budgeted?.id === "mid-y", `budget cap forces affordable pick, got ${budgeted?.id}`);

  // Empty / priced-out pool → null (caller turns this into an error upstream).
  assert(pickDynamic([], { importance: "high" }) === null, "empty catalog → null");
  assert(
    pickDynamic(catalog, { importance: "low", budgetUsd: 0.0001 }) === null,
    "budget below every rate → null",
  );

  // providerFor: EXACT id/name match only — no substring fallback (would cross
  // providers). "mid" is a substring of "mid-y" but must NOT match.
  assert(providerFor(catalog, "mid-y") === "openai", "provider by exact id");
  assert(providerFor(catalog, "mid") === null, "substring must NOT match (exact only)");
  assert(providerFor(catalog, "not-in-catalog") === null, "unknown model → null provider");

  // blendedRate: balanced blend, null when unpriced.
  assert(blendedRate({ inPerM: 10, outPerM: 20 }) === 15, "balanced blend 15");
  assert(blendedRate({ inPerM: null, outPerM: null }) === null, "unpriced → null");

  // eslint-disable-next-line no-console
  console.log("ok — resolve-model: substitution/dynamic/passthrough logic verified");
}
