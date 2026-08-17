"use client"

import { useCallback, useMemo, useState } from "react"
import {
  DataGrid,
  DataGridContainer,
  dataGridFeatures,
  type DataGridFeatures,
} from "~/components/reui/data-grid/data-grid"
import { DataGridScrollArea } from "~/components/reui/data-grid/data-grid-scroll-area"
import { DataGridTableDndRows } from "~/components/reui/data-grid/data-grid-table-dnd-rows"
import { type DragEndEvent, type UniqueIdentifier } from "@dnd-kit/core"
import { arrayMove } from "@dnd-kit/sortable"
import { useTable, type ColumnDef } from "@tanstack/react-table"

import { Button } from "~/components/ui/button"
import { createLabelGridColumns, type LabelRowAction } from "./columns"
import { LABEL_COLOR_VALUES, LABEL_RECORDS, type LabelRecord } from "./data"
import { LabelsEmptyState } from "./empty-state"
import { LabelForm, type LabelFormValues } from "./label-form"
import { PlusIcon } from "lucide-react"

type LabelFormState =
  | {
      mode: "create"
      label: null
    }
  | {
      mode: "edit"
      label: LabelRecord
    }
  | null

const LABEL_FORM_ID = "labels-grid-form"

function sortLabelsByOrder(labels: LabelRecord[]) {
  return [...labels].sort((a, b) => a.displayOrder - b.displayOrder)
}

function normalizeLabelOrder(labels: LabelRecord[]) {
  return labels.map((label, index) => ({
    ...label,
    displayOrder: index + 1,
  }))
}

function placeLabelAtOrder(labels: LabelRecord[], label: LabelRecord) {
  const orderedLabels = sortLabelsByOrder(
    labels.filter((item) => item.id !== label.id)
  )
  const insertIndex = Math.max(
    0,
    Math.min(label.displayOrder - 1, orderedLabels.length)
  )

  orderedLabels.splice(insertIndex, 0, label)

  return normalizeLabelOrder(orderedLabels)
}

function createLabelId(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")

  return `${slug || "label"}-${Date.now().toString(36)}`
}

function hasDuplicateTitle(
  labels: LabelRecord[],
  title: string,
  ignoreId?: string
) {
  const normalizedTitle = title.trim().toLowerCase()

  return labels.some(
    (label) =>
      label.id !== ignoreId &&
      label.title.trim().toLowerCase() === normalizedTitle
  )
}

function getFormDefaultValues(formState: LabelFormState): LabelFormValues {
  if (formState?.mode === "edit") {
    return {
      title: formState.label.title,
      color: formState.label.color,
    }
  }

  return {
    title: "",
    color: LABEL_COLOR_VALUES[0],
  }
}

export function LabelsDataGridView() {
  const [labels, setLabels] = useState<LabelRecord[]>(() =>
    normalizeLabelOrder(sortLabelsByOrder(LABEL_RECORDS))
  )
  const [formState, setFormState] = useState<LabelFormState>(null)

  const orderedLabels = useMemo(() => sortLabelsByOrder(labels), [labels])

  const dataIds = useMemo<UniqueIdentifier[]>(
    () => orderedLabels.map((label) => label.id),
    [orderedLabels]
  )

  const formDefaultValues = useMemo(
    () => getFormDefaultValues(formState),
    [formState]
  )
  const showGridContent = orderedLabels.length > 0 || !formState

  const closeForm = useCallback(() => {
    setFormState(null)
  }, [])

  const openCreateForm = useCallback(() => {
    setFormState({
      mode: "create",
      label: null,
    })
  }, [])

  const handleLabelAction = useCallback(
    (action: LabelRowAction, label: LabelRecord) => {
      if (action === "edit") {
        setFormState({
          mode: "edit",
          label,
        })
        return
      }

      setLabels((current) =>
        normalizeLabelOrder(
          sortLabelsByOrder(current).filter((item) => item.id !== label.id)
        )
      )
      setFormState((current) =>
        current?.mode === "edit" && current.label.id === label.id
          ? null
          : current
      )
    },
    []
  )

  const columns = useMemo<ColumnDef<DataGridFeatures, LabelRecord>[]>(
    () => createLabelGridColumns({ onAction: handleLabelAction }),
    [handleLabelAction]
  )

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useTable({
    features: dataGridFeatures,
    // No pagination row model on v8, so every row rendered. The shared
    // bundle registers one, and manualPagination is v9's way to say the
    // data is already the page - it keeps the pagination APIs while
    // leaving the rows unsliced.
    manualPagination: true,
    data: orderedLabels,
    columns,
    getRowId: (row) => row.id,
  })

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    if (!active || !over || active.id === over.id) return

    const oldIndex = dataIds.indexOf(active.id)
    const newIndex = dataIds.indexOf(over.id)

    if (oldIndex < 0 || newIndex < 0) {
      return
    }

    setLabels(normalizeLabelOrder(arrayMove(orderedLabels, oldIndex, newIndex)))
  }

  const handleSubmitLabel = (values: LabelFormValues) => {
    const title = values.title.trim()
    const editingLabel =
      formState?.mode === "edit" ? formState.label : undefined

    if (hasDuplicateTitle(labels, title, editingLabel?.id)) {
      return false
    }

    if (formState?.mode === "edit" && editingLabel) {
      const nextLabel: LabelRecord = {
        ...editingLabel,
        title,
        color: values.color,
      }

      setLabels((current) => placeLabelAtOrder(current, nextLabel))
      setFormState(null)
      return true
    }

    const nextLabel: LabelRecord = {
      id: createLabelId(title),
      title,
      color: values.color,
      displayOrder: 1,
    }

    setLabels((current) => placeLabelAtOrder(current, nextLabel))
    setFormState(null)
    return true
  }

  return (
    <DataGrid
      table={table}
      recordCount={orderedLabels.length}
      emptyMessage={<LabelsEmptyState onCreate={openCreateForm} />}
      tableLayout={{
        dense: true,
        rowBorder: false,
        rowRounded: true,
        headerSticky: false,
        headerBackground: false,
        headerBorder: false,
        columnsVisibility: false,
        columnsResizable: false,
        columnsMovable: false,
        rowsDraggable: true,
        width: "fixed",
      }}
      tableClassNames={{
        base: "border-spacing-y-2 text-sm",
        header: "sr-only",
        bodyRow:
          "group/label-row hover:bg-transparent [&>td]:h-11 [&>td]:border-y [&>td]:bg-background hover:[&>td]:bg-muted/30 [&>td:first-child]:border-l [&>td:last-child]:border-r",
        edgeCell: "first:ps-2 last:pe-2",
      }}
    >
      <section className="flex w-full max-w-4xl flex-col gap-3 px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-xl font-semibold tracking-tight">Labels</h2>
            <p className="text-muted-foreground text-sm">
              Structure and organize project labels.
            </p>
          </div>

          <Button type="button" variant="outline" onClick={openCreateForm}>
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Add label
          </Button>
        </div>

        <div className="flex flex-col gap-0">
          {/* Form */}
          {formState ? (
            <LabelForm
              formId={LABEL_FORM_ID}
              mode={formState.mode}
              defaultValues={formDefaultValues}
              onCancel={closeForm}
              onSubmit={handleSubmitLabel}
            />
          ) : null}

          {/* Content */}
          {showGridContent ? (
            <DataGridContainer className={formState ? "-mt-2" : undefined}>
              <DataGridScrollArea>
                <DataGridTableDndRows
                  dataIds={dataIds}
                  handleDragEnd={handleDragEnd}
                />
              </DataGridScrollArea>
            </DataGridContainer>
          ) : null}
        </div>
      </section>
    </DataGrid>
  )
}