"use no memo"

import { memo, type ComponentProps } from "react"
import { Badge } from "@/components/reui/badge"
import { type DataGridFeatures } from "@/components/reui/data-grid/data-grid"
import { DataGridColumnHeader } from "@/components/reui/data-grid/data-grid-column-header"
import { type ColumnDef } from "@tanstack/react-table"

import { cn } from "@/lib/utils"
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Item, ItemMedia } from "@/components/ui/item"
import {
  AGENT_DETAILS,
  type AgentRun,
  type RunAttention,
  type RunEnvironment,
  type RunGroupRow,
  type RunItemRow,
  type RunOwner,
  type RunStatusId,
  type RunTableRow,
} from "./data"
import { ChevronRightIcon, ArrowRightIcon, CalendarClockIcon, MoreHorizontalIcon, EyeIcon, CopyIcon, RefreshCwIcon, PauseIcon } from "lucide-react"

export type RunAction = "open" | "copy" | "retry" | "pause"

const attentionVariant: Record<
  RunAttention,
  ComponentProps<typeof Badge>["variant"]
> = {
  Escalated: "destructive-light",
  "Needs approval": "warning-light",
  Retrying: "info-light",
  "On track": "success-light",
  Done: "secondary",
}

const environmentDotClass: Record<RunEnvironment, string> = {
  Production: "bg-primary",
  Staging: "bg-warning",
  Development: "bg-info",
}

const agentTileClass = "bg-background border-border text-foreground"

const statusDotClass: Record<RunStatusId, string> = {
  running: "bg-sky-500",
  waiting: "bg-muted-foreground/70",
  failed: "bg-destructive",
  completed: "bg-success",
}

function isRunRow(row: RunTableRow): row is RunItemRow {
  return row.kind === "run"
}

function getGroupRuns(row: RunGroupRow) {
  return row.subRows?.map((item) => item.run) ?? []
}

function getGroupAttention(runs: AgentRun[]): RunAttention {
  if (runs.some((run) => run.attention === "Escalated")) return "Escalated"
  if (runs.some((run) => run.attention === "Needs approval")) {
    return "Needs approval"
  }
  if (runs.some((run) => run.attention === "Retrying")) return "Retrying"
  if (runs.length > 0 && runs.every((run) => run.attention === "Done")) {
    return "Done"
  }

  return "On track"
}

function getLatestRun(runs: AgentRun[]) {
  return runs.reduce<AgentRun | undefined>((latest, run) => {
    if (!latest || run.startedAt.localeCompare(latest.startedAt) > 0) return run
    return latest
  }, undefined)
}

function getRunOwners(run: AgentRun) {
  if (run.owners.length > 0) return run.owners
  return run.owner ? [run.owner] : []
}

function stepRingColor(rate: number) {
  if (rate >= 75) return "text-emerald-500"
  if (rate >= 40) return "text-amber-500"
  return "text-rose-500"
}

const OwnerAvatar = memo(function OwnerAvatar({
  owner,
  className,
}: {
  owner: RunOwner | null
  className?: string
}) {
  return (
    <Avatar className={cn("size-5 shrink-0", className)}>
      {owner?.avatarSrc ? (
        <AvatarImage src={owner.avatarSrc} alt={owner.name} />
      ) : null}
      <AvatarFallback className="text-[9px]">
        {owner?.initials ?? "--"}
      </AvatarFallback>
    </Avatar>
  )
})

function EnvironmentBadge({ environment }: { environment: RunEnvironment }) {
  return (
    <Badge variant="outline" className="bg-background gap-1.5">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          environmentDotClass[environment]
        )}
        aria-hidden="true"
      />
      {environment}
    </Badge>
  )
}

function AttentionBadge({ attention }: { attention: RunAttention }) {
  return <Badge variant={attentionVariant[attention]}>{attention}</Badge>
}

function StatusMark({ statusId }: { statusId: RunStatusId }) {
  return (
    <span
      className={cn("size-2.5 shrink-0 rounded-full", statusDotClass[statusId])}
      aria-hidden="true"
    />
  )
}

function GroupExpandButton({
  label,
  expanded,
  onToggle,
}: {
  label: string
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
      aria-expanded={expanded}
      className="text-muted-foreground hover:text-foreground size-6 shrink-0 p-0 shadow-none"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onToggle()
      }}
    >
      <ChevronRightIcon className={cn(
                    "size-3.5 shrink-0 transition-transform duration-150",
                    expanded && "rotate-90"
                  )} aria-hidden="true" />
    </Button>
  )
}

function StatusGroupCell({
  row,
  expanded,
  onToggle,
}: {
  row: RunGroupRow
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div data-run-row="group" className="flex min-w-0 items-center gap-1.5">
      <GroupExpandButton
        label={row.group.label}
        expanded={expanded}
        onToggle={onToggle}
      />
      <StatusMark statusId={row.group.id} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-foreground shrink-0 truncate text-sm font-medium">
          {row.group.label}
        </span>
        <Badge variant="outline" className="shrink-0">
          {row.subRows?.length ?? 0}
        </Badge>
      </div>
    </div>
  )
}

function AgentIcon({ run }: { run: AgentRun }) {
  return (
    <Item
      render={<span />}
      className={cn(
        "p-0",
        "flex size-7 shrink-0 items-center justify-center border [&_svg]:opacity-95",
        agentTileClass
      )}
    >
      <ItemMedia variant="icon" className="size-auto">
        {AGENT_DETAILS[run.agent].icon}
      </ItemMedia>
    </Item>
  )
}

function RunTitleAffordance({ title }: { title: string }) {
  return (
    <span className="group/run-title flex min-w-0 items-center gap-1">
      <span
        data-slot="run-title"
        className="hover:text-primary text-foreground min-w-0 cursor-pointer truncate py-0.25 transition-colors"
      >
        {title}
      </span>
      <ArrowRightIcon className="size-3 shrink-0 -translate-x-1 opacity-0 transition-all group-hover/run-title:translate-x-0 group-hover/run-title:opacity-100" aria-hidden="true" />
    </span>
  )
}

function RunTitleCell({
  run,
  showContext,
}: {
  run: AgentRun
  showContext: boolean
}) {
  return (
    <div data-run-row="run" className="flex min-w-0 items-center gap-3">
      <AgentIcon run={run} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="min-w-0 text-sm leading-5 font-medium">
          <RunTitleAffordance title={run.title} />
        </div>
        {showContext ? (
          <p className="text-muted-foreground truncate text-xs leading-4">
            {run.context}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function RunCell({
  row,
  expanded,
  onToggle,
  showContext,
}: {
  row: RunTableRow
  expanded: boolean
  onToggle: () => void
  showContext: boolean
}) {
  if (isRunRow(row)) {
    return <RunTitleCell run={row.run} showContext={showContext} />
  }

  return <StatusGroupCell row={row} expanded={expanded} onToggle={onToggle} />
}

function OwnerCell({ run }: { run: AgentRun }) {
  const owners = getRunOwners(run)
  const visibleOwners = owners.slice(0, 3)
  const overflowCount = Math.max(0, owners.length - visibleOwners.length)

  if (owners.length === 0) {
    return (
      <div className="flex min-w-0 items-center justify-end">
        <OwnerAvatar owner={null} />
        <span className="sr-only">Unassigned owner</span>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center justify-end">
      <AvatarGroup
        aria-label={`Assigned owners for ${run.runKey}`}
        className="-space-x-1"
      >
        {visibleOwners.map((owner) => (
          <OwnerAvatar
            key={owner.id}
            owner={owner}
            className="ring-background ring-2"
          />
        ))}
        {overflowCount > 0 ? (
          <AvatarGroupCount className="bg-background size-5 border text-[9px] tabular-nums">
            +{overflowCount}
          </AvatarGroupCount>
        ) : null}
      </AvatarGroup>
      <span className="sr-only">
        {owners.map((owner) => owner.name).join(",")}
      </span>
    </div>
  )
}

function StartedCell({ run }: { run: AgentRun }) {
  return (
    <Badge variant="outline" className="bg-background gap-1.5 font-normal">
      <CalendarClockIcon className="text-muted-foreground size-3.5" aria-hidden="true" />
      <span className="tabular-nums">{run.startedLabel}</span>
    </Badge>
  )
}

function StepProgressCell({ run }: { run: AgentRun }) {
  if (run.stepProgress === null) {
    return (
      <div className="flex justify-end">
        <span className="text-muted-foreground text-sm tabular-nums">-</span>
      </div>
    )
  }

  const rate = run.stepProgress
  const radius = 9
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (rate / 100) * circumference

  return (
    <div
      className="flex items-center justify-end gap-2"
      aria-label={`${rate}% of steps complete`}
    >
      <svg
        viewBox="0 0 24 24"
        className={cn("size-5 shrink-0", stepRingColor(rate))}
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          className="stroke-border"
          strokeWidth="2.5"
        />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          className="stroke-current"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform="rotate(-90 12 12)"
        />
      </svg>
      <span className="text-foreground text-sm tabular-nums">{rate}%</span>
    </div>
  )
}

function GroupSummaryCell({ row }: { row: RunGroupRow }) {
  return (
    <div className="relative h-4 min-w-0">
      <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-0 w-80 max-w-[calc(100vw-8rem)] -translate-y-1/2 truncate text-right text-sm leading-4">
        {row.group.summary}
      </span>
    </div>
  )
}

function RunActionsCell({
  run,
  onAction,
}: {
  run: AgentRun
  onAction: (action: RunAction, run: AgentRun) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Actions for ${run.runKey}`}
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      {/* Content */}
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onAction("open", run)}>
            <EyeIcon aria-hidden="true" />
            Open run
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onAction("copy", run)}>
            <CopyIcon aria-hidden="true" />
            Copy run id
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onAction("retry", run)}>
            <RefreshCwIcon aria-hidden="true" />
            Retry run
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onAction("pause", run)}>
            <PauseIcon aria-hidden="true" />
            Pause run
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function createRunColumns({
  showContext,
  onAction,
}: {
  showContext: boolean
  onAction: (action: RunAction, run: AgentRun) => void
}): ColumnDef<DataGridFeatures, RunTableRow>[] {
  return [
    {
      accessorFn: (row) => (isRunRow(row) ? row.run.title : row.group.label),
      id: "run",
      header: ({ column }) => (
        <DataGridColumnHeader title="Run" column={column} />
      ),
      cell: ({ row }) => (
        <RunCell
          row={row.original}
          expanded={row.getIsExpanded()}
          onToggle={row.getToggleExpandedHandler()}
          showContext={showContext}
        />
      ),
      enableHiding: false,
      enableSorting: false,
      minSize: 300,
      meta: {
        headerTitle: "Run",
        autoSize: true,
      },
    },
    {
      accessorFn: (row) =>
        isRunRow(row)
          ? getRunOwners(row.run)
              .map((owner) => owner.name)
              .join(",") || "Unassigned"
          : row.group.focus,
      id: "owner",
      header: ({ column }) => (
        <DataGridColumnHeader title="Owner" column={column} />
      ),
      cell: ({ row }) =>
        isRunRow(row.original) ? (
          <OwnerCell run={row.original.run} />
        ) : (
          <span className="sr-only">{row.original.group.focus}</span>
        ),
      size: 120,
      enableSorting: false,
      meta: {
        headerTitle: "Owner",
      },
    },
    {
      accessorFn: (row) =>
        isRunRow(row) ? row.run.environment : row.group.focus,
      id: "environment",
      header: ({ column }) => (
        <DataGridColumnHeader title="Env" column={column} />
      ),
      cell: ({ row }) =>
        isRunRow(row.original) ? (
          <div className="flex justify-end">
            <EnvironmentBadge environment={row.original.run.environment} />
          </div>
        ) : (
          <span className="sr-only">{row.original.group.focus}</span>
        ),
      size: 96,
      enableSorting: false,
      meta: {
        headerTitle: "Env",
      },
    },
    {
      accessorFn: (row) =>
        isRunRow(row)
          ? row.run.startedAt
          : (getLatestRun(getGroupRuns(row))?.startedAt ?? ""),
      id: "started",
      header: ({ column }) => (
        <DataGridColumnHeader title="Started" column={column} />
      ),
      cell: ({ row }) => {
        if (isRunRow(row.original)) {
          return (
            <div className="flex justify-end">
              <StartedCell run={row.original.run} />
            </div>
          )
        }

        return (
          <span className="sr-only">
            Latest {getLatestRun(getGroupRuns(row.original))?.startedLabel}
          </span>
        )
      },
      size: 92,
      enableSorting: false,
      meta: {
        headerTitle: "Started",
      },
    },
    {
      accessorFn: (row) =>
        isRunRow(row)
          ? (row.run.stepProgress ?? -1)
          : Math.round(
              getGroupRuns(row).reduce(
                (sum, run) => sum + (run.stepProgress ?? 0),
                0
              ) / Math.max(getGroupRuns(row).length, 1)
            ),
      id: "steps",
      header: ({ column }) => (
        <DataGridColumnHeader title="Steps" column={column} />
      ),
      cell: ({ row }) => {
        if (isRunRow(row.original)) {
          return <StepProgressCell run={row.original.run} />
        }

        return null
      },
      size: 84,
      enableSorting: false,
      meta: {
        headerTitle: "Steps",
      },
    },
    {
      accessorFn: (row) =>
        isRunRow(row)
          ? row.run.attention
          : getGroupAttention(getGroupRuns(row)),
      id: "attention",
      header: ({ column }) => (
        <DataGridColumnHeader title="Attention" column={column} />
      ),
      cell: ({ row }) =>
        isRunRow(row.original) ? (
          <div className="flex justify-end">
            <AttentionBadge attention={row.original.run.attention} />
          </div>
        ) : (
          <span className="sr-only">
            {getGroupAttention(getGroupRuns(row.original))}
          </span>
        ),
      size: 80,
      enableSorting: false,
      meta: {
        headerTitle: "Attention",
      },
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) =>
        isRunRow(row.original) ? (
          <div className="flex justify-end">
            <RunActionsCell run={row.original.run} onAction={onAction} />
          </div>
        ) : (
          <GroupSummaryCell row={row.original} />
        ),
      size: 60,
      enableHiding: false,
      enableSorting: false,
    },
  ]
}