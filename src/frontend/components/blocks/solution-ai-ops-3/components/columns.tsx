import { type ComponentProps } from "react"
import { Badge } from "~/components/reui/badge"
import { type DataGridFeatures } from "~/components/reui/data-grid/data-grid"
import { DataGridColumnHeader } from "~/components/reui/data-grid/data-grid-column-header"
import { type ColumnDef } from "@tanstack/react-table"

import { cn } from "~/lib/utils"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar"
import { Button } from "~/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import {
  type PromptItemRecord,
  type PromptPriority,
  type PromptStatus,
  type PromptType,
} from "./data"
import { EyeIcon, CircleCheckIcon, MoreHorizontalIcon, CopyIcon, FlagIcon } from "lucide-react"

export type PromptItemRowAction = "open" | "ready" | "copy" | "stale"

const dateFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
})

type PromptBadgeConfig = {
  variant: ComponentProps<typeof Badge>["variant"]
  dotClassName?: string
}

const PROMPT_BADGE_SIZE = "default" satisfies ComponentProps<
  typeof Badge
>["size"]

const priorityBadgeConfig: Record<PromptPriority, PromptBadgeConfig> = {
  Critical: {
    variant: "destructive-outline",
    dotClassName: "bg-rose-500 dark:bg-rose-400",
  },
  High: {
    variant: "warning-outline",
    dotClassName: "bg-amber-500 dark:bg-amber-400",
  },
  Medium: {
    variant: "outline",
    dotClassName: "bg-sky-500 dark:bg-sky-400",
  },
  Low: {
    variant: "outline",
    dotClassName: "bg-zinc-400 dark:bg-zinc-500",
  },
}

const statusBadgeConfig: Record<PromptStatus, PromptBadgeConfig> = {
  Draft: {
    variant: "info-outline",
    dotClassName: "bg-sky-500 dark:bg-sky-400",
  },
  Live: {
    variant: "success-outline",
    dotClassName: "bg-emerald-500 dark:bg-emerald-400",
  },
  "Review required": {
    variant: "warning-outline",
    dotClassName: "bg-amber-500 dark:bg-amber-400",
  },
  Stale: {
    variant: "destructive-outline",
    dotClassName: "bg-rose-500 dark:bg-rose-400",
  },
  Ready: {
    variant: "success-outline",
    dotClassName: "bg-emerald-500 dark:bg-emerald-400",
  },
}

const typeBadgeConfig: Record<PromptType, PromptBadgeConfig> = {
  Safety: {
    variant: "destructive-outline",
    dotClassName: "bg-rose-500 dark:bg-rose-400",
  },
  Evaluation: {
    variant: "info-outline",
    dotClassName: "bg-sky-500 dark:bg-sky-400",
  },
  Routing: {
    variant: "success-outline",
    dotClassName: "bg-emerald-500 dark:bg-emerald-400",
  },
  Owner: {
    variant: "focus-outline",
    dotClassName: "bg-violet-500 dark:bg-violet-400",
  },
}

export function formatPromptDate(value: string) {
  return dateFormatter.format(new Date(`${value}T00:00:00`))
}

function DotSeparator() {
  return (
    <span
      className="bg-muted-foreground/40 size-1 shrink-0 rounded-full"
      aria-hidden="true"
    />
  )
}

function PromptBadge({
  label,
  config,
  className,
}: {
  label: string
  config: PromptBadgeConfig
  className?: string
}) {
  return (
    <Badge
      variant={config.variant}
      size={PROMPT_BADGE_SIZE}
      className={cn("max-w-full min-w-0 shrink justify-start", className)}
    >
      {config.dotClassName ? (
        <span
          className={cn("size-1.5 shrink-0 rounded-full", config.dotClassName)}
          aria-hidden="true"
        />
      ) : null}
      <span className="truncate">{label}</span>
    </Badge>
  )
}

function PromptTitleCell({ item }: { item: PromptItemRecord }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-foreground truncate text-sm leading-5 font-medium">
        {item.title}
      </span>
      <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs leading-4">
        <span className="truncate">{item.source}</span>
        <DotSeparator />
        <span className="shrink-0 tabular-nums">
          Updated {formatPromptDate(item.updatedAt)}
        </span>
      </div>
    </div>
  )
}

function OwnerCell({ item }: { item: PromptItemRecord }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar className="size-8 shrink-0">
        <AvatarImage src={item.owner.avatarSrc} alt={item.owner.name} />
        <AvatarFallback>{item.owner.initials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.owner.name}</div>
        <div className="text-muted-foreground truncate text-sm">
          {item.owner.role}
        </div>
      </div>
    </div>
  )
}

function TypeCell({ type }: { type: PromptType }) {
  return <PromptTypeBadge type={type} />
}

export function PromptItemActions({
  item,
  onAction,
  className,
}: {
  item: PromptItemRecord
  onAction: (action: PromptItemRowAction, item: PromptItemRecord) => void
  className?: string
}) {
  return (
    <div className={cn("flex items-center justify-end gap-1", className)}>
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        aria-label={`Open ${item.title}`}
        onClick={(event) => {
          event.stopPropagation()
          onAction("open", item)
        }}
      >
        <EyeIcon aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        aria-label={`Mark ${item.title} ready`}
        onClick={(event) => {
          event.stopPropagation()
          onAction("ready", item)
        }}
      >
        <CircleCheckIcon aria-hidden="true" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label={`More actions for ${item.title}`}
              onClick={(event) => event.stopPropagation()}
            />
          }
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => onAction("copy", item)}>
              <CopyIcon aria-hidden="true" />
              Copy ID
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onAction("stale", item)}
            >
              <FlagIcon aria-hidden="true" />
              Flag stale
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function PromptPriorityBadge({
  priority,
  className,
}: {
  priority: PromptPriority
  className?: string
}) {
  return (
    <PromptBadge
      label={priority}
      config={priorityBadgeConfig[priority]}
      className={className}
    />
  )
}

export function PromptStatusBadge({
  status,
  className,
}: {
  status: PromptStatus
  className?: string
}) {
  return (
    <PromptBadge
      label={status}
      config={statusBadgeConfig[status]}
      className={className}
    />
  )
}

export function PromptTypeBadge({
  type,
  className,
}: {
  type: PromptType
  className?: string
}) {
  return (
    <PromptBadge
      label={type}
      config={typeBadgeConfig[type]}
      className={className}
    />
  )
}

function DateCell({
  value,
  muted = false,
}: {
  value: string
  muted?: boolean
}) {
  return (
    <span
      className={cn(
        "block truncate text-sm tabular-nums",
        muted && "text-muted-foreground"
      )}
      title={value}
    >
      {formatPromptDate(value)}
    </span>
  )
}

export function createPromptQueueColumns({
  onAction,
}: {
  onAction: (action: PromptItemRowAction, item: PromptItemRecord) => void
}): ColumnDef<DataGridFeatures, PromptItemRecord>[] {
  return [
    {
      accessorKey: "title",
      id: "title",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} visibility={true} />
      ),
      cell: ({ row }) => <PromptTitleCell item={row.original} />,
      size: 330,
      minSize: 260,
      enableSorting: true,
      enableHiding: false,
      enableResizing: true,
      meta: {
        headerTitle: "Prompt",
      },
    },
    {
      id: "owner",
      accessorFn: (row) => row.owner.name,
      header: ({ column }) => (
        <DataGridColumnHeader column={column} visibility={true} />
      ),
      cell: ({ row }) => <OwnerCell item={row.original} />,
      size: 210,
      minSize: 180,
      enableSorting: true,
      enableHiding: true,
      enableResizing: true,
      meta: {
        headerTitle: "Owner",
      },
    },
    {
      accessorKey: "priority",
      id: "priority",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} visibility={true} />
      ),
      cell: ({ row }) => (
        <PromptPriorityBadge priority={row.original.priority} />
      ),
      size: 118,
      enableSorting: true,
      enableHiding: true,
      enableResizing: true,
      meta: {
        headerTitle: "Risk",
      },
    },
    {
      accessorKey: "status",
      id: "status",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} visibility={true} />
      ),
      cell: ({ row }) => <PromptStatusBadge status={row.original.status} />,
      size: 130,
      enableSorting: true,
      enableHiding: true,
      enableResizing: true,
      meta: {
        headerTitle: "Status",
      },
    },
    {
      accessorKey: "type",
      id: "type",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} visibility={true} />
      ),
      cell: ({ row }) => <TypeCell type={row.original.type} />,
      size: 130,
      enableSorting: true,
      enableHiding: true,
      enableResizing: true,
      meta: {
        headerTitle: "Check",
      },
    },
    {
      accessorKey: "source",
      id: "source",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} visibility={true} />
      ),
      cell: ({ row }) => (
        <span className="text-muted-foreground block truncate text-sm leading-5">
          {row.original.source}
        </span>
      ),
      size: 160,
      enableSorting: true,
      enableHiding: true,
      enableResizing: true,
      meta: {
        headerTitle: "Source",
      },
    },
    {
      accessorKey: "dueAt",
      id: "dueAt",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} visibility={true} />
      ),
      cell: ({ row }) => <DateCell value={row.original.dueAt} />,
      sortFn: (rowA, rowB) =>
        new Date(rowA.original.dueAt).getTime() -
        new Date(rowB.original.dueAt).getTime(),
      size: 116,
      enableSorting: true,
      enableHiding: true,
      enableResizing: true,
      meta: {
        headerTitle: "Due",
      },
    },
    {
      id: "actions",
      header: ({ column }) => (
        <DataGridColumnHeader column={column} visibility={true} />
      ),
      cell: ({ row }) => (
        <PromptItemActions item={row.original} onAction={onAction} />
      ),
      size: 112,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Actions",
      },
    },
  ]
}