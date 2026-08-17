/**
 * @fileoverview AI Router recommendations — cheaper-model suggestions written
 * by `syncRouterRecommendations` (local heuristic today, Jules-dispatched
 * later). Lets an operator refresh the analysis and dismiss suggestions that
 * don't apply. Mounted below `<AiRouterConsole>` on `/dashboard/ai-router` as
 * its own island.
 */

"use client";

import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ResourceTable, type Column } from "@/components/storage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError, apiGet, apiSend } from "@/lib/api";

import { InlineError } from "./shared";

// --- Response types (mirror ai_router_recommendations schema) --------------

interface Recommendation {
  id: string;
  at: number;
  project: string;
  provider: string;
  model: string;
  suggestedProvider: string | null;
  suggestedModel: string | null;
  rationale: string;
  estMonthlySavingsUsd: number;
  source: "local" | "jules";
  julesSessionId: string | null;
  prUrl: string | null;
  status: "open" | "dispatched" | "pr_opened" | "dismissed";
}

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

const usd = (n: number) => `$${n.toFixed(2)}`;

function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 401) return "Sign in to view recommendations.";
  if (err instanceof ApiError) return err.message;
  return fallback;
}

export function AiRouterRecommendations() {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState<string | null>(null);
  const [rowNotice, setRowNotice] = useState<{ id: string; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ recommendations: Recommendation[] }>("/ai-router/recommendations");
      setRecommendations(res.recommendations);
      setReady(true);
    } catch (err) {
      setError(describeError(err, "Failed to load recommendations."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await apiSend("POST", "/ai-router/recommendations/refresh");
      await load();
    } catch (err) {
      setError(describeError(err, "Failed to refresh recommendations."));
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const dismiss = useCallback(
    async (id: string) => {
      setDismissing(id);
      setError(null);
      try {
        await apiSend("POST", "/ai-router/recommendations/" + encodeURIComponent(id) + "/dismiss");
        await load();
      } catch (err) {
        setError(describeError(err, "Failed to dismiss recommendation."));
      } finally {
        setDismissing(null);
      }
    },
    [load],
  );

  const sendToJules = useCallback(
    async (id: string) => {
      setDispatching(id);
      setRowNotice(null);
      try {
        await apiSend("POST", "/ai-router/recommendations/" + encodeURIComponent(id) + "/dispatch-jules");
        await load();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setRowNotice({ id, msg: "No repo mapping — advisory only." });
        } else {
          setError(describeError(err, "Failed to dispatch to Jules."));
        }
      } finally {
        setDispatching(null);
      }
    },
    [load],
  );

  if (error && !ready) {
    return <InlineError message={error} onRetry={() => void load()} />;
  }

  if (!ready) {
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" />
        Loading recommendations…
      </div>
    );
  }

  const columns: Column<Recommendation>[] = [
    {
      key: "project",
      header: "Project",
      sortValue: (r) => r.project,
      render: (r) => <span className="font-mono text-sm">{r.project}</span>,
    },
    {
      key: "current",
      header: "Current model",
      sortValue: (r) => `${r.provider}/${r.model}`,
      render: (r) => <span className="font-mono text-xs">{`${r.provider}/${r.model}`}</span>,
    },
    {
      key: "suggested",
      header: "Suggested model",
      sortValue: (r) => `${r.suggestedProvider ?? r.provider}/${r.suggestedModel ?? ""}`,
      render: (r) => (
        <span className="font-mono text-xs">
          {`${r.suggestedProvider ?? r.provider}/${r.suggestedModel ?? "—"}`}
        </span>
      ),
    },
    {
      key: "savings",
      header: "Est. monthly savings",
      align: "right",
      sortValue: (r) => r.estMonthlySavingsUsd,
      render: (r) => (
        <span className="font-mono text-xs tabular-nums">{usd(r.estMonthlySavingsUsd)}</span>
      ),
    },
    {
      key: "rationale",
      header: "Rationale",
      render: (r) => (
        <span className="line-clamp-1 max-w-xs text-xs text-muted-foreground" title={r.rationale}>
          {r.rationale}
        </span>
      ),
    },
    {
      key: "source",
      header: "Source",
      sortValue: (r) => r.source,
      render: (r) => (
        <Badge variant={r.source === "jules" ? "default" : "secondary"}>{r.source}</Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => r.status,
      render: (r) => (
        <Badge variant={r.status === "dismissed" ? "secondary" : "default"}>{r.status}</Badge>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => {
        if (r.status === "dispatched") {
          return (
            <div className="flex justify-end">
              {r.julesSessionId ? (
                <a
                  href={`https://jules.google.com/session/${r.julesSessionId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  <Badge variant="default">Dispatched to Jules</Badge>
                </a>
              ) : (
                <Badge variant="default">Dispatched to Jules</Badge>
              )}
            </div>
          );
        }

        if (r.status === "pr_opened") {
          return (
            <div className="flex items-center justify-end gap-2">
              <Badge variant="default">PR opened</Badge>
              {r.prUrl && (
                <a
                  href={r.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline"
                >
                  PR
                </a>
              )}
            </div>
          );
        }

        return (
          <div className="flex flex-col items-end gap-1">
            <div className="flex justify-end gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={dispatching === r.id}
                onClick={() => void sendToJules(r.id)}
              >
                {dispatching === r.id ? (
                  <span className="flex items-center gap-1">
                    <Loader2Icon className="size-3 animate-spin" />
                    Sending…
                  </span>
                ) : (
                  "Send to Jules"
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={dismissing === r.id}
                onClick={() => void dismiss(r.id)}
              >
                {dismissing === r.id ? <Loader2Icon className="size-3 animate-spin" /> : "Dismiss"}
              </Button>
            </div>
            {rowNotice?.id === r.id && (
              <span className="text-[11px] text-muted-foreground">{rowNotice.msg}</span>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            AI Router · Recommendations
          </div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Cheaper-model suggestions</h2>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="gap-2"
        >
          {refreshing ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-4" />
          )}
          {refreshing ? "Analyzing…" : "Refresh"}
        </Button>
      </header>

      {error && <p className={`${PANEL} text-sm text-destructive`}>{error}</p>}

      <ResourceTable
        rows={recommendations}
        columns={columns}
        loading={loading}
        rowKey={(r) => r.id}
        searchText={(r) => `${r.project} ${r.provider} ${r.model}`}
        initialSortKey="savings"
        empty="No recommendations yet — Refresh to analyze router usage."
      />
    </div>
  );
}

export default AiRouterRecommendations;
