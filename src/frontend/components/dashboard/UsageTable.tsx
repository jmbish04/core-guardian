/**
 * @fileoverview Per-probe detail table — every binding on one screen.
 *
 * Replaces the previous stack of identical progress bars. Rows are ordered by
 * severity (surging first, then percent-of-threshold descending) so the thing
 * that needs attention is always the first row, and unmetered probes sink to
 * the bottom rather than being hidden in a separate card — a governance panel
 * that silently drops a binding is worse than one that admits it cannot see it.
 */

"use client";

import { AlertTriangleIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { compactNumber, formatRatio, humanSize } from "@/lib/format";

export type TableReading = {
  id: string;
  label: string;
  product: string;
  bindings: string[];
  unit: string;
  status: "ok" | "not_metered" | "unavailable";
  value: number;
  alertThreshold: number | null;
  surging: boolean;
  error?: string;
};

function fmt(value: number, unit: string): string {
  return unit.includes("bytes") ? humanSize(value) : compactNumber(value);
}

/** Percent of threshold, or null when the probe has no threshold to measure against. */
function ratio(r: TableReading): number | null {
  if (r.status !== "ok" || !r.alertThreshold || r.alertThreshold <= 0) return null;
  return r.value / r.alertThreshold;
}

/** Severity rank — drives row order. Higher sorts first. */
function severity(r: TableReading): number {
  if (r.surging) return 1000;
  if (r.status !== "ok") return -1;
  return ratio(r) ?? 0;
}

function StatusBadge({ reading }: { reading: TableReading }) {
  if (reading.status === "not_metered") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        not metered
      </Badge>
    );
  }
  if (reading.status === "unavailable") {
    return (
      <Badge variant="outline" className="border-amber-500/25 text-amber-600 dark:text-amber-400">
        unavailable
      </Badge>
    );
  }
  if (reading.surging) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400"
      >
        <AlertTriangleIcon className="size-3" />
        surging
      </Badge>
    );
  }
  const pct = ratio(reading);
  if (pct != null && pct >= 0.7) {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400"
      >
        elevated
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    >
      healthy
    </Badge>
  );
}

export function UsageTable({
  readings,
  selectedId,
  onSelect,
}: {
  readings: TableReading[];
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const rows = [...readings].sort((a, b) => severity(b) - severity(a));

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold">All bindings</h3>
          <p className="text-xs text-muted-foreground">
            Ordered by severity. Click a row to chart it above.
          </p>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {readings.filter((r) => r.status === "ok").length}/{readings.length} metered
        </span>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="ps-5">Binding</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Usage</TableHead>
              <TableHead className="text-right">Threshold</TableHead>
              <TableHead className="w-[160px]">Load</TableHead>
              <TableHead className="pe-5 text-right">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((reading) => {
              const pct = ratio(reading);
              const active = reading.id === selectedId;
              const clickable = reading.status === "ok" && onSelect;
              return (
                <TableRow
                  key={reading.id}
                  data-state={active ? "selected" : undefined}
                  onClick={clickable ? () => onSelect(reading.id) : undefined}
                  className={clickable ? "cursor-pointer" : "opacity-60"}
                >
                  <TableCell className="ps-5">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{reading.label}</span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {reading.bindings.length === 0
                          ? "—"
                          : reading.bindings.slice(0, 2).join(", ")}
                        {reading.bindings.length > 2 && (
                          <span className="text-muted-foreground/60">
                            {" "}
                            +{reading.bindings.length - 2}
                          </span>
                        )}
                      </span>
                    </div>
                  </TableCell>

                  <TableCell className="text-muted-foreground">{reading.product}</TableCell>

                  <TableCell className="text-right">
                    {reading.status === "ok" ? (
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium tabular-nums">
                          {fmt(reading.value, reading.unit)}
                        </span>
                        <span className="text-[11px] text-muted-foreground">{reading.unit}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {reading.status === "not_metered"
                          ? "no analytics dataset"
                          : (reading.error ?? "probe failed")}
                      </span>
                    )}
                  </TableCell>

                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {reading.alertThreshold ? fmt(reading.alertThreshold, reading.unit) : "—"}
                  </TableCell>

                  <TableCell>
                    {pct == null ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]">
                          <div
                            className={`h-full rounded-full ${
                              reading.surging
                                ? "bg-rose-500"
                                : pct >= 0.7
                                  ? "bg-amber-500"
                                  : "bg-foreground/60"
                            }`}
                            style={{ width: `${Math.min(100, pct * 100)}%` }}
                          />
                        </div>
                        <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                          {reading.alertThreshold
                            ? formatRatio(reading.value, reading.alertThreshold)
                            : `${Math.round(pct * 100)}%`}
                        </span>
                      </div>
                    )}
                  </TableCell>

                  <TableCell className="pe-5 text-right">
                    <StatusBadge reading={reading} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
