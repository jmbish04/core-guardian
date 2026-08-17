import { useState } from "react"
import { type DataGridFeatures } from "~/components/reui/data-grid/data-grid"
import { DataGridTableDndRowHandle } from "~/components/reui/data-grid/data-grid-table-dnd-rows"
import { type ColumnDef } from "@tanstack/react-table"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog"
import { Button } from "~/components/ui/button"
import { type LabelRecord } from "./data"
import { TagIcon, PencilIcon, Trash2Icon } from "lucide-react"

export type LabelRowAction = "edit" | "delete"

function LabelTitleCell({ label }: { label: LabelRecord }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TagIcon className="size-3.5 shrink-0" style={{ color: label.color, fill: label.color }} aria-hidden="true" />
      <span className="truncate text-sm font-medium">{label.title}</span>
    </div>
  )
}

function LabelActionsCell({
  label,
  onAction,
}: {
  label: LabelRecord
  onAction: (action: LabelRowAction, label: LabelRecord) => void
}) {
  const [deleteOpen, setDeleteOpen] = useState(false)

  const handleDeleteConfirm = () => {
    onAction("delete", label)
    setDeleteOpen(false)
  }

  return (
    <>
      <div className="flex items-center justify-end gap-1">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Edit ${label.title}`}
          onClick={(event) => {
            event.stopPropagation()
            onAction("edit", label)
          }}
        >
          <PencilIcon aria-hidden="true" />
        </Button>

        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Delete ${label.title}`}
          onClick={(event) => {
            event.stopPropagation()
            setDeleteOpen(true)
          }}
        >
          <Trash2Icon aria-hidden="true" />
        </Button>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete label?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes{" "}
              <span className="text-foreground font-medium">{label.title}</span>{" "}
              from the labels list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDeleteConfirm}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function createLabelGridColumns({
  onAction,
}: {
  onAction: (action: LabelRowAction, label: LabelRecord) => void
}): ColumnDef<DataGridFeatures, LabelRecord>[] {
  return [
    {
      id: "drag",
      header: "Move",
      cell: () => <DataGridTableDndRowHandle />,
      size: 36,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Move",
        cellClassName: "pe-0!",
      },
    },
    {
      accessorKey: "title",
      id: "title",
      header: "Label",
      cell: ({ row }) => <LabelTitleCell label={row.original} />,
      size: 520,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Label",
        cellClassName: "ps-0!",
      },
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <LabelActionsCell label={row.original} onAction={onAction} />
      ),
      size: 92,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: {
        headerTitle: "Actions",
        cellClassName: "pe-2!",
      },
    },
  ]
}