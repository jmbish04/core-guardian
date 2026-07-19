/**
 * @fileoverview Alert rule evaluation and auto-action execution.
 *
 * The cron collects usage readings, then hands them here. Each enabled rule is
 * compared against its probe's reading; a rule that trips records a
 * `billing_events` row and — only if it is `armed` — executes its mitigation.
 *
 * Safety properties, in order of importance:
 *  1. **Disarmed by default.** A new rule evaluates and records but never acts.
 *     `armed` must be set deliberately, per rule.
 *  2. **Cooldown.** A rule cannot fire again inside `cooldownMinutes`, so a
 *     sustained surge produces one action, not one per hour forever.
 *  3. **Unset threshold means inert.** A rule with `threshold = null` is never
 *     evaluated, regardless of `enabled`.
 *
 * @see {@link file://src/backend/db/schemas/governance/alert-rules.ts}
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { alertRules, billingEvents, type AlertRuleRow } from "@/backend/db/schema";
import { cfApi } from "@/backend/guardian/resources";

import type { UsageReading } from "./collect";

import { USAGE_PROBES } from "./probes";

/** Outcome of evaluating one rule. */
export type RuleOutcome = {
  ruleId: string;
  ruleName: string;
  service: string;
  tripped: boolean;
  /** Why the rule did not act, when it tripped but stayed inert. */
  suppressedBy: "cooldown" | "disarmed" | "notify_only" | null;
  actionTaken: string | null;
  actionError: string | null;
  value: number;
  threshold: number;
};

/** Applies a rule's comparator. */
function compare(value: number, comparator: string, threshold: number): boolean {
  switch (comparator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    default:
      return false;
  }
}

/**
 * Executes a rule's mitigation.
 *
 * @param env - Worker env
 * @param rule - The rule that tripped
 * @returns Description of what was executed
 * @throws Error when the target is missing or the Cloudflare API rejects it
 */
async function executeAction(env: Env, rule: AlertRuleRow): Promise<string> {
  switch (rule.action) {
    case "evict_r2": {
      if (!rule.actionTarget) throw new Error("evict_r2 requires an action target (bucket name).");
      const path = `/r2/buckets/${encodeURIComponent(rule.actionTarget)}/lifecycle`;
      // Merge, never replace — buckets carry a default multipart-abort rule.
      let existing: unknown[] = [];
      try {
        const current = await cfApi<{ rules?: unknown[] }>(env, path);
        existing = (current.result?.rules ?? []).filter(
          (r) => (r as { id?: string }).id !== "core-guardian-emergency-expire",
        );
      } catch {
        // No lifecycle configuration yet.
      }
      await cfApi(env, path, {
        method: "PUT",
        body: JSON.stringify({
          rules: [
            ...existing,
            {
              id: "core-guardian-emergency-expire",
              enabled: true,
              conditions: { prefix: "" },
              action: { type: "Expire", parameters: { days: 1 } },
            },
          ],
        }),
      });
      return `Auto-applied 1-day Expire lifecycle rule to R2 bucket "${rule.actionTarget}"`;
    }

    case "drop_vectorize": {
      if (!rule.actionTarget) {
        throw new Error("drop_vectorize requires an action target (index name).");
      }
      await cfApi(env, `/vectorize/v2/indexes/${encodeURIComponent(rule.actionTarget)}`, {
        method: "DELETE",
      });
      return `Auto-deleted Vectorize index "${rule.actionTarget}"`;
    }

    case "disable_topup": {
      await cfApi(env, "/ai-gateway/billing/topup/config", { method: "DELETE" });
      return "Auto-disabled AI Gateway auto top-up";
    }

    default:
      return "No action (notify only)";
  }
}

/**
 * Evaluates every enabled rule against the readings just collected.
 *
 * @param env - Worker env
 * @param readings - Probe readings from `collectUsage`
 * @returns One outcome per evaluated rule
 *
 * @remarks Never throws — a failing action is captured on the outcome so the
 * cron records it and continues to the next rule.
 */
export async function evaluateRules(env: Env, readings: UsageReading[]): Promise<RuleOutcome[]> {
  const db = getDb(env);
  const rules = await db.select().from(alertRules);
  const byService = new Map(readings.map((r) => [r.id, r]));
  const now = Date.now();
  const outcomes: RuleOutcome[] = [];

  for (const rule of rules) {
    // A rule with no threshold is inert regardless of `enabled`.
    if (!rule.enabled || rule.threshold === null) continue;

    const reading = byService.get(rule.service);
    if (!reading || reading.status !== "ok") continue;

    const tripped = compare(reading.value, rule.comparator, rule.threshold);
    if (!tripped) continue;

    const withinCooldown =
      rule.lastFiredAt !== null && now - rule.lastFiredAt < rule.cooldownMinutes * 60_000;

    const outcome: RuleOutcome = {
      ruleId: rule.id,
      ruleName: rule.name,
      service: rule.service,
      tripped: true,
      suppressedBy: withinCooldown
        ? "cooldown"
        : rule.action === "notify"
          ? "notify_only"
          : rule.armed
            ? null
            : "disarmed",
      actionTaken: null,
      actionError: null,
      value: reading.value,
      threshold: rule.threshold,
    };

    if (withinCooldown) {
      outcomes.push(outcome);
      continue;
    }

    // Always record that the rule tripped, whether or not it acted.
    const summary =
      `Rule "${rule.name}" tripped: ${reading.label} ${reading.value} ${rule.comparator} ` +
      `${rule.threshold} ${reading.unit}`;

    if (rule.action !== "notify" && rule.armed) {
      try {
        outcome.actionTaken = await executeAction(env, rule);
      } catch (err) {
        outcome.actionError = err instanceof Error ? err.message : String(err);
      }
    }

    await db.insert(billingEvents).values({
      id: crypto.randomUUID(),
      service: rule.service,
      actionTaken: outcome.actionError
        ? `${summary}. Action FAILED: ${outcome.actionError}`
        : outcome.actionTaken
          ? `${summary}. ${outcome.actionTaken}`
          : `${summary}. No action taken (${outcome.suppressedBy}).`,
      timestamp: now,
    });

    await db.update(alertRules).set({ lastFiredAt: now }).where(eq(alertRules.id, rule.id));
    outcomes.push(outcome);
  }

  return outcomes;
}

/**
 * Seed rules derived from the probe registry's built-in thresholds.
 *
 * Gives the operator a populated, editable starting point instead of an empty
 * table. Every seeded rule is `notify` + disarmed.
 *
 * @param env - Worker env
 * @returns Number of rules created (0 if rules already exist)
 */
export async function seedDefaultRules(env: Env): Promise<number> {
  const db = getDb(env);
  const existing = await db.select({ id: alertRules.id }).from(alertRules).limit(1);
  if (existing.length > 0) return 0;

  const now = Date.now();
  const rows = USAGE_PROBES.filter(
    (probe) => probe.dataset !== null && Number.isFinite(probe.alertThreshold),
  ).map((probe) => ({
    id: crypto.randomUUID(),
    name: `${probe.label} surge`,
    description: `${probe.label} above ${probe.alertThreshold} ${probe.unit} in 1h.`,
    service: probe.id,
    comparator: "gt" as const,
    threshold: probe.alertThreshold,
    windowHours: 1,
    severity: "moderate" as const,
    action: "notify" as const,
    actionTarget: null,
    armed: false,
    enabled: true,
    cooldownMinutes: 60,
    lastFiredAt: null,
    createdAt: now,
    updatedAt: now,
  }));

  // alert_rules has 15 columns; D1 caps bound parameters at 100, so insert 6
  // rows (90 params) at a time.
  for (let i = 0; i < rows.length; i += 6) {
    await db.insert(alertRules).values(rows.slice(i, i + 6));
  }
  return rows.length;
}
