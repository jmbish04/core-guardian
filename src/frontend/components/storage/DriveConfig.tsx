/**
 * @fileoverview Drive folder config — paste a folder URL/id per archive purpose;
 * the backend extracts the id and validates the service account's access live.
 */

"use client";

import { CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { relativeTime } from "@/lib/format";

type Folder = {
  purpose: string;
  folderId: string;
  url: string;
  name: string | null;
  validated: boolean;
  error: string | null;
  validatedAt: number | null;
  updatedAt: number;
};

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

const PURPOSE_LABEL: Record<string, string> = {
  root: "Archive root",
  r2: "R2 bucket archives",
  d1: "D1 database archives",
  "cf-image": "Cloudflare Images archives",
};

export function DriveConfig() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { folders } = await apiGet<{ folders: Folder[] }>("/drive/folders");
      setFolders(folders);
      setDrafts(Object.fromEntries(folders.map((f) => [f.purpose, f.url])));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to configure Drive folders."
          : err instanceof ApiError
            ? err.message
            : "Failed to load Drive config.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(purpose: string) {
    setSaving(purpose);
    setError(null);
    try {
      const updated = await apiSend<Folder>("POST", "/drive/folders", {
        purpose,
        input: drafts[purpose] ?? "",
      });
      setFolders((prev) => prev.map((f) => (f.purpose === purpose ? updated : f)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed.");
    } finally {
      setSaving(null);
    }
  }

  if (error && folders.length === 0)
    return <p className={`${PANEL} text-sm text-muted-foreground`}>{error}</p>;
  if (loading)
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" /> Loading Drive config…
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          Guardian · Archive destinations
        </div>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">Google Drive folders</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Archive destinations are now managed automatically. The worker impersonates its Workspace
          user (domain-wide delegation) and finds-or-creates a folder named after itself
          (<code className="font-mono">core-guardian</code>) — owned by the user or shared with them —
          then creates <code className="font-mono">d1-archive</code> /{" "}
          <code className="font-mono">r2-archive</code> /{" "}
          <code className="font-mono">cf-image-archive</code> subfolders inside it. Nothing to paste.
        </p>
        <p className="mt-2 max-w-2xl rounded-lg border border-sky-500/25 bg-sky-500/10 p-3 text-xs text-sky-700 dark:text-sky-300">
          The overrides below are optional. Leave them alone to let the worker manage its own Drive
          tree; set one only to pin a specific folder for a purpose.
        </p>
      </header>

      {error && <p className={`${PANEL} text-sm text-destructive`}>{error}</p>}

      <div className="flex flex-col gap-3">
        {folders.map((f) => (
          <div key={f.purpose} className={PANEL}>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`drive-${f.purpose}`} className="text-base font-medium">
                {PURPOSE_LABEL[f.purpose] ?? f.purpose}
              </Label>
              {f.validatedAt ? (
                <span className="flex items-center gap-1.5 font-mono text-xs text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2Icon className="size-3.5" />
                  {f.name ?? "validated"} · {relativeTime(f.validatedAt)}
                </span>
              ) : f.error ? (
                <span className="flex items-center gap-1.5 font-mono text-xs text-rose-600 dark:text-rose-400">
                  <XCircleIcon className="size-3.5" /> not validated
                </span>
              ) : (
                <span className="font-mono text-xs text-muted-foreground">seed · unsaved</span>
              )}
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                id={`drive-${f.purpose}`}
                value={drafts[f.purpose] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [f.purpose]: e.target.value }))}
                placeholder="https://drive.google.com/drive/folders/…"
                className="flex-1 font-mono text-xs"
              />
              <Button
                onClick={() => void save(f.purpose)}
                disabled={saving === f.purpose || !drafts[f.purpose]}
              >
                {saving === f.purpose ? <Loader2Icon className="size-4 animate-spin" /> : "Validate & save"}
              </Button>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground">
              <span>id: {f.folderId}</span>
              {f.error && <span className="text-amber-600 dark:text-amber-400">{f.error}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
