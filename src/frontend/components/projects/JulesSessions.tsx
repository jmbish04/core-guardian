/**
 * @fileoverview /dashboard/jules — Jules coding-session monitor.
 *
 * Table of every `jules_sessions` row (`GET /api/guardian/projects/jules/sessions`)
 * with a status filter and jump-out links to the live Jules session and its PR.
 * The status is filtered server-side so the poller's terminal/non-terminal split
 * stays authoritative.
 */

"use client";

import { ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiGet } from "@/lib/api";
import { relativeTime } from "@/lib/format";

import { EmptyState, InlineError } from "@/components/dashboard/shared";
import {
  JulesStatusBadge,
  LoadingRow,
  useResource,
  type JulesSession,
  type JulesStatus,
} from "./shared";

const STATUS_OPTIONS: { value: JulesStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "running", label: "Running" },
  { value: "stuck", label: "Stuck" },
  { value: "submitted", label: "Submitted" },
  { value: "failed", label: "Failed" },
  { value: "completed", label: "Completed" },
];

/** Compact icon-link that renders a dash when the URL is absent. */
function LinkOut({
  href,
  label,
  icon: Icon,
}: {
  href: string | null;
  label: string;
  icon: typeof ExternalLinkIcon;
}) {
  if (!href) return <span className="text-muted-foreground">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonVariants({ variant: "ghost", size: "sm" })}
    >
      <Icon className="size-3.5" />
      {label}
    </a>
  );
}

export function JulesSessions() {
  const [status, setStatus] = useState<JulesStatus | "all">("all");

  const fetcher = useCallback(
    () =>
      apiGet<{ sessions: JulesSession[] }>(
        `/guardian/projects/jules/sessions${status === "all" ? "" : `?status=${status}`}`,
      ).then((r) => r.sessions),
    [status],
  );
  const { data, loading, error, reload } = useResource(fetcher);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground" htmlFor="jules-status">
            Status
          </label>
          <Select value={status} onValueChange={(v) => setStatus(v as JulesStatus | "all")}>
            <SelectTrigger id="jules-status" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" onClick={reload} className="ml-auto">
          Refresh
        </Button>
      </div>

      {loading && !data ? (
        <LoadingRow label="Loading Jules sessions…" />
      ) : error ? (
        <InlineError message={error} onRetry={reload} />
      ) : !data || data.length === 0 ? (
        <EmptyState label="No Jules sessions match this filter." />
      ) : (
        <div className="overflow-x-auto rounded-md ring-1 ring-border/40">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Repo</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Links</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <JulesStatusBadge status={s.status} />
                  </TableCell>
                  <TableCell>
                    {s.project ? (
                      <a
                        href={`/dashboard/projects/${encodeURIComponent(s.project)}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {s.project}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{s.repo}</TableCell>
                  <TableCell className="text-muted-foreground">{relativeTime(s.createdAt)}</TableCell>
                  <TableCell className="text-muted-foreground">{relativeTime(s.updatedAt)}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <LinkOut href={s.sessionUrl} label="Session" icon={ExternalLinkIcon} />
                      <LinkOut href={s.prUrl} label="PR" icon={GitPullRequestIcon} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
