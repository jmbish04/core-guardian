/**
 * @fileoverview GuardianPanel — Core Guardian emergency governance cockpit.
 *
 * Three stacked sections:
 *  1. Billing telemetry — per-binding usage vs. safety thresholds (`UsageGrid`)
 *  2. Kill switches — the destructive mitigations
 *       - R2 eviction    → `POST /api/r2/evict` (1-day Expire lifecycle rule)
 *       - Vectorize drop → `POST /api/vectorize/reset` (deletes the index)
 *  3. Audit trail — the D1 `billing_events` table (`GuardianAuditLog`)
 *
 * The Vectorize drop is gated behind an AlertDialog confirmation barrier
 * because it is irreversible. A successful mitigation bumps `auditKey` so the
 * audit trail immediately reflects the row that was just written.
 */

"use client";

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  DatabaseZapIcon,
  HardDriveIcon,
  Loader2Icon,
  ShieldAlertIcon,
} from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiSend } from "@/lib/api";

import { GuardianAuditLog } from "./GuardianAuditLog";
import { UsageGrid } from "./UsageGrid";

/** Envelope returned by both eviction endpoints. */
type MitigationResult = {
  ok: boolean;
  service: string;
  actionTaken: string;
  eventId: string;
  timestamp: number;
};

type Status = { kind: "success" | "error"; message: string } | null;

/** Shared card chrome — matches the telemetry and audit sections. */
const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

/** Inline status banner — success (emerald) or failure (destructive). */
function StatusBanner({ status }: { status: Status }) {
  if (!status) return null;
  const success = status.kind === "success";
  return (
    <output
      aria-live="polite"
      className={
        success
          ? "flex items-start gap-3 rounded-xl bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30"
          : "flex items-start gap-3 rounded-xl bg-destructive/10 p-4 ring-1 ring-destructive/30"
      }
    >
      {success ? (
        <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-emerald-400" />
      ) : (
        <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-destructive" />
      )}
      <div className="text-sm">
        <p className={success ? "font-medium text-emerald-300" : "font-medium text-destructive"}>
          {success ? "Mitigation executed" : "Mitigation failed"}
        </p>
        <p className="text-muted-foreground">{status.message}</p>
      </div>
    </output>
  );
}

export function GuardianPanel() {
  const [status, setStatus] = useState<Status>(null);
  // Bumped after a successful mitigation so the audit trail refetches.
  const [auditKey, setAuditKey] = useState(0);

  const [bucketName, setBucketName] = useState("");
  const [evicting, setEvicting] = useState(false);

  const [indexName, setIndexName] = useState("");
  const [dropping, setDropping] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function run(
    path: string,
    body: unknown,
    setBusy: (busy: boolean) => void,
    onDone: () => void,
  ) {
    setBusy(true);
    setStatus(null);
    try {
      const result = await apiSend<MitigationResult>("POST", path, body);
      setStatus({ kind: "success", message: result.actionTaken });
      setAuditKey((k) => k + 1);
      onDone();
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof ApiError ? err.message : "Request failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <StatusBanner status={status} />

      {/* --- 1. Billing telemetry -------------------------------------------- */}
      <UsageGrid />

      {/* --- 2. Kill switches ------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <header>
          <h2 className="text-xl font-semibold tracking-tight">Emergency controls</h2>
          <p className="text-sm text-muted-foreground">
            Destructive and irreversible. Each action runs against the live Cloudflare account and
            is recorded in the audit trail below.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className={PANEL}>
            <div className="flex items-center gap-2">
              <HardDriveIcon className="size-5 text-muted-foreground" />
              <h3 className="text-base font-medium">R2 emergency eviction</h3>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Injects a 1-day <code className="font-mono">Expire</code> lifecycle rule so R2 drains
              the bucket asynchronously. Replaces the bucket&rsquo;s existing lifecycle
              configuration.
            </p>

            <form
              className="mt-4 flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!bucketName.trim() || evicting) return;
                void run("/r2/evict", { bucketName: bucketName.trim() }, setEvicting, () =>
                  setBucketName(""),
                );
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="guardian-bucket">Bucket name</Label>
                <Input
                  id="guardian-bucket"
                  value={bucketName}
                  onChange={(e) => setBucketName(e.target.value)}
                  placeholder="runaway-assets-bucket"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
              </div>
              <Button
                type="submit"
                variant="destructive"
                disabled={evicting || !bucketName.trim()}
                className="gap-2"
              >
                {evicting ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <ShieldAlertIcon className="size-4" />
                )}
                {evicting ? "Evicting…" : "Evict Bucket"}
              </Button>
            </form>
          </div>

          <div className={PANEL}>
            <div className="flex items-center gap-2">
              <DatabaseZapIcon className="size-5 text-muted-foreground" />
              <h3 className="text-base font-medium">Vectorize emergency drop</h3>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Deletes the index outright to halt runaway vector read/write metering. This cannot be
              undone — the vectors are not recoverable.
            </p>

            <form
              className="mt-4 flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!indexName.trim() || dropping) return;
                setConfirmOpen(true);
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="guardian-index">Index name</Label>
                <Input
                  id="guardian-index"
                  value={indexName}
                  onChange={(e) => setIndexName(e.target.value)}
                  placeholder="runaway-embeddings-index"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
              </div>
              <Button
                type="submit"
                variant="destructive"
                disabled={dropping || !indexName.trim()}
                className="gap-2"
              >
                {dropping ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <ShieldAlertIcon className="size-4" />
                )}
                {dropping ? "Dropping…" : "Drop Index"}
              </Button>
            </form>
          </div>
        </div>
      </section>

      {/* --- 3. Audit trail --------------------------------------------------- */}
      <GuardianAuditLog refreshKey={auditKey} />

      {/* Confirmation barrier — the drop is irreversible. */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Vectorize index?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the index{" "}
              <span className="font-mono text-foreground">{indexName}</span> and every vector in it.
              Metering stops immediately. There is no undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                void run("/vectorize/reset", { indexName: indexName.trim() }, setDropping, () =>
                  setIndexName(""),
                );
              }}
            >
              Drop index
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
