/**
 * @fileoverview Account Workers-plan setting (free | paid).
 *
 * Defaults to "paid" — the operator has a Workers Paid account, so exceeding an
 * included allowance is billable overage (a cost signal), not a hard cap (a
 * service-stopping crisis). The alert evaluator reads this to frame and grade
 * alerts correctly. Stored in the SESSIONS KV so it can be flipped at runtime
 * without a redeploy.
 */

import type { WorkersPlan } from "./allowances";

const PLAN_KEY = "guardian:workers-plan";

/** Read the configured plan; defaults to "paid". */
export async function getWorkersPlan(env: Env): Promise<WorkersPlan> {
  const v = await env.SESSIONS.get(PLAN_KEY).catch(() => null);
  return v === "free" ? "free" : "paid";
}

/** Set the plan (free | paid). */
export async function setWorkersPlan(env: Env, plan: WorkersPlan): Promise<void> {
  await env.SESSIONS.put(PLAN_KEY, plan);
}
