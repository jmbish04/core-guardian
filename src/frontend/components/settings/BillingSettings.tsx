/**
 * @fileoverview BillingSettings — the Billing settings section.
 *
 * A ReUI `profile-8` adaptation (plan summary + usage metrics), wired to REAL
 * account data from `GET /api/guardian/allowances`: the current plan, the
 * billing period, and the included-allowance meters that actually drive the
 * bill. profile-8's invoice-history and payment-details cards are intentionally
 * dropped — Cloudflare exposes no invoice/payment API to this app, and the
 * cockpit never fabricates billing rows. Per-line billing detail lives on the
 * Accountant and Cost Basis pages, linked from the footer.
 */

"use client";

import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, apiGet } from "@/lib/api";
import { formatUsage, usd } from "@/lib/format";

type Allowance = {
  service: string;
  displayName: string;
  unit: string;
  comparable: boolean;
  reset: "monthly" | "daily";
  included: number;
  usedSoFar: number;
  projected: number;
  projectedFraction: number | null;
  remaining: number | null;
  overageCostUsd: number | null;
  note?: string;
};
type Payload = {
  plan: "free" | "paid";
  period: { monthStart: number; elapsedFraction: number };
  allowances: Allowance[];
};

/** tone by projected fraction — green under, amber near, rose over. */
function toneFor(frac: number | null): { bar: string; text: string } {
  if (frac == null) return { bar: "bg-muted-foreground/40", text: "text-muted-foreground" };
  if (frac >= 1) return { bar: "bg-destructive", text: "text-destructive" };
  if (frac >= 0.8) return { bar: "bg-warning", text: "text-warning" };
  return { bar: "bg-success", text: "text-success" };
}

function fmtDate(ms: number): string {
  // The period boundary is a UTC instant (start-of-month). Render it in UTC so a
  // western-timezone user doesn't see the reset date shifted a day early.
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function BillingSettings() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiGet<Payload>("/guardian/allowances")
      .then((p) => live && setData(p))
      .catch((err) => {
        if (!live) return;
        setError(
          err instanceof ApiError && err.status === 401
            ? "Sign in to view billing."
            : err instanceof ApiError
              ? err.message
              : "Failed to load billing.",
        );
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        Loading billing…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/4 px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return null;

  // Top allowances by how close to (or over) their included quota they run.
  const meters = [...data.allowances]
    .filter((a) => a.comparable && a.included > 0)
    .sort((a, b) => (b.projectedFraction ?? 0) - (a.projectedFraction ?? 0))
    .slice(0, 6);

  const nextReset = new Date(data.period.monthStart);
  nextReset.setUTCMonth(nextReset.getUTCMonth() + 1);

  return (
    <div className="flex flex-col gap-6">
      {/* Plan summary */}
      <Card className="gap-0 p-0">
        <CardHeader className="gap-4 px-5 py-5 sm:px-6">
          <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1fr)_minmax(10rem,13rem)]">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>Cloudflare Workers</CardTitle>
                <Badge
                  variant="outline"
                  className={
                    data.plan === "paid"
                      ? "border-success/30 bg-success/5 text-success"
                      : "border-info/30 bg-info/5 text-info"
                  }
                >
                  {data.plan === "paid" ? "Paid" : "Free"}
                </Badge>
              </div>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                Included allowances reset each period; usage past them bills at Cloudflare&apos;s
                published overage rates. This account watches the meters below and alerts before a
                line goes over.
              </p>
            </div>

            <dl className="grid gap-4 md:pl-4">
              <div className="space-y-0.5">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Period started
                </dt>
                <dd className="text-sm font-medium">{fmtDate(data.period.monthStart)}</dd>
              </div>
              <div className="space-y-0.5">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Resets
                </dt>
                <dd className="text-sm font-medium">
                  {fmtDate(nextReset.getTime())}
                  <span className="ml-1.5 text-muted-foreground">
                    · {Math.round(data.period.elapsedFraction * 100)}% elapsed
                  </span>
                </dd>
              </div>
            </dl>
          </div>
        </CardHeader>

        <CardFooter className="flex-col items-start gap-2 border-t px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="max-w-xl text-sm text-muted-foreground">
            Line-by-line billing detail lives on the Accountant and Cost Basis pages.
          </p>
          <div className="flex items-center gap-3 text-sm font-medium text-primary">
            <a href="/dashboard/accountant" className="hover:underline">
              Accountant
            </a>
            <a href="/dashboard/cost-basis" className="hover:underline">
              Cost Basis
            </a>
          </div>
        </CardFooter>
      </Card>

      {/* Usage meters — real included-allowance consumption */}
      <Card className="gap-0 p-0">
        <CardHeader className="px-5 py-4 sm:px-6">
          <CardTitle className="text-base">Included allowance usage</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-0 p-0 sm:grid-cols-2 sm:divide-x [&>*]:border-b [&>*]:border-border/60 sm:[&>*:nth-last-child(-n+2)]:border-b-0">
          {meters.length === 0 ? (
            <div className="col-span-full px-6 py-8 text-center text-sm text-muted-foreground">
              No comparable allowance meters this period.
            </div>
          ) : (
            meters.map((a) => {
              const frac = a.projectedFraction ?? 0;
              const tone = toneFor(a.projectedFraction);
              return (
                <div key={a.service} className="flex flex-col gap-2 px-5 py-4 sm:px-6">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{a.displayName}</span>
                    <span className={`text-xs font-semibold tabular-nums ${tone.text}`}>
                      {Math.round(frac * 100)}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full ${tone.bar}`}
                      style={{ width: `${Math.min(100, frac * 100)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="tabular-nums">
                      {formatUsage(a.unit, a.usedSoFar)} / {formatUsage(a.unit, a.included)}
                    </span>
                    {a.overageCostUsd != null && a.overageCostUsd > 0 && (
                      <span className="font-medium text-destructive">
                        +{usd(a.overageCostUsd)} over
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
