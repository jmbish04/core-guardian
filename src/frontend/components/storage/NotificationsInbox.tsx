/**
 * @fileoverview Cloudflare notifications inbox — inbound billing alerts.
 *
 * Three parts: receiver provisioning status, the notification policies that
 * deliver to it, and the raw event log with expandable JSON payloads.
 *
 * Layout follows the shadcn "logs" table block — severity dot, timestamp,
 * alert type, message, expandable raw payload — rebuilt on this repo's local
 * `@/components/ui` primitives.
 */

"use client";

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  InboxIcon,
  Loader2Icon,
  PlugZapIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { relativeTime, shortDate } from "@/lib/format";

type WebhookEvent = {
  id: string;
  alertType: string;
  alertName: string | null;
  text: string | null;
  severity: string | null;
  accountId: string | null;
  payload: unknown;
  verified: boolean;
  receivedAt: number;
};

type Status = {
  provisioned: boolean;
  receiverUrl: string;
  destinations: { id: string; name: string; url: string | null }[];
  policies: { id: string; name: string; alertType: string; enabled: boolean }[];
};

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

/** Severity tint for the row dot. */
function severityTone(event: WebhookEvent): string {
  const s = (event.severity ?? "").toLowerCase();
  if (s.includes("critical") || s.includes("error")) return "bg-rose-500";
  if (s.includes("warn")) return "bg-amber-500";
  if (event.alertType.startsWith("billing_")) return "bg-amber-500";
  return "bg-sky-500";
}

/** One event row with an expandable raw payload. */
function EventRow({ event }: { event: WebhookEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border/40 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-foreground/[0.03]"
      >
        {open ? (
          <ChevronDownIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${severityTone(event)}`} />
        <span className="w-32 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {relativeTime(event.receivedAt)}
        </span>
        <span className="w-52 shrink-0 truncate font-mono text-xs">{event.alertType}</span>
        <span className="min-w-0 flex-1 truncate text-sm">
          {event.text ?? event.alertName ?? "(no message)"}
        </span>
        {!event.verified && (
          <Badge variant="outline" className="shrink-0 border-destructive/30 text-destructive">
            unverified
          </Badge>
        )}
      </button>
      {open && (
        <div className="px-4 pb-4 pl-14">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Raw payload · received {shortDate(event.receivedAt)}
          </div>
          <pre className="overflow-x-auto rounded-md border border-border/60 bg-foreground/[0.03] p-3 font-mono text-[11px] leading-relaxed">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function NotificationsInbox() {
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [budget, setBudget] = useState("100");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, e] = await Promise.all([
        apiGet<Status>("/alerting/status"),
        apiGet<{ events: WebhookEvent[] }>("/alerting/events", { limit: 100 }),
      ]);
      setStatus(s);
      setEvents(e.events);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view Cloudflare notifications."
          : err instanceof ApiError
            ? err.message
            : "Failed to load notifications.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function provision() {
    setNotice(null);
    try {
      const result = await apiSend<{ destinationId: string }>("POST", "/alerting/provision");
      setNotice(`Webhook destination created (${result.destinationId}).`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to provision the destination.");
    }
  }

  async function createBudgetPolicy() {
    const destination = status?.destinations.find((d) => d.name === "Core Guardian");
    if (!destination) {
      setError("Provision the webhook destination first.");
      return;
    }
    setNotice(null);
    try {
      await apiSend("POST", "/alerting/policies", {
        destinationId: destination.id,
        alertType: "billing_budget_alert",
        name: `Budget alert — $${budget}`,
        totalSpendDollars: Number(budget),
      });
      setNotice(`Budget alert created at $${budget}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create the policy.");
    }
  }

  if (error && !status) {
    return <p className={`${PANEL} text-sm text-muted-foreground`}>{error}</p>;
  }

  if (loading && !status) {
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" />
        Loading Cloudflare notifications…
      </div>
    );
  }

  const guardianDestination = status?.destinations.find((d) => d.name === "Core Guardian");
  const billingPolicies = status?.policies.filter((p) => p.alertType.startsWith("billing_")) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Cloudflare · Inbound notifications
          </div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Alert inbox</h2>
        </div>
        <Button
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
      </header>

      {(error || notice) && (
        <p className={`${PANEL} text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}>
          {error ?? notice}
        </p>
      )}

      {/* --- Receiver status -------------------------------------------------- */}
      <div className={PANEL}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {status?.provisioned && guardianDestination ? (
                <CheckCircle2Icon className="size-5 text-emerald-500" />
              ) : (
                <AlertTriangleIcon className="size-5 text-amber-500" />
              )}
              <h3 className="text-base font-medium">Webhook receiver</h3>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {status?.provisioned && guardianDestination
                ? "Provisioned. Cloudflare delivers alerts to this Worker and each payload is verified against the shared secret."
                : "Not provisioned. Cloudflare has nowhere to deliver billing alerts, and the receiver rejects everything until a secret exists."}
            </p>
            <p className="mt-2 font-mono text-xs break-all text-muted-foreground">
              {status?.receiverUrl}
            </p>
          </div>
          {!guardianDestination && (
            <Button onClick={() => void provision()} className="gap-2">
              <PlugZapIcon className="size-4" />
              Provision destination
            </Button>
          )}
        </div>
      </div>

      {/* --- Policies --------------------------------------------------------- */}
      <div className={PANEL}>
        <h3 className="text-base font-medium">Billing notification policies</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Cloudflare-side rules deciding which billing events get delivered here. Separate from
          Guardian&rsquo;s own alert rules, which evaluate usage telemetry.
        </p>

        <ul className="mt-3 flex flex-col gap-2">
          {billingPolicies.map((policy) => (
            <li key={policy.id} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate">{policy.name}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {policy.alertType} · {policy.enabled ? "enabled" : "disabled"}
              </span>
            </li>
          ))}
          {billingPolicies.length === 0 && (
            <li className="text-sm text-muted-foreground">No billing policies configured.</li>
          )}
        </ul>

        {guardianDestination && (
          <div className="mt-4 flex flex-col gap-3 border-t border-border/40 pt-4 sm:flex-row sm:items-end">
            <div className="flex flex-col gap-2">
              <Label htmlFor="budget-threshold">Budget alert threshold ($)</Label>
              <Input
                id="budget-threshold"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                inputMode="decimal"
                className="w-40 font-mono"
              />
            </div>
            <Button variant="outline" onClick={() => void createBudgetPolicy()}>
              Create budget alert
            </Button>
          </div>
        )}
      </div>

      {/* --- Event log -------------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <InboxIcon className="size-5 text-muted-foreground" />
          <h3 className="text-base font-medium">Received events</h3>
          <span className="font-mono text-xs text-muted-foreground">{events.length}</span>
        </div>

        <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
          {events.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No notifications received yet. Cloudflare sends a test payload when a destination is
              saved — if nothing arrives, the delivery path is not working.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
