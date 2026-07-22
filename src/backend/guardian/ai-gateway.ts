/**
 * @fileoverview AI Gateway billing + gateway configuration.
 *
 * Wraps the `/ai-gateway/billing/*` endpoints — credit balance, metered usage
 * history, invoices, auto top-up configuration, and the account spending limit —
 * plus per-gateway settings (rate limiting, caching, log retention, retries).
 *
 * This is the only Cloudflare surface that reports real dollars rather than
 * product-specific meter units, which makes it the sharpest spend signal
 * Guardian has.
 *
 * @remarks Deliberately omitted: `POST /ai-gateway/billing/topup`, which opens
 * a Stripe PaymentIntent and charges the card on file. Guardian is a spend
 * *governor*; a button that spends money does not belong in it.
 *
 * @see {@link file://src/backend/api/routes/ai-gateway.ts} for the routes.
 */

import { cfApi } from "@/backend/guardian/resources";

/** Current credit balance, payment method, and auto top-up state. */
export type CreditBalance = {
  balance: number;
  hasDefaultPaymentMethod: boolean;
  paymentMethod: { brand: string | null; last4: string | null };
  topupConfig: {
    amount: number;
    threshold: number;
    disabledReason: string | null;
    error: string | null;
    lastFailedAt: number | null;
  };
  firstTopupSuccess: boolean | null;
};

/**
 * Reads the AI Gateway credit balance.
 *
 * @param env - Worker env
 * @returns Balance in account currency, payment method, and top-up config
 */
/**
 * The AI Gateway billing API returns every monetary amount in **cents**
 * (`640.19` = $6.40, `5000` = $50.00, invoice line `5` = $0.05). We normalize
 * to dollars at this boundary so the API, MCP, and frontend all speak dollars —
 * rendering the raw cents is what made a $6.40 balance read as "$640". Per-token
 * rate strings (`unit_amount_decimal`) are already dollars and are left alone.
 */
const centsToUsd = (n: number | null | undefined): number => (n ?? 0) / 100;

export async function getCreditBalance(env: Env): Promise<CreditBalance> {
  const { result } = await cfApi<{
    balance: number;
    has_default_payment_method: boolean;
    payment_method?: { brand?: string; last4?: string };
    topup_config?: {
      amount?: number;
      threshold?: number;
      disabledReason?: string;
      error?: string;
      lastFailedAt?: number;
    };
    first_topup_success?: boolean;
  }>(env, "/ai-gateway/billing/credit-balance");

  return {
    balance: centsToUsd(result.balance),
    hasDefaultPaymentMethod: Boolean(result.has_default_payment_method),
    paymentMethod: {
      brand: result.payment_method?.brand ?? null,
      last4: result.payment_method?.last4 ?? null,
    },
    topupConfig: {
      amount: centsToUsd(result.topup_config?.amount),
      threshold: centsToUsd(result.topup_config?.threshold),
      disabledReason: result.topup_config?.disabledReason || null,
      error: result.topup_config?.error || null,
      lastFailedAt: result.topup_config?.lastFailedAt || null,
    },
    firstTopupSuccess: result.first_topup_success ?? null,
  };
}

/** Account spending limit. */
export type SpendingLimit = {
  enabled: boolean;
  amount: number;
  duration: string | null;
  strategy: string | null;
};

/**
 * Reads the account spending limit.
 *
 * @param env - Worker env
 * @returns The limit and whether it is enforced
 */
export async function getSpendingLimit(env: Env): Promise<SpendingLimit> {
  const { result } = await cfApi<{
    enabled?: boolean;
    config?: { amount?: number; duration?: string; strategy?: string };
  }>(env, "/ai-gateway/billing/spending-limit");

  return {
    enabled: Boolean(result.enabled),
    amount: centsToUsd(result.config?.amount),
    duration: result.config?.duration ?? null,
    strategy: result.config?.strategy ?? null,
  };
}

/** One metered usage bucket. */
export type UsageBucket = { id: string; value: number; startTime: number; endTime: number };

/**
 * Reads metered AI Gateway usage over a time range.
 *
 * @param env - Worker env
 * @param window - `day` or `hour` bucket size
 * @param startTime - Unix ms; both bounds are required by the API
 * @param endTime - Unix ms
 * @returns Buckets oldest-last, as returned by Cloudflare
 */
export async function getUsageHistory(
  env: Env,
  window: "day" | "hour",
  startTime: number,
  endTime: number,
): Promise<UsageBucket[]> {
  const params = new URLSearchParams({
    value_grouping_window: window,
    start_time: String(startTime),
    end_time: String(endTime),
  });
  const { result } = await cfApi<{
    history?: { id: string; aggregated_value: number; start_time: number; end_time: number }[];
  }>(env, `/ai-gateway/billing/usage-history?${params}`);

  return (result.history ?? []).map((h) => ({
    id: h.id,
    // aggregated_value is a spend total — cents, like the rest of this API.
    value: centsToUsd(h.aggregated_value),
    startTime: h.start_time,
    endTime: h.end_time,
  }));
}

/** A past invoice. */
export type Invoice = {
  id: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  amountRemaining: number;
  currency: string;
  created: number | null;
  description: string | null;
  origin: string | null;
  pdfUrl: string | null;
};

/**
 * Reads invoice history.
 *
 * @param env - Worker env
 * @param type - `auto`, `manual`, or `all`
 * @returns Invoices newest-first
 */
export async function getInvoiceHistory(
  env: Env,
  type?: "auto" | "manual" | "all",
): Promise<Invoice[]> {
  const query = type ? `?type=${type}` : "";
  const { result } = await cfApi<{
    invoices?: {
      id?: string;
      status?: string;
      amount_due: number;
      amount_paid: number;
      amount_remaining: number;
      currency: string;
      created?: number;
      description?: string;
      invoice_origin?: string;
      invoice_pdf?: string;
    }[];
  }>(env, `/ai-gateway/billing/invoice-history${query}`);

  return (result.invoices ?? [])
    .map((i) => ({
      id: i.id ?? null,
      status: i.status ?? null,
      amountDue: centsToUsd(i.amount_due),
      amountPaid: centsToUsd(i.amount_paid),
      amountRemaining: centsToUsd(i.amount_remaining),
      currency: i.currency ?? "usd",
      created: i.created ?? null,
      description: i.description ?? null,
      origin: i.invoice_origin ?? null,
      pdfUrl: i.invoice_pdf ?? null,
    }))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
}

/** The upcoming (draft) invoice. */
export type InvoicePreview = {
  amountDue: number;
  amountRemaining: number;
  currency: string;
  status: string | null;
  periodStart: number | null;
  periodEnd: number | null;
  lines: { description: string; amount: number; quantity: number; unitAmount: string | null }[];
};

/**
 * Reads a preview of the upcoming invoice, including per-model line items.
 *
 * @param env - Worker env
 * @returns The draft invoice with its line items, largest charge first
 */
export async function getInvoicePreview(env: Env): Promise<InvoicePreview> {
  const { result } = await cfApi<{
    amount_due: number;
    amount_remaining: number;
    currency: string;
    status?: string;
    period_start?: number;
    period_end?: number;
    invoice_lines?: {
      description: string;
      amount: number;
      quantity: number;
      pricing?: { unit_amount_decimal?: string };
    }[];
  }>(env, "/ai-gateway/billing/invoice-preview");

  return {
    amountDue: centsToUsd(result.amount_due),
    amountRemaining: centsToUsd(result.amount_remaining),
    currency: result.currency ?? "usd",
    status: result.status ?? null,
    periodStart: result.period_start ?? null,
    periodEnd: result.period_end ?? null,
    lines: (result.invoice_lines ?? [])
      .map((l) => ({
        description: l.description,
        amount: centsToUsd(l.amount),
        quantity: l.quantity ?? 0,
        unitAmount: l.pricing?.unit_amount_decimal ?? null,
      }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/**
 * Sets the auto top-up threshold and amount.
 *
 * @param env - Worker env
 * @param amountDollars - Top-up amount in dollars (Cloudflare minimum $10)
 * @param thresholdDollars - Balance in dollars that triggers a top-up (minimum $5)
 * @returns The stored configuration, in dollars
 */
export async function setTopupConfig(
  env: Env,
  amountDollars: number,
  thresholdDollars: number,
): Promise<{ amount: number; threshold: number }> {
  // Dollars in, dollars out — Cloudflare wants cents on the wire.
  const amount = Math.round(amountDollars * 100);
  const threshold = Math.round(thresholdDollars * 100);
  const { result } = await cfApi<{ amount: number; threshold: number }>(
    env,
    "/ai-gateway/billing/topup/config",
    { method: "POST", body: JSON.stringify({ amount, threshold }) },
  );
  return {
    amount: centsToUsd(result.amount ?? amount),
    threshold: centsToUsd(result.threshold ?? threshold),
  };
}

/**
 * Removes the auto top-up configuration — the account stops auto-charging.
 *
 * @param env - Worker env
 */
export async function deleteTopupConfig(env: Env): Promise<void> {
  await cfApi(env, "/ai-gateway/billing/topup/config", { method: "DELETE" });
}

/**
 * Removes the account spending limit.
 *
 * @param env - Worker env
 *
 * @remarks Removing a limit *raises* the ceiling on spend. Cloudflare no longer
 * allows creating or modifying these limits through this API (POST returns 403),
 * so a removal here cannot be undone from Guardian — it must be recreated via
 * AI Gateway spend limits in the dashboard.
 */
export async function deleteSpendingLimit(env: Env): Promise<void> {
  await cfApi(env, "/ai-gateway/billing/spending-limit", { method: "DELETE" });
}

/** One AI Gateway with its routing / limit configuration. */
export type Gateway = {
  id: string;
  createdAt: string | null;
  modifiedAt: string | null;
  rateLimitingInterval: number | null;
  rateLimitingLimit: number | null;
  rateLimitingTechnique: string | null;
  cacheTtl: number | null;
  logManagement: number | null;
  collectLogs: boolean;
  authentication: boolean;
  retryMaxAttempts: number | null;
  retryDelay: number | null;
  workersAiBillingMode: string | null;
};

/**
 * Lists AI Gateways with their limit and caching configuration.
 *
 * @param env - Worker env
 * @returns Gateways sorted by id
 */
export async function listGateways(env: Env): Promise<Gateway[]> {
  const { result } = await cfApi<Record<string, any>[]>(env, "/ai-gateway/gateways");
  return (result ?? [])
    .map((g) => ({
      id: g.id,
      createdAt: g.created_at ?? null,
      modifiedAt: g.modified_at ?? null,
      rateLimitingInterval: g.rate_limiting_interval ?? null,
      rateLimitingLimit: g.rate_limiting_limit ?? null,
      rateLimitingTechnique: g.rate_limiting_technique ?? null,
      cacheTtl: g.cache_ttl ?? null,
      logManagement: g.log_management ?? null,
      collectLogs: Boolean(g.collect_logs),
      authentication: Boolean(g.authentication),
      retryMaxAttempts: g.retry_max_attempts ?? null,
      retryDelay: g.retry_delay ?? null,
      workersAiBillingMode: g.workers_ai_billing_mode ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Updates one gateway's rate limiting / caching configuration.
 *
 * @param env - Worker env
 * @param gatewayId - Gateway id
 * @param patch - Fields to change, in Cloudflare's snake_case shape
 * @returns The updated gateway
 */
export async function updateGateway(
  env: Env,
  gatewayId: string,
  patch: Record<string, unknown>,
): Promise<Gateway> {
  const { result } = await cfApi<Record<string, any>>(
    env,
    `/ai-gateway/gateways/${encodeURIComponent(gatewayId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return {
    id: result.id,
    createdAt: result.created_at ?? null,
    modifiedAt: result.modified_at ?? null,
    rateLimitingInterval: result.rate_limiting_interval ?? null,
    rateLimitingLimit: result.rate_limiting_limit ?? null,
    rateLimitingTechnique: result.rate_limiting_technique ?? null,
    cacheTtl: result.cache_ttl ?? null,
    logManagement: result.log_management ?? null,
    collectLogs: Boolean(result.collect_logs),
    authentication: Boolean(result.authentication),
    retryMaxAttempts: result.retry_max_attempts ?? null,
    retryDelay: result.retry_delay ?? null,
    workersAiBillingMode: result.workers_ai_billing_mode ?? null,
  };
}
