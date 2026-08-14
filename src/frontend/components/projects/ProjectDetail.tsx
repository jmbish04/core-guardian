/**
 * @fileoverview /dashboard/projects/[name] — the single-project viewport.
 *
 * Fetches `GET /api/guardian/projects/{name}` (project + its jules_sessions +
 * current circuit) and lays it out as tabs: Spend · Budget & circuit · Jules
 * sessions · Settings · Danger zone (worker projects only). Budget/circuit and
 * danger controls live in ./project-controls.
 */

"use client";

import { ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { relativeTime, shortDate, usd } from "@/lib/format";

import { EmptyState, InlineError } from "@/components/dashboard/shared";
import { CircuitPanel, DangerZone } from "./project-controls";
import {
  ActivePill,
  CriticalityBadge,
  JulesStatusBadge,
  KindBadge,
  LoadingRow,
  StatusBanner,
  type Circuit,
  type Criticality,
  type JulesSession,
  type Project,
  type Status,
} from "./shared";

type DetailResponse = {
  project: Project;
  julesSessions: JulesSession[];
  circuit: Circuit;
};

const CARD = "rounded-md bg-card/40 p-5 ring-1 ring-border/40";
const CRITICALITIES: Criticality[] = ["hobby", "normal", "important", "critical"];

function SettingsForm({ project, onSaved }: { project: Project; onSaved: (p: Project) => void }) {
  const [note, setNote] = useState(project.note ?? "");
  const [criticality, setCriticality] = useState<Criticality>(project.criticality);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const dirty = note !== (project.note ?? "") || criticality !== project.criticality;

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      const r = await apiSend<{ project: Project }>(
        "POST",
        `/guardian/projects/${encodeURIComponent(project.name)}/config`,
        { note: note.trim() === "" ? null : note.trim(), criticality },
      );
      onSaved(r.project);
      setStatus({ kind: "success", message: "Settings saved." });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof ApiError ? e.message : "Save failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={CARD}>
      <h3 className="text-base font-medium">Settings</h3>
      <StatusBanner status={status} className="mt-4" />
      <div className="mt-4 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="crit-select">Criticality</Label>
          <Select value={criticality} onValueChange={(v) => setCriticality(v as Criticality)}>
            <SelectTrigger id="crit-select" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CRITICALITIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Drives tightening priority when spend surges — critical projects survive longest.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="note-input">Operator note</Label>
          <Textarea
            id="note-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Freeform note about this project…"
          />
        </div>
        <div>
          <Button disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SpendPanel({ project }: { project: Project }) {
  return (
    <div className={CARD}>
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        Spend this month
      </div>
      <div className="mt-1 text-4xl font-semibold tabular-nums">{usd(project.spendThisMonthUsd)}</div>
      <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Last seen</dt>
          <dd className="mt-0.5">{relativeTime(project.lastSeen)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">First tracked</dt>
          <dd className="mt-0.5">{shortDate(project.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Kind</dt>
          <dd className="mt-0.5">
            <KindBadge kind={project.kind} />
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">
        Spend is the sum of AI Router request cost attributed to this project name for the current
        UTC month. Compute and non-routed provider cost are not included here.
      </p>
    </div>
  );
}

function JulesPanel({ sessions }: { sessions: JulesSession[] }) {
  if (sessions.length === 0)
    return <EmptyState label="No Jules sessions for this project yet." />;
  return (
    <ul className="flex flex-col divide-y divide-border/40 rounded-md bg-card/40 ring-1 ring-border/40">
      {sessions.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center gap-3 p-4">
          <JulesStatusBadge status={s.status} />
          <span className="font-mono text-xs text-muted-foreground">{s.repo}</span>
          <span className="text-xs text-muted-foreground">updated {relativeTime(s.updatedAt)}</span>
          <div className="ml-auto flex items-center gap-1">
            {s.sessionUrl ? (
              <a
                href={s.sessionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                <ExternalLinkIcon className="size-3.5" /> Session
              </a>
            ) : null}
            {s.prUrl ? (
              <a
                href={s.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                <GitPullRequestIcon className="size-3.5" /> PR
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ProjectDetail({ name }: { name: string }) {
  const fetcher = useCallback(
    () => apiGet<DetailResponse>(`/guardian/projects/${encodeURIComponent(name)}`),
    [name],
  );
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetcher()
      .then(setData)
      .catch((e) =>
        setError(
          e instanceof ApiError && e.status === 404
            ? `No project named "${name}".`
            : e instanceof ApiError
              ? e.message
              : "Failed to load project.",
        ),
      )
      .finally(() => setLoading(false));
  }, [fetcher, name]);

  useEffect(() => reload(), [reload]);

  if (loading && !data) return <LoadingRow label={`Loading ${name}…`} />;
  if (error) return <InlineError message={error} onRetry={reload} />;
  if (!data) return null;

  const { project, julesSessions, circuit } = data;
  const isWorker = project.kind === "worker";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{project.name}</h1>
        <KindBadge kind={project.kind} />
        <CriticalityBadge criticality={project.criticality} />
        <ActivePill active={project.isActive} />
        {project.repo ? (
          <a
            href={`https://github.com/${project.repo}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
          >
            {project.repo}
            <ExternalLinkIcon className="size-3" />
          </a>
        ) : null}
      </header>

      <Tabs defaultValue="spend">
        <TabsList variant="line" className="flex-wrap">
          <TabsTrigger value="spend">Spend</TabsTrigger>
          <TabsTrigger value="circuit">Budget &amp; circuit</TabsTrigger>
          <TabsTrigger value="jules">Jules sessions</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          {isWorker ? <TabsTrigger value="danger">Danger zone</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="spend">
          <SpendPanel project={project} />
        </TabsContent>
        <TabsContent value="circuit">
          <CircuitPanel project={project.name} circuit={circuit} onChanged={reload} />
        </TabsContent>
        <TabsContent value="jules">
          <JulesPanel sessions={julesSessions} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsForm
            project={project}
            onSaved={(p) => setData((d) => (d ? { ...d, project: p } : d))}
          />
        </TabsContent>
        {isWorker ? (
          <TabsContent value="danger">
            <DangerZone name={project.name} onChanged={reload} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
