import { Badge } from "~/components/reui/badge"
import { type DataGridFeatures } from "~/components/reui/data-grid/data-grid"
import { DataGridTableDndRowHandle } from "~/components/reui/data-grid/data-grid-table-dnd-rows"
import { Row, type ColumnDef } from "@tanstack/react-table"

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
import { Item, ItemMedia } from "~/components/ui/item"
import { type BacklogItem, type BacklogStatus, type BacklogType } from "./data"
import { SparklesIcon, ShieldCheckIcon, FlaskConicalIcon, WrenchIcon, FlagIcon, MoreHorizontalIcon, ArrowUpIcon, ArrowDownIcon, Trash2Icon } from "lucide-react"

export type BacklogRowAction = "move-top" | "move-bottom" | "remove"

// ── Status badge (label carries the signal; color is redundant, not the only cue) ──

const statusVariant: Record<
  BacklogStatus,
  | "primary-outline"
  | "info-outline"
  | "success-outline"
  | "destructive-outline"
  | "outline"
> = {
  "In Progress": "primary-outline",
  "In Review": "info-outline",
  Ready: "success-outline",
  Blocked: "destructive-outline",
  Planned: "outline",
}

export function StatusBadge({ status }: { status: BacklogStatus }) {
  return <Badge variant={statusVariant[status]}>{status}</Badge>
}

// ── Type marker (icon shape + label distinguish type; icon stays muted texture) ──

function TypeIcon({ type }: { type: BacklogType }) {
  if (type === "Feature") {
    return (
      <SparklesIcon className="size-3.5 shrink-0" aria-hidden="true" />
    )
  }

  if (type === "Security") {
    return (
      <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
    )
  }

  if (type === "Research") {
    return (
      <FlaskConicalIcon className="size-3.5 shrink-0" aria-hidden="true" />
    )
  }

  return (
    <WrenchIcon className="size-3.5 shrink-0" aria-hidden="true" />
  )
}

function TaskCell({ item }: { item: BacklogItem }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Item className="border-background bg-muted [&_svg]:text-accent-foreground flex size-8 shrink-0 items-center justify-center border-2 p-0 shadow-[0_1px_3px_0_rgba(0,0,0,0.14)] dark:border [&_svg]:size-3.5">
        <ItemMedia variant="icon" className="size-auto">
          <TypeIcon type={item.type} />
        </ItemMedia>
      </Item>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground truncate text-sm font-medium">
          {item.title}
        </span>
        <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          <span className="tabular-nums">{item.ref}</span>
          <span
            aria-hidden
            className="bg-muted-foreground/40 size-1 shrink-0 rounded-full"
          />
          <span className="truncate">{item.type}</span>
        </span>
      </div>
    </div>
  )
}

function OwnerCell({ item }: { item: BacklogItem }) {
  const initials = item.owner.name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar className="size-6">
        {item.owner.avatar ? (
          <AvatarImage src={item.owner.avatar} alt="" />
        ) : null}
        <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
      </Avatar>
      <span className="text-foreground min-w-0 truncate text-sm">
        {item.owner.name}
      </span>
    </div>
  )
}

function TeamCell({ item }: { item: BacklogItem }) {
  return (
    <span className="text-foreground block min-w-0 truncate text-sm">
      {item.team}
    </span>
  )
}

function CycleCell({ item }: { item: BacklogItem }) {
  return (
    <span className="text-muted-foreground block min-w-0 truncate text-sm">
      {item.cycle}
    </span>
  )
}

function DueDateCell({ item }: { item: BacklogItem }) {
  return (
    <span className="text-foreground text-sm tabular-nums">{item.dueDate}</span>
  )
}

function RankCell({ rank }: { rank: number }) {
  if (rank === 1) {
    return (
      <span className="text-primary inline-flex items-center gap-1 text-sm font-semibold tabular-nums">
        <FlagIcon className="size-3.5 shrink-0" aria-hidden="true" />
        1
      </span>
    )
  }

  return (
    <span className="text-muted-foreground text-sm tabular-nums">{rank}</span>
  )
}

function ActionsCell({
  item,
  rank,
  total,
  onAction,
}: {
  item: BacklogItem
  rank: number
  total: number
  onAction: (action: BacklogRowAction, item: BacklogItem) => void
}) {
  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={`Actions for ${item.title}`}
            />
          }
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" className="w-44">
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={rank === 1}
              onClick={() => onAction("move-top", item)}
            >
              <ArrowUpIcon className="size-4" aria-hidden="true" />
              Move to top
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={rank === total}
              onClick={() => onAction("move-bottom", item)}
            >
              <ArrowDownIcon className="size-4" aria-hidden="true" />
              Move to bottom
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onAction("remove", item)}
          >
            <Trash2Icon className="size-4" aria-hidden="true" />
            Remove from sprint
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function createBacklogColumns({
  total,
  onAction,
}: {
  total: number
  onAction: (action: BacklogRowAction, item: BacklogItem) => void
}): ColumnDef<DataGridFeatures, BacklogItem>[] {
  return [
    {
      id: "drag",
      header: () => <span className="sr-only">Reorder</span>,
      cell: () => <DataGridTableDndRowHandle />,
      size: 44,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Reorder",
        cellClassName: "pe-0!",
      },
    },
    {
      id: "rank",
      header: "#",
      cell: ({ row }: { row: Row<DataGridFeatures, BacklogItem> }) => (
        <RankCell rank={row.index + 1} />
      ),
      // Sized to its widest cell: the flagged first rank measures 27px and the
      // cell carries 8px of trailing padding, so 40 fits it with slack while
      // giving the space back to Task.
      size: 40,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Priority",
        cellClassName: "ps-0!",
        headerClassName: "ps-0!",
      },
    },
    {
      accessorKey: "title",
      id: "task",
      header: "Task",
      cell: ({ row }: { row: Row<DataGridFeatures, BacklogItem> }) => (
        <TaskCell item={row.original} />
      ),
      size: 260,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Task",
      },
    },
    {
      accessorKey: "owner",
      id: "owner",
      header: "Owner",
      cell: ({ row }: { row: Row<DataGridFeatures, BacklogItem> }) => (
        <OwnerCell item={row.original} />
      ),
      size: 165,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Owner",
      },
    },
    {
      accessorKey: "team",
      id: "team",
      header: "Team",
      cell: ({ row }: { row: Row<DataGridFeatures, BacklogItem> }) => (
        <TeamCell item={row.original} />
      ),
      size: 130,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Team",
      },
    },
    {
      accessorKey: "cycle",
      id: "cycle",
      header: "Cycle",
      cell: ({ row }: { row: Row<DataGridFeatures, BacklogItem> }) => (
        <CycleCell item={row.original} />
      ),
      size: 110,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Cycle",
      },
    },
    {
      accessorKey: "dueDate",
      id: "dueDate",
      header: "Due",
      cell: ({ row }: { row: Row<DataGridFeatures, BacklogItem> }) => (
        <DueDateCell item={row.original} />
      ),
      size: 90,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Due",
      },
    },
    {
      accessorKey: "status",
      id: "status",
      header: "Status",
      cell: ({ row }: { row: Row<DataGridFeatures, BacklogItem> }) => (
        <StatusBadge status={row.original.status} />
      ),
      size: 125,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Status",
      },
    },
    {
      accessorKey: "effort",
      id: "effort",
      header: "Effort",
      cell: ({ row }: { row: Row<DataGridFeatures, BacklogItem> }) => (
        <span className="text-foreground text-sm tabular-nums">
          {row.original.effort}
          <span className="text-muted-foreground ms-1 text-xs">pts</span>
        </span>
      ),
      size: 80,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Effort",
      },
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }: { row: Row<DataGridFeatures, BacklogItem> }) => (
        <ActionsCell
          item={row.original}
          rank={row.index + 1}
          total={total}
          onAction={onAction}
        />
      ),
      size: 56,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Actions",
        cellClassName: "pe-4!",
        headerClassName: "pe-4!",
      },
    },
  ]
}