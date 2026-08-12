/**
 * @fileoverview AI Router circuit breakers. Criteria + spend counters live in
 * CIRCUITS KV for low-latency pre-flight checks. D1 (ai_router_requests) is the
 * durable trail. Evaluation is hierarchical, first-trip-wins:
 * kill switch → global → provider → model → project.
 */
import type { BreakerVerdict, Circuit, CircuitScope, RouterRequest, Window } from "./types";

const KILL_KEY = "killswitch";

/** UTC window key. week = ISO-8601 `YYYY-Www`. total = "all". */
export function windowKey(window: Window, at: number): string {
  const d = new Date(at);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  if (window === "total") return "all";
  if (window === "month") return `${y}-${m}`;
  if (window === "day") return `${y}-${m}-${String(d.getUTCDate()).padStart(2, "0")}`;
  // ISO week
  const dt = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(dt.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((dt.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The four scopes a call is evaluated against, broad → narrow. */
export function scopesFor(req: { provider: string; model: string; project: string }): CircuitScope[] {
  return ["global", `provider:${req.provider}`, `model:${req.provider}/${req.model}`, `project:${req.project}`];
}

const circuitKey = (scope: CircuitScope) => `circuit:${scope}`;
const spendKey = (scope: CircuitScope, at: number, w: Window) => `spend:${scope}:${windowKey(w, at)}`;

export async function getKillSwitch(env: Env): Promise<boolean> {
  return (await env.CIRCUITS.get(KILL_KEY)) === "on";
}
export async function setKillSwitch(env: Env, on: boolean): Promise<void> {
  await env.CIRCUITS.put(KILL_KEY, on ? "on" : "off");
}
export async function getCircuit(env: Env, scope: CircuitScope): Promise<Circuit | null> {
  return (await env.CIRCUITS.get(circuitKey(scope), "json")) as Circuit | null;
}
export async function setCircuit(env: Env, scope: CircuitScope, c: Circuit): Promise<void> {
  await env.CIRCUITS.put(circuitKey(scope), JSON.stringify(c));
}
export async function deleteCircuit(env: Env, scope: CircuitScope): Promise<void> {
  await env.CIRCUITS.delete(circuitKey(scope));
}
async function readSpend(env: Env, scope: CircuitScope, at: number, w: Window): Promise<number> {
  return Number((await env.CIRCUITS.get(spendKey(scope, at, w))) ?? 0);
}

export async function evaluateBreakers(env: Env, req: RouterRequest, now: number): Promise<BreakerVerdict> {
  if (await getKillSwitch(env)) return { admitted: false, scope: "killswitch", message: "kill switch active" };
  for (const scope of scopesFor(req)) {
    const c = await getCircuit(env, scope);
    if (!c || !c.enabled) continue;
    if (c.breakGlassUntil && c.breakGlassUntil > now) continue;
    const spent = await readSpend(env, scope, now, c.window);
    if (spent >= c.budgetUsd) {
      return { admitted: false, scope, message: `circuit ${scope} over budget: $${spent.toFixed(4)} >= $${c.budgetUsd}` };
    }
  }
  return { admitted: true };
}

export async function incrementSpend(env: Env, req: RouterRequest, costUsd: number, now: number): Promise<void> {
  if (costUsd <= 0) return;
  for (const scope of scopesFor(req)) {
    const c = await getCircuit(env, scope);
    const w: Window = c?.window ?? "month"; // count under the circuit's window, else monthly
    const key = spendKey(scope, now, w);
    const prev = Number((await env.CIRCUITS.get(key)) ?? 0);
    await env.CIRCUITS.put(key, String(prev + costUsd));
  }
}

export async function breakGlass(env: Env, scope: CircuitScope, hours: number, now: number): Promise<void> {
  const c = (await getCircuit(env, scope)) ?? { budgetUsd: Infinity, window: "month" as Window, enabled: true };
  await setCircuit(env, scope, { ...c, breakGlassUntil: now + hours * 3_600_000 });
}

export async function listCircuits(env: Env): Promise<Array<{ scope: string; circuit: Circuit; spent: number }>> {
  const out: Array<{ scope: string; circuit: Circuit; spent: number }> = [];
  const list = await env.CIRCUITS.list({ prefix: "circuit:" });
  const now = Date.now();
  for (const k of list.keys) {
    const scope = k.name.slice("circuit:".length);
    const c = await getCircuit(env, scope);
    if (c) out.push({ scope, circuit: c, spent: await readSpend(env, scope, now, c.window) });
  }
  return out;
}

if (import.meta.main) {
  const eq = (a: unknown, b: unknown, m: string) => { if (a !== b) throw new Error(`${m}: got ${a}, want ${b}`); };
  eq(windowKey("month", Date.UTC(2026, 7, 11)), "2026-08", "month key");
  eq(windowKey("day", Date.UTC(2026, 7, 1)), "2026-08-01", "day key");
  eq(windowKey("total", Date.now()), "all", "total key");
  eq(windowKey("week", Date.UTC(2025, 11, 31)), "2026-W01", "week key year-boundary");
  const s = scopesFor({ provider: "openai", model: "gpt-5", project: "acre" });
  eq(s[0], "global", "scope0"); eq(s[2], "model:openai/gpt-5", "scope2"); eq(s[3], "project:acre", "scope3");
  // eslint-disable-next-line no-console
  console.log("ok — circuits pure helpers verified");
}
