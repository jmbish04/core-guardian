/**
 * @fileoverview Split an AI call's cost into input vs output USD. Reuses the
 * KV price map + defaults from ai-proxy.ts so router pricing stays consistent
 * with the existing native breaker.
 */
import type { Usage } from "./types";

// Re-declare the prefix price map access by importing ai-proxy internals is not
// exported; replicate the tiny getter here against the same KV key + defaults.
const PRICES_KEY = "ai:prices"; // read from CIRCUITS KV
const DEFAULT_PRICES: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 2.5, out: 10 }, "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "claude-3-5-sonnet": { in: 3, out: 15 }, "claude-3-5-haiku": { in: 0.8, out: 4 },
  "gemini-1.5-pro": { in: 1.25, out: 5 }, "gemini-1.5-flash": { in: 0.075, out: 0.3 },
};

export async function priceSplit(
  env: Env, model: string, usage: Usage,
): Promise<{ tokensInCost: number; tokensOutCost: number; costUsd: number }> {
  // Price overrides live in CIRCUITS KV (NOT SESSIONS — that's Astro's).
  const stored = (await env.CIRCUITS.get(PRICES_KEY, "json").catch(() => null)) as
    | Record<string, { in: number; out: number }> | null;
  const prices = { ...DEFAULT_PRICES, ...(stored ?? {}) };
  const key = Object.keys(prices).find((k) => model.includes(k));
  if (!key) return { tokensInCost: 0, tokensOutCost: 0, costUsd: 0 };
  const p = prices[key];
  const tokensInCost = (usage.tokensIn / 1_000_000) * p.in;
  const tokensOutCost = (usage.tokensOut / 1_000_000) * p.out;
  return { tokensInCost, tokensOutCost, costUsd: tokensInCost + tokensOutCost };
}

if (import.meta.main) {
  // Pure-math check with an injected fake env.
  const fakeEnv = { CIRCUITS: { get: async () => null } } as unknown as Env;
  priceSplit(fakeEnv, "gpt-4o-2024", { tokensIn: 1_000_000, tokensOut: 1_000_000 }).then((r) => {
    if (r.costUsd.toFixed(2) !== "12.50") throw new Error(`price split: ${r.costUsd}`);
    // eslint-disable-next-line no-console
    console.log("ok — pricing verified");
  });
}
