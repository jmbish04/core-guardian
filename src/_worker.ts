/**
 * @fileoverview Cloudflare Workers entry point for Astro SSR + Hono API +
 * Durable Objects (the `workerEntryPoint` for `@astrojs/cloudflare`).
 *
 * The adapter bundles THIS module's default export as the Worker entry and
 * re-exports the Durable Object classes named in `astro.config.ts`. It does not
 * call `start()` / `createExports()` — that was an older adapter contract, and
 * relying on it silently disabled SSR (every non-API path fell through to an
 * asset lookup and 404'd).
 *
 * Astro SSR is reached by delegating to `handle(request, env, ctx)` from
 * `@astrojs/cloudflare/handler`, which builds the Astro app internally from the
 * generated manifest. There is nothing for us to construct or hold.
 *
 * Our handler routes:
 *   - `/agents/*`        → the Agents SDK router (`routeAgentRequest`)
 *   - `/api/*` + doc URLs → the Hono app
 *   - everything else    → Astro SSR via the adapter's `handle()` (which also
 *                          falls through to the `ASSETS` binding for static
 *                          files). This is the piece a naive `env.ASSETS.fetch`
 *                          custom entry forgets — without it, SSR pages 404.
 *
 * In addition to `fetch`, the handler exports `email(message, env, ctx)` —
 * Cloudflare Email Routing's inbound entry point. It parses + stores received
 * mail in D1 for the `/inbox` showcase (see `backend/email/inbound.ts`). The
 * handler is attached to BOTH the object returned by `createExports().default`
 * (what the Astro adapter re-exports) AND the standalone default export.
 *
 * The same pair also carries `scheduled(event, env, ctx)` — the hourly Core
 * Guardian usage evaluation wired to the `0 * * * *` cron in `wrangler.jsonc`.
 */

import type { ExportedHandler } from "@cloudflare/workers-types";

import { handle } from "@astrojs/cloudflare/handler";
import { routeAgentRequest } from "agents";
import { desc } from "drizzle-orm";

import { ArtifactAgent } from "./backend/ai/agents/ArtifactAgent";
import { BrowserHitlAgent } from "./backend/ai/agents/BrowserHitlAgent";
import { ChatBroker } from "./backend/ai/agents/ChatBroker";
// Import Durable Object classes (the Agents SDK showcase + realtime agents)
import { CodeModeAgent } from "./backend/ai/agents/CodeModeAgent";
import { CoderAgent } from "./backend/ai/agents/CoderAgent";
import { McpAgent } from "./backend/ai/agents/McpAgent";
import { NotificationsAgent } from "./backend/ai/agents/NotificationsAgent";
import { OrchestratorAgent } from "./backend/ai/agents/OrchestratorAgent";
import { ResearcherAgent } from "./backend/ai/agents/ResearcherAgent";
import { SkillsAgent } from "./backend/ai/agents/SkillsAgent";
import { ThinkingAgent } from "./backend/ai/agents/ThinkingAgent";
import { WorkflowsAgent } from "./backend/ai/agents/WorkflowsAgent";
import { app as honoApp } from "./backend/api/index";
import { getDb } from "./backend/db";
import {
  aiGatewayCosts,
  aiModelPricing,
  billableUsage,
  dailyCost,
  scrapeRuns,
} from "./backend/db/schema";
import { handleInboundEmail } from "./backend/email/inbound";
import { snapshotGatewayCosts } from "./backend/guardian/ai-gateway-costs";
import { syncBillableUsage } from "./backend/guardian/billable-usage";
import { backfillBillableUsage } from "./backend/guardian/backfill-billable-usage";
import { snapshotResources, syncZones } from "./backend/guardian/snapshot-resources";
import { CATALOG_CACHE_KEY, refreshModelCatalog } from "./backend/guardian/model-catalog";
import { syncRecommendationAlerts } from "./backend/guardian/model-recommendations";
import { scrapeAllModelPricing } from "./backend/guardian/ai-model-pricing";
import { evaluateUsage } from "./backend/guardian/collect";
import { backfillDailyCost, snapshotDailyCost } from "./backend/guardian/daily-cost";
import { checkSustainedSpend } from "./backend/guardian/offense/auto-break";
import { checkInfraSpikes, checkNuclearBudget } from "./backend/guardian/offense/nuclear";
import { checkProviderSpendAlerts, syncProviderCosts } from "./backend/guardian/providers/sync";
import { pollJulesSessions } from "./backend/guardian/projects/poll-jules";
import { syncWorkerProjects } from "./backend/guardian/projects/sync-workers";
import { scrapeAllPricing } from "./backend/guardian/pricing-scrape";

// Re-export Durable Object classes (Pattern B: the @astrojs/cloudflare adapter
// re-exports these alongside the default handler so Cloudflare resolves every
// DO binding declared in wrangler.jsonc).
export {
  CodeModeAgent,
  BrowserHitlAgent,
  WorkflowsAgent,
  ArtifactAgent,
  OrchestratorAgent,
  ResearcherAgent,
  CoderAgent,
  ChatBroker,
  NotificationsAgent,
  McpAgent,
  ThinkingAgent,
  SkillsAgent,
};

/**
 * Runs the Guardian hourly usage evaluation, swallowing failures.
 *
 * A cron invocation that throws is retried and shows as an error in the
 * dashboard; a usage read failing is expected (e.g. the API token lacks
 * Analytics Read) and should be logged, not escalated.
 */
async function runGuardianEvaluation(env: Env) {
  try {
    const { alerted } = await evaluateUsage(env);
    if (alerted.length > 0) {
      console.warn(JSON.stringify({ level: "WARN", source: "guardian.cron", surging: alerted }));
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "ERROR", source: "guardian.cron", error: String(err) }));
  }
  // Monthly: refresh the scraped Cloudflare pricing catalog. The cron is hourly,
  // so gate on 30 days rather than adding a second cron trigger.
  try {
    await maybeScrapePricing(env);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.pricing", error: String(err) }),
    );
  }
  // Weekly: refresh the multi-provider AI model-pricing catalog.
  try {
    await maybeScrapeModelPricing(env);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.modelPricing", error: String(err) }),
    );
  }
  // Daily: snapshot AI Gateway per-model actual cost into D1 (GraphQL retains
  // only ~31 days; D1 keeps permanent history). Idempotent upsert, safe hourly.
  try {
    await maybeSnapshotGatewayCosts(env);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.gatewayCosts", error: String(err) }),
    );
  }
  // Daily: roll each service's raw usage up into a reconstructed USD cost so the
  // panel can chart day-over-day movement. Gated on 1 day like the gateway
  // snapshot — no second cron trigger. Idempotent upsert, safe hourly.
  try {
    await maybeSnapshotDailyCost(env);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.dailyCost", error: String(err) }),
    );
  }
  // Daily: pull actual billed cost from Cloudflare's Billable Usage API — the
  // ground truth the reconstructed daily_cost estimate is reconciled against.
  // Gated on 1 day; needs the API token to carry Billing:Read (non-fatal).
  try {
    await maybeSyncBillableUsage(env);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.billableUsage", error: String(err) }),
    );
  }
  // One-time: backfill the fuller billable-usage history so "since last login"
  // deltas have depth on a fresh install. KV-guarded to run exactly once.
  try {
    await maybeBackfillBillableUsage(env);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.backfill", error: String(err) }),
    );
  }
  // Hourly: sync zones + snapshot per-resource usage + the worker→resource
  // binding map (the spend-attribution data foundation). Non-fatal.
  try {
    await syncZones(env);
    const snap = await snapshotResources(env);
    console.warn(JSON.stringify({ level: "INFO", source: "guardian.snapshotResources", ...snap }));
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.snapshotResources", error: String(err) }),
    );
  }
  // Daily: pull external AI provider billing (Anthropic/OpenAI/Cursor cost APIs
  // + Gemini Cloud Billing budget) into provider_cost, then run the per-provider
  // budget threshold alerts. Gated on 1 day; each provider is skipped when its
  // key/config is absent (non-fatal).
  try {
    await maybeSyncProviderCosts(env);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.providers", error: String(err) }),
    );
  }
  // Daily: refresh the merged model-pricing candidate catalog (OpenRouter + AI
  // Pricing Guru + scraped) that the cost advisor recommends against.
  try {
    await maybeRefreshModelCatalog(env);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.modelCatalog", error: String(err) }),
    );
  }
  // Daily: Spend Offense sustained-spend auto-breaker. Runs once per day (gated
  // on UTC hour 08, after the daily-cost step above has repriced the two days it
  // scores) — files an incident when spend clears the threshold two days running.
  try {
    await maybeCheckSustainedSpend(env);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.offense", error: String(err) }),
    );
  }
  // Daily (P9a): nuclear total-CF-budget breaker + non-AI infra-spike guard.
  // Same UTC-08 gate as the sustained-spend check — both are idempotent (dedupe
  // on an active incident), so a redundant run is a no-op.
  try {
    await maybeCheckNuclearBudget(env);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.offense.nuclear", error: String(err) }),
    );
  }
  try {
    await maybeCheckInfraSpikes(env);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.offense.infraSpike", error: String(err) }),
    );
  }
  // Nightly (UTC-06): reconcile the P14a unified project registry with the live
  // account (workers + AI-only callers). Idempotent full reconcile.
  try {
    await maybeSyncProjects(env);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.projects.sync", error: String(err) }),
    );
  }
  // Hourly (every run): advance in-flight Jules sessions pending → terminal.
  try {
    await pollJules(env);
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.projects.pollJules", error: String(err) }),
    );
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 3_600_000;
const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;

async function maybeScrapePricing(env: Env) {
  const [latest] = await getDb(env)
    .select({ ranAt: scrapeRuns.ranAt })
    .from(scrapeRuns)
    .orderBy(desc(scrapeRuns.ranAt))
    .limit(1);
  if (latest && Date.now() - latest.ranAt < THIRTY_DAYS_MS) return;
  const { docs, revisions } = await scrapeAllPricing(env);
  console.warn(JSON.stringify({ level: "INFO", source: "guardian.pricing", docs, revisions }));
}

async function maybeScrapeModelPricing(env: Env) {
  const [latest] = await getDb(env)
    .select({ scrapedAt: aiModelPricing.scrapedAt })
    .from(aiModelPricing)
    .orderBy(desc(aiModelPricing.scrapedAt))
    .limit(1);
  if (latest && Date.now() - latest.scrapedAt < SEVEN_DAYS_MS) return;
  const counts = await scrapeAllModelPricing(env);
  console.warn(JSON.stringify({ level: "INFO", source: "guardian.modelPricing", counts }));
}

const ONE_DAY_MS = 24 * 3_600_000;

async function maybeSnapshotGatewayCosts(env: Env) {
  const [latest] = await getDb(env)
    .select({ capturedAt: aiGatewayCosts.capturedAt })
    .from(aiGatewayCosts)
    .orderBy(desc(aiGatewayCosts.capturedAt))
    .limit(1);
  if (latest && Date.now() - latest.capturedAt < ONE_DAY_MS) return;
  const rows = await snapshotGatewayCosts(env, 3);
  console.warn(JSON.stringify({ level: "INFO", source: "guardian.gatewayCosts", rows }));
}

async function maybeSnapshotDailyCost(env: Env) {
  const [latest] = await getDb(env)
    .select({ capturedAt: dailyCost.capturedAt })
    .from(dailyCost)
    .orderBy(desc(dailyCost.capturedAt))
    .limit(1);
  if (latest && Date.now() - latest.capturedAt < ONE_DAY_MS) return;
  // First run: reconstruct up to 30 days of history from the snapshot table so
  // the trend isn't empty until a month of crons has elapsed.
  if (!latest) {
    const backfilled = await backfillDailyCost(env, 30);
    console.warn(JSON.stringify({ level: "INFO", source: "guardian.dailyCost", backfilled }));
  }
  // Re-price yesterday (now complete, with the per-model neuron split) and
  // today (running total). Upserts keep both idempotent.
  const yesterday = await snapshotDailyCost(env, Date.now() - ONE_DAY_MS, true);
  const today = await snapshotDailyCost(env, Date.now(), true);
  console.warn(JSON.stringify({ level: "INFO", source: "guardian.dailyCost", yesterday, today }));
}

async function maybeSyncBillableUsage(env: Env) {
  const [latest] = await getDb(env)
    .select({ capturedAt: billableUsage.capturedAt })
    .from(billableUsage)
    .orderBy(desc(billableUsage.capturedAt))
    .limit(1);
  if (latest && Date.now() - latest.capturedAt < ONE_DAY_MS) return;
  const rows = await syncBillableUsage(env, 35);
  console.warn(JSON.stringify({ level: "INFO", source: "guardian.billableUsage", rows }));
}

const BILLABLE_BACKFILL_KEY = "guardian:billable-backfill-done";

async function maybeBackfillBillableUsage(env: Env) {
  const done = await env.SESSIONS.get(BILLABLE_BACKFILL_KEY);
  if (done) return;
  const bf = await backfillBillableUsage(env);
  // Only mark done when every window succeeded — otherwise retry next cron so
  // rate-limited/half-fetched history isn't permanently skipped.
  if (bf.failures === 0) await env.SESSIONS.put(BILLABLE_BACKFILL_KEY, String(Date.now()));
  console.warn(JSON.stringify({ level: "INFO", source: "guardian.backfill", ...bf }));
}

const PROVIDER_SYNC_KEY = "provider-cost:last-sync";

async function maybeSyncProviderCosts(env: Env) {
  // Debounce on a KV timestamp, NOT the latest provider_cost row: a provider
  // with $0 spend (or no key) writes no rows, so a D1-latest gate would leave
  // the table empty forever and re-hit the provider APIs every cron tick.
  try {
    const raw = await env.SESSIONS.get(PROVIDER_SYNC_KEY);
    const at = raw ? Number(raw) : NaN;
    if (Number.isFinite(at) && Date.now() - at < ONE_DAY_MS) return;
  } catch {
    /* fall through to a sync */
  }
  const synced = await syncProviderCosts(env, 35);
  const alerts = await checkProviderSpendAlerts(env);
  await env.SESSIONS.put(PROVIDER_SYNC_KEY, String(Date.now())).catch(() => {});
  console.warn(
    JSON.stringify({
      level: "INFO",
      source: "guardian.providers",
      synced,
      firedAlerts: alerts.filter((a) => a.fired).map((a) => a.provider),
    }),
  );
}

async function maybeRefreshModelCatalog(env: Env) {
  try {
    const cached = await env.SESSIONS.get(CATALOG_CACHE_KEY);
    if (cached) {
      const { at } = JSON.parse(cached) as { at?: number };
      if (at && Date.now() - at < ONE_DAY_MS) return;
    }
  } catch {
    /* fall through to a refresh */
  }
  const models = await refreshModelCatalog(env);
  // With a fresh catalog, refresh the advisory recommendation alerts too.
  const alerts = await syncRecommendationAlerts(env).catch((err) => {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.recommendationAlerts", error: String(err) }),
    );
    return 0;
  });
  console.warn(
    JSON.stringify({ level: "INFO", source: "guardian.modelCatalog", models: models.length, alerts }),
  );
}

/**
 * Daily gate for the Spend Offense auto-breaker. The cron is hourly, so only run
 * at UTC hour 08 — the checker is idempotent (it dedupes on an existing active
 * incident), but gating avoids 24 redundant daily-cost reads per day.
 */
async function maybeCheckSustainedSpend(env: Env) {
  if (new Date().getUTCHours() !== 8) return;
  const result = await checkSustainedSpend(env);
  if (result.incidentFiled) {
    console.warn(JSON.stringify({ level: "WARN", source: "guardian.offense", ...result }));
  }
}

/**
 * Daily gate (UTC-08) for the P9a nuclear total-CF-budget breaker. No-op until
 * `nuclear_budget_usd` is configured; idempotent via active-incident dedupe.
 */
async function maybeCheckNuclearBudget(env: Env) {
  if (new Date().getUTCHours() !== 8) return;
  const result = await checkNuclearBudget(env);
  if (result.incidentFiled) {
    console.warn(JSON.stringify({ level: "WARN", source: "guardian.offense.nuclear", ...result }));
  }
}

/** Daily gate (UTC-08) for the P9a non-AI infra-spike guard (recommend-only). */
async function maybeCheckInfraSpikes(env: Env) {
  if (new Date().getUTCHours() !== 8) return;
  const result = await checkInfraSpikes(env);
  if (result.incidentsFiled > 0) {
    console.warn(
      JSON.stringify({ level: "WARN", source: "guardian.offense.infraSpike", ...result }),
    );
  }
}

/**
 * Nightly gate (UTC-06) for the P14a project sync. The cron is hourly, so run
 * once per day — the sync is a full idempotent reconcile of guardian_projects.
 */
async function maybeSyncProjects(env: Env) {
  if (new Date().getUTCHours() !== 6) return;
  const summary = await syncWorkerProjects(env);
  console.warn(JSON.stringify({ level: "INFO", source: "guardian.projects.sync", ...summary }));
}

/**
 * P14a Jules-session poller. Runs EVERY cron invocation (hourly) — Jules
 * sessions are short-lived, so no daily gate. No-op when nothing is in flight.
 */
async function pollJules(env: Env) {
  const summary = await pollJulesSessions(env);
  if (summary.updated > 0) {
    console.warn(JSON.stringify({ level: "INFO", source: "guardian.projects.pollJules", ...summary }));
  }
}

/** True for paths the Hono API owns (REST + OpenAPI doc surfaces). */
function isApiPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname.startsWith("/oauth/") ||
    pathname.startsWith("/.well-known/oauth-") ||
    pathname === "/openapi.json" ||
    pathname === "/swagger" ||
    pathname === "/scalar" ||
    pathname === "/scaler"
  );
  // NOTE: `/docs` is intentionally NOT an API path — it is served as an Astro
  // SSR page (`src/frontend/pages/docs/index.astro`). The docs metadata API is
  // mounted at `/api/docs/*`, which is covered by the `/api/` prefix above.
}

/**
 * The Worker's fetch handler.
 *
 * Routing order:
 *   1. `/agents/*`   → Agents SDK (WebSocket + HTTP)
 *   2. API + docs    → Hono
 *   3. everything else → Astro SSR, which falls through to the `ASSETS`
 *      binding for static files on its own.
 *
 * NOTE: `request as any` bridges the lib.dom (Hono) vs @cloudflare/workers-types
 * (`agents` / Astro) `Request` type friction.
 */
const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/agents/")) {
      const agentResponse = await routeAgentRequest(request as any, env);
      if (agentResponse) return agentResponse;
    }

    if (isApiPath(url.pathname)) {
      return honoApp.fetch(request as any, env, ctx);
    }

    // Astro SSR. `handle` owns asset fallthrough, so do NOT short-circuit to
    // env.ASSETS.fetch here — doing so is what made every page 404.
    return handle(request as any, env as any, ctx as any);
  },

  // Cloudflare Email Routing inbound handler. Invoked when a routing rule
  // targets this Worker. Parses + stores the email in D1 for `/inbox`.
  async email(message: any, env: Env, ctx: ExecutionContext) {
    await handleInboundEmail(message, env, ctx);
  },

  // Core Guardian hourly usage evaluation (cron `0 * * * *`).
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await runGuardianEvaluation(env);
  },
} as unknown as ExportedHandler<Env>;

export default handler;
