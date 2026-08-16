/**
 * @fileoverview P11 AI model-savings — per (project, model) "switch off the
 * expensive model, save $Y" recommendations + a one-click Jules model-switch.
 *
 * Where {@link ../model-recommendations} answers the account-wide question ("per
 * model, is there a cheaper-but-capable swap?") and returns ONE best swap per
 * model, this module powers a dedicated recommendations page: it keeps the
 * PROJECT dimension (from `ai_router_requests`) and returns, per (project,
 * model) with real spend, a ranked list of the top-3 cheaper capable
 * alternatives from the {@link ../model-catalog} plus the dollar savings each
 * would yield for that exact workload.
 *
 * Reuse: the catalog, capability score + tier gate, and model matching all come
 * from `model-catalog` — a candidate must score AT OR ABOVE the incumbent, so a
 * recommendation only ever lowers price, never capability (identical rule to
 * `model-recommendations`). The Jules dispatch reuses `createJulesDispatch` +
 * the `jules_sessions` tracking so a switch shows up on the /jules page.
 *
 * ZERO AI in the logic: deterministic catalog comparison + arithmetic.
 */

import { gte, sql } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { aiRouterRequests, julesSessions } from "@/backend/db/schema";
import { getSecret, getSecretStoreBinding } from "@/backend/utils/secrets";

import { getDailyCostReport } from "../daily-cost";
import {
  getModelCatalog,
  isChatModel,
  matchCatalogModel,
  normalizeModelName as norm,
  type CatalogModel,
} from "../model-catalog";

const DAY_MS = 86_400_000;
const JULES_BASE = "https://jules.googleapis.com/v1alpha";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SavingsAlternative = {
  model: string;
  provider: string;
  /** Blended $/1M for this workload's in/out token mix (balanced when unknown). */
  ratePerM: number;
  estimatedSavingsUsd: number;
  /** 0..1 fraction of current spend saved. */
  savingsPct: number;
};

export type ModelSavingsRec = {
  project: string | null;
  currentModel: string;
  currentProvider: string;
  currentSpendUsd: number;
  /** Top-3 cheaper capable swaps, savings desc. Empty when none exists. */
  alternatives: SavingsAlternative[];
  /** Best alternative's saving, or null when there is no cheaper capable swap. */
  topSavingsUsd: number | null;
};

export type ModelSavingsReport = {
  days: number;
  recommendations: ModelSavingsRec[];
  totalPotentialSavingsUsd: number;
};

/** One (project, model) with observed spend + token mix over the window. */
type Observed = {
  project: string | null;
  provider: string;
  model: string;
  spendUsd: number;
  tokensIn: number;
  tokensOut: number;
};

// ---------------------------------------------------------------------------
// Pure helpers (self-checked)
// ---------------------------------------------------------------------------

/**
 * Blended $/1M for a candidate over a workload's in/out token split. When the
 * split is unknown (no token detail, e.g. neuron-priced Workers AI rows) we
 * assume a balanced mix — the ratio between two models is what drives savings,
 * and a balanced blend is the least-biased estimate.
 * ponytail: balanced-split assumption when tokens are unknown; pass real tokens
 * (router rows do) for an exact blend.
 */
export function rateFor(c: Pick<CatalogModel, "inPerM" | "outPerM">, inTok: number, outTok: number): number | null {
  if (c.inPerM === null && c.outPerM === null) return null;
  const i = c.inPerM ?? 0;
  const o = c.outPerM ?? 0;
  const total = inTok + outTok;
  return total > 0 ? (inTok * i + outTok * o) / total : (i + o) / 2;
}

/**
 * Rank the catalog's cheaper-but-at-least-as-capable swaps for one workload.
 * Pure: no env, no I/O — the whole comparison is arithmetic over the catalog.
 *
 * @param catalog - candidate models
 * @param incumbent - the current model's key (excluded) + capability floor + rate
 * @param spendUsd - current observed spend (the base the % applies to)
 * @param inTok/outTok - the workload's token mix (0/0 → balanced blend)
 */
export function rankAlternatives(
  catalog: CatalogModel[],
  incumbent: { key: string | null; model: string; score: number; rate: number },
  spendUsd: number,
  inTok: number,
  outTok: number,
): SavingsAlternative[] {
  if (incumbent.rate <= 0) return [];
  const out: SavingsAlternative[] = [];
  const incNorm = norm(incumbent.model);
  for (const c of catalog) {
    if (c.score < incumbent.score) continue; // never lower capability
    if (incumbent.key && c.key === incumbent.key) continue;
    if (norm(c.id) === incNorm) continue;
    const altRate = rateFor(c, inTok, outTok);
    if (altRate === null || altRate >= incumbent.rate) continue;
    const savingsPct = 1 - altRate / incumbent.rate;
    out.push({
      model: c.name,
      provider: c.provider,
      ratePerM: altRate,
      estimatedSavingsUsd: spendUsd * savingsPct,
      savingsPct,
    });
  }
  out.sort((a, b) => b.estimatedSavingsUsd - a.estimatedSavingsUsd);
  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/**
 * Per (project, model) spend + token mix from `ai_router_requests` over the
 * window, PLUS direct Workers-AI models from the daily-cost neuron split as
 * `project=null` rows (those carry no token detail, so they compare on list
 * rates via the balanced-split blend).
 * ponytail: the Workers-AI rows are the newest day's neuron split (that's what
 * daily-cost exposes) while router rows sum the whole window — a known,
 * documented mix; scale the daily rows here if the two windows ever need to match.
 */
async function observe(env: Env, days: number): Promise<Observed[]> {
  const since = Date.now() - days * DAY_MS;
  const rows = await getDb(env)
    .select({
      project: aiRouterRequests.project,
      provider: aiRouterRequests.provider,
      model: aiRouterRequests.model,
      spendUsd: sql<number>`sum(${aiRouterRequests.costUsd})`,
      tokensIn: sql<number>`sum(${aiRouterRequests.tokensIn})`,
      tokensOut: sql<number>`sum(${aiRouterRequests.tokensOut})`,
    })
    .from(aiRouterRequests)
    .where(gte(aiRouterRequests.at, since))
    .groupBy(aiRouterRequests.project, aiRouterRequests.provider, aiRouterRequests.model);

  const observed: Observed[] = rows
    .filter((r) => (r.spendUsd ?? 0) > 0)
    .map((r) => ({
      project: r.project,
      provider: r.provider,
      model: r.model,
      spendUsd: r.spendUsd ?? 0,
      tokensIn: r.tokensIn ?? 0,
      tokensOut: r.tokensOut ?? 0,
    }));

  try {
    const report = await getDailyCostReport(env, days);
    for (const m of report.workersAiModels.models) {
      if (m.costUsd == null || m.costUsd <= 0) continue;
      observed.push({
        project: null,
        provider: "workers-ai",
        model: m.model,
        spendUsd: m.costUsd,
        tokensIn: 0,
        tokensOut: 0,
      });
    }
  } catch {
    /* daily-cost is optional context — router rows still stand */
  }
  return observed;
}

// ---------------------------------------------------------------------------
// Public: the recommendations report
// ---------------------------------------------------------------------------

/**
 * Per (project, model) with real spend, the cheaper capable alternatives and the
 * dollar savings each would yield, ranked by the best per-row saving.
 *
 * @param days - trailing observation window (default 30)
 */
export async function getModelSavings(env: Env, days = 30): Promise<ModelSavingsReport> {
  const [observed, catalog] = await Promise.all([observe(env, days), getModelCatalog(env)]);

  const recommendations: ModelSavingsRec[] = [];
  for (const o of observed) {
    // A chat-cost swap only makes sense between chat/completion models.
    if (!isChatModel(o.model)) continue;

    const match = matchCatalogModel(catalog, o.model);
    // No catalog match ⇒ the incumbent's capability score is unreliable, so we
    // recommend NOTHING (a cheaper candidate could be a silent downgrade). The
    // row still appears, just with no alternatives.
    const score = match?.score ?? 0;
    // Current rate: prefer the catalog list rate (apples-to-apples with the
    // candidates); else derive the real paid rate from spend/tokens; else we
    // cannot compare (honest null — no alternatives).
    const catRate = match ? rateFor(match, o.tokensIn, o.tokensOut) : null;
    const totalTok = o.tokensIn + o.tokensOut;
    const currentRate =
      catRate ?? (totalTok > 0 ? o.spendUsd / (totalTok / 1_000_000) : null);

    const alternatives =
      match === null || currentRate === null
        ? []
        : rankAlternatives(
            catalog,
            { key: match?.key ?? null, model: o.model, score, rate: currentRate },
            o.spendUsd,
            o.tokensIn,
            o.tokensOut,
          );

    recommendations.push({
      project: o.project,
      currentModel: o.model,
      currentProvider: o.provider,
      currentSpendUsd: o.spendUsd,
      alternatives,
      topSavingsUsd: alternatives[0]?.estimatedSavingsUsd ?? null,
    });
  }

  // Best savings first; rows with no cheaper capable swap sink to the bottom.
  recommendations.sort((a, b) => (b.topSavingsUsd ?? -1) - (a.topSavingsUsd ?? -1));
  const totalPotentialSavingsUsd = recommendations.reduce((s, r) => s + (r.topSavingsUsd ?? 0), 0);

  return { days, recommendations, totalPotentialSavingsUsd };
}

// ---------------------------------------------------------------------------
// Jules model-switch dispatch
// ---------------------------------------------------------------------------

/** Result of one repo's switch-model dispatch (never throws — errors are values). */
export type ModelSwitchDispatch = {
  repo: string;
  project: string | null;
  ok: boolean;
  dispatchId: string | null;
  julesSessionId: string | null;
  error?: string;
};

/** owner/repo from a `owner/repo[.git]` string, or null. */
function parseOwnerRepo(name: string): { owner: string; repo: string } | null {
  const m = name.trim().match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * The self-contained switch-model brief. Real newlines via a template literal
 * (house rule: never `.join("\n")`). No findings callback — a switch is a code
 * change, not an audit; the PR is the deliverable.
 */
function buildSwitchPrompt(args: {
  owner: string;
  repo: string;
  fromModel: string;
  toModel: string;
}): string {
  const { owner, repo, fromModel, toModel } = args;
  return `You are updating the GitHub repository ${owner}/${repo} on behalf of core-guardian, an automated Cloudflare spend watchdog. The owner has chosen to switch this project OFF the expensive AI model "${fromModel}" and ONTO the cheaper "${toModel}", which core-guardian has verified is at least as capable for this workload.

TASK:
1. Find every place this repo calls the model "${fromModel}" — direct SDK calls, Workers AI \`env.AI.run("${fromModel}", ...)\`, AI Gateway requests, config/env values, and any hard-coded model-name string.
2. Change each to use "${toModel}" instead. Preserve all other request parameters (messages, temperature, max_tokens, tools). If a call site would be better served by routing through core-guardian's AI Router (https://core-guardian.hacolby.workers.dev/api/guardian/ai-router/run) so the model can be governed centrally, prefer that.
3. Do NOT change unrelated code. Keep the diff minimal and reviewable.

DELIVERABLE: open a pull request with these changes and a clear title/description explaining the model switch and the expected savings. Do NOT merge the PR — the owner reviews and merges it.

If the repository does not actually reference "${fromModel}" anywhere, open no PR and make no changes.`;
}

/**
 * Dispatch a single Jules session to switch `fromModel` → `toModel` in one repo.
 * Reuses {@link createJulesDispatch} (registers a pending dispatch row) and
 * inserts a `jules_sessions` row so the switch shows on the /jules page.
 */
export async function dispatchModelSwitch(
  env: Env,
  args: { repo: string; project: string | null; fromModel: string; toModel: string },
): Promise<ModelSwitchDispatch> {
  const base: Omit<ModelSwitchDispatch, "ok"> = {
    repo: args.repo,
    project: args.project,
    dispatchId: null,
    julesSessionId: null,
  };
  const parsed = parseOwnerRepo(args.repo);
  if (!parsed) {
    return { ...base, ok: false, error: `Cannot resolve a GitHub owner/repo from "${args.repo}".` };
  }
  const { owner, repo } = parsed;

  // Anti-injection: fromModel/toModel trace back to ai_router_requests.model
  // (user-populated) and are interpolated into the Jules prompt. Restrict to a
  // safe model-id charset so no newline/quote/instruction can be smuggled in.
  const MODEL_ID = /^[\w./@:-]{1,120}$/;
  if (!MODEL_ID.test(args.fromModel) || !MODEL_ID.test(args.toModel)) {
    return { ...base, ok: false, error: "Invalid model id — refusing to build a Jules prompt." };
  }

  const apiKey =
    (await getSecretStoreBinding(env, "JULES_API_KEY")) ?? getSecret(env, "JULES_API_KEY");
  if (!apiKey) {
    return { ...base, ok: false, error: "JULES_API_KEY is not configured." };
  }

  // Lazy import: jules-dispatch transitively pulls in the Workers-only `agents`
  // runtime, which the standalone self-check can't load. Deferring it here keeps
  // the pure ranking logic runnable via `import.meta.main`.
  const { createJulesDispatch } = await import("./jules-dispatch");
  const { id: dispatchId } = await createJulesDispatch(env, { julesSessionId: "", targetId: null });
  try {
    const res = await fetch(`${JULES_BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
      body: JSON.stringify({
        prompt: buildSwitchPrompt({ owner, repo, fromModel: args.fromModel, toModel: args.toModel }),
        sourceContext: {
          source: `sources/github/${owner}/${repo}`,
          githubRepoContext: { startingBranch: "main" },
        },
        automationMode: "AUTO_CREATE_PR",
        title: `core-guardian model switch — ${args.fromModel} → ${args.toModel}`,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      return { ...base, ok: false, dispatchId, error: `Jules session create failed (${res.status}): ${detail || res.statusText}` };
    }
    const json = (await res.json().catch(() => null)) as { id?: string; name?: string } | null;
    const sessionId = json?.id ?? json?.name?.split("/").pop() ?? "";
    if (!sessionId) {
      return { ...base, ok: false, dispatchId, error: "Jules session create returned no session id." };
    }
    try {
      await getDb(env)
        .insert(julesSessions)
        .values({
          id: crypto.randomUUID(),
          sessionId,
          dispatchId,
          project: args.project,
          repo: `${owner}/${repo}`,
          status: "pending",
          sessionUrl: `https://jules.google.com/session/${sessionId}`,
        });
    } catch (err) {
      console.error(JSON.stringify({ level: "ERROR", source: "guardian.offense.modelSwitch.session", error: String(err) }));
    }
    return { ...base, ok: true, dispatchId, julesSessionId: sessionId };
  } catch (err) {
    return { ...base, ok: false, dispatchId, error: `Jules dispatch error: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Self-check — pure ranking/rate logic. Never runs in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const assert = (c: boolean, m: string) => {
    if (!c) throw new Error(m);
  };
  const mk = (key: string, name: string, inP: number, outP: number, score: number): CatalogModel => ({
    key,
    id: name,
    name,
    provider: "p",
    inPerM: inP,
    outPerM: outP,
    cachedInPerM: null,
    context: null,
    score,
    tier: "mid",
    source: "aipricing",
  });

  // rateFor: balanced blend when tokens unknown, weighted when known.
  assert(rateFor({ inPerM: 10, outPerM: 20 }, 0, 0) === 15, "balanced blend = 15");
  assert(rateFor({ inPerM: 10, outPerM: 20 }, 1_000_000, 0) === 10, "all-in = input rate");
  assert(rateFor({ inPerM: null, outPerM: null }, 0, 0) === null, "unpriced → null");

  const catalog = [
    mk("p:cheap-capable", "cheap-capable", 2, 4, 70), // half price, ≥ capability
    mk("p:cheap-weak", "cheap-weak", 1, 1, 40), // cheaper but LOWER capability → excluded
    mk("p:pricey", "pricey", 20, 40, 90), // more expensive → excluded
    mk("p:incumbent", "incumbent", 4, 8, 60), // the current model → excluded by key
  ];
  const alts = rankAlternatives(
    catalog,
    { key: "p:incumbent", model: "incumbent", score: 60, rate: 6 },
    100,
    0,
    0,
  );
  assert(alts.length === 1, `only the cheaper-capable swap survives, got ${alts.length}`);
  assert(alts[0].model === "cheap-capable", "picked the cheaper capable model");
  // rate 3 vs 6 → 50% cheaper → $50 saved on $100 spend.
  assert(Math.abs(alts[0].estimatedSavingsUsd - 50) < 1e-9, `savings 50, got ${alts[0].estimatedSavingsUsd}`);
  assert(Math.abs(alts[0].savingsPct - 0.5) < 1e-9, "50% saved");

  // zero/negative current rate → no recommendation (guards divide-by-zero).
  assert(rankAlternatives(catalog, { key: null, model: "x", score: 0, rate: 0 }, 100, 0, 0).length === 0, "rate 0 → no alts");

  // eslint-disable-next-line no-console
  console.log("ok — model-savings ranking + rate logic verified");
}
