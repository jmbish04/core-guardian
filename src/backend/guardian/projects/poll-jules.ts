/**
 * @fileoverview `pollJulesSessions` — the P14a Jules lifecycle poller (zero AI).
 *
 * Walks every non-terminal `jules_sessions` row (pending|running|stuck), calls
 * `GET /sessions/{id}` on the Jules v1alpha API, maps Jules' reported state to
 * our `status`, and fills in `session_url` + `pr_url`. Terminal states
 * (submitted|failed|completed) are left alone — nothing to poll.
 *
 * Robustness: per-row try/catch, so one unreadable session never sinks the run;
 * the function never throws. Rows with a null `session_id` (a dispatch whose
 * Jules session was never created) are skipped.
 *
 * State mapping is a deterministic keyword match over Jules' state string plus
 * "did it open a PR" — NO AI. The exact Jules enum names are treated as
 * untrusted/variable, so we classify by substring rather than exact equality.
 *
 * @see {@link file://src/backend/db/schemas/governance/projects/jules-sessions.ts}
 */

import { inArray } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { julesSessions, type JulesSessionRow } from "@/backend/db/schema";
import { getSecret, getSecretStoreBinding } from "@/backend/utils/secrets";

/** Jules public API base (v1alpha). Auth is the `X-Goog-Api-Key` header. */
const JULES_BASE = "https://jules.googleapis.com/v1alpha";

/** Our non-terminal statuses — the poll set. Terminal = submitted|failed|completed. */
const NON_TERMINAL = ["pending", "running", "stuck"] as const;

/** Our status enum (mirrors the jules_sessions column). */
type JulesStatus = JulesSessionRow["status"];

/** Summary returned by {@link pollJulesSessions}. */
export interface PollSummary {
  /** Non-terminal rows considered this run. */
  polled: number;
  /** Rows whose status/urls changed. */
  updated: number;
  /** Rows that reached a terminal status this run. */
  terminal: number;
  /** Rows skipped for a null session_id. */
  skipped: number;
  polledAt: number;
}

/**
 * Deterministically map a Jules session state string (+ whether a PR exists) to
 * our status. Substring match, case-insensitive — Jules' exact enum is treated
 * as variable. A PR link is the strongest signal (Jules submitted its work).
 */
export function mapJulesState(rawState: string | undefined, hasPr: boolean): JulesStatus {
  const s = (rawState ?? "").toUpperCase();
  if (hasPr) return "submitted";
  if (/FAIL|ERROR|CANCEL/.test(s)) return "failed";
  if (/COMPLET|SUCCE|FINISH|DONE/.test(s)) return "completed";
  if (/SUBMIT|PULL_REQUEST|MERGED/.test(s)) return "submitted";
  if (/PAUSE|AWAIT|STUCK|BLOCK|FEEDBACK|INPUT/.test(s)) return "stuck";
  if (/PROGRESS|RUNNING|PLAN|ACTIVE|WORK|EXECUT/.test(s)) return "running";
  return "pending";
}

/** Pull the first PR url out of a Jules session `outputs[]`, if any. */
function extractPrUrl(session: Record<string, any> | null): string | null {
  const outputs = session?.outputs;
  if (!Array.isArray(outputs)) return null;
  for (const o of outputs) {
    const url = o?.pullRequest?.url ?? o?.pull_request?.url;
    if (typeof url === "string" && url) return url;
  }
  return null;
}

/**
 * Poll all non-terminal Jules sessions and advance their lifecycle.
 *
 * @param env - Worker env (D1, JULES_API_KEY Secrets Store binding).
 */
export async function pollJulesSessions(env: Env): Promise<PollSummary> {
  const db = getDb(env);
  const now = Date.now();

  const rows = await db
    .select()
    .from(julesSessions)
    .where(inArray(julesSessions.status, [...NON_TERMINAL]));

  const summary: PollSummary = {
    polled: rows.length,
    updated: 0,
    terminal: 0,
    skipped: 0,
    polledAt: now,
  };
  if (rows.length === 0) return summary;

  const apiKey =
    (await getSecretStoreBinding(env, "JULES_API_KEY")) ?? getSecret(env, "JULES_API_KEY");
  if (!apiKey) {
    console.warn(
      JSON.stringify({ level: "WARN", source: "guardian.projects.pollJules", error: "no JULES_API_KEY" }),
    );
    return summary;
  }

  for (const row of rows) {
    if (!row.sessionId) {
      summary.skipped++;
      continue;
    }
    try {
      const res = await fetch(`${JULES_BASE}/sessions/${encodeURIComponent(row.sessionId)}`, {
        headers: { "X-Goog-Api-Key": apiKey },
      });
      if (!res.ok) {
        // 404/5xx — leave the row as-is for the next run; a persistent 404 could
        // be handled later, but never fabricate a terminal state here.
        continue;
      }
      const session = (await res.json().catch(() => null)) as Record<string, any> | null;

      const prUrl = extractPrUrl(session);
      const rawState: string | undefined = session?.state ?? session?.status;
      const status = mapJulesState(rawState, !!prUrl);
      const sessionUrl =
        (typeof session?.url === "string" ? session.url : null) ??
        (typeof session?.uiUrl === "string" ? session.uiUrl : null) ??
        `https://jules.google.com/session/${row.sessionId}`;

      // Only write when something actually changed (idempotent, cheap).
      const changed =
        status !== row.status || sessionUrl !== row.sessionUrl || (prUrl ?? null) !== row.prUrl;
      if (!changed) continue;

      await db
        .update(julesSessions)
        .set({ status, sessionUrl, prUrl: prUrl ?? row.prUrl, updatedAt: now })
        .where(inArray(julesSessions.id, [row.id]));
      summary.updated++;
      if (status === "submitted" || status === "failed" || status === "completed") {
        summary.terminal++;
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: "WARN",
          source: "guardian.projects.pollJules",
          session: row.sessionId,
          error: String(err),
        }),
      );
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Self-check — the pure state mapper. Never runs in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const assert = (cond: boolean, m: string) => {
    if (!cond) throw new Error(m);
  };
  assert(mapJulesState("IN_PROGRESS", false) === "running", "in_progress → running");
  assert(mapJulesState("PLANNING", false) === "running", "planning → running");
  assert(mapJulesState("AWAITING_USER_FEEDBACK", false) === "stuck", "awaiting → stuck");
  assert(mapJulesState("FAILED", false) === "failed", "failed → failed");
  assert(mapJulesState("COMPLETED", false) === "completed", "completed → completed");
  assert(mapJulesState("anything", true) === "submitted", "PR present → submitted (wins)");
  assert(mapJulesState(undefined, false) === "pending", "unknown → pending");
  // eslint-disable-next-line no-console
  console.log("ok — poll-jules state mapper verified");
}
