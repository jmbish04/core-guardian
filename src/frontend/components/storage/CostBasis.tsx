/**
 * @fileoverview Cost-basis console — the scraped overage rates the spend calc
 * runs on, and how fresh each one is.
 *
 * Cloudflare has no pricing API; every rate here was scraped from a public
 * pricing doc (Browser Rendering) and is labelled with its scrape date so no
 * dollar figure is ever presented as authoritative when it is really an
 * estimate off a rate of unknown age.
 */

"use client";

import { Loader2Icon, RefreshCwIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { formatExact, relativeTime } from "@/lib/format";

type Rate = {
  product: string;
  metric: string;
  unitPrice: number;
  perUnits: number;
  currency: string;
  included: number | null;
  effectiveFrom: number;
};

type Run = {
  id: string;
  url: string;
  product: string;
  status: string;
  method: string;
  revisionsWritten: number;
  error: string | null;
  ranAt: number;
};

type Pricing = { rates: Rate[]; runs: Run[]; lastScrapedAt: number | null };

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

/** `$0.75 / 1M` rather than a bare float — perUnits carries the denominator. */
function priceLabel(r: Rate): string {
  const per =
    r.perUnits === 1
      ? "unit"
      : r.perUnits >= 1_000_000
        ? `${r.perUnits / 1_000_000}M`
        : r.perUnits >= 1_000
          ? `${r.perUnits / 1_000}k`
          : String(r.perUnits);
  return `$${r.unitPrice.toFixed(r.unitPrice < 0.01 ? 4 : 2)} / ${per}`;
}

const STATUS_TONE: Record<string, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  partial: "text-amber-600 dark:text-amber-400",
  failed: "text-rose-600 dark:text-rose-400",
};

export function CostBasis() {
  const [data, setData] = useState<Pricing | null>(null);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiGet<Pricing>("/guardian/pricing"));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view the cost basis."
          : err instanceof ApiError
            ? err.message
            : "Failed to load pricing.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function scrape() {
    setScraping(true);
    setNotice(null);
    setError(null);
    try {
      const r = await apiSend<{ docs: number; revisions: number }>(
        "POST",
        "/guardian/pricing/scrape",
      );
      setNotice(`Scraped ${r.docs} docs → ${r.revisions} rates.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Scrape failed.");
    } finally {
      setScraping(false);
    }
  }

  if (error && !data) return <p className={`${PANEL} text-sm text-muted-foreground`}>{error}</p>;
  if (loading && !data)
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" /> Loading cost basis…
      </div>
    );
  if (!data) return null;

  // Group rates by product for readability.
  const byProduct = new Map<string, Rate[]>();
  for (const r of data.rates) {
    (byProduct.get(r.product) ?? byProduct.set(r.product, []).get(r.product)!).push(r);
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Guardian · Cost basis
          </div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Scraped overage rates</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.lastScrapedAt
              ? `Last scraped ${relativeTime(data.lastScrapedAt)}. Rates re-check monthly on the cron.`
              : "Never scraped yet — run one to seed the catalog."}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void scrape()} disabled={scraping} className="gap-2">
          {scraping ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
          {scraping ? "Scraping…" : "Scrape now"}
        </Button>
      </header>

      {(error || notice) && (
        <p className={`${PANEL} text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}>
          {error ?? notice}
        </p>
      )}

      {data.rates.length === 0 ? (
        <div className={`${PANEL} text-sm text-muted-foreground`}>
          No rates yet. Cloudflare has no pricing API, so rates come from scraping the pricing docs
          — hit “Scrape now” to populate the catalog.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {[...byProduct.entries()].map(([product, rates]) => (
            <div key={product} className={PANEL}>
              <h3 className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
                {product}
              </h3>
              <ul className="mt-3 flex flex-col gap-2">
                {rates.map((r) => (
                  <li key={r.metric} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="truncate text-muted-foreground">{r.metric}</span>
                    <span className="shrink-0 font-mono text-xs tabular-nums">
                      {priceLabel(r)}
                      {r.included ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {formatExact(r.included)} free
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* --- Scrape health ---------------------------------------------------- */}
      <section className={PANEL}>
        <h3 className="text-base font-medium">Scrape runs</h3>
        <ul className="mt-3 flex flex-col gap-2">
          {data.runs.length === 0 && (
            <li className="text-sm text-muted-foreground">No scrape runs yet.</li>
          )}
          {data.runs.map((run) => (
            <li key={run.id} className="flex items-baseline justify-between gap-3 text-sm">
              <a
                href={run.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 truncate text-muted-foreground hover:text-foreground"
              >
                {run.product}
                <ExternalLinkIcon className="size-3 shrink-0" />
              </a>
              <span className="shrink-0 font-mono text-xs">
                <span className={STATUS_TONE[run.status] ?? "text-muted-foreground"}>
                  {run.status}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  · {run.method} · {run.revisionsWritten} rates · {relativeTime(run.ranAt)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
