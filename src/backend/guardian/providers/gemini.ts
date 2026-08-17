/**
 * @fileoverview Gemini / Google AI spend — via the Cloud Billing **Budgets** API.
 *
 * Google exposes no per-API-key spend endpoint without a BigQuery billing
 * export. The keyless path that IS available is the Cloud Billing Budgets API:
 * `GET /v1/billingAccounts/{id}/budgets` returns each configured budget's
 * ceiling + threshold rules. So Gemini rows carry `metric: "budget"` (the
 * ceiling, not spend) and the alert layer never treats them as spend.
 *
 * Auth reuses the repo's Google service account (the same SA that does Drive),
 * minted for the `cloud-billing.readonly` scope with NO impersonation — the SA
 * itself must be granted `billing.budgets.get/list` on the billing account.
 * The billing account id (e.g. `012345-6789AB-CDEF01`) is read from the
 * `GCP_BILLING_ACCOUNT_ID` Secrets Store binding, falling back to a runtime
 * `gemini_billing_account_id` in `global_config`; absent → Gemini is skipped.
 *
 * @see https://cloud.google.com/billing/docs/reference/budget/rest
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { globalConfig } from "@/backend/db/schema";
import { getGoogleServiceAccountToken } from "@/backend/lib/google-drive";
import { getSecret, getSecretStoreBinding } from "@/backend/utils/secrets";

import { num, ProviderBillingError, ymd, type ProviderDailyCost } from "./types";

const BILLING_SCOPE = "https://www.googleapis.com/auth/cloud-billing.readonly";
const CONFIG_KEY = "gemini_billing_account_id";

type Budget = {
  displayName?: string;
  amount?: { specifiedAmount?: { currencyCode?: string; units?: string | number; nanos?: number } };
};

/**
 * Read the GCP billing account id — Secrets Store binding first
 * (`GCP_BILLING_ACCOUNT_ID`), then a runtime `global_config` override.
 */
async function billingAccountId(env: Env): Promise<string | null> {
  const secret =
    (await getSecretStoreBinding(env, "GCP_BILLING_ACCOUNT_ID")) ??
    getSecret(env, "GCP_BILLING_ACCOUNT_ID");
  if (secret && secret.trim()) return secret.trim();

  const [row] = await getDb(env)
    .select()
    .from(globalConfig)
    .where(eq(globalConfig.key, CONFIG_KEY))
    .limit(1);
  const v = row?.value;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Fetch each configured Gemini/GCP budget as a `metric: "budget"` row dated
 * today. Returns [] when no billing account id is configured. Throws on API
 * error.
 */
export async function fetchGeminiBudgets(env: Env, nowMs = Date.now()): Promise<ProviderDailyCost[]> {
  const account = await billingAccountId(env);
  if (!account) return [];

  const token = await getGoogleServiceAccountToken(env, BILLING_SCOPE, nowMs / 1000);
  const res = await fetch(
    `https://billingbudgets.googleapis.com/v1/billingAccounts/${encodeURIComponent(account)}/budgets`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await res.json().catch(() => null)) as {
    budgets?: Budget[];
    error?: { message?: string };
  } | null;
  if (!res.ok) {
    throw new ProviderBillingError("gemini", body?.error?.message ?? `HTTP ${res.status}`);
  }

  const day = ymd(nowMs);
  const out: ProviderDailyCost[] = [];
  for (const b of body?.budgets ?? []) {
    const amt = b.amount?.specifiedAmount;
    if (!amt) continue; // "last-period" budgets have no fixed amount — skip
    const units = num(amt.units) + (amt.nanos ?? 0) / 1e9;
    out.push({
      day,
      dimension: b.displayName ?? "budget",
      metric: "budget",
      costUsd: units,
      currency: amt.currencyCode ?? "USD",
      source: "gcp-budget",
    });
  }
  return out;
}
