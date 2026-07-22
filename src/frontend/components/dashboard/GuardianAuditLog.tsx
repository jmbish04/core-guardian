/**
 * @fileoverview Governance audit trail — the D1 `billing_events` table.
 *
 * Fetches `GET /api/guardian/events`. Two kinds of row land in this table:
 * mitigations executed from the panel (R2 lifecycle eviction, Vectorize drop)
 * and surge alerts recorded by the hourly cron. The outcome column is derived
 * from which kind it is — a mitigation row exists only because the Cloudflare
 * API call succeeded, whereas a surge row is a warning that nothing was done.
 *
 * Layout follows the shadcn "audit-log" table block, rebuilt on this repo's
 * local `@/components/ui` primitives.
 */

"use client";

import { AlertTriangleIcon, CircleCheckIcon, Loader2Icon, ShieldIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, apiGet } from "@/lib/api";
import { relativeTime, shortDate } from "@/lib/format";

type BillingEvent = {
  id: string;
  service: string;
  actionTaken: string;
  timestamp: number;
};

/**
 * Surge alerts are written by the cron with a known prefix; everything else is
 * a mitigation the operator executed.
 */
function isSurgeAlert(event: BillingEvent): boolean {
  return event.actionTaken.startsWith("Surge detected:");
}

function OutcomeBadge({ event }: { event: BillingEvent }) {
  if (isSurgeAlert(event)) {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 border-amber-500/30 text-amber-700 dark:text-amber-400"
      >
        <AlertTriangleIcon className="size-3" />
        Alerted
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="gap-1.5 border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
    >
      <CircleCheckIcon className="size-3" />
      Executed
    </Badge>
  );
}

export function GuardianAuditLog({ refreshKey = 0 }: { refreshKey?: number }) {
  const [events, setEvents] = useState<BillingEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ events: BillingEvent[] }>("/guardian/events", { limit: 50 });
      setEvents(data.events);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view the audit trail."
          : err instanceof ApiError
            ? err.message
            : "Failed to load the audit trail.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <ShieldIcon className="size-5 text-muted-foreground" />
            Audit trail
          </h2>
          <p className="text-sm text-muted-foreground">
            Every mitigation executed and every surge detected · {events.length} shown
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          className="gap-2"
        >
          {loading && <Loader2Icon className="size-4 animate-spin" />}
          Refresh
        </Button>
      </header>

      <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
        {error ? (
          <p className="p-4 text-sm text-muted-foreground">{error}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-44 ps-4">Time</TableHead>
                <TableHead className="w-40">Resource</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="w-36 pe-4">Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow
                  key={event.id}
                  className={isSurgeAlert(event) ? "bg-amber-500/[0.04]" : undefined}
                >
                  <TableCell className="ps-4 font-mono text-xs tabular-nums text-muted-foreground">
                    <div className="text-foreground/80">{relativeTime(event.timestamp)}</div>
                    <div>{shortDate(event.timestamp)}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{event.service}</TableCell>
                  <TableCell className="text-sm">{event.actionTaken}</TableCell>
                  <TableCell className="pe-4">
                    <OutcomeBadge event={event} />
                  </TableCell>
                </TableRow>
              ))}
              {events.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={4} className="p-6 text-center text-sm text-muted-foreground">
                    No governance events recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
