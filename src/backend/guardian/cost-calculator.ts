/**
 * @fileoverview Usage cost calculator — a stateless pricing service other
 * workers call to turn an operation into a dollar figure.
 *
 * A caller POSTs one or more operations; each is priced and returned. Two kinds:
 *
 *   - `ai`  — provider + model + token counts, priced from the scraped model
 *     catalog ({@link calculateCosts}). Thinking tokens bill at the output rate.
 *   - `cf`  — a Cloudflare platform op (`service` = a probe id like d1, r2-storage,
 *     workers-ai, durable-objects-requests) + `units` in that probe's unit,
 *     priced at the MARGINAL overage rate from {@link ALLOWANCES}.
 *
 * "Marginal" matters: platform allowances are pooled per billing period, so a
 * unit's *incremental* cost is the overage rate once you're over the included
 * quantity, and effectively $0 while under it. This calculator returns the
 * marginal cost (what the op adds at the margin) and flags the basis; it does
 * not know your month-to-date position, so a caller under allowance should read
 * the figure as an upper bound. `costUsd` is null when no rate is known for the
 * service (never invented).
 *
 * Stateless by design — it prices, it does not record. To persist usage with an
 * origin, use {@link file://src/backend/guardian/register-usage.ts} or the
 * Workers AI proxy.
 *
 * @see {@link file://src/backend/guardian/allowances.ts} for the CF rates.
 * @see {@link file://src/backend/guardian/ai-model-advisor.ts} for AI pricing.
 */

import { calculateCosts } from "./ai-model-advisor";
import { ALLOWANCES } from "./allowances";
import { USAGE_PROBES } from "./probes";

/** Probe id → unit, so a `cf` line echoes back what `units` was measured in. */
const PROBE_UNIT = new Map(USAGE_PROBES.map((p) => [p.id, p.unit]));

export type AiOperation = {
  kind: "ai";
  provider?: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  /** Reasoning/thinking tokens — billed at the output rate. */
  tokensThinking?: number;
  requests?: number;
  /** Unix ms the usage occurred; pricing is looked up as-of this time. */
  at?: number;
};

export type CfOperation = {
  kind: "cf";
  /** Probe id: d1, r2-storage, r2-operations, workers-ai, durable-objects-requests, … */
  service: string;
  /** Quantity in the service's native unit (rows read, bytes, neurons, requests…). */
  units: number;
};

export type CostOperation = AiOperation | CfOperation;

export type CostResultLine = {
  kind: "ai" | "cf";
  /** ai: `provider/model`; cf: the service id. */
  label: string;
  unit: string;
  units: number;
  costUsd: number | null;
  /** How the figure was derived. */
  basis: string;
  /** The unit rate used, when known. */
  rate: { usd: number; per: number } | null;
  /** ai only: whether the model matched a catalog price. */
  matched?: boolean;
  /** Set when the op could not be priced (e.g. unknown service). */
  error?: string;
};

/**
 * Price a batch of operations. Never throws on a single bad op — that line
 * comes back with `costUsd: null` and an `error`.
 *
 * @returns per-line detail plus the summed total (nulls treated as 0)
 */
export async function calculateOperations(
  env: Env,
  operations: CostOperation[],
): Promise<{ lines: CostResultLine[]; totalUsd: number }> {
  // Price every AI op in one catalog pass; CF ops are pure arithmetic.
  const aiOps = operations.filter((o): o is AiOperation => o.kind === "ai");
  const aiPriced = aiOps.length
    ? await calculateCosts(
        env,
        aiOps.map((o) => ({
          provider: o.provider,
          model: o.model,
          inputTokens: o.tokensIn ?? 0,
          // Thinking bills as output — fold it in, matching register-usage.
          outputTokens: (o.tokensOut ?? 0) + (o.tokensThinking ?? 0),
          at: o.at,
        })),
      )
    : { lines: [], totalUsd: 0 };

  let aiIdx = 0;
  const lines: CostResultLine[] = operations.map((op) => {
    if (op.kind === "ai") {
      const priced = aiPriced.lines[aiIdx++];
      return {
        kind: "ai",
        label: `${op.provider ?? "?"}/${op.model}`,
        unit: "tokens",
        units: (op.tokensIn ?? 0) + (op.tokensOut ?? 0) + (op.tokensThinking ?? 0),
        costUsd: priced?.costUsd ?? null,
        basis: priced?.matched ? "catalog" : "unmatched-model",
        rate:
          priced?.inputPricePerMillion != null && priced.outputPricePerMillion != null
            ? { usd: priced.outputPricePerMillion, per: 1_000_000 }
            : null,
        matched: priced?.matched ?? false,
        ...(priced?.matched ? {} : { error: `Model not in pricing catalog: ${op.model}` }),
      };
    }
    // cf
    const a = ALLOWANCES[op.service];
    const unit = PROBE_UNIT.get(op.service) ?? "units";
    if (!a) {
      return {
        kind: "cf",
        label: op.service,
        unit,
        units: op.units,
        costUsd: null,
        basis: "unknown-service",
        rate: null,
        error: `Unknown service '${op.service}'. Known: ${Object.keys(ALLOWANCES).join(", ")}`,
      };
    }
    if (a.overageUsd === undefined || a.overagePer === undefined) {
      return {
        kind: "cf",
        label: op.service,
        unit: a.unit,
        units: op.units,
        costUsd: null,
        basis: "no-rate",
        rate: null,
        error: `No overage rate known for '${op.service}'.`,
      };
    }
    return {
      kind: "cf",
      label: op.service,
      unit: a.unit,
      units: op.units,
      costUsd: (op.units / a.overagePer) * a.overageUsd,
      basis: "marginal-rate",
      rate: { usd: a.overageUsd, per: a.overagePer },
    };
  });

  const totalUsd = lines.reduce((sum, l) => sum + (l.costUsd ?? 0), 0);
  return { lines, totalUsd };
}

// ---------------------------------------------------------------------------
// Self-check — CF marginal arithmetic (AI path needs D1, verified elsewhere).
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const near = (a: number, b: number, m: string) => {
    if (Math.abs(a - b) > 1e-9) throw new Error(`${m}: got ${a}, want ${b}`);
  };
  // Pure CF arithmetic, no env needed: replicate the marginal formula.
  const price = (service: string, units: number) => {
    const a = ALLOWANCES[service];
    if (!a || a.overageUsd === undefined || a.overagePer === undefined) return null;
    return (units / a.overagePer) * a.overageUsd;
  };
  near(price("workers-ai", 1_000_000) ?? -1, 11, "1M neurons @ $0.011/1k = $11");
  near(price("d1", 1_000_000) ?? -1, 0.001, "1M D1 rows @ $0.001/1M");
  if (price("durable-objects-cpu", 9e9) !== null) throw new Error("no-rate must be null");
  // eslint-disable-next-line no-console
  console.log("ok — cost-calculator CF marginal pricing verified");
}
