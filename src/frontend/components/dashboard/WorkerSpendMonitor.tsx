/**
 * @fileoverview Per-worker spend monitor — Cloudflare compute + AI-provider cost.
 *
 * Renders /api/guardian/worker/{name}/spend: the worker's Cloudflare usage
 * (requests, subrequests, errors, CPU quantiles) and its AI-Gateway upstream
 * cost by provider/model. When the worker isn't routing AI through the gateway
 * (routed:false) it calls that out plainly — provider billing is invisible
 * Cloudflare-side until the calls flow through the gateway (or the native AI
 * proxy).
 */

"use client";

import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiError, apiGet } from "@/lib/api";
import { formatExact } from "@/lib/format";

type Spend = {
  worker: string;
  gateway: string;
  windowHours: number;
  cloudflare: {
    requests: number;
    errors: number;
    subrequests: number;
    cpuTimeP50Us: number | null;
    cpuTimeP99Us: number | null;
  };
  ai: {
    routed: boolean;
    upstreamCostUsd: number;
    requests: number;
    tokensIn: number;
    tokensOut: number;
    byModel: { provider: string; model: string; costUsd: number; tokensIn: number; tokensOut: number }[];
  };
};

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

function ms(us: number | null): string {
  return us === null ? "—" : `${(us / 1000).toFixed(1)} ms`;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={PANEL}>
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function WorkerSpendMonitor({
  worker,
  gateway,
  title,
}: {
  worker: string;
  gateway?: string;
  title?: string;
}) {
  const [data, setData] = useState<Spend | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const q = gateway ? `?gateway=${encodeURIComponent(gateway)}` : "";
      setData(await apiGet<Spend>(`/guardian/worker/${encodeURIComponent(worker)}/spend${q}`));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view worker spend."
          : err instanceof ApiError
            ? err.message
            : "Failed to load worker spend.",
      );
    } finally {
      setLoading(false);
    }
  }, [worker, gateway]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data)
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" /> Loading {worker} spend…
      </div>
    );
  if (!data) return error ? <p className={`${PANEL} text-sm text-muted-foreground`}>{error}</p> : null;

  const days = Math.round(data.windowHours / 24);
  const errRate = data.cloudflare.requests > 0 ? (data.cloudflare.errors / data.cloudflare.requests) * 100 : 0;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Worker spend · {data.worker}
          </div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">{title ?? data.worker}</h2>
        </div>
        <span className="font-mono text-xs text-muted-foreground">last {days}d</span>
      </header>

      {/* Cloudflare compute */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Requests" value={formatExact(data.cloudflare.requests)} sub={`${days}d`} />
        <Stat label="Subrequests" value={formatExact(data.cloudflare.subrequests)} />
        <Stat label="Errors" value={formatExact(data.cloudflare.errors)} sub={`${errRate.toFixed(2)}% rate`} />
        <Stat label="CPU p50 / p99" value={ms(data.cloudflare.cpuTimeP50Us)} sub={`p99 ${ms(data.cloudflare.cpuTimeP99Us)}`} />
      </div>

      {/* AI provider spend */}
      {data.ai.routed ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="AI upstream cost" value={`$${data.ai.upstreamCostUsd.toFixed(4)}`} sub={`gateway: ${data.gateway}`} />
            <Stat label="AI requests" value={formatExact(data.ai.requests)} />
            <Stat label="Tokens in" value={formatExact(data.ai.tokensIn)} />
            <Stat label="Tokens out" value={formatExact(data.ai.tokensOut)} />
          </div>
          {data.ai.byModel.length > 0 && (
            <div className={PANEL}>
              <h3 className="text-base font-medium">AI cost by model</h3>
              <ul className="mt-3 flex flex-col gap-2">
                {data.ai.byModel.slice(0, 10).map((m) => (
                  <li key={`${m.provider}:${m.model}`} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="truncate font-mono text-xs">
                      <span className="text-muted-foreground">{m.provider}</span> {m.model}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums">
                      <span className="text-muted-foreground">
                        {formatExact(m.tokensIn)}→{formatExact(m.tokensOut)} tok ·{" "}
                      </span>
                      ${m.costUsd.toFixed(4)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className={`${PANEL} ring-1 ring-amber-500/25`}>
          <div className="flex items-start gap-3">
            <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <h3 className="text-base font-medium">AI provider billing not visible</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                <span className="font-mono">{data.worker}</span> is not routing its AI calls through the{" "}
                <span className="font-mono">{data.gateway}</span> AI Gateway, so its provider spend
                (OpenAI / Anthropic / Google) is invisible on the Cloudflare side — it lives only on the
                provider's own dashboard. Route its calls through the <span className="font-mono">{data.gateway}</span>{" "}
                gateway (or the native AI proxy at <span className="font-mono">/api/ai/*</span>) to meter and
                cap the cost here.
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
