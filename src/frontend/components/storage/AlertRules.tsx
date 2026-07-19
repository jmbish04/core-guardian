/**
 * @fileoverview Alert Rules — declarative alert logic and auto-action config.
 *
 * Layout follows the ReUI "alert rules" block: grouped field rows with an icon,
 * title, status badge, description, and a severity/threshold selector per rule,
 * with an unsaved-changes badge and a validation banner above the save footer.
 * Rebuilt on this repo's local `@/components/ui` primitives.
 *
 * The safety model is the point of this screen, so it is visible rather than
 * implied:
 *  - A rule with no threshold shows "Set threshold" and cannot be enabled.
 *  - A rule with a mitigation shows "Dry run" until it is explicitly armed.
 *  - Arming is a separate confirm-gated action, not a field you can bulk-save.
 *  - Any edit to an armed rule disarms it (enforced server-side).
 */

"use client";

import {
  ActivityIcon,
  AlertCircleIcon,
  DatabaseZapIcon,
  HardDriveIcon,
  Loader2Icon,
  RotateCcwIcon,
  SaveIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TrendingUpIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { compactNumber, relativeTime } from "@/lib/format";

import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

type Severity = "info" | "moderate" | "significant" | "critical";
type Action = "notify" | "evict_r2" | "drop_vectorize" | "disable_topup";

type Rule = {
  id: string;
  name: string;
  description: string;
  service: string;
  comparator: "gt" | "gte" | "lt" | "lte";
  threshold: number | null;
  windowHours: number;
  severity: Severity;
  action: Action;
  actionTarget: string | null;
  armed: boolean;
  enabled: boolean;
  cooldownMinutes: number;
  lastFiredAt: number | null;
  createdAt: number;
  updatedAt: number;
};

const PANEL = "rounded-xl border border-border/60 bg-background/40";

/** Icon per action, so the row reads at a glance. */
const ACTION_ICON: Record<Action, React.ComponentType<{ className?: string }>> = {
  notify: ActivityIcon,
  evict_r2: HardDriveIcon,
  drop_vectorize: DatabaseZapIcon,
  disable_topup: TrendingUpIcon,
};

const ACTION_LABEL: Record<Action, string> = {
  notify: "Notify only",
  evict_r2: "Evict R2 bucket",
  drop_vectorize: "Drop Vectorize index",
  disable_topup: "Disable auto top-up",
};

const SEVERITY_HINT: Record<Severity, string> = {
  info: "Record it. No escalation.",
  moderate: "Worth a look this week.",
  significant: "Investigate today.",
  critical: "Page someone now.",
};

/** Status badge summarising a rule's readiness. */
function RuleStatus({ rule }: { rule: Rule }) {
  if (rule.threshold === null) {
    return (
      <Badge variant="outline" className="border-destructive/30 text-destructive">
        Set threshold
      </Badge>
    );
  }
  if (!rule.enabled) {
    return <Badge variant="secondary">Paused</Badge>;
  }
  if (rule.action !== "notify" && !rule.armed) {
    return (
      <Badge variant="outline" className="border-amber-500/30 text-amber-700 dark:text-amber-400">
        Dry run
      </Badge>
    );
  }
  if (rule.armed) {
    return (
      <Badge variant="outline" className="border-rose-500/30 text-rose-700 dark:text-rose-400">
        Armed
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
    >
      Active
    </Badge>
  );
}

export function AlertRules() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [draft, setDraft] = useState<Record<string, Partial<Rule>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [armTarget, setArmTarget] = useState<Rule | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ rules: Rule[] }>("/rules");
      setRules(data.rules);
      setDraft({});
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to manage alert rules."
          : err instanceof ApiError
            ? err.message
            : "Failed to load rules.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** A rule merged with any unsaved edits. */
  const merged = useCallback((rule: Rule): Rule => ({ ...rule, ...draft[rule.id] }), [draft]);

  const dirty = Object.keys(draft).length > 0;
  const needsThreshold = useMemo(
    () => rules.map(merged).filter((r) => r.threshold === null),
    [rules, merged],
  );

  function edit(id: string, patch: Partial<Rule>) {
    setDraft((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      for (const [id, patch] of Object.entries(draft)) {
        await apiSend("PATCH", `/rules/${id}`, patch);
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save rules.");
    } finally {
      setSaving(false);
    }
  }

  async function seed() {
    setSaving(true);
    try {
      await apiSend("POST", "/rules/seed");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to seed rules.");
    } finally {
      setSaving(false);
    }
  }

  async function setArmed(rule: Rule, armed: boolean) {
    await apiSend("POST", `/rules/${rule.id}/arm`, {
      armed,
      ...(armed ? { confirm: rule.name } : {}),
    });
    await load();
  }

  if (error && rules.length === 0) {
    return <p className={`${PANEL} p-6 text-sm text-muted-foreground`}>{error}</p>;
  }

  if (loading) {
    return (
      <div className={`${PANEL} flex items-center gap-2 p-6 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" />
        Loading alert rules…
      </div>
    );
  }

  const armedCount = rules.filter((r) => r.armed).length;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-xl font-semibold tracking-tight">Alert Rules</h2>
          <p className="text-sm text-muted-foreground">
            {rules.length} rules
            {needsThreshold.length > 0 && ` · ${needsThreshold.length} need setup`}
            {armedCount > 0 && ` · ${armedCount} armed`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <Badge
              variant="outline"
              className="border-amber-500/30 text-amber-700 dark:text-amber-400"
            >
              Unsaved changes
            </Badge>
          )}
          {rules.length === 0 && (
            <Button variant="outline" size="sm" onClick={() => void seed()} className="gap-2">
              <SparklesIcon className="size-4" />
              Seed from probe defaults
            </Button>
          )}
        </div>
      </header>

      {needsThreshold.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/[0.04] px-3 py-2.5">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="text-sm">
            <div className="font-medium">Threshold required</div>
            <div className="text-muted-foreground">
              {needsThreshold.map((r) => r.name).join(", ")} cannot run without a threshold.
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className={`${PANEL} overflow-hidden`}>
        {rules.map((raw, index) => {
          const rule = merged(raw);
          const Icon = ACTION_ICON[rule.action];
          const isDirty = Boolean(draft[rule.id]);
          return (
            <div key={rule.id}>
              {index > 0 && <Separator />}
              <div className="flex flex-col gap-3 px-5 py-4">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border-2 border-background bg-muted">
                    <Icon className="size-4 text-foreground" />
                  </span>

                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="font-medium">{rule.name}</span>
                      <RuleStatus rule={rule} />
                      {isDirty && (
                        <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                      )}
                    </div>
                    <p className="max-w-2xl text-sm text-muted-foreground">
                      <span className="font-mono text-xs">{rule.service}</span> ·{" "}
                      {ACTION_LABEL[rule.action]}
                      {rule.actionTarget && (
                        <>
                          {" → "}
                          <span className="font-mono text-xs">{rule.actionTarget}</span>
                        </>
                      )}
                      {rule.lastFiredAt && ` · last fired ${relativeTime(rule.lastFiredAt)}`}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 self-center">
                    <Select
                      value={rule.severity}
                      onValueChange={(value) => edit(rule.id, { severity: value as Severity })}
                    >
                      <SelectTrigger className="w-[180px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(SEVERITY_HINT) as Severity[]).map((severity) => (
                          <SelectItem key={severity} value={severity}>
                            <span className="flex flex-col items-start gap-px">
                              <span className="font-medium capitalize">{severity}</span>
                              <small className="text-xs text-muted-foreground">
                                {SEVERITY_HINT[severity]}
                              </small>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex flex-wrap items-end gap-3 pl-11">
                  <div className="flex flex-col gap-1.5">
                    <Label
                      htmlFor={`threshold-${rule.id}`}
                      className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground"
                    >
                      Threshold
                    </Label>
                    <Input
                      id={`threshold-${rule.id}`}
                      value={rule.threshold ?? ""}
                      onChange={(e) =>
                        edit(rule.id, {
                          threshold: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                      inputMode="decimal"
                      placeholder="Set a threshold"
                      aria-invalid={rule.threshold === null}
                      className={
                        rule.threshold === null
                          ? "w-44 font-mono ring-1 ring-destructive/40"
                          : "w-44 font-mono"
                      }
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
                      Cooldown
                    </Label>
                    <Input
                      value={rule.cooldownMinutes}
                      onChange={(e) => edit(rule.id, { cooldownMinutes: Number(e.target.value) })}
                      inputMode="numeric"
                      className="w-28 font-mono"
                    />
                  </div>

                  <div className="flex flex-1 items-end justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => edit(rule.id, { enabled: !rule.enabled })}
                    >
                      {rule.enabled ? "Pause" : "Resume"}
                    </Button>
                    {rule.action !== "notify" &&
                      (rule.armed ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-muted-foreground"
                          onClick={() => void setArmed(rule, false)}
                        >
                          Disarm
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          disabled={rule.threshold === null}
                          onClick={() => setArmTarget(rule)}
                        >
                          <ShieldCheckIcon className="size-3.5" />
                          Arm
                        </Button>
                      ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {rules.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No alert rules yet. Seed them from the probe registry's built-in thresholds to get a
            populated starting point.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {armedCount > 0
            ? `${armedCount} armed rule${armedCount === 1 ? "" : "s"} can change infrastructure without asking.`
            : "No rule is armed — every mitigation is dry-run until you arm it."}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            onClick={() => setDraft({})}
            disabled={!dirty || saving}
            className="gap-2"
          >
            <RotateCcwIcon className="size-4" />
            Discard
          </Button>
          <Button onClick={() => void save()} disabled={!dirty || saving} className="gap-2">
            {saving ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <SaveIcon className="size-4" />
            )}
            Save changes
          </Button>
        </div>
      </div>

      <ConfirmDeleteDialog
        open={Boolean(armTarget)}
        onOpenChange={(open) => !open && setArmTarget(null)}
        phrase={armTarget?.name ?? ""}
        title="Arm this rule?"
        description={
          armTarget ? (
            <>
              Once armed, this rule will run{" "}
              <span className="font-medium text-foreground">{ACTION_LABEL[armTarget.action]}</span>
              {armTarget.actionTarget && (
                <>
                  {" on "}
                  <span className="font-mono text-foreground">{armTarget.actionTarget}</span>
                </>
              )}{" "}
              automatically, with no human in the loop, whenever{" "}
              <span className="font-mono text-foreground">{armTarget.service}</span> exceeds{" "}
              {compactNumber(armTarget.threshold ?? 0)}. That action is irreversible. Editing the
              rule later disarms it again.
            </>
          ) : null
        }
        onConfirm={() => (armTarget ? setArmed(armTarget, true) : Promise.resolve())}
      />
    </div>
  );
}
