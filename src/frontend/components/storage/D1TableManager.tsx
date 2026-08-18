/**
 * @fileoverview D1TableManager — shrink a bloated D1 database, table by table.
 *
 * Click a database → see its tables ranked by estimated size → archive the
 * massive ones to Drive (whole table, or only rows older than a cutoff), verify
 * the export by re-downloading it, then trim the archived rows from D1 to
 * reclaim space. Every step is logged server-side; trim is gated on a verified
 * archive and a type-to-confirm barrier.
 */

"use client";

import { ArchiveIcon, CheckCircle2Icon, ExternalLinkIcon, Loader2Icon, ScissorsIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiGet, apiSend } from "@/lib/api";
import { humanSize, relativeTime } from "@/lib/format";

import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

export type D1ShrinkTarget = { uuid: string; name: string };

type TableInfo = { name: string; rows: number; estBytes: number; columns: string[] };
type ArchiveRec = {
  id: string;
  tableName: string;
  archivedRows: number;
  bytes: number;
  driveUrl: string;
  verified: boolean;
  verifiedRows: number;
  trimmed: boolean;
  trimmedRows: number;
  reclaimedBytes: number;
  createdAt: number;
  timeColumn: string;
};
type Payload = { tables: TableInfo[]; archives: ArchiveRec[] };

export function D1TableManager({
  target,
  onOpenChange,
  onChanged,
}: {
  target: D1ShrinkTarget | null;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // "<action>:<key>"
  const [error, setError] = useState<string | null>(null);
  // Per-table archive scope draft: column + cutoff (empty = whole table).
  const [scope, setScope] = useState<Record<string, { col: string; cutoff: string }>>({});
  const [trimming, setTrimming] = useState<ArchiveRec | null>(null);

  const load = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    setError(null);
    try {
      setData(await apiGet<Payload>(`/guardian/d1/${encodeURIComponent(target.uuid)}/tables`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tables");
    } finally {
      setLoading(false);
    }
  }, [target]);

  useEffect(() => {
    if (target) void load();
    else setData(null);
  }, [target, load]);

  const archive = async (t: TableInfo) => {
    if (!target) return;
    setBusy(`archive:${t.name}`);
    setError(null);
    try {
      const s = scope[t.name];
      await apiSend("POST", `/guardian/d1/${encodeURIComponent(target.uuid)}/archive`, {
        databaseName: target.name,
        table: t.name,
        ...(s?.col && s.cutoff ? { timeColumn: s.col, cutoff: /^\d+$/.test(s.cutoff) ? Number(s.cutoff) : s.cutoff } : {}),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Archive failed");
    } finally {
      setBusy(null);
    }
  };

  const verify = async (rec: ArchiveRec) => {
    setBusy(`verify:${rec.id}`);
    setError(null);
    try {
      await apiSend("POST", `/guardian/d1/archive/${rec.id}/verify`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verify failed");
    } finally {
      setBusy(null);
    }
  };

  const trim = async (rec: ArchiveRec) => {
    setBusy(`trim:${rec.id}`);
    setError(null);
    try {
      await apiSend("POST", `/guardian/d1/archive/${rec.id}/trim`);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trim failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <AlertDialog open={Boolean(target)} onOpenChange={onOpenChange}>
        <AlertDialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ScissorsIcon className="size-5" /> Shrink {target?.name}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Archive a massive table to Drive, verify the export, then trim the archived rows to
              reclaim D1 space. Trim is gated on a verified archive.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {loading && !data ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" /> Analyzing tables…
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Tables ranked by size */}
              <div className="flex flex-col gap-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Tables by estimated size
                </div>
                {(data?.tables ?? []).map((t) => {
                  const s = scope[t.name] ?? { col: "", cutoff: "" };
                  return (
                    <div key={t.name} className="rounded-lg border border-border/50 bg-muted/30 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <span className="font-mono text-sm font-medium">{t.name}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {t.rows.toLocaleString()} rows · ~{humanSize(t.estBytes)}
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === `archive:${t.name}`}
                          onClick={() => void archive(t)}
                        >
                          {busy === `archive:${t.name}` ? (
                            <Loader2Icon className="size-4 animate-spin" />
                          ) : (
                            <ArchiveIcon className="size-4" />
                          )}
                          Archive
                        </Button>
                      </div>
                      {/* Optional scope: only rows where <col> < <cutoff> */}
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>Scope:</span>
                        <Select
                          value={s.col || "__all__"}
                          onValueChange={(v) =>
                            setScope((p) => ({ ...p, [t.name]: { ...s, col: v === "__all__" ? "" : v } }))
                          }
                        >
                          <SelectTrigger className="h-7 w-40 text-xs">
                            <SelectValue placeholder="whole table" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__all__">whole table</SelectItem>
                            {t.columns.map((c) => (
                              <SelectItem key={c} value={c}>
                                {c} &lt; …
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {s.col && (
                          <Input
                            value={s.cutoff}
                            onChange={(e) =>
                              setScope((p) => ({ ...p, [t.name]: { ...s, cutoff: e.target.value } }))
                            }
                            placeholder="cutoff (ts or 'YYYY-MM-DD')"
                            className="h-7 w-52 text-xs"
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
                {data?.tables.length === 0 && (
                  <p className="text-sm text-muted-foreground">No user tables.</p>
                )}
              </div>

              {/* Archive log: verify + trim */}
              {(data?.archives ?? []).length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Archives
                  </div>
                  {data!.archives.map((rec) => (
                    <div
                      key={rec.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/40 px-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        <span className="font-mono text-xs">{rec.tableName}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {rec.archivedRows.toLocaleString()} rows · {humanSize(rec.bytes)} ·{" "}
                          {relativeTime(rec.createdAt)}
                          {rec.timeColumn && <> · scoped ({rec.timeColumn})</>}
                        </span>
                        <div className="mt-0.5 text-xs">
                          {rec.trimmed ? (
                            <span className="text-emerald-600 dark:text-emerald-400">
                              ✓ trimmed {rec.trimmedRows.toLocaleString()} rows · reclaimed ~
                              {humanSize(rec.reclaimedBytes)}
                            </span>
                          ) : rec.verified ? (
                            <span className="text-sky-600 dark:text-sky-400">
                              ✓ verified {rec.verifiedRows.toLocaleString()} rows in Drive
                            </span>
                          ) : (
                            <span className="text-amber-600 dark:text-amber-400">unverified</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <a
                          href={rec.driveUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                          aria-label="Open in Drive"
                        >
                          <ExternalLinkIcon className="size-4" />
                        </a>
                        {!rec.verified && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === `verify:${rec.id}`}
                            onClick={() => void verify(rec)}
                          >
                            {busy === `verify:${rec.id}` ? (
                              <Loader2Icon className="size-4 animate-spin" />
                            ) : (
                              <CheckCircle2Icon className="size-4" />
                            )}
                            Verify
                          </Button>
                        )}
                        {rec.verified && !rec.trimmed && (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setTrimming(rec)}
                          >
                            <ScissorsIcon className="size-4" /> Trim
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <ConfirmDeleteDialog
        open={Boolean(trimming)}
        onOpenChange={(open) => !open && setTrimming(null)}
        phrase={trimming?.tableName ?? ""}
        title="Trim archived rows from D1?"
        description={
          trimming ? (
            <>
              This deletes{" "}
              <span className="font-mono text-foreground">{trimming.archivedRows.toLocaleString()}</span>{" "}
              archived rows from{" "}
              <span className="font-mono text-foreground">{trimming.tableName}</span> to reclaim ~
              {humanSize(trimming.bytes)}. The rows are already verified in Drive. No undo.
            </>
          ) : null
        }
        onConfirm={() => (trimming ? trim(trimming) : Promise.resolve())}
      />
    </>
  );
}
