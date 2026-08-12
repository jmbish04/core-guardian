/**
 * @fileoverview AI Router usage-by-project — cost-by-project bar chart, a
 * cost-descending project rollup table, and a per-project model drill.
 *
 * Answers "why is AI spend high — which project?" `ai_router_requests` is the
 * only table carrying a `project` dimension, so this view is router-only —
 * correct for attribution, not a total-spend figure. Mounted above
 * `<AiRouterConsole>` on `/dashboard/ai-router` as its own island (that one is
 * already large).
 */

"use client";

import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";

import { ResourceTable, type Column } from "@/components/storage";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError, apiGet } from "@/lib/api";

import { InlineError } from "./shared";

// --- Response types (mirror guardian/ai-router-usage.ts) -------------------

interface ProjectUsage {
  project: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  errors: number;
  breakers: number;
}

interface ModelUsage {
  provider: string;
  model: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

const DAY_OPTIONS = [7, 30, 90] as const;

/** The five OKLCH palette hues exposed in global.css as `--chart-1..5`. */
const PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

const CHART_CONFIG = {
  costUsd: { label: "Cost" },
} satisfies ChartConfig;

const usd = (n: number) => `$${n.toFixed(2)}`;

export function AiRouterUsage() {
  const [days, setDays] = useState(30);
  const [projects, setProjects] = useState<ProjectUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [drillProject, setDrillProject] = useState<string | null>(null);
  const [models, setModels] = useState<ModelUsage[]>([]);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState<string | null>(null);

  const reqSeq = useRef(0);
  const drillSeq = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const seq = ++reqSeq.current;
    try {
      const end = Math.floor(Date.now() / 60_000) * 60_000;
      const start = end - days * 86_400_000;
      const res = await apiGet<{ projects: ProjectUsage[] }>("/ai-router/usage", { start, end });
      if (seq === reqSeq.current) {
        setProjects(res.projects);
        setReady(true);
      }
    } catch (err) {
      if (seq === reqSeq.current) {
        setError(
          err instanceof ApiError && err.status === 401
            ? "Sign in to view usage."
            : err instanceof ApiError
              ? err.message
              : "Failed to load AI Router usage.",
        );
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  // Close the drill dialog on range change so it can't show a stale range.
  useEffect(() => {
    setDrillProject(null);
  }, [days]);

  const openDrill = useCallback(
    async (project: string) => {
      setDrillProject(project);
      setDrillLoading(true);
      setDrillError(null);
      setModels([]);
      const seq = ++drillSeq.current;
      try {
        const end = Math.floor(Date.now() / 60_000) * 60_000;
        const start = end - days * 86_400_000;
        const res = await apiGet<{ models: ModelUsage[] }>(
          "/ai-router/usage/" + encodeURIComponent(project),
          { start, end },
        );
        if (seq === drillSeq.current) setModels(res.models);
      } catch (err) {
        if (seq === drillSeq.current) {
          setDrillError(
            err instanceof ApiError && err.status === 401
              ? "Sign in to view usage."
              : err instanceof ApiError
                ? err.message
                : "Failed to load model breakdown.",
          );
        }
      } finally {
        if (seq === drillSeq.current) setDrillLoading(false);
      }
    },
    [days],
  );

  if (error && !ready) {
    return <InlineError message={error} onRetry={() => void load()} />;
  }

  if (!ready) {
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" />
        Loading AI Router usage…
      </div>
    );
  }

  const top = projects.slice(0, 10);

  const columns: Column<ProjectUsage>[] = [
    {
      key: "project",
      header: "Project",
      sortValue: (r) => r.project,
      render: (r) => <span className="font-mono text-sm">{r.project}</span>,
    },
    {
      key: "requests",
      header: "Requests",
      align: "right",
      sortValue: (r) => r.requests,
      render: (r) => (
        <span className="font-mono text-xs tabular-nums">{r.requests.toLocaleString()}</span>
      ),
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      sortValue: (r) => r.tokensIn + r.tokensOut,
      render: (r) => (
        <span className="font-mono text-xs tabular-nums">
          {r.tokensIn.toLocaleString()}
          <span className="text-muted-foreground"> / {r.tokensOut.toLocaleString()}</span>
        </span>
      ),
    },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      sortValue: (r) => r.costUsd,
      render: (r) => <span className="font-mono text-xs tabular-nums">{usd(r.costUsd)}</span>,
    },
    {
      key: "errorRate",
      header: "Error %",
      align: "right",
      sortValue: (r) => (r.requests > 0 ? r.errors / r.requests : 0),
      render: (r) => (
        <span className="font-mono text-xs tabular-nums">
          {r.requests > 0 ? `${((r.errors / r.requests) * 100).toFixed(1)}%` : "—"}
        </span>
      ),
    },
    {
      key: "breakers",
      header: "Breakers",
      align: "right",
      sortValue: (r) => r.breakers,
      render: (r) => <span className="font-mono text-xs tabular-nums">{r.breakers}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => void openDrill(r.project)}
        >
          Models
        </Button>
      ),
    },
  ];

  const modelColumns: Column<ModelUsage>[] = [
    {
      key: "model",
      header: "Provider / model",
      sortValue: (r) => `${r.provider}/${r.model}`,
      render: (r) => (
        <span className="font-mono text-xs">
          <span className="text-muted-foreground">{r.provider}/</span>
          {r.model}
        </span>
      ),
    },
    {
      key: "requests",
      header: "Requests",
      align: "right",
      sortValue: (r) => r.requests,
      render: (r) => (
        <span className="font-mono text-xs tabular-nums">{r.requests.toLocaleString()}</span>
      ),
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      sortValue: (r) => r.tokensIn + r.tokensOut,
      render: (r) => (
        <span className="font-mono text-xs tabular-nums">
          {r.tokensIn.toLocaleString()}
          <span className="text-muted-foreground"> / {r.tokensOut.toLocaleString()}</span>
        </span>
      ),
    },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      sortValue: (r) => r.costUsd,
      render: (r) => <span className="font-mono text-xs tabular-nums">{usd(r.costUsd)}</span>,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            AI Router · Usage
          </div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Spend by project</h2>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="ai-router-usage-range" className="text-xs text-muted-foreground">
              Range
            </Label>
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger id="ai-router-usage-range" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAY_OPTIONS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            className="gap-2"
          >
            {loading ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-4" />
            )}
            Refresh
          </Button>
        </div>
      </header>

      {error && <p className={`${PANEL} text-sm text-destructive`}>{error}</p>}

      {/* --- Cost-by-project bar chart ------------------------------------ */}
      <section className={PANEL}>
        <h3 className="text-base font-medium">Spend by project (last {days} days)</h3>
        {top.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            No AI Router requests recorded in this window.
          </p>
        ) : (
          <ChartContainer
            config={CHART_CONFIG}
            className="mt-4 aspect-auto h-[max(240px,theme(spacing.10)*var(--rows))] w-full"
            style={{ ["--rows" as string]: top.length }}
          >
            <BarChart data={top} layout="vertical" margin={{ left: 4, right: 16, top: 4, bottom: 4 }}>
              <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tick={{ fill: "hsl(var(--foreground))", fontSize: 11 }}
                tickFormatter={(v) => usd(Number(v))}
              />
              <YAxis
                type="category"
                dataKey="project"
                tickLine={false}
                axisLine={false}
                width={120}
                tick={{ fill: "hsl(var(--foreground))", fontSize: 11 }}
              />
              <ChartTooltip content={<ChartTooltipContent formatter={(v) => usd(Number(v))} />} />
              <Bar dataKey="costUsd" radius={[0, 4, 4, 0]}>
                {top.map((row, i) => (
                  <Cell key={row.project} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </section>

      {/* --- Project rollup table ------------------------------------------ */}
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-medium">Projects ({projects.length})</h3>
        <ResourceTable
          rows={projects}
          columns={columns}
          loading={loading}
          rowKey={(r) => r.project}
          searchText={(r) => r.project}
          initialSortKey="cost"
          empty="No AI Router requests recorded in this window."
        />
      </section>

      {/* --- Model drill ----------------------------------------------------- */}
      <Dialog
        open={drillProject !== null}
        onOpenChange={(open) => {
          if (!open) setDrillProject(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Models · {drillProject}</DialogTitle>
            <DialogDescription>
              Provider/model breakdown for <span className="font-mono">{drillProject}</span> over the
              last {days} days.
            </DialogDescription>
          </DialogHeader>

          {drillError ? (
            <InlineError
              message={drillError}
              onRetry={() => drillProject && void openDrill(drillProject)}
            />
          ) : drillLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              Loading models…
            </div>
          ) : (
            <ResourceTable
              rows={models}
              columns={modelColumns}
              rowKey={(r) => `${r.provider}/${r.model}`}
              searchText={(r) => `${r.provider} ${r.model}`}
              initialSortKey="cost"
              empty="No requests for this project in this window."
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default AiRouterUsage;
