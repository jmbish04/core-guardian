/**
 * @fileoverview AlertsBell — global header alert affordance.
 *
 * A bell button with an unread-count badge that opens a popover listing the
 * active guardian alerts (`GET /api/guardian/alerts`), severity-first, each a
 * ReUI Alert row linking to the full board. Lives in the shared Header, so it
 * degrades quietly when unauthenticated (public pages 401 → no badge, no list).
 *
 * Read-only: this is the at-a-glance surface. Snooze/resolve stay on
 * `/dashboard/alerts` (`AlertsBoard`), which the footer links to.
 */

"use client";

import { BellIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/reui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ApiError, apiGet } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Severity = "info" | "warning" | "critical";
type GuardianAlert = {
  id: string;
  service: string;
  resource: string;
  worker: string | null;
  severity: Severity;
  cause: string;
  status: "active" | "snoozed" | "resolved";
  updatedAt: number;
};
type Payload = { alerts: GuardianAlert[] };

/** severity → ReUI Alert variant + badge color token. */
const SEV: Record<Severity, { variant: "destructive" | "warning" | "info"; badge: string; rank: number }> = {
  critical: { variant: "destructive", badge: "bg-destructive", rank: 3 },
  warning: { variant: "warning", badge: "bg-warning", rank: 2 },
  info: { variant: "info", badge: "bg-info", rank: 1 },
};

const MAX_ROWS = 6;

export function AlertsBell() {
  const [alerts, setAlerts] = useState<GuardianAlert[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [gated, setGated] = useState(false);

  useEffect(() => {
    let live = true;
    // Ask the server for active only — never pull the full alert history over the
    // wire to filter client-side (it grows unbounded). The endpoint already
    // returns these severity-first.
    apiGet<Payload>("/guardian/alerts?status=active")
      .then((p) => {
        if (!live) return;
        setAlerts(p.alerts);
      })
      .catch((err) => {
        if (!live) return;
        // Public/unauthenticated pages 401 — stay silent, don't surface an error.
        if (err instanceof ApiError && err.status === 401) setGated(true);
        setAlerts([]);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const count = alerts?.length ?? 0;
  const worst = alerts?.[0]?.severity;

  // On public pages there's nothing to show and no session — hide entirely.
  if (gated) return null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={count > 0 ? `Alerts (${count} active)` : "Alerts"}
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "relative size-8")}
          >
            <BellIcon className="size-5" />
            {count > 0 && (
              <span
                className={cn(
                  "absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-4 text-white",
                  worst ? SEV[worst].badge : "bg-destructive",
                )}
              >
                {count > 9 ? "9+" : count}
              </span>
            )}
          </button>
        }
      />
      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <span className="text-sm font-semibold">Alerts</span>
          {count > 0 && (
            <span className="text-xs text-muted-foreground">{count} active</span>
          )}
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              Loading…
            </div>
          ) : count === 0 ? (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground">All clear.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {alerts!.slice(0, MAX_ROWS).map((a) => (
                <a
                  key={a.id}
                  href="/dashboard/alerts"
                  aria-label={`${a.severity} alert: ${a.resource || a.service} — ${a.cause}`}
                  className="block"
                >
                  <Alert variant={SEV[a.severity].variant} className="hover:bg-muted/40">
                    <AlertTitle>{a.resource || a.service}</AlertTitle>
                    <AlertDescription>
                      <span className="line-clamp-1">{a.cause}</span>
                      <span className="text-xs text-muted-foreground/70">
                        {a.worker ? `${a.worker} · ` : ""}
                        {relativeTime(a.updatedAt)}
                      </span>
                    </AlertDescription>
                  </Alert>
                </a>
              ))}
            </div>
          )}
        </div>

        <a
          href="/dashboard/alerts"
          className="block border-t border-border/60 px-4 py-2.5 text-center text-xs font-medium text-primary hover:underline"
        >
          View all alerts
        </a>
      </PopoverContent>
    </Popover>
  );
}
