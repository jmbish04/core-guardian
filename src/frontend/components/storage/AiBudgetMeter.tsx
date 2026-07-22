/**
 * @fileoverview AI budget meter — the native-proxy spend breaker as a quota.
 *
 * Reads /api/ai/budget and renders the monthly rolling AI spend against the cap
 * as a UsageQuotaMeter (tone reddens as it approaches the cap), showing the
 * breaker state. This is the UI for the 0190 KV circuit breaker.
 */

"use client";

import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { UsageQuotaMeter, toneForFraction } from "@/components/charts";
import { ApiError, apiGet } from "@/lib/api";

type Budget = {
  cap: number | null;
  spent: number;
  remaining: number | null;
  breaker: "armed" | "tripped" | "break-glass";
  breakGlassUntil: number | null;
  month: string;
};

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

export function AiBudgetMeter() {
  const [b, setB] = useState<Budget | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setB(await apiGet<Budget>("/ai/budget"));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? null : "Failed to load AI budget.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return null;
  if (!b) return error ? <p className={`${PANEL} text-sm text-muted-foreground`}>{error}</p> : null;

  const fraction = b.cap && b.cap > 0 ? b.spent / b.cap : 0;
  const pct = Math.round(fraction * 100);
  const breakerLabel =
    b.breaker === "tripped" ? "Breaker TRIPPED" : b.breaker === "break-glass" ? "Break-glass active" : "Armed";

  return (
    <UsageQuotaMeter
      meterLabel="AI spend (native proxy)"
      meterCaption={`${b.month.replace("ai:cost:", "")} · breaker ${breakerLabel}`}
      percent={pct}
      used={`$${b.spent.toFixed(2)}`}
      limit={b.cap !== null ? `$${b.cap.toFixed(2)}` : "no cap"}
      unitLabel="of cap"
      tone={b.breaker === "tripped" ? "rose" : toneForFraction(fraction)}
      facts={[
        { label: "Remaining", value: b.remaining !== null ? `$${b.remaining.toFixed(2)}` : "—" },
        { label: "Breaker", value: breakerLabel },
        {
          label: "Break-glass",
          value: b.breakGlassUntil ? new Date(b.breakGlassUntil).toISOString().slice(0, 10) : "off",
        },
      ]}
    />
  );
}
