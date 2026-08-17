/**
 * @fileoverview `syncWorkerProjects` — the P14a unified-project sync (zero AI).
 *
 * Reconciles the `guardian_projects` registry with reality in two passes:
 *
 *  1. **Workers.** `cfApi /workers/scripts` → upsert one row per script
 *     (kind='worker', is_active=1, last_seen=now). Operator metadata
 *     (`note`, `criticality`) is PRESERVED across syncs — only liveness +
 *     repo are refreshed. Any existing kind='worker' row NOT in the returned
 *     list is marked is_active=0 (its last_seen is kept as the tombstone).
 *
 *  2. **AI-only projects.** Distinct `ai_router_requests.project` values that
 *     are not already a project row are inserted as kind='ai_project'. These
 *     are callers that hit the AI Router without being one of our workers
 *     (outside apps, python, gas, …).
 *
 * Repo resolution: best-effort. Cloudflare Workers Builds connects a script to
 * a GitHub repo; we fetch the account's build triggers ONCE and map
 * script-id → owner/repo from whatever shape the (beta) API returns. If that
 * endpoint is unavailable or its shape is unrecognized, every repo is left null
 * and the miss is logged — it never blocks the sync.
 *
 * NO AI anywhere. Pure Cloudflare REST + D1 + arithmetic.
 *
 * @see {@link file://src/backend/guardian/resources.ts} for cfApi.
 */

import { and, eq, inArray, lt } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { aiRouterRequests, guardianProjects } from "@/backend/db/schema";
import { cfApi, listWorkerScriptIds } from "@/backend/guardian/resources";

/** Summary returned by {@link syncWorkerProjects} and surfaced on `POST /sync`. */
export interface SyncSummary {
  /** Workers returned by /workers/scripts this run. */
  workers: number;
  /** Worker rows upserted (created or refreshed). */
  workersUpserted: number;
  /** Previously-active worker rows flipped to is_active=0 (gone from the account). */
  workersDeactivated: number;
  /** Distinct ai_router_requests.project values considered. */
  aiProjects: number;
  /** New kind='ai_project' rows inserted (name not already a project). */
  aiProjectsInserted: number;
  /** Worker rows that got a repo resolved from the builds config. */
  reposResolved: number;
  syncedAt: number;
}

/**
 * Best-effort: map each Worker script id → its connected `owner/repo` from the
 * Cloudflare Workers Builds triggers. One account-scoped call; on any failure
 * (endpoint absent, shape unknown, token scope) returns an empty map and logs —
 * the caller then leaves `repo` null. Never throws.
 *
 * The Builds API is beta and its response shape has churned, so we read fields
 * defensively: the key comes from any of a few id fields, and the repo from a
 * `repo_connection` sub-object or flat repo fields, joined with an owner when
 * the repo name has no slash.
 */
async function loadWorkerRepoMap(env: Env): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { result } = await cfApi<Record<string, any>[]>(env, "/builds/triggers");
    for (const trigger of result ?? []) {
      const scriptId: string | undefined =
        trigger.external_script_id ?? trigger.script_name ?? trigger.worker_name ?? trigger.name;
      if (!scriptId) continue;

      const conn = trigger.repo_connection ?? trigger.repository ?? trigger;
      let repo: string | undefined =
        conn.repo_name ?? conn.name ?? conn.full_name ?? conn.repository;
      const owner: string | undefined =
        conn.provider_account_name ?? conn.repo_owner ?? conn.owner ?? conn.account_name;
      if (repo && !repo.includes("/") && owner) repo = `${owner}/${repo}`;
      if (repo && repo.includes("/")) map.set(scriptId, repo);
    }
  } catch (err) {
    // Endpoint/shape unclear or token lacks the scope — do not block the sync.
    console.warn(
      JSON.stringify({ level: "WARN", source: "guardian.projects.repoMap", error: String(err) }),
    );
  }
  return map;
}

/**
 * Reconcile `guardian_projects` with the live account.
 *
 * @param env - Worker env carrying the Secrets Store CF credentials + `DB`.
 * @returns Counts of what changed.
 */
export async function syncWorkerProjects(env: Env): Promise<SyncSummary> {
  const db = getDb(env);
  // Captured BEFORE any upsert: every live worker is written with lastSeen=now
  // (>= runStart), so the "< runStart" deactivation sweep can never catch one.
  const runStart = Date.now();
  const now = runStart;

  const [{ ids: workerNames, complete }, repoMap] = await Promise.all([
    listWorkerScriptIds(env),
    loadWorkerRepoMap(env),
  ]);

  // --- Pass 1: upsert workers ------------------------------------------------
  let workersUpserted = 0;
  let reposResolved = 0;
  for (const name of workerNames) {
    const repo = repoMap.get(name) ?? null;
    if (repo) reposResolved++;
    await db
      .insert(guardianProjects)
      .values({ name, kind: "worker", repo, isActive: true, lastSeen: now, createdAt: now })
      .onConflictDoUpdate({
        target: guardianProjects.name,
        // Refresh liveness + kind + repo; PRESERVE note/criticality (operator
        // intent). Never overwrite a resolved repo with null — a transient
        // builds-API miss shouldn't wipe a good value.
        set: {
          kind: "worker",
          isActive: true,
          lastSeen: now,
          ...(repo ? { repo } : {}),
        },
      });
    workersUpserted++;
  }

  // --- Deactivate workers that vanished from the account ---------------------
  // last_seen sweep: every live worker was just stamped last_seen=runStart, so a
  // kind='worker' row still carrying last_seen<runStart wasn't in this run → gone
  // → is_active=0 (its last_seen stays as the tombstone). No big IN list (D1 bound
  // -param safe). SKIP entirely on an incomplete fetch — never deactivate on a
  // partial worker list.
  let workersDeactivated = 0;
  if (complete) {
    const deactivated = await db
      .update(guardianProjects)
      .set({ isActive: false })
      .where(
        and(
          eq(guardianProjects.kind, "worker"),
          eq(guardianProjects.isActive, true),
          lt(guardianProjects.lastSeen, runStart),
        ),
      )
      .returning({ name: guardianProjects.name });
    workersDeactivated = deactivated.length;
  } else {
    console.warn(
      JSON.stringify({
        level: "WARN",
        source: "guardian.projects.sync",
        msg: "worker list incomplete — skipping deactivation sweep this run",
      }),
    );
  }

  // --- Pass 2: AI-only projects ----------------------------------------------
  const aiRows = await db
    .selectDistinct({ project: aiRouterRequests.project })
    .from(aiRouterRequests);
  const aiNames = aiRows.map((r) => r.project).filter((p): p is string => !!p);

  // Which of those names already exist as ANY project (worker or otherwise)?
  const existing =
    aiNames.length > 0
      ? await db
          .select({ name: guardianProjects.name })
          .from(guardianProjects)
          .where(inArray(guardianProjects.name, aiNames))
      : [];
  const existingSet = new Set(existing.map((e) => e.name));

  let aiProjectsInserted = 0;
  for (const name of aiNames) {
    if (existingSet.has(name)) continue;
    await db
      .insert(guardianProjects)
      .values({ name, kind: "ai_project", isActive: true, lastSeen: now, createdAt: now })
      // Dedupe by name defensively (two distinct-project rows can't collide, but
      // a concurrent worker upsert could) — do nothing if it now exists.
      .onConflictDoNothing({ target: guardianProjects.name });
    existingSet.add(name);
    aiProjectsInserted++;
  }

  return {
    workers: workerNames.length,
    workersUpserted,
    workersDeactivated,
    aiProjects: aiNames.length,
    aiProjectsInserted,
    reposResolved,
    syncedAt: now,
  };
}
