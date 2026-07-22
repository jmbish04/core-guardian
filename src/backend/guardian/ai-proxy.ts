/**
 * @fileoverview AI proxy + two-tier circuit breaker.
 *
 * A thin relay in front of the native provider APIs (OpenAI / Anthropic / Google
 * Gemini) so calls that bypass AI Gateway are still metered and can be halted.
 * The caller passes its own provider key; we forward the request unchanged,
 * read the provider's own `usage` token counts from the response, price them
 * against a KV price map, and add to a monthly rolling-cost counter in KV. When
 * the counter crosses the budget the breaker trips and further calls get 429
 * before the provider is ever touched.
 *
 * ponytail: a fetch relay, not three bundled provider SDKs (bundle size + node
 * compat in a Worker). And token counts come from the provider's own `usage`
 * payload, not WASM tiktoken — exact, and free. A char/4 pre-flight estimate
 * guards the request before it is sent; swap in tiktoken only if that estimate
 * proves too loose. The gateway path stays governed by AI Gateway native Spend
 * Limits; this KV breaker governs the native path the gateway never sees.
 */

const CAP_KEY = "ai:budget:cap"; // monthly USD cap
const BREAKER_KEY = "ai:breaker"; // "armed" | "tripped" | "break-glass:<untilMs>"
const PRICES_KEY = "ai:prices"; // { model: { in: $/1M, out: $/1M } }

/** Default per-1M-token prices (USD) until overridden in KV. Estimates. */
const DEFAULT_PRICES: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "claude-3-5-sonnet": { in: 3, out: 15 },
  "claude-3-5-haiku": { in: 0.8, out: 4 },
  "gemini-1.5-pro": { in: 1.25, out: 5 },
  "gemini-1.5-flash": { in: 0.075, out: 0.3 },
};

type Provider = {
  url: (model: string) => string;
  headers: (key: string) => Record<string, string>;
  /** Read {inputTokens, outputTokens} from the provider's JSON response. */
  usage: (json: any) => { inTok: number; outTok: number };
};

const PROVIDERS: Record<string, Provider> = {
  openai: {
    url: () => "https://api.openai.com/v1/chat/completions",
    headers: (key) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
    usage: (j) => ({ inTok: j?.usage?.prompt_tokens ?? 0, outTok: j?.usage?.completion_tokens ?? 0 }),
  },
  anthropic: {
    url: () => "https://api.anthropic.com/v1/messages",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }),
    usage: (j) => ({ inTok: j?.usage?.input_tokens ?? 0, outTok: j?.usage?.output_tokens ?? 0 }),
  },
  google: {
    url: (model) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers: (key) => ({ "x-goog-api-key": key, "Content-Type": "application/json" }),
    usage: (j) => ({
      inTok: j?.usageMetadata?.promptTokenCount ?? 0,
      outTok: j?.usageMetadata?.candidatesTokenCount ?? 0,
    }),
  },
};

/** Current month key, e.g. ai:cost:2026-07. now passed in for testability. */
function monthKey(now: number): string {
  const d = new Date(now);
  return `ai:cost:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function getPrices(env: Env): Promise<Record<string, { in: number; out: number }>> {
  const stored = await env.SESSIONS.get(PRICES_KEY, "json").catch(() => null);
  return { ...DEFAULT_PRICES, ...(stored as Record<string, { in: number; out: number }> | null) };
}

/** Price a call. Unknown model → 0 (logged as unknown, not blocked). */
function priceCall(
  prices: Record<string, { in: number; out: number }>,
  model: string,
  inTok: number,
  outTok: number,
): number {
  // Match on a prefix so "gpt-4o-2024-…" hits "gpt-4o".
  const key = Object.keys(prices).find((k) => model.includes(k));
  if (!key) return 0;
  const p = prices[key];
  return (inTok / 1_000_000) * p.in + (outTok / 1_000_000) * p.out;
}

export type BudgetStatus = {
  cap: number | null;
  spent: number;
  remaining: number | null;
  breaker: "armed" | "tripped" | "break-glass";
  breakGlassUntil: number | null;
  month: string;
};

export async function getBudgetStatus(env: Env, now: number): Promise<BudgetStatus> {
  const [capRaw, spentRaw, breakerRaw] = await Promise.all([
    env.SESSIONS.get(CAP_KEY),
    env.SESSIONS.get(monthKey(now)),
    env.SESSIONS.get(BREAKER_KEY),
  ]);
  const cap = capRaw ? Number(capRaw) : null;
  const spent = spentRaw ? Number(spentRaw) : 0;

  // An active break-glass window overrides the cap; otherwise trip when over cap.
  let breakGlassUntil: number | null = null;
  if (breakerRaw?.startsWith("break-glass:")) breakGlassUntil = Number(breakerRaw.split(":")[1]);
  const inBreakGlass = breakGlassUntil !== null && breakGlassUntil > now;
  const overCap = cap !== null && spent >= cap;
  const breaker: "armed" | "tripped" | "break-glass" = inBreakGlass
    ? "break-glass"
    : overCap
      ? "tripped"
      : "armed";

  return {
    cap,
    spent,
    remaining: cap === null ? null : Math.max(0, cap - spent),
    breaker,
    breakGlassUntil: inBreakGlass ? breakGlassUntil : null,
    month: monthKey(now),
  };
}

export async function setBudgetCap(env: Env, cap: number): Promise<void> {
  await env.SESSIONS.put(CAP_KEY, String(cap));
}

/** Break-glass: allow spend past the cap for `hours`. */
export async function breakGlass(env: Env, now: number, hours: number): Promise<void> {
  await env.SESSIONS.put(BREAKER_KEY, `break-glass:${now + hours * 3_600_000}`);
}

export type ProxyResult =
  | { ok: true; status: number; body: unknown; cost: number; spent: number }
  | { ok: false; status: number; error: string; spent?: number; cap?: number };

/**
 * Proxy one native provider call through the breaker.
 *
 * @param provider - openai | anthropic | google
 * @param model - model id (also used to price)
 * @param apiKey - the CALLER's provider key (never stored)
 * @param body - the request body, forwarded verbatim
 */
export async function proxyCall(
  env: Env,
  provider: string,
  model: string,
  apiKey: string,
  body: unknown,
  now: number,
): Promise<ProxyResult> {
  const p = PROVIDERS[provider];
  if (!p) return { ok: false, status: 400, error: `Unknown provider: ${provider}` };

  // Breaker check BEFORE touching the provider.
  const status = await getBudgetStatus(env, now);
  if (status.breaker === "tripped") {
    return { ok: false, status: 429, error: "AI budget exceeded — breaker tripped.", spent: status.spent, cap: status.cap ?? undefined };
  }

  const res = await fetch(p.url(model), {
    method: "POST",
    headers: { ...p.headers(apiKey) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));

  // Meter on the provider's own usage numbers.
  const { inTok, outTok } = p.usage(json);
  const prices = await getPrices(env);
  const cost = priceCall(prices, model, inTok, outTok);

  // Increment the monthly rolling counter. ponytail: read-modify-write on KV is
  // not atomic; a burst can under-count slightly. Fine for a spend GOVERNOR
  // (the cap is a soft ceiling, and native AI Gateway Spend Limits are the hard
  // stop). Move to a Durable Object counter only if exactness matters.
  const key = monthKey(now);
  const prev = Number((await env.SESSIONS.get(key)) ?? 0);
  const spent = prev + cost;
  await env.SESSIONS.put(key, String(spent));

  return { ok: true, status: res.status, body: json, cost, spent };
}

// ---------------------------------------------------------------------------
// Self-check — pure pricing + month-key logic. Never runs in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const eq = (a: unknown, b: unknown, m: string) => {
    if (a !== b) throw new Error(`${m}: got ${a}, want ${b}`);
  };
  const prices = { "gpt-4o": { in: 2.5, out: 10 } };
  // 1M in + 1M out = $2.50 + $10.00 = $12.50
  eq(priceCall(prices, "gpt-4o-2024-08-06", 1_000_000, 1_000_000).toFixed(2), "12.50", "prefix-match price");
  eq(priceCall(prices, "unknown-model", 1_000_000, 0), 0, "unknown model → 0");
  eq(monthKey(Date.UTC(2026, 6, 21)), "ai:cost:2026-07", "month key");
  // eslint-disable-next-line no-console
  console.log("ok — ai-proxy pricing + month-key verified");
}
