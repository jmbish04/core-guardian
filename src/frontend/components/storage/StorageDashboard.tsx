/**
 * @fileoverview Data Storage dashboard — account-wide counts and totals per
 * product, the five largest resources in each, and entry points to the
 * per-product pages.
 *
 * KV reports no stored size because Cloudflare exposes no API for it; the tile
 * says so rather than showing a fabricated zero.
 */

"use client";

import { DatabaseIcon, HardDriveIcon, LayersIcon, Loader2Icon, TableIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ApiError, apiGet } from "@/lib/api";
import { humanSize } from "@/lib/format";

type Summary = {
  r2: { count: number; totalBytes: number; totalObjects: number };
  d1: { count: number; totalBytes: number };
  kv: { count: number; totalBytes: number | null };
  catalogs: { count: number };
  pipelines: { count: number };
  top: {
    r2: { name: string; sizeBytes: number }[];
    d1: { name: string; sizeBytes: number }[];
    kv: { name: string }[];
    pipelines: { name: string; status: string | null }[];
  };
};

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

function StatTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className={PANEL}>
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function TopList({
  title,
  href,
  icon,
  rows,
}: {
  title: string;
  href: string;
  icon: React.ReactNode;
  rows: { name: string; detail: string }[];
}) {
  return (
    <div className={`${PANEL} flex flex-col`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-base font-medium">{title}</h3>
        </div>
        <a
          href={href}
          className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground hover:text-foreground"
        >
          open →
        </a>
      </div>
      <ul className="mt-3 flex flex-1 flex-col gap-2">
        {rows.map((row) => (
          <li key={row.name} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-mono text-xs">{row.name}</span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {row.detail}
            </span>
          </li>
        ))}
        {rows.length === 0 && <li className="text-sm text-muted-foreground">None.</li>}
      </ul>
    </div>
  );
}

export function StorageDashboard() {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Summary>("/storage/summary")
      .then(setData)
      .catch((err) =>
        setError(
          err instanceof ApiError && err.status === 401
            ? "Sign in to view storage inventory."
            : err instanceof ApiError
              ? err.message
              : "Failed to load storage summary.",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  if (error) {
    return <p className={`${PANEL} text-sm text-muted-foreground`}>{error}</p>;
  }

  if (loading || !data) {
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" />
        Inventorying account storage…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile
          label="R2"
          value={String(data.r2.count)}
          sub={`${humanSize(data.r2.totalBytes)} · ${data.r2.totalObjects.toLocaleString()} objects`}
        />
        <StatTile label="D1" value={String(data.d1.count)} sub={humanSize(data.d1.totalBytes)} />
        <StatTile
          label="KV"
          value={String(data.kv.count)}
          // Cloudflare exposes no stored-size API for KV.
          sub="size not reported by API"
        />
        <StatTile label="Data catalogs" value={String(data.catalogs.count)} sub="R2 warehouses" />
        <StatTile label="Pipelines" value={String(data.pipelines.count)} sub="configured" />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <TopList
          title="Largest R2 buckets"
          href="/dashboard/storage/r2"
          icon={<HardDriveIcon className="size-5 text-muted-foreground" />}
          rows={data.top.r2.map((r) => ({ name: r.name, detail: humanSize(r.sizeBytes) }))}
        />
        <TopList
          title="Largest D1 databases"
          href="/dashboard/storage/d1"
          icon={<DatabaseIcon className="size-5 text-muted-foreground" />}
          rows={data.top.d1.map((r) => ({ name: r.name, detail: humanSize(r.sizeBytes) }))}
        />
        <TopList
          title="KV namespaces"
          href="/dashboard/storage/kv"
          icon={<LayersIcon className="size-5 text-muted-foreground" />}
          rows={data.top.kv.map((r) => ({ name: r.name, detail: "—" }))}
        />
        <TopList
          title="Pipelines"
          href="/dashboard/storage/pipelines"
          icon={<TableIcon className="size-5 text-muted-foreground" />}
          rows={data.top.pipelines.map((r) => ({ name: r.name, detail: r.status ?? "—" }))}
        />
      </div>

      <nav className="flex flex-wrap gap-2">
        {[
          { href: "/dashboard/storage/r2", label: "R2 buckets" },
          { href: "/dashboard/storage/d1", label: "D1 databases" },
          { href: "/dashboard/storage/kv", label: "KV namespaces" },
          { href: "/dashboard/storage/data-catalog", label: "Data catalogs" },
          { href: "/dashboard/storage/pipelines", label: "Pipelines" },
        ].map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="inline-flex h-9 items-center rounded-md border border-border/60 px-4 text-sm transition-colors hover:bg-muted"
          >
            {link.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
