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

import { and, eq, gt } from "drizzle-orm";

import { getDb } from "@/backend/db";
import {
  billingEvents,
  circuitBreakEvents,
  julesDispatches,
  julesSessions,
  scanTargets,
  type CircuitBreakAction,
  type ScanTargetRow,
} from "@/backend/db/schema";
import { NotificationsAgent } from "@/backend/ai/agents/NotificationsAgent";
import { getCircuit, setCircuit, type CircuitScope } from "@/backend/guardian/ai-router/circuits";
import type { JulesDispatchRow } from "@/backend/db/schemas/governance/offense/jules-dispatches";
import { getSecret, getSecretStoreBinding } from "@/backend/utils/secrets";
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
  /** The `circuit_break_events` incident filed, or null if the nonce was already spent/expired. */
  incidentId: string | null;
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
 *   Optional: {@link dispatchToJules} needs the nonce *before* it can create the
 *   session, so it inserts with `""` and UPDATEs the real id after POST /sessions.
 * @param args.targetId - The scan_targets row being audited, if known.
 * @returns the new dispatch `id` and its `nonce`.
 */
export async function createJulesDispatch(
  env: Env,
  args: { julesSessionId?: string | null; targetId?: string | null },
): Promise<{ id: string; nonce: string }> {
  const db = getDb(env);
  const id = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  await db.insert(julesDispatches).values({
    id,
    nonce,
    julesSessionId: args.julesSessionId ?? "",
    targetId: args.targetId ?? null,
    taskType: "spend_audit",
    status: "pending",
    dispatchedAt: Date.now(),
  });
  return { id, nonce };
}

// ---------------------------------------------------------------------------
// Outbound dispatch (P5) — hand a flagged target to the Jules REST API
// ---------------------------------------------------------------------------

/** Jules public API base (v1alpha). Auth is the `X-Goog-Api-Key` header. */
const JULES_BASE = "https://jules.googleapis.com/v1alpha";

/** Outcome of one {@link dispatchToJules} run (never throws — errors are values). */
export interface DispatchResult {
  ok: boolean;
  /** The pending `jules_dispatches` row minted for this attempt (null if we never got that far). */
  dispatchId: string | null;
  /** The Jules session id, once created. */
  julesSessionId: string | null;
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
}

/**
 * Derive `{owner, repo}` from a scan_targets row's `name`. For github_action
 * targets `name` is the repo full_name (`owner/repo`); a worker target only
 * qualifies if its name is already in that shape. Anything else is undispatchable.
 */
function parseOwnerRepo(name: string): { owner: string; repo: string } | null {
  const m = name.trim().match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * The self-contained audit brief handed to Jules. Real newlines via a template
 * literal (house rule: never `.join("\n")`). The nonce is embedded as the ONLY
 * credential for the findings callback; Jules is told not to leak the URL.
 */
function buildAuditPrompt(args: {
  owner: string;
  repo: string;
  findingsUrl: string;
  nonce: string;
}): string {
  const { owner, repo, findingsUrl, nonce } = args;
  return `You are auditing the GitHub repository ${owner}/${repo} on behalf of core-guardian, an automated Cloudflare spend watchdog. Your job is to find and disable code that runs up the AI bill without reporting through core-guardian.

AUDIT for these spend violations:
1. Cron / scheduled AI: is a cron schedule (GitHub Actions \`schedule:\`, a Worker cron trigger, launchd/cron, etc.) driving an AI operation? A schedule multiplies the billable blast radius, so flag every scheduled path that reaches an AI call.
2. Guardian bypass: does any AI integration bypass core-guardian's AI endpoint (https://core-guardian.hacolby.workers.dev/api/guardian/ai-router/run)?
   - If the call goes through Cloudflare AI Gateway: are \`cf-aig-metadata\` tags present on the request so core-guardian can attribute the spend? Missing metadata is a violation.
   - If the call uses raw Cloudflare Workers AI (\`env.AI.run\`, \`@cf/...\`) or a provider-native API (OpenAI, Anthropic, Google, OpenRouter, etc.) directly: is that usage reported to core-guardian at all? If not, it is a violation.

REMEDIATE: for every violation you find, COMMENT OUT the offending code to disable it (do not delete it), then open a pull request with those changes. Do not merge the PR.

REPORT: after opening the PR, call the findings API EXACTLY ONCE with curl:
  curl -X POST '${findingsUrl}' \\
    -H 'Content-Type: application/json' \\
    -d '<json>'
where <json> is:
{
  "repo": "${owner}/${repo}",
  "repo_type": "<github_action|worker|py|gas|...>",
  "worker_name": "<from wrangler.jsonc name, or omit>",
  "cron_audit_findings": [],
  "ai_audit_findings": [],
  "pr_number": <the PR number you opened>,
  "actions_taken": [],
  "circuit_breaker_recommendation": [],
  "core_guardian_project_identification": { "projectName": "<from config/metadata>", "projectType": "<worker|action|...>" },
  "nonce": "${nonce}"
}
Fill cron_audit_findings, ai_audit_findings, and actions_taken with your findings. For circuit_breaker_recommendation: ONLY if you determine this project's AI access must be disabled to stop runaway spend, include the EXACT token "DISABLE_AI_ACCESS" as an element of the array (you may add human-readable strings alongside it). If disabling is not warranted, leave circuit_breaker_recommendation empty — do not include the token in any negative or explanatory sentence. If you find no violations, still report once with empty finding arrays.

SECURITY: the nonce above is a one-time secret that authenticates this report. Do NOT reference, print, log, or include the findings API URL or the nonce anywhere in the pull request, commit messages, code comments, or PR description. Use them only in the single curl call above.`;
}

/** Mark a dispatch failed (best-effort; used when the Jules call errors). */
async function markDispatchFailed(env: Env, dispatchId: string): Promise<void> {
  await getDb(env)
    .update(julesDispatches)
    .set({ status: "failed" })
    .where(eq(julesDispatches.id, dispatchId));
}

/**
 * Dispatch a Jules spend-audit session for a flagged scan target.
 *
 * Ordering (the nonce must exist before the prompt is built, the session id only
 * exists after the API responds):
 *   1. resolve owner/repo + read JULES_API_KEY,
 *   2. mint the nonce + insert a `pending` dispatch row (session id ""),
 *   3. POST /sessions with the nonce-carrying brief,
 *   4. UPDATE the row with the returned jules_session_id.
 * Any Jules API failure marks the dispatch `failed` and is returned as a value —
 * this never throws.
 *
 * @param env - Worker env (D1, JULES_API_KEY Secrets Store binding, WORKER_BASE_URL).
 * @param target - The scan_targets row to audit (github_action, or a worker whose
 *   name is already `owner/repo`).
 */
export async function dispatchToJules(env: Env, target: ScanTargetRow): Promise<DispatchResult> {
  // Only github_action targets carry a trustworthy repo full_name (from the
  // GitHub scan of the owner's own account). A worker's name is a script id, and
  // a worker literally named "owner/repo" would otherwise aim Jules at an
  // arbitrary repository — refuse anything but github_action.
  if (target.kind !== "github_action") {
    return {
      ok: false,
      dispatchId: null,
      julesSessionId: null,
      error: `Only github_action targets are dispatchable to Jules (got kind=${target.kind}); worker→repo mapping is not yet available.`,
    };
  }
  const parsed = parseOwnerRepo(target.name);
  if (!parsed) {
    return {
      ok: false,
      dispatchId: null,
      julesSessionId: null,
      error: `Cannot resolve a GitHub owner/repo from target "${target.name}" (kind=${target.kind}). Only targets whose name is "owner/repo" are dispatchable.`,
    };
  }
  const { owner, repo } = parsed;

  // Secret Store bindings are async .get(); local-dev plain-var fallback.
  const apiKey =
    (await getSecretStoreBinding(env, "JULES_API_KEY")) ?? getSecret(env, "JULES_API_KEY");
  if (!apiKey) {
    return {
      ok: false,
      dispatchId: null,
      julesSessionId: null,
      error: "JULES_API_KEY is not configured (no Secrets Store binding, no local var).",
    };
  }

  // Mint the nonce + pending row first — the prompt needs the nonce, the row's
  // session id is backfilled after the API responds.
  const { id: dispatchId, nonce } = await createJulesDispatch(env, {
    julesSessionId: "",
    targetId: target.id,
  });

  try {
    const prompt = buildAuditPrompt({
      owner,
      repo,
      findingsUrl: `${env.WORKER_BASE_URL}/api/guardian/offense/findings`,
      nonce,
    });
    const res = await fetch(`${JULES_BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
      body: JSON.stringify({
        prompt,
        sourceContext: {
          // ponytail: assume the default branch is `main` (scan_targets doesn't
          // store it); pass the real branch here if that ever bites.
          source: `sources/github/${owner}/${repo}`,
          githubRepoContext: { startingBranch: "main" },
        },
        // Auto-approve the plan (unattended) and open a PR — but never auto-merge.
        automationMode: "AUTO_CREATE_PR",
        title: `core-guardian spend audit — ${owner}/${repo}`,
      }),
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      await markDispatchFailed(env, dispatchId);
      return {
        ok: false,
        dispatchId,
        julesSessionId: null,
        error: `Jules session create failed (${res.status}): ${detail || res.statusText}`,
      };
    }

    const json = (await res.json().catch(() => null)) as { id?: string; name?: string } | null;
    // Response is `{ name: "sessions/<id>", id: "<id>", ... }`.
    const sessionId = json?.id ?? json?.name?.split("/").pop() ?? "";
    if (!sessionId) {
      await markDispatchFailed(env, dispatchId);
      return {
        ok: false,
        dispatchId,
        julesSessionId: null,
        error: "Jules session create returned no session id.",
      };
    }

    await getDb(env)
      .update(julesDispatches)
      .set({ julesSessionId: sessionId })
      .where(eq(julesDispatches.id, dispatchId));

    // P14a: record the session so the /jules lifecycle poller can track it from
    // pending → terminal. Best-effort — a session-row failure must not fail the
    // dispatch (the dispatch/nonce is the load-bearing part).
    try {
      await getDb(env)
        .insert(julesSessions)
        .values({
          id: crypto.randomUUID(),
          sessionId,
          dispatchId,
          project: target.workerName ?? null,
          repo: `${owner}/${repo}`,
          status: "pending",
          sessionUrl: `https://jules.google.com/session/${sessionId}`,
        });
    } catch (err) {
      console.error(
        JSON.stringify({ level: "ERROR", source: "guardian.offense.jules.session", error: String(err) }),
      );
    }

    return { ok: true, dispatchId, julesSessionId: sessionId };
  } catch (err) {
    await markDispatchFailed(env, dispatchId).catch(() => {});
    return {
      ok: false,
      dispatchId,
      julesSessionId: null,
      error: `Jules dispatch error: ${String(err)}`,
    };
  }
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
  // Structured token ONLY — never a free-text substring. An LLM writing
  // "do NOT recommend disabling" must not trip an outage, so we require the exact
  // opt-in token Jules is instructed to emit.
  return recommendations.some((r) => r.trim().toUpperCase() === "DISABLE_AI_ACCESS");
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
  const NONCE_TTL_MS = 2 * 60 * 60 * 1000; // pending dispatches expire after 2h

  // ATOMIC claim: spend the nonce as the FIRST write, guarded on still-pending
  // AND not expired, and CHECK the result. Concurrent/replayed reports race on
  // this single UPDATE — only the row-changing winner proceeds, so incidents,
  // breaker flips, and notifications never double-fire.
  const claimed = await db
    .update(julesDispatches)
    .set({
      status: "reported",
      reportedAt: now,
      findings: findings as unknown as Record<string, unknown>,
    })
    .where(
      and(
        eq(julesDispatches.id, dispatch.id),
        eq(julesDispatches.status, "pending"),
        gt(julesDispatches.dispatchedAt, now - NONCE_TTL_MS),
      ),
    )
    .returning({ id: julesDispatches.id });
  if (claimed.length === 0) {
    // Lost the race, already reported, or the nonce expired → no side effects.
    return { incidentId: null, circuitFlipped: false };
  }

  const ident = findings.core_guardian_project_identification;
  const projectName = ident?.projectName?.trim();
  const wantsDisable = recommendsDisable(findings.circuit_breaker_recommendation);
  const scope = projectName ? `project:${projectName}` : null;

  // ANTI-INJECTION: the circuit scope must be tied to the DISPATCHED target, not
  // to whatever project name Jules echoed out of untrusted repo content. Only
  // auto-flip when the reported projectName matches a trusted identity of the
  // target we actually dispatched (its worker_name or repo name). A mismatch is
  // filed for the operator, but nothing is auto-broken — a malicious repo can't
  // name a victim project and DoS it.
  let projectMatchesTarget = false;
  if (projectName && dispatch.targetId) {
    const [t] = await db
      .select({ name: scanTargets.name, workerName: scanTargets.workerName })
      .from(scanTargets)
      .where(eq(scanTargets.id, dispatch.targetId))
      .limit(1);
    const trusted = [t?.workerName, t?.name]
      .filter((v): v is string => !!v)
      .map((v) => v.toLowerCase());
    projectMatchesTarget = trusted.includes(projectName.toLowerCase());
  }

  // Auto-act: flip the breaker to a $0 budget only when Jules emitted the
  // structured DISABLE_AI_ACCESS token AND the project matches the dispatched
  // target. Snapshot any prior circuit so an operator override can RESTORE it.
  const actionsTaken: CircuitBreakAction[] = [];
  let circuitFlipped = false;
  let priorCircuit: unknown = null;
  if (wantsDisable && projectName && scope && projectMatchesTarget) {
    priorCircuit = await getCircuit(env, scope as CircuitScope);
    await setCircuit(env, scope as CircuitScope, { budgetUsd: 0, window: "month", enabled: true });
    circuitFlipped = true;
    actionsTaken.push({
      kind: "circuit_break",
      detail: `Flipped ${scope} to a $0 monthly budget — Jules recommended disabling this project's AI access.`,
      at: now,
    });
  } else if (wantsDisable && projectName && !projectMatchesTarget) {
    actionsTaken.push({
      kind: "jules_action",
      detail: `Jules recommended disabling "${projectName}", but it does not match the dispatched target — NOT auto-flipped; operator review required.`,
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
        priorCircuit,
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
  assert(recommendsDisable(["DISABLE_AI_ACCESS"]), "exact structured token matches");
  assert(recommendsDisable(["disabled per audit", "disable_ai_access"]), "token among strings, ci");
  assert(
    !recommendsDisable(["I do NOT recommend disabling this project's AI access"]),
    "free-text negation must NOT trip an outage",
  );
  assert(!recommendsDisable(["monitor only", "no action"]), "no false positive");
  assert(!recommendsDisable([]), "empty → no flip");

  // owner/repo resolution
  assert(parseOwnerRepo("jmbish04/codra")?.repo === "codra", "parses owner/repo");
  assert(parseOwnerRepo("jmbish04/codra.git")?.repo === "codra", "strips .git");
  assert(parseOwnerRepo("just-a-worker-name") === null, "rejects non-owner/repo");
  assert(parseOwnerRepo("a/b/c") === null, "rejects deep paths");

  // the nonce (and not the URL) must be carried; the brief must forbid leaking it
  const prompt = buildAuditPrompt({
    owner: "o",
    repo: "r",
    findingsUrl: "https://x/api/guardian/offense/findings",
    nonce: "NONCE-123",
  });
  assert(prompt.includes("NONCE-123"), "prompt carries the nonce");
  assert(/Do NOT reference/i.test(prompt), "prompt forbids leaking the URL/nonce in the PR");

  // eslint-disable-next-line no-console
  console.log("ok — jules-dispatch recommendation classifier + dispatch helpers verified");
}
