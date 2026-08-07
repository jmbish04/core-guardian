/**
 * @fileoverview Archive-then-cleanup flow for a single D1 database.
 *
 * Step 1: confirm, then POST /guardian/archive/d1 — copies the database to Drive
 * as a .sql dump, a .jsonl bundle, and a Python reconstruct script, and files a
 * human-gated deletion action item. Step 2: only once the archive is byte-count
 * verified, offer to delete the source (to stop billing) via the type-to-confirm
 * barrier, which approves the filed action item (execute + verify server-side).
 */

"use client";

import { ArchiveIcon, CheckCircle2Icon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ApiError, apiSend } from "@/lib/api";
import { humanSize } from "@/lib/format";

import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

export type ArchiveTarget = { uuid: string; name: string; numTables: number; sizeBytes: number };

type ArchiveResult = {
  database: string;
  uuid: string;
  tables: number;
  rows: number;
  bytes: number;
  driveUrl: string;
  verified: boolean;
  actionItemId: string;
};

export function ArchiveD1Dialog({
  target,
  onOpenChange,
  onDeleted,
}: {
  /** The database to archive, or null when the dialog is closed. */
  target: ArchiveTarget | null;
  onOpenChange: (open: boolean) => void;
  /** Called after the source database is deleted so the table can refresh. */
  onDeleted: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<ArchiveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState(false);

  // Reset between openings so a prior run never leaks into the next.
  useEffect(() => {
    if (target) {
      setWorking(false);
      setResult(null);
      setError(null);
      setCleanup(false);
    }
  }, [target]);

  const open = Boolean(target) && !cleanup;

  async function archive() {
    if (!target) return;
    setWorking(true);
    setError(null);
    try {
      const res = await apiSend<ArchiveResult>("POST", "/guardian/archive/d1", {
        uuid: target.uuid,
        name: target.name,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Archive failed.");
    } finally {
      setWorking(false);
    }
  }

  async function deleteSource() {
    if (!result) return;
    // Approve the action item the archive filed: server deletes + verifies gone.
    const res = await apiSend<{ status: "complete" | "failed"; detail: string }>(
      "POST",
      `/guardian/action-items/${encodeURIComponent(result.actionItemId)}/approve`,
    );
    if (res.status !== "complete") throw new ApiError(500, res.detail);
    onDeleted();
    onOpenChange(false);
  }

  return (
    <>
      <AlertDialog open={open} onOpenChange={(o) => !o && onOpenChange(false)}>
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {result ? (
                <CheckCircle2Icon className="size-5 text-emerald-500" />
              ) : (
                <ArchiveIcon className="size-5 text-muted-foreground" />
              )}
              {result ? "Archive complete" : "Archive D1 database?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {result ? (
                <>
                  Copied{" "}
                  <span className="font-mono text-foreground">{result.database}</span> to Drive:{" "}
                  {result.rows.toLocaleString()} rows across {result.tables} tables (
                  {humanSize(result.bytes)} JSONL) plus a .sql dump and a Python reconstruct script.
                </>
              ) : target ? (
                <>
                  Exports{" "}
                  <span className="font-mono text-foreground">{target.name}</span> (
                  {humanSize(target.sizeBytes)}, {target.numTables} tables) to the Drive archive
                  folder as a .sql dump, a .jsonl bundle, and a Python reload script. This copies
                  only — nothing is deleted yet.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {result && (
            <div className="flex flex-col gap-3">
              <a
                href={result.driveUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <ExternalLinkIcon className="size-4" />
                Open in Google Drive
              </a>
              <p className="text-sm text-muted-foreground">
                {result.verified
                  ? "Drive confirmed the full byte count. You can now delete the source database to stop billing for it."
                  : "The archive uploaded but Drive's byte count did not match — do not delete the source. Re-run the archive first."}
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            {result ? (
              <>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
                {result.verified && (
                  <Button variant="destructive" onClick={() => setCleanup(true)}>
                    Delete source database
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={working}>
                  Cancel
                </Button>
                <Button className="gap-2" onClick={() => void archive()} disabled={working}>
                  {working && <Loader2Icon className="size-4 animate-spin" />}
                  Archive to Drive
                </Button>
              </>
            )}
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <ConfirmDeleteDialog
        open={cleanup}
        onOpenChange={(o) => {
          setCleanup(o);
          if (!o) onOpenChange(false);
        }}
        phrase={result?.database ?? ""}
        title="Delete the archived source?"
        description={
          result ? (
            <>
              The archive of{" "}
              <span className="font-mono text-foreground">{result.database}</span> is verified in
              Drive. This permanently deletes the live database to stop billing. Restore later with
              the reconstruct script. There is no undo.
            </>
          ) : null
        }
        onConfirm={deleteSource}
      />
    </>
  );
}
