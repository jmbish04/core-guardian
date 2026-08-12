/**
 * @fileoverview Jules dispatch minting + findings intake (Spend Offense, P4).
 *
 * Two halves of the capability-token flow:
 *
 *  - {@link createJulesDispatch} mints a per-dispatch nonce and records a
 *    `pending` `jules_dispatches` row. P5 (the actual Jules HTTP call) uses this
 *    to hand Jules a self-contained brief carrying the nonce; P4 just exposes it.
 *  - {@link recordFindings} is the auto-act core. The route has already verified
 *    the presented nonce against a pending spend_audit dispatch (that lookup IS
 *    the auth — see routes/offense.ts). This persists the findings, spends the
 *    nonce (→ reported), and then AUTO-ACTS with **zero AI**: if Jules recommends
 *    disabling a project and named one, it flips that project's circuit breaker,
 *    files a `circuit_break_events` incident, audits it, and notifies.
 *
 * Determinism: the auto-act decision is a keyword check over Jules' recommendation
 * strings plus the presence of a project name. No model is consulted here.
 */

import { and, eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import {
  billingEvents,
  circuitBreakEvents,
  julesDispatches,
  type CircuitBreakAction,
} from "@/backend/db/schema";
import { NotificationsAgent } from "@/backend/ai/agents/NotificationsAgent";
import { setCircuit } from "@/backend/guardian/ai-router/circuits";
import type { JulesDispatchRow } from "@/backend/db/schemas/governance/offense/jules-dispatches";
import { getAgentByName } from "agents";

// ---------------------------------------------------------------------------
// Findings payload (mirrors the Jules reporting contract; see the route's zod)
// ---------------------------------------------------------------------------

/** The project's own identity, from its config/metadata. `projectName` keys the breaker. */
export interface ProjectIdentification {
  projectName: string;
  projectType?: string;
  [key: string]: unknown;
}

/** What Jules curls back to `/findings`. Validated by the route before it reaches here. */
export interface FindingsPayload {
  repo: string;
  repo_type: string;
  worker_name?: string;
  cron_audit_findings: string[];
  ai_audit_findings: string[];
  pr_number?: number;
  actions_taken: string[];
  circuit_breaker_recommendation: string[];
  core_guardian_project_identification: ProjectIdentification;
  nonce: string;
}

/** Outcome of one {@link recordFindings} run. */
export interface RecordFindingsResult {
  /** The `circuit_break_events` incident filed for this report. */
  incidentId: string;
  /** True when a project circuit breaker was flipped as a result. */
  circuitFlipped: boolean;
}

// ---------------------------------------------------------------------------
// Mint (P5 consumer)
// ---------------------------------------------------------------------------

/**
 * Mint a capability token and record a `pending` dispatch. The returned `nonce`
 * is the only credential the findings-intake endpoint accepts for this dispatch.
 *
 * @param env - Worker env (D1).
 * @param args.julesSessionId - The Jules session/run this dispatch is handed to.
 * @param args.targetId - The scan_targets row being audited, if known.
 * @returns the new dispatch `id` and its `nonce`.
 */
export async function createJulesDispatch(
  env: Env,
  args: { julesSessionId: string; targetId?: string | null },
): Promise<{ id: string; nonce: string }> {
  const db = getDb(env);
  const id = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  await db.insert(julesDispatches).values({
    id,
    nonce,
    julesSessionId: args.julesSessionId,
    targetId: args.targetId ?? null,
    taskType: "spend_audit",
    status: "pending",
    dispatchedAt: Date.now(),
  });
  return { id, nonce };
}

// ---------------------------------------------------------------------------
// Auto-act core
// ---------------------------------------------------------------------------

/**
 * Deterministic: does Jules' recommendation call for disabling a project's
 * guardian access? A plain keyword match over the recommendation strings — no AI.
 * ponytail: keyword heuristic; tighten the vocabulary if false positives appear.
 */
function recommendsDisable(recommendations: string[]): boolean {
  return recommendations.some((r) => /\bdisabl/i.test(r));
}

/**
 * Persist a verified findings report and auto-act on it.
 *
 * The nonce has ALREADY been verified by the caller (the route matched it to
 * this `dispatch`). This function spends the nonce (marks the dispatch reported),
 * files an incident, and — when Jules recommends disabling a named project —
 * flips that project's circuit breaker to a zero budget so guardian rejects its
 * AI calls.
 *
 * @param env - Worker env (D1, CIRCUITS KV, NotificationsAgent binding).
 * @param dispatch - The pending dispatch the presented nonce matched.
 * @param findings - The validated findings payload.
 * @returns the incident id and whether a breaker was flipped.
 */
export async function recordFindings(
  env: Env,
  dispatch: JulesDispatchRow,
  findings: FindingsPayload,
): Promise<RecordFindingsResult> {
  const db = getDb(env);
  const now = Date.now();

  // Spend the nonce: mark the dispatch reported and store the raw findings.
  // Guard on status='pending' so a concurrent double-report can't both win.
  await db
    .update(julesDispatches)
    .set({
      status: "reported",
      reportedAt: now,
      findings: findings as unknown as Record<string, unknown>,
    })
    .where(and(eq(julesDispatches.id, dispatch.id), eq(julesDispatches.status, "pending")));

  const ident = findings.core_guardian_project_identification;
  const projectName = ident?.projectName?.trim();
  const wantsDisable = recommendsDisable(findings.circuit_breaker_recommendation);
  const scope = projectName ? `project:${projectName}` : null;

  // Auto-act: flip the project's breaker to a zero budget (rejects every AI call
  // for that project) when Jules recommends it AND named the project.
  const actionsTaken: CircuitBreakAction[] = [];
  let circuitFlipped = false;
  if (wantsDisable && projectName && scope) {
    await setCircuit(env, scope, { budgetUsd: 0, window: "month", enabled: true });
    circuitFlipped = true;
    actionsTaken.push({
      kind: "circuit_break",
      detail: `Flipped ${scope} to a $0 monthly budget — Jules recommended disabling this project's AI access.`,
      at: now,
    });
  }
  // Preserve the actions Jules itself took (e.g. commented out the offending code).
  for (const a of findings.actions_taken) {
    actionsTaken.push({ kind: "jules_action", detail: a, at: now });
  }

  const reasonBits = [
    ...findings.ai_audit_findings,
    ...findings.cron_audit_findings,
  ].filter(Boolean);
  const reason =
    `Jules spend audit of ${findings.repo} (${findings.repo_type})` +
    (findings.worker_name ? ` [worker ${findings.worker_name}]` : "") +
    (reasonBits.length ? `: ${reasonBits.join("; ")}` : ": no specific findings reported") +
    (circuitFlipped ? " — project AI access disabled." : "");

  const incidentId = crypto.randomUUID();
  await db.insert(circuitBreakEvents).values({
    id: incidentId,
    projectIdentification: ident as unknown as Record<string, unknown>,
    scope,
    reason,
    source: "jules",
    status: "active",
    julesPr: findings.pr_number != null ? String(findings.pr_number) : null,
    actionsTaken: actionsTaken.length ? actionsTaken : null,
    recommendation: {
      summary: findings.circuit_breaker_recommendation.length
        ? findings.circuit_breaker_recommendation.join("; ")
        : "Jules reported no circuit-breaker recommendation.",
      details: {
        repo: findings.repo,
        repoType: findings.repo_type,
        workerName: findings.worker_name ?? null,
        prNumber: findings.pr_number ?? null,
        cronAuditFindings: findings.cron_audit_findings,
        aiAuditFindings: findings.ai_audit_findings,
        julesActions: findings.actions_taken,
        circuitFlipped,
      },
    },
    createdAt: now,
  });

  // Governance audit trail.
  await db.insert(billingEvents).values({
    id: crypto.randomUUID(),
    service: "offense",
    actionTaken: `Filed jules incident ${incidentId} from dispatch ${dispatch.id}${circuitFlipped ? ` (breaker ${scope} disabled)` : ""}.`,
    timestamp: now,
  });

  // Surface to the frontend notification feed. A notify failure must not roll
  // back the durable incident (mirror auto-break.ts).
  try {
    const ns = env.NOTIFICATIONS_AGENT as unknown as DurableObjectNamespace<NotificationsAgent>;
    const feed = await getAgentByName(ns, "global");
    await feed.add({
      type: circuitFlipped ? "error" : "warning",
      title: circuitFlipped ? `Project AI disabled: ${projectName}` : "Jules spend audit reported",
      body: reason,
      severity: circuitFlipped ? "error" : "warning",
      actor: "guardian.offense.jules",
      entityType: "circuit_break_event",
      entityId: incidentId,
      href: "/api/guardian/offense/incidents?status=active",
    });
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.offense.jules.notify", error: String(err) }),
    );
  }

  return { incidentId, circuitFlipped };
}

// ---------------------------------------------------------------------------
// Self-check — the pure recommendation classifier. Never runs in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const assert = (cond: boolean, m: string) => {
    if (!cond) throw new Error(m);
  };
  assert(recommendsDisable(["disable core-guardian access for project"]), "matches 'disable'");
  assert(recommendsDisable(["Recommend DISABLING the project breaker"]), "case-insensitive");
  assert(!recommendsDisable(["monitor only", "no action"]), "no false positive");
  assert(!recommendsDisable([]), "empty → no flip");
  // eslint-disable-next-line no-console
  console.log("ok — jules-dispatch recommendation classifier verified");
}
