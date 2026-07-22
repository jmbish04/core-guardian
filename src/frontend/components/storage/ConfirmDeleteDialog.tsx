/**
 * @fileoverview Type-to-confirm barrier for irreversible resource deletion.
 *
 * Follows the Cloudflare dashboard pattern: the phrase you must type is shown
 * in a read-only field with a copy button, and the delete button stays disabled
 * until the typed value matches exactly. The same match is re-checked
 * server-side — this dialog is ergonomics, not the security control.
 */

"use client";

import { AlertTriangleIcon, CheckIcon, CopyIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  /** Exact string the operator must type — always the resource's own name. */
  phrase,
  title,
  description,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phrase: string;
  title: string;
  description: React.ReactNode;
  onConfirm: () => Promise<void> | void;
}) {
  const [typed, setTyped] = useState("");
  const [copied, setCopied] = useState(false);
  const [working, setWorking] = useState(false);

  // Reset between openings so a previous confirmation never carries over.
  useEffect(() => {
    if (open) {
      setTyped("");
      setCopied(false);
      setWorking(false);
    }
  }, [open]);

  const matches = typed === phrase;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangleIcon className="size-5 text-destructive" />
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground">Type the following to confirm</Label>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={phrase}
                className="font-mono"
                aria-label="Confirmation phrase"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Copy confirmation phrase"
                onClick={() => {
                  try {
                    void navigator.clipboard.writeText(phrase);
                  } catch {
                    /* clipboard unavailable — the operator can still type it */
                  }
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                }}
              >
                {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm-input" className="text-xs text-muted-foreground">
              Confirmation
            </Label>
            <Input
              id="confirm-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={phrase}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={working}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!matches || working}
              className="gap-2"
              onClick={async () => {
                setWorking(true);
                try {
                  await onConfirm();
                  onOpenChange(false);
                } finally {
                  setWorking(false);
                }
              }}
            >
              {working && <Loader2Icon className="size-4 animate-spin" />}
              Delete permanently
            </Button>
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
