/**
 * @fileoverview AI Gateway billing console — the only Cloudflare surface that
 * reports actual dollars.
 *
 * Shows credit balance, payment method, auto top-up state, the enforced
 * spending limit, the draft invoice broken down by model, and per-gateway rate
 * limit / cache configuration. Auto top-up can be set or disabled here; the
 * spending limit can only be removed (Cloudflare no longer allows creating or
 * modifying limits through this API).
 *
 * Deliberately absent: a manual top-up button. That endpoint charges the card
 * on file, and a spend governor should not be able to spend.
 */

"use client";

import { AlertTriangleIcon, ExternalLinkIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { relativeTime } from "@/lib/format";

import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { ResourceTable, type Column } from "./ResourceTable";

type Billing = {
  balance: {
    balance: number;
    hasDefaultPaymentMethod: boolean;
    paymentMethod: { brand: string | null; last4: string | null };
    topupConfig: {
      amount: number;
      threshold: number;
      disabledReason: string | null;
      error: string | null;
      lastFailedAt: number | null;
    };
    firstTopupSuccess: boolean | null;
  };
  spendingLimit: {
    enabled: boolean;
    amount: number;
    duration: string | null;
    strategy: string | null;
  };
  invoicePreview: {
    amountDue: number;
    amountRemaining: number;
    currency: string;
    status: string | null;
    periodStart: number | null;
    periodEnd: number | null;
    lines: { description: string; amount: number; quantity: number; unitAmount: string | null }[];
  };
};

type Gateway = {
  id: string;
  rateLimitingLimit: number | null;
  rateLimitingInterval: number | null;
  rateLimitingTechnique: string | null;
  cacheTtl: number | null;
  logManagement: number | null;
  collectLogs: boolean;
  authentication: boolean;
  modifiedAt: string | null;
};

type Invoice = {
  id: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: number | null;
  description: string | null;
  origin: string | null;
  pdfUrl: string | null;
};

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

/**
 * The API returns every AI Gateway money value in dollars — Cloudflare's raw
 * cents are converted at the backend boundary (`guardian/ai-gateway.ts`), so
 * one formatter covers all of them. Rendering the raw cents is what made a
 * $6.40 balance read as "$640".
 */
const usd = (n: number) => `$${n.toFixed(2)}`;

export function AiGatewayBilling() {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemoveLimit, setConfirmRemoveLimit] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);

  const [topupAmount, setTopupAmount] = useState("");
  const [topupThreshold, setTopupThreshold] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, g, inv] = await Promise.all([
        apiGet<Billing>("/ai-gateway/billing"),
        apiGet<{ gateways: Gateway[] }>("/ai-gateway/gateways"),
        apiGet<{ invoices: Invoice[] }>("/ai-gateway/billing/invoices"),
      ]);
      setBilling(b);
      setGateways(g.gateways);
      setInvoices(inv.invoices);
      setTopupAmount(
        b.balance.topupConfig.amount ? String(b.balance.topupConfig.amount) : "",
      );
      setTopupThreshold(
        b.balance.topupConfig.threshold ? String(b.balance.topupConfig.threshold) : "",
      );
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view AI Gateway billing."
          : err instanceof ApiError
            ? err.message
            : "Failed to load billing.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveTopup() {
    setNotice(null);
    try {
      await apiSend("POST", "/ai-gateway/billing/topup-config", {
        amount: Number(topupAmount),
        threshold: Number(topupThreshold),
      });
      setNotice("Auto top-up updated.");
      setTopupOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update auto top-up.");
    }
  }

  async function disableTopup() {
    setNotice(null);
    try {
      await apiSend("DELETE", "/ai-gateway/billing/topup-config");
      setNotice("Auto top-up disabled.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to disable auto top-up.");
    }
  }

  async function removeSpendingLimit() {
    await apiSend("DELETE", "/ai-gateway/billing/spending-limit", {
      confirm: "remove spending limit",
    });
    setNotice("Spending limit removed.");
    await load();
  }

  if (error && !billing) {
    return <p className={`${PANEL} text-sm text-muted-foreground`}>{error}</p>;
  }

  if (loading && !billing) {
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" />
        Loading AI Gateway billing…
      </div>
    );
  }
  if (!billing) return null;

  const { balance, spendingLimit, invoicePreview } = billing;
  const topupOn = balance.topupConfig.amount > 0 && balance.topupConfig.threshold > 0;

  const gatewayColumns: Column<Gateway>[] = [
    {
      key: "id",
      header: "Gateway",
      sortValue: (g) => g.id,
      render: (g) => <span className="font-mono text-sm">{g.id}</span>,
    },
    {
      key: "rate",
      header: "Rate limit",
      sortValue: (g) => g.rateLimitingLimit ?? 0,
      render: (g) =>
        g.rateLimitingLimit ? (
          <span className="font-mono text-xs">
            {g.rateLimitingLimit}/{g.rateLimitingInterval}s
            <span className="text-muted-foreground"> · {g.rateLimitingTechnique}</span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/60">none</span>
        ),
    },
    {
      key: "cache",
      header: "Cache TTL",
      align: "right",
      sortValue: (g) => g.cacheTtl ?? 0,
      render: (g) => (
        <span className="font-mono text-xs tabular-nums">
          {g.cacheTtl ? `${g.cacheTtl}s` : "—"}
        </span>
      ),
    },
    {
      key: "logs",
      header: "Log retention",
      align: "right",
      sortValue: (g) => g.logManagement ?? 0,
      render: (g) => (
        <span className="font-mono text-xs tabular-nums">
          {g.logManagement ? g.logManagement.toLocaleString() : "—"}
        </span>
      ),
    },
    {
      key: "modified",
      header: "Modified",
      sortValue: (g) => g.modifiedAt ?? "",
      render: (g) => (
        <span className="text-xs text-muted-foreground">
          {g.modifiedAt ? relativeTime(g.modifiedAt.replace(" ", "T") + "Z") : "—"}
        </span>
      ),
    },
  ];

  const invoiceColumns: Column<Invoice>[] = [
    {
      key: "created",
      header: "Date",
      sortValue: (i) => i.created ?? 0,
      render: (i) => (
        <span className="font-mono text-xs text-muted-foreground">
          {i.created ? relativeTime(i.created * 1000) : "—"}
        </span>
      ),
    },
    {
      key: "id",
      header: "Invoice",
      render: (i) => <span className="font-mono text-xs">{i.id ?? "—"}</span>,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      sortValue: (i) => i.amountDue,
      render: (i) => <span className="font-mono text-sm tabular-nums">{usd(i.amountDue)}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (i) => i.status ?? "",
      render: (i) => (
        <span
          className={
            i.status === "paid"
              ? "font-mono text-xs text-emerald-600 dark:text-emerald-400"
              : "font-mono text-xs text-amber-600 dark:text-amber-400"
          }
        >
          {i.status ?? "—"}
        </span>
      ),
    },
    {
      key: "pdf",
      header: "",
      align: "right",
      render: (i) =>
        i.pdfUrl ? (
          <a
            href={i.pdfUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            PDF
            <ExternalLinkIcon className="size-3" />
          </a>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            AI Gateway · Billing
          </div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Credits and limits</h2>
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

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className={PANEL}>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            Credit balance
          </div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{usd(balance.balance)}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {balance.paymentMethod.brand
              ? `${balance.paymentMethod.brand} ····${balance.paymentMethod.last4}`
              : "no payment method on file"}
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/40 pt-3">
            <span className="text-xs text-muted-foreground">
              {topupOn ? (
                <>
                  Auto top-up{" "}
                  <span className="text-emerald-600 dark:text-emerald-400">on</span> ·{" "}
                  {usd(balance.topupConfig.amount)} at {usd(balance.topupConfig.threshold)}
                </>
              ) : (
                <>
                  Auto top-up <span className="text-muted-foreground">off</span>
                </>
              )}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setTopupOpen(true)}
            >
              Manage
            </Button>
          </div>
        </div>

        <div className={PANEL}>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            Upcoming invoice
          </div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">
            {usd(invoicePreview.amountDue)}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {invoicePreview.status ?? "draft"} · {invoicePreview.lines.length} line items
          </div>
        </div>

        <div className={PANEL}>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            Spending limit
          </div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">
            {spendingLimit.enabled ? usd(spendingLimit.amount) : "none"}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {spendingLimit.enabled
              ? `${spendingLimit.duration} · ${spendingLimit.strategy}`
              : "spend is uncapped"}
          </div>
          {spendingLimit.enabled && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 text-destructive"
              onClick={() => setConfirmRemoveLimit(true)}
            >
              Remove limit
            </Button>
          )}
        </div>
      </div>

      {/* --- Auto top-up (modal) --------------------------------------------- */}
      <Dialog open={topupOpen} onOpenChange={setTopupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Auto top-up</DialogTitle>
            <DialogDescription>
              {topupOn
                ? `Currently charges ${usd(balance.topupConfig.amount)} when the balance falls below ${usd(balance.topupConfig.threshold)}.`
                : "Disabled — the balance will not be automatically refilled."}
            </DialogDescription>
          </DialogHeader>

          {balance.topupConfig.error && (
            <p className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
              <AlertTriangleIcon className="size-4" />
              {balance.topupConfig.error}
              {balance.topupConfig.lastFailedAt
                ? ` (last failed ${relativeTime(balance.topupConfig.lastFailedAt)})`
                : ""}
            </p>
          )}

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="topup-threshold">Trigger when balance is below ($)</Label>
              <Input
                id="topup-threshold"
                value={topupThreshold}
                onChange={(e) => setTopupThreshold(e.target.value)}
                inputMode="decimal"
                placeholder="5.00"
                className="font-mono"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="topup-amount">Top up by ($)</Label>
              <Input
                id="topup-amount"
                value={topupAmount}
                onChange={(e) => setTopupAmount(e.target.value)}
                inputMode="decimal"
                placeholder="10.00"
                className="font-mono"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Cloudflare minimums: $10.00 top-up, $5.00 threshold.
            </p>
          </div>

          <div className="flex items-center justify-between gap-2">
            {topupOn ? (
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void disableTopup()}>
                Disable
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setTopupOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void saveTopup()}
                disabled={Number(topupAmount) < 10 || Number(topupThreshold) < 5}
              >
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* --- Draft invoice line items ---------------------------------------- */}
      <div className={PANEL}>
        <h3 className="text-base font-medium">Upcoming charges by model</h3>
        <ul className="mt-3 flex flex-col gap-2">
          {invoicePreview.lines.slice(0, 10).map((line) => (
            <li
              key={line.description}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="truncate font-mono text-xs">{line.description}</span>
              <span className="shrink-0 font-mono text-xs tabular-nums">
                <span className="text-muted-foreground">{line.quantity.toLocaleString()} × </span>
                {usd(line.amount)}
              </span>
            </li>
          ))}
          {invoicePreview.lines.length === 0 && (
            <li className="text-sm text-muted-foreground">No usage charges this period.</li>
          )}
        </ul>
      </div>

      {/* --- Gateways --------------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-medium">Gateways ({gateways.length})</h3>
        <ResourceTable
          rows={gateways}
          columns={gatewayColumns}
          loading={loading}
          rowKey={(g) => g.id}
          searchText={(g) => g.id}
          initialSortKey="id"
          empty="No gateways."
        />
      </section>

      {/* --- Invoices --------------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-medium">Invoice history</h3>
        <ResourceTable
          rows={invoices}
          columns={invoiceColumns}
          loading={loading}
          rowKey={(i) => i.id ?? String(i.created)}
          searchText={(i) => `${i.id ?? ""} ${i.status ?? ""} ${i.description ?? ""}`}
          initialSortKey="created"
          empty="No invoices."
        />
      </section>

      <ConfirmDeleteDialog
        open={confirmRemoveLimit}
        onOpenChange={setConfirmRemoveLimit}
        phrase="remove spending limit"
        title="Remove the spending limit?"
        description={
          <>
            This removes the {usd(spendingLimit.amount)} {spendingLimit.duration} cap and leaves
            AI Gateway spend uncapped. Cloudflare no longer allows creating or modifying spending
            limits through this API, so Guardian cannot put it back — you would have to recreate it
            as an AI Gateway spend limit in the dashboard.
          </>
        }
        onConfirm={removeSpendingLimit}
      />
    </div>
  );
}
