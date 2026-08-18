"use client"

import { useCallback, useMemo, useState, type ComponentProps } from "react"
import { Badge } from "~/components/reui/badge"
import {
  DataGrid,
  DataGridContainer,
  dataGridFeatures,
} from "~/components/reui/data-grid/data-grid"
import { DataGridScrollArea } from "~/components/reui/data-grid/data-grid-scroll-area"
import { DataGridTable } from "~/components/reui/data-grid/data-grid-table"
import { useTable, type ExpandedState } from "@tanstack/react-table"
import { toast } from "sonner"

import { cn } from "~/lib/utils"
import { Button } from "~/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import { Field, FieldGroup, FieldLabel } from "~/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "~/components/ui/input-group"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select"
import { Switch } from "~/components/ui/switch"
import {
  AGENT_RUNS,
  RUN_ATTENTION_OPTIONS,
  RUN_STATUS_GROUPS,
  TOAST_INFO_ICON,
  TOAST_SUCCESS_ICON,
  type AgentRun,
  type RunAttention,
  type RunGroupRow,
  type RunItemRow,
  type RunStatusGroup,
  type RunTableRow,
} from "./data"
import { createRunColumns, type RunAction } from "./run-queue-columns"
import { SearchIcon, XIcon, BellIcon, Settings2Icon, PlusIcon } from "lucide-react"

type TableDensity = "compact" | "comfortable"

const TABLE_DENSITY_OPTIONS: { value: TableDensity; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
]

function getRunSearchBlob(run: AgentRun) {
  return [
    run.runKey,
    run.title,
    run.context,
    run.agent,
    run.environment,
    run.attention,
    run.owner?.name,
    run.owner?.role,
    run.owners.map((owner) => owner.name).join(" "),
    run.owners.map((owner) => owner.role).join(" "),
    run.stepProgress === null ? "queued" : `${run.stepProgress}%`,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function buildRunRows(runs: AgentRun[]): RunGroupRow[] {
  return RUN_STATUS_GROUPS.map((group) => {
    const subRows: RunItemRow[] = runs
      .filter((run) => run.statusId === group.id)
      .map((run) => ({
        kind: "run",
        id: run.id,
        group,
        run,
      }))

    const row: RunGroupRow = {
      kind: "group",
      id: group.id,
      group,
      subRows,
    }

    return row
  }).filter((row) => (row.subRows?.length ?? 0) > 0)
}

function getExpandedGroupState(rows: RunGroupRow[]): ExpandedState {
  return rows.reduce<Record<string, boolean>>((expanded, row) => {
    expanded[row.id] = true
    return expanded
  }, {})
}

function isExpanded(expanded: ExpandedState, rowId: string) {
  if (expanded === true) return true
  return expanded[rowId] === true
}

function getGroupRunCount(group: RunStatusGroup, runs: AgentRun[]) {
  return runs.filter((run) => run.statusId === group.id).length
}

function getAttentionCount(runs: AgentRun[], attention: RunAttention) {
  return runs.filter((run) => run.attention === attention).length
}

function getUnassignedRunCount(runs: AgentRun[]) {
  return runs.filter((run) => !run.owner && run.owners.length === 0).length
}

function RunMetric({
  label,
  value,
  variant = "secondary",
}: {
  label: string
  value: number
  variant?: ComponentProps<typeof Badge>["variant"]
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 sm:border-l sm:pl-3 sm:first:border-l-0 sm:first:pl-0">
      <span className="text-muted-foreground truncate text-xs font-medium">
        {label}
      </span>
      <Badge variant={variant}>{value}</Badge>
    </div>
  )
}

export function RunQueue() {
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedAttention, setSelectedAttention] = useState<RunAttention[]>([])
  const [showContext, setShowContext] = useState(true)
  const [tableDensity, setTableDensity] = useState<TableDensity>("compact")
  const [expandedRows, setExpandedRows] = useState<ExpandedState>(() =>
    getExpandedGroupState(buildRunRows(AGENT_RUNS))
  )

  const filteredRuns = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase()

    return AGENT_RUNS.filter((run) => {
      if (
        normalizedQuery.length > 0 &&
        !getRunSearchBlob(run).includes(normalizedQuery)
      ) {
        return false
      }

      if (
        selectedAttention.length > 0 &&
        !selectedAttention.includes(run.attention)
      ) {
        return false
      }

      return true
    })
  }, [searchQuery, selectedAttention])

  const groupedRows = useMemo(() => buildRunRows(filteredRuns), [filteredRuns])

  const allGroupsExpanded =
    groupedRows.length > 0 &&
    groupedRows.every((row) => isExpanded(expandedRows, row.id))

  const activeFilterCount = selectedAttention.length
  const escalatedRunCount = getAttentionCount(filteredRuns, "Escalated")
  const approvalRunCount = getAttentionCount(filteredRuns, "Needs approval")
  const unassignedRunCount = getUnassignedRunCount(filteredRuns)

  const handleAttentionToggle = useCallback(
    (attention: RunAttention, checked: boolean) => {
      setSelectedAttention((current) => {
        if (checked) {
          return current.includes(attention) ? current : [...current, attention]
        }

        return current.filter((item) => item !== attention)
      })
    },
    []
  )

  const handleToggleGroups = useCallback(() => {
    setExpandedRows(allGroupsExpanded ? {} : getExpandedGroupState(groupedRows))
  }, [allGroupsExpanded, groupedRows])

  const handleRunAction = useCallback((action: RunAction, run: AgentRun) => {
    if (action === "open") {
      toast.info("Open run", {
        description: `${run.runKey} / ${run.title}`,
        icon: TOAST_INFO_ICON,
      })
      return
    }

    if (action === "copy") {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        void navigator.clipboard.writeText(run.runKey)
      }

      toast.success("Run id copied", {
        description: run.runKey,
        icon: TOAST_SUCCESS_ICON,
      })
      return
    }

    if (action === "retry") {
      toast.success("Run requeued", {
        description: `${run.runKey} replays from its last successful checkpoint.`,
        icon: TOAST_SUCCESS_ICON,
      })
      return
    }

    toast.info("Run paused", {
      description: `${run.runKey} holds after its current step until resumed.`,
      icon: TOAST_INFO_ICON,
    })
  }, [])

  const handleNewRun = useCallback(() => {
    toast.info("New run", {
      description: "Connect this action to your agent launch flow.",
      icon: TOAST_INFO_ICON,
    })
  }, [])

  const columns = useMemo(
    () =>
      createRunColumns({
        showContext,
        onAction: handleRunAction,
      }),
    [handleRunAction, showContext]
  )

  const table = useTable({
    features: dataGridFeatures,
    // No pagination row model on v8, so every row rendered. The shared
    // bundle registers one, and manualPagination is v9's way to say the
    // data is already the page - it keeps the pagination APIs while
    // leaving the rows unsliced.
    manualPagination: true,
    data: groupedRows,
    columns,
    getRowId: (row) => row.id,
    getSubRows: (row) =>
      row.kind === "group"
        ? (row.subRows as RunTableRow[] | undefined)
        : undefined,
    getRowCanExpand: (row) =>
      row.original.kind === "group" && Boolean(row.original.subRows?.length),
    state: {
      expanded: expandedRows,
    },
    onExpandedChange: setExpandedRows,
  })

  function clearFilters() {
    setSearchQuery("")
    setSelectedAttention([])
  }

  return (
    <DataGrid
      table={table}
      recordCount={filteredRuns.length}
      emptyMessage="No runs match this view. Clear the search or attention filters."
      tableLayout={{
        dense: tableDensity === "compact",
        rowBorder: true,
        headerSticky: false,
        columnsVisibility: false,
        columnsResizable: false,
        columnsMovable: false,
        width: "fixed",
      }}
      tableClassNames={{
        body: "[&>tr:has(>td:only-child:empty)]:hidden",
        bodyRow: cn(
          "group/run-row [&>td]:h-9 [&:has([data-run-row=group])>td]:h-11 [&:has([data-run-row=group])>td]:bg-muted/45 [&:has([data-run-row=group])>td]:shadow-none [&:has([data-run-row=group])>td]:hover:bg-muted/45",
          showContext && "[&>td]:h-12"
        ),
        edgeCell: "first:ps-3 last:pe-3 lg:first:ps-4 lg:last:pe-4",
      }}
    >
      <section className="flex w-full max-w-7xl flex-col px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">
                Run Queue
              </h2>
              <span className="flex items-center gap-1.5">
                <span
                  className="relative flex size-2 shrink-0"
                  aria-hidden="true"
                >
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" />
                  <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                </span>
                <span className="text-muted-foreground hidden text-sm sm:block">
                  Live
                </span>
              </span>
            </div>
            <p className="text-muted-foreground max-w-2xl text-sm">
              Triage the live agent run backlog.
            </p>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <RunMetric label="Runs" value={filteredRuns.length} />
            <RunMetric
              label="Escalated"
              value={escalatedRunCount}
              variant={
                escalatedRunCount > 0 ? "destructive-light" : "secondary"
              }
            />
            <RunMetric
              label="Needs approval"
              value={approvalRunCount}
              variant={approvalRunCount > 0 ? "warning-light" : "secondary"}
            />
            <RunMetric label="Unassigned" value={unassignedRunCount} />
          </div>
        </div>

        {/* Toolbar */}
        <div className="bg-muted/20 flex flex-col gap-3 border-y px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
          <InputGroup className="w-full min-w-0 lg:max-w-sm">
            <InputGroupAddon align="inline-start">
              <SearchIcon className="text-muted-foreground size-4" aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search runs..."
              aria-label="Search agent runs"
            />
            {searchQuery.length > 0 ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Clear search"
                  onClick={() => setSearchQuery("")}
                >
                  <XIcon className="size-4" aria-hidden="true" />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>

          <div className="flex min-w-0 flex-wrap items-center gap-1.5 lg:justify-end">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                render={
                  <Button type="button" variant="outline">
                    <BellIcon data-icon="inline-start" aria-hidden="true" />
                    Attention
                    {activeFilterCount > 0 ? (
                      <Badge variant="secondary">{activeFilterCount}</Badge>
                    ) : null}
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Attention</DropdownMenuLabel>
                  {RUN_ATTENTION_OPTIONS.map((attention) => (
                    <DropdownMenuCheckboxItem
                      key={attention}
                      checked={selectedAttention.includes(attention)}
                      closeOnClick={false}
                      onCheckedChange={(checked) =>
                        handleAttentionToggle(attention, checked === true)
                      }
                    >
                      {attention}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
                {activeFilterCount > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      closeOnClick={false}
                      onClick={() => setSelectedAttention([])}
                    >
                      Reset attention
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>

            <Popover>
              <PopoverTrigger
                render={
                  <Button type="button" variant="outline">
                    <Settings2Icon data-icon="inline-start" aria-hidden="true" />
                    Display
                  </Button>
                }
              />
              <PopoverContent align="end" className="w-[300px] p-0">
                <FieldGroup className="gap-3 px-3.5 py-3">
                  <div className="flex flex-col gap-2">
                    <div className="text-muted-foreground text-xs font-medium">
                      Table
                    </div>
                    <div className="flex flex-col">
                      <Field
                        orientation="horizontal"
                        className="min-h-9 items-center justify-between gap-3"
                      >
                        <FieldLabel className="text-sm font-normal">
                          Density
                        </FieldLabel>
                        <Select
                          value={tableDensity}
                          onValueChange={(value) =>
                            setTableDensity(value as TableDensity)
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-[132px] shrink-0"
                          >
                            <SelectValue>
                              {
                                TABLE_DENSITY_OPTIONS.find(
                                  (option) => option.value === tableDensity
                                )?.label
                              }
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent align="end">
                            <SelectGroup>
                              {TABLE_DENSITY_OPTIONS.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>

                      <Field
                        orientation="horizontal"
                        className="min-h-9 items-center justify-between gap-3"
                      >
                        <FieldLabel className="text-sm font-normal">
                          Latest step line
                        </FieldLabel>
                        <Switch
                          size="sm"
                          checked={showContext}
                          onCheckedChange={setShowContext}
                          aria-label="Toggle the latest step context line"
                        />
                      </Field>
                    </div>
                  </div>
                </FieldGroup>
              </PopoverContent>
            </Popover>

            <Button
              type="button"
              variant="outline"
              onClick={handleToggleGroups}
            >
              {allGroupsExpanded ? "Collapse groups" : "Expand groups"}
            </Button>

            {searchQuery.length > 0 || selectedAttention.length > 0 ? (
              <Button type="button" variant="ghost" onClick={clearFilters}>
                Clear
              </Button>
            ) : null}

            <Button type="button" onClick={handleNewRun}>
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              New run
            </Button>
          </div>
        </div>

        {/* Content */}
        <DataGridContainer className="border-b">
          <DataGridScrollArea>
            <DataGridTable renderHeader={false} />
          </DataGridScrollArea>
        </DataGridContainer>

        {/* Footer */}
        <div className="text-muted-foreground mt-3 flex flex-col gap-2 text-sm lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-foreground font-medium">Queue Mix</span>
            {RUN_STATUS_GROUPS.map((group) => (
              <Badge key={group.id} variant="outline">
                {group.label}: {getGroupRunCount(group, filteredRuns)}
              </Badge>
            ))}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
            <span className="text-foreground font-medium">
              {filteredRuns.length} visible
            </span>
            <span className="text-muted-foreground">
              of {AGENT_RUNS.length} runs
            </span>
            <Badge
              variant={
                activeFilterCount > 0 || searchQuery.length > 0
                  ? "info-light"
                  : "secondary"
              }
            >
              {activeFilterCount > 0 || searchQuery.length > 0
                ? "Filtered"
                : "All runs"}
            </Badge>
          </div>
        </div>
      </section>
    </DataGrid>
  )
}