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
import { desc } from "drizzle-orm";

import { getDb } from "./backend/db";
import { scrapeRuns } from "./backend/db/schema";
import { handleInboundEmail } from "./backend/email/inbound";
import { evaluateUsage } from "./backend/guardian/collect";
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
  // Monthly: refresh the scraped pricing catalog. The cron is hourly, so gate on
  // 30 days since the last scrape rather than adding a second cron trigger.
  try {
    await maybeScrapePricing(env);
  } catch (err) {
    console.error(JSON.stringify({ level: "ERROR", source: "guardian.pricing", error: String(err) }));
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 3_600_000;

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

/** True for paths the Hono API owns (REST + OpenAPI doc surfaces). */
function isApiPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
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
