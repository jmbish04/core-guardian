/**
 * @fileoverview Sign-in form — exchanges the Worker API key for a session cookie.
 *
 * Every authenticated panel in this app (Guardian telemetry, storage, AI
 * Gateway billing, alert rules, the notifications inbox) gates on the
 * `cr_session` cookie and renders "Sign in to view…" without it. Until this
 * existed there was no way to obtain that cookie from a browser at all — the
 * dashboards were only reachable with a bearer token from a script.
 *
 * `POST /api/auth/login` sets the cookie for `Path=/`, so one sign-in unlocks
 * every panel. The key is sent once and never stored client-side.
 */

"use client";

import { KeyRoundIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignInForm({ redirectTo = "/dashboard/guardian" }: { redirectTo?: string }) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!apiKey.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Same-origin: the Set-Cookie lands on this site.
        credentials: "same-origin",
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      if (!response.ok) {
        setError(response.status === 401 ? "Invalid API key." : `Sign-in failed (${response.status}).`);
        return;
      }
      // Full navigation rather than a client route change so every island
      // remounts and refetches with the new cookie attached.
      window.location.assign(redirectTo);
    } catch {
      setError("Network error — could not reach the sign-in endpoint.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-xl border border-border/60 bg-background/40 p-6"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="worker-api-key">Worker API key</Label>
        <Input
          id="worker-api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="••••••••••••••••"
          autoComplete="current-password"
          spellCheck={false}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          The <code className="font-mono">WORKER_API_KEY</code> secret. Sets a session cookie valid
          across every dashboard panel.
        </p>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/25">
          {error}
        </p>
      )}

      <Button type="submit" disabled={busy || !apiKey.trim()} className="gap-2">
        {busy ? <Loader2Icon className="size-4 animate-spin" /> : <KeyRoundIcon className="size-4" />}
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
