"use client"

import { useCallback, useMemo, useState, type ReactNode } from "react"
import {
  DataGrid,
  dataGridFeatures,
  type DataGridFeatures,
  type DataGridTableInstance,
} from "~/components/reui/data-grid/data-grid"
import { DataGridScrollArea } from "~/components/reui/data-grid/data-grid-scroll-area"
import { DataGridTable } from "~/components/reui/data-grid/data-grid-table"
import {
  createFilter,
  Filters,
  type Filter,
  type FilterFieldConfig,
  type FilterOption,
} from "~/components/reui/filters"
import {
  useTable,
  type ColumnVisibilityState,
  type PaginationState,
  type SortingState,
} from "@tanstack/react-table"
import { toast } from "sonner"

import { cn } from "~/lib/utils"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar"
import { Button } from "~/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "~/components/ui/field"
import { Item, ItemMedia } from "~/components/ui/item"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover"
import { Progress, ProgressLabel } from "~/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select"
import { Separator } from "~/components/ui/separator"
import { Switch } from "~/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "~/components/ui/toggle-group"
import {
  createPromptQueueColumns,
  formatPromptDate,
  PromptItemActions,
  PromptPriorityBadge,
  PromptStatusBadge,
  PromptTypeBadge,
  type PromptItemRowAction,
} from "./columns"
import {
  getPromptSearchBlob,
  PROMPT_DISPLAY_PROPERTIES,
  PROMPT_ITEMS,
  PROMPT_PRIORITY_OPTIONS,
  PROMPT_STATUS_OPTIONS,
  PROMPT_TABS,
  PROMPT_TYPE_OPTIONS,
  type PromptDisplayProperty,
  type PromptFilterValue,
  type PromptItemRecord,
  type PromptOwner,
  type PromptPriority,
  type PromptStatus,
  type PromptTabId,
  type PromptType,
} from "./data"
import { PromptQueueEmptyState } from "./empty-state"
import { FilterPlusIcon } from "./icons"
import { InboxIcon, CalendarClockIcon, ClockIcon, ChevronLeftIcon, ChevronRightIcon, BriefcaseBusinessIcon, LayoutDashboardIcon, ListIcon, FilterIcon, DownloadIcon, Settings2Icon, CheckIcon } from "lucide-react"

type TableDensity = "compact" | "comfortable"
type PromptViewMode = "table" | "card"

const TABLE_DENSITY_OPTIONS: { value: TableDensity; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
]

const RICH_FILTER_OPTION_CLASS_NAME = "[&>span:last-child]:sr-only"
const PROMPT_QUEUE_PAGE_SIZES = [10, 20, 50]
const PROMPT_QUEUE_PAGE_GROUP_LIMIT = 5
const DAY_IN_MS = 1000 * 60 * 60 * 24

const PROMPT_STATUS_PROGRESS_CONFIG: Record<
  PromptStatus,
  { label: string; value: number; indicatorClassName: string }
> = {
  Draft: {
    label: "Draft",
    value: 20,
    indicatorClassName: "**:data-[slot=progress-indicator]:bg-sky-500",
  },
  Live: {
    label: "Live",
    value: 100,
    indicatorClassName: "**:data-[slot=progress-indicator]:bg-emerald-500",
  },
  "Review required": {
    label: "Review required",
    value: 42,
    indicatorClassName: "**:data-[slot=progress-indicator]:bg-amber-500",
  },
  Stale: {
    label: "Stale",
    value: 34,
    indicatorClassName: "**:data-[slot=progress-indicator]:bg-rose-500",
  },
  Ready: {
    label: "Ready",
    value: 82,
    indicatorClassName: "**:data-[slot=progress-indicator]:bg-emerald-500",
  },
}

const TAB_EMPTY_STATE: Record<
  PromptTabId,
  { title: string; description: string; actionLabel: string }
> = {
  overview: {
    title: "No Prompts",
    description: "No prompts match the current filters.",
    actionLabel: "Clear filters",
  },
  mine: {
    title: "No Owned Prompts",
    description: "Owned prompts return when reviewer filters match.",
    actionLabel: "Clear filters",
  },
  review: {
    title: "No Reviews",
    description: "No review prompts match this filter set.",
    actionLabel: "Clear filters",
  },
  stale: {
    title: "No Stale Prompts",
    description: "No overdue safety or eval checks match.",
    actionLabel: "Open review",
  },
  activity: {
    title: "No Activity",
    description: "Prompt handoffs appear after recent review movement.",
    actionLabel: "Open overview",
  },
}

function createDefaultPromptFilters() {
  return [createFilter<PromptFilterValue>("priority", "is", [])]
}

function renderSelectedFilterState(values: PromptFilterValue[]) {
  if (values.length === 0) return "Select"
  if (values.length > 1) return `${values.length} selected`
  return null
}

function PromptOwnerFilterAvatar({ owner }: { owner: PromptOwner }) {
  return (
    <Avatar className="size-5 shrink-0">
      <AvatarImage src={owner.avatarSrc} alt={owner.name} />
      <AvatarFallback className="text-[10px] leading-none">
        {owner.initials}
      </AvatarFallback>
    </Avatar>
  )
}

function PromptOwnerFilterOption({ owner }: { owner: PromptOwner }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <PromptOwnerFilterAvatar owner={owner} />
      <span className="min-w-0 truncate text-sm font-medium">{owner.name}</span>
    </div>
  )
}

function createBadgeFilterOptions<T extends PromptFilterValue>(
  options: { value: T; label: string }[],
  renderBadge: (value: T) => ReactNode
): FilterOption<PromptFilterValue>[] {
  return options.map((option) => ({
    ...option,
    icon: renderBadge(option.value),
    className: RICH_FILTER_OPTION_CLASS_NAME,
  }))
}

function getActiveFilters(filters: Filter<PromptFilterValue>[]) {
  return filters.filter((filter) => {
    const { operator, values } = filter

    if (operator === "empty" || operator === "not_empty") return true
    if (!values || values.length === 0) return false

    if (
      values.every((value) => typeof value === "string" && value.trim() === "")
    ) {
      return false
    }

    return true
  })
}

function filterFieldValue(item: PromptItemRecord, field: string) {
  switch (field) {
    case "keyword":
      return getPromptSearchBlob(item)
    case "owner":
      return item.owner.name
    case "priority":
      return item.priority
    case "status":
      return item.status
    case "type":
      return item.type
    default:
      return ""
  }
}

function applyFiltersToData(
  data: PromptItemRecord[],
  filters: Filter<PromptFilterValue>[]
) {
  const activeFilters = getActiveFilters(filters)

  return activeFilters.reduce((result, filter) => {
    const { field, operator, values } = filter

    return result.filter((item) => {
      const fieldValue = filterFieldValue(item, field)

      switch (operator) {
        case "is":
          return values.includes(fieldValue)
        case "is_not":
          return !values.includes(fieldValue)
        case "is_any_of":
          return values.some((value) => fieldValue === value)
        case "is_not_any_of":
          return !values.some((value) => fieldValue === value)
        case "contains": {
          const tokens = values
            .map((value) => String(value).trim())
            .filter(Boolean)

          if (tokens.length === 0) return true

          return tokens.some((token) =>
            String(fieldValue).toLowerCase().includes(token.toLowerCase())
          )
        }
        case "not_contains":
          return !values.some((value) =>
            String(fieldValue)
              .toLowerCase()
              .includes(String(value).toLowerCase())
          )
        case "starts_with":
          return values.some((value) =>
            String(fieldValue)
              .toLowerCase()
              .startsWith(String(value).toLowerCase())
          )
        case "ends_with":
          return values.some((value) =>
            String(fieldValue)
              .toLowerCase()
              .endsWith(String(value).toLowerCase())
          )
        case "empty":
          return String(fieldValue).length === 0
        case "not_empty":
          return String(fieldValue).length > 0
        default:
          return true
      }
    })
  }, data)
}

function formatPromptReference(id: string) {
  const code = id
    .split("-")
    .map((part) => part.slice(0, 3).toUpperCase())
    .join("-")

  return `WQ ${code}`
}

function formatPromptWindow(updatedAt: string, dueAt: string) {
  const updatedDate = new Date(`${updatedAt}T00:00:00`).getTime()
  const dueDate = new Date(`${dueAt}T00:00:00`).getTime()
  const dayCount = Math.max(0, Math.round((dueDate - updatedDate) / DAY_IN_MS))

  if (dayCount === 0) return "Same day"
  if (dayCount === 1) return "1d window"

  return `${dayCount}d window`
}

function PromptQueueCardMeta({
  label,
  value,
  icon,
  muted = false,
}: {
  label: string
  value: string
  icon: ReactNode
  muted?: boolean
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 px-4 py-3">
      <Item
        render={<span />}
        className="text-muted-foreground mt-0.5 flex size-4 shrink-0 items-center justify-center border-0 p-0"
      >
        <ItemMedia variant="icon" className="size-auto">
          {icon}
        </ItemMedia>
      </Item>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-muted-foreground text-xs">{label}</span>
        <span
          className={cn(
            "truncate text-sm font-medium tabular-nums",
            muted ? "text-muted-foreground" : "text-foreground"
          )}
        >
          {value}
        </span>
      </div>
    </div>
  )
}

function PromptQueueStageProgress({ status }: { status: PromptStatus }) {
  const config = PROMPT_STATUS_PROGRESS_CONFIG[status]

  return (
    <div className="mt-auto flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">Stage</span>
        <span className="text-foreground truncate font-medium tabular-nums">
          {config.label} - {config.value}%
        </span>
      </div>
      <Progress
        value={config.value}
        className={cn(
          "gap-0 **:data-[slot=progress-indicator]:rounded-full **:data-[slot=progress-track]:h-1.5 **:data-[slot=progress-track]:rounded-full",
          config.indicatorClassName
        )}
      >
        <ProgressLabel className="sr-only">Prompt stage progress</ProgressLabel>
      </Progress>
    </div>
  )
}

function PromptQueueItemCard({
  item,
  visibleProperties,
  onAction,
}: {
  item: PromptItemRecord
  visibleProperties: Record<PromptDisplayProperty, boolean>
  onAction: (action: PromptItemRowAction, item: PromptItemRecord) => void
}) {
  const showSupportBadges = visibleProperties.status || visibleProperties.type
  const showDates = visibleProperties.dueAt || visibleProperties.updatedAt
  const showContent =
    showSupportBadges || visibleProperties.owner || visibleProperties.status
  const dateColumnCount =
    Number(visibleProperties.dueAt) + Number(visibleProperties.updatedAt)

  return (
    <Card className="hover:bg-muted/20 h-full min-w-0 gap-0 overflow-hidden p-0 shadow-none! transition-colors">
      {/* Header */}
      <CardHeader className="grid-cols-1 gap-2 border-b px-4 py-3.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="text-muted-foreground min-w-0 truncate text-xs font-medium tabular-nums">
            {formatPromptReference(item.id)}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {visibleProperties.priority ? (
              <PromptPriorityBadge
                priority={item.priority}
                className="max-w-24"
              />
            ) : null}
            <PromptItemActions
              item={item}
              onAction={onAction}
              className="focus-within:opacity-100 sm:opacity-70 sm:transition-opacity sm:group-hover/card:opacity-100"
            />
          </div>
        </div>

        <div className="min-w-0">
          <CardTitle className="line-clamp-2 text-sm leading-5 font-semibold">
            {item.title}
          </CardTitle>
          <CardDescription className="mt-1 flex min-w-0 items-center gap-1.5 text-xs">
            <InboxIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{item.source}</span>
          </CardDescription>
        </div>
      </CardHeader>

      {showContent ? (
        <CardContent className="flex min-h-36 min-w-0 flex-1 flex-col gap-3 px-4 py-3.5">
          {showSupportBadges ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {visibleProperties.status ? (
                <PromptStatusBadge status={item.status} className="max-w-32" />
              ) : null}
              {visibleProperties.type ? (
                <PromptTypeBadge type={item.type} className="max-w-32" />
              ) : null}
            </div>
          ) : null}

          {visibleProperties.owner ? (
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <Avatar className="size-8 shrink-0">
                  <AvatarImage
                    src={item.owner.avatarSrc}
                    alt={item.owner.name}
                  />
                  <AvatarFallback>{item.owner.initials}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="text-foreground truncate text-sm font-medium">
                    {item.owner.name}
                  </div>
                  <div className="text-muted-foreground truncate text-xs">
                    {item.owner.role}
                  </div>
                </div>
              </div>

              {showDates ? (
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {formatPromptWindow(item.updatedAt, item.dueAt)}
                </span>
              ) : null}
            </div>
          ) : null}

          {visibleProperties.status ? (
            <PromptQueueStageProgress status={item.status} />
          ) : null}
        </CardContent>
      ) : null}

      {showDates ? (
        <CardFooter
          className={cn(
            "grid gap-0 border-t p-0",
            dateColumnCount > 1 &&
              "divide-border divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0"
          )}
        >
          {visibleProperties.dueAt ? (
            <PromptQueueCardMeta
              label="Due"
              value={formatPromptDate(item.dueAt)}
              icon={
                <CalendarClockIcon className="size-4" aria-hidden="true" />
              }
            />
          ) : null}
          {visibleProperties.updatedAt ? (
            <PromptQueueCardMeta
              label="Updated"
              value={formatPromptDate(item.updatedAt)}
              muted
              icon={
                <ClockIcon className="size-4" aria-hidden="true" />
              }
            />
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
  )
}

function PromptQueueCardGrid({
  items,
  visibleProperties,
  onAction,
}: {
  items: PromptItemRecord[]
  visibleProperties: Record<PromptDisplayProperty, boolean>
  onAction: (action: PromptItemRowAction, item: PromptItemRecord) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-3 px-4 py-4 sm:grid-cols-2 lg:px-6 xl:grid-cols-3">
      {items.map((item) => (
        <PromptQueueItemCard
          key={item.id}
          item={item}
          visibleProperties={visibleProperties}
          onAction={onAction}
        />
      ))}
    </div>
  )
}

function PromptQueueBottomToolbar({
  table,
  recordCount,
}: {
  table: DataGridTableInstance<PromptItemRecord>
  recordCount: number
}) {
  const pageIndex = table.state.pagination.pageIndex
  const pageSize = table.state.pagination.pageSize
  const pageCount = table.getPageCount()
  const from = recordCount === 0 ? 0 : pageIndex * pageSize + 1
  const to = Math.min((pageIndex + 1) * pageSize, recordCount)
  const currentGroupStart =
    Math.floor(pageIndex / PROMPT_QUEUE_PAGE_GROUP_LIMIT) *
    PROMPT_QUEUE_PAGE_GROUP_LIMIT
  const currentGroupEnd = Math.min(
    currentGroupStart + PROMPT_QUEUE_PAGE_GROUP_LIMIT,
    pageCount
  )
  const pageButtonClassName = "p-0 text-sm"
  const arrowButtonClassName = `${pageButtonClassName} rtl:rotate-180`

  return (
    <div
      data-slot="data-grid-pagination"
      className="flex grow flex-col flex-wrap items-center justify-between gap-2.5 py-0 sm:flex-row"
    >
      <div className="order-2 flex flex-wrap items-center gap-2.5 pb-2.5 sm:order-1 sm:pb-0">
        <div className="text-muted-foreground text-sm">Rows per page</div>
        <Select
          value={`${pageSize}`}
          onValueChange={(value) => table.setPageSize(Number(value))}
        >
          <SelectTrigger className="w-16" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent side="top" className="min-w-18">
            <SelectGroup>
              {PROMPT_QUEUE_PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={`${size}`}>
                  {size}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="order-1 flex flex-col items-center justify-center gap-2.5 pt-2.5 sm:order-2 sm:flex-row sm:justify-end sm:pt-0">
        <div className="text-muted-foreground order-2 text-sm text-nowrap sm:order-1">
          {from} - {to} of {recordCount} prompts
        </div>

        {pageCount > 1 ? (
          <div className="order-1 flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              className={arrowButtonClassName}
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <span className="sr-only">Go to previous page</span>
              <ChevronLeftIcon className="size-4" />
            </Button>

            {currentGroupStart > 0 ? (
              <Button
                size="icon-sm"
                variant="ghost"
                className={pageButtonClassName}
                onClick={() => table.setPageIndex(currentGroupStart - 1)}
              >
                ...
              </Button>
            ) : null}

            {Array.from(
              { length: currentGroupEnd - currentGroupStart },
              (_, index) => {
                const page = currentGroupStart + index

                return (
                  <Button
                    key={page}
                    size="icon-sm"
                    variant="ghost"
                    className={cn(
                      pageButtonClassName,
                      "text-muted-foreground",
                      pageIndex === page && "bg-accent text-accent-foreground"
                    )}
                    onClick={() => table.setPageIndex(page)}
                  >
                    {page + 1}
                  </Button>
                )
              }
            )}

            {currentGroupEnd < pageCount ? (
              <Button
                size="icon-sm"
                variant="ghost"
                className={pageButtonClassName}
                onClick={() => table.setPageIndex(currentGroupEnd)}
              >
                ...
              </Button>
            ) : null}

            <Button
              size="icon-sm"
              variant="ghost"
              className={arrowButtonClassName}
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              <span className="sr-only">Go to next page</span>
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function PromptQueueDataGridView() {
  const [promptItems, setPromptItems] =
    useState<PromptItemRecord[]>(PROMPT_ITEMS)
  const [activeTab, setActiveTab] = useState<PromptTabId>("overview")
  const [filtersBarOpen, setFiltersBarOpen] = useState(true)
  const [filters, setFilters] = useState<Filter<PromptFilterValue>[]>(
    createDefaultPromptFilters
  )
  const [viewMode, setViewMode] = useState<PromptViewMode>("table")
  const [tableDensity, setTableDensity] = useState<TableDensity>("compact")
  const [stickyHeader, setStickyHeader] = useState(false)
  const [columnsResizable, setColumnsResizable] = useState(false)
  const [columnsMovable, setColumnsMovable] = useState(false)
  const [visibleProperties, setVisibleProperties] = useState<
    Record<PromptDisplayProperty, boolean>
  >({
    owner: true,
    priority: true,
    status: true,
    type: true,
    source: false,
    dueAt: true,
    updatedAt: true,
  })
  const [sorting, setSorting] = useState<SortingState>([
    { id: "dueAt", desc: false },
  ])
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  })

  const resetPagination = useCallback(() => {
    setPagination((current) =>
      current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }
    )
  }, [])

  const activeFilters = useMemo(() => getActiveFilters(filters), [filters])

  const tabRecords = useMemo(
    () => promptItems.filter((item) => item.tabs.includes(activeTab)),
    [activeTab, promptItems]
  )

  const filteredRecords = useMemo(
    () => applyFiltersToData(tabRecords, filters),
    [filters, tabRecords]
  )

  const promptOwnerByName = useMemo(() => {
    return new Map<string, PromptOwner>(
      promptItems.map((item) => [item.owner.name, item.owner])
    )
  }, [promptItems])

  const ownerFilterOptions = useMemo<FilterOption<PromptFilterValue>[]>(() => {
    return [...promptOwnerByName.values()].map((owner) => ({
      value: owner.name,
      label: owner.name,
      icon: <PromptOwnerFilterOption owner={owner} />,
      className: RICH_FILTER_OPTION_CLASS_NAME,
    }))
  }, [promptOwnerByName])

  const promptFilterFields = useMemo<FilterFieldConfig<PromptFilterValue>[]>(
    () => [
      {
        key: "priority",
        label: "Risk",
        type: "select",
        searchable: false,
        className: "w-40",
        defaultOperator: "is",
        options: createBadgeFilterOptions(
          PROMPT_PRIORITY_OPTIONS,
          (priority: PromptPriority) => (
            <PromptPriorityBadge priority={priority} />
          )
        ),
        customValueRenderer: (values) => {
          const state = renderSelectedFilterState(values)
          if (state) return state

          return <PromptPriorityBadge priority={values[0] as PromptPriority} />
        },
      },
      {
        key: "status",
        label: "Status",
        type: "select",
        searchable: false,
        className: "w-44",
        defaultOperator: "is",
        options: createBadgeFilterOptions(
          PROMPT_STATUS_OPTIONS,
          (status: PromptStatus) => <PromptStatusBadge status={status} />
        ),
        customValueRenderer: (values) => {
          const state = renderSelectedFilterState(values)
          if (state) return state

          return <PromptStatusBadge status={values[0] as PromptStatus} />
        },
      },
      {
        key: "type",
        label: "Check",
        type: "select",
        searchable: false,
        className: "w-40",
        defaultOperator: "is",
        options: createBadgeFilterOptions(
          PROMPT_TYPE_OPTIONS,
          (type: PromptType) => <PromptTypeBadge type={type} />
        ),
        customValueRenderer: (values) => {
          const state = renderSelectedFilterState(values)
          if (state) return state

          return <PromptTypeBadge type={values[0] as PromptType} />
        },
      },
      {
        key: "owner",
        label: "Owner",
        type: "select",
        searchable: true,
        className: "w-56",
        defaultOperator: "is",
        options: ownerFilterOptions,
        customValueRenderer: (values) => {
          const state = renderSelectedFilterState(values)
          if (state) return state

          const owner = promptOwnerByName.get(String(values[0]))
          if (!owner) return String(values[0])

          return (
            <div className="flex min-w-0 items-center gap-2">
              <PromptOwnerFilterAvatar owner={owner} />
              <span className="truncate">{owner.name}</span>
            </div>
          )
        },
      },
      {
        key: "keyword",
        label: "Keyword",
        type: "text",
        className: "w-48",
        defaultOperator: "contains",
        placeholder: "Search prompts...",
      },
    ],
    [ownerFilterOptions, promptOwnerByName]
  )

  const columnVisibility = useMemo<ColumnVisibilityState>(
    () => ({
      owner: visibleProperties.owner,
      priority: visibleProperties.priority,
      status: visibleProperties.status,
      type: visibleProperties.type,
      source: visibleProperties.source,
      dueAt: visibleProperties.dueAt,
    }),
    [visibleProperties]
  )

  const handlePromptItemAction = useCallback(
    (action: PromptItemRowAction, item: PromptItemRecord) => {
      if (action === "open") {
        toast.info("Prompt opened", {
          description: `Open ${item.id.toUpperCase()} in the prompt review drawer.`,
        })
        return
      }

      if (action === "ready") {
        setPromptItems((current) =>
          current.map((prompt) =>
            prompt.id === item.id
              ? {
                  ...prompt,
                  status: "Ready",
                  tabs: Array.from(new Set([...prompt.tabs, "mine"])),
                }
              : prompt
          )
        )
        toast.success("Prompt ready", {
          description: `${item.title} is marked ready for release.`,
        })
        return
      }

      if (action === "copy") {
        if (navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(item.id).catch(() => undefined)
        }

        toast.success("Prompt ID copied", {
          description: item.id.toUpperCase(),
        })
        return
      }

      setPromptItems((current) =>
        current.map((prompt) =>
          prompt.id === item.id
            ? {
                ...prompt,
                status: "Stale",
                priority: "Critical",
                tabs: Array.from(new Set([...prompt.tabs, "stale"])),
              }
            : prompt
        )
      )
      toast.warning("Prompt flagged", {
        description: `${item.title} moved to stale review.`,
      })
    },
    []
  )

  const columns = useMemo(
    () => createPromptQueueColumns({ onAction: handlePromptItemAction }),
    [handlePromptItemAction]
  )

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useTable({
    features: dataGridFeatures,
    data: filteredRecords,
    columns,
    state: {
      sorting,
      pagination,
      columnVisibility,
    },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getRowId: (row) => row.id,
  })

  const handleTabChange = useCallback(
    (value: string) => {
      setActiveTab(value as PromptTabId)
      resetPagination()
    },
    [resetPagination]
  )

  const handleFiltersChange = useCallback(
    (nextFilters: Filter<PromptFilterValue>[]) => {
      setFilters(nextFilters)
      resetPagination()
    },
    [resetPagination]
  )

  const handleClearFilters = useCallback(() => {
    setFilters(createDefaultPromptFilters())
    resetPagination()
  }, [resetPagination])

  const handleExportRegistry = useCallback(() => {
    const reviewCount = filteredRecords.filter(
      (item) => item.status === "Review required"
    ).length

    toast.success("Registry exported", {
      description: `${filteredRecords.length} prompts, ${reviewCount} need review.`,
    })
  }, [filteredRecords])

  const handleViewModeChange = useCallback((value: string[]) => {
    const nextValue = value[0] as PromptViewMode | undefined
    if (!nextValue) return

    setViewMode(nextValue)
  }, [])

  const toggleProperty = useCallback((property: PromptDisplayProperty) => {
    setVisibleProperties((current) => ({
      ...current,
      [property]: !current[property],
    }))
  }, [])

  const emptyState = TAB_EMPTY_STATE[activeTab]
  const hasVisibleFilters = filtersBarOpen || activeFilters.length > 0
  const showEmptyState = filteredRecords.length === 0
  const pageRecords = table.getRowModel().rows.map((row) => row.original)
  const emptyStateAction =
    activeTab === "stale"
      ? () => handleTabChange("review")
      : activeTab === "activity"
        ? () => handleTabChange("overview")
        : handleClearFilters

  return (
    <DataGrid
      table={table}
      recordCount={filteredRecords.length}
      emptyMessage="No prompts match this view."
      tableLayout={{
        dense: tableDensity === "compact",
        rowBorder: true,
        headerSticky: stickyHeader,
        columnsVisibility: false,
        columnsResizable,
        columnsMovable,
        width: "fixed",
      }}
      tableClassNames={{
        bodyRow: "group/prompt-row",
        edgeCell: "first:ps-3 last:pe-3 lg:first:ps-4 lg:last:pe-4",
      }}
    >
      <div className="flex w-full flex-col">
        <div className="flex flex-col gap-3 py-3 lg:min-h-12 lg:flex-row lg:items-center lg:gap-4 lg:py-0">
          <div className="flex min-w-0 items-center gap-2">
            <BriefcaseBusinessIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            <h2 className="text-foreground truncate text-sm font-medium">
              Prompt Queue
            </h2>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2 lg:ml-auto lg:flex-nowrap">
            <ToggleGroup
              multiple={false}
              value={[viewMode]}
              onValueChange={handleViewModeChange}
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Prompt queue view"
              className="shrink-0"
            >
              {(["card", "table"] as PromptViewMode[]).map((mode) => (
                <ToggleGroupItem
                  key={mode}
                  value={mode}
                  className="px-2"
                  aria-label={mode === "card" ? "Card view" : "List view"}
                >
                  {mode === "card" ? (
                    <LayoutDashboardIcon className="size-4" aria-hidden="true" />
                  ) : (
                    <ListIcon className="size-4" aria-hidden="true" />
                  )}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-pressed={hasVisibleFilters}
              onClick={() => setFiltersBarOpen((open) => !open)}
            >
              <FilterIcon className="size-4" aria-hidden="true" />
              Filter
            </Button>

            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleExportRegistry}
            >
              <DownloadIcon className="size-4" aria-hidden="true" />
              Export
            </Button>

            <Popover>
              <PopoverTrigger
                render={
                  <Button type="button" size="sm" variant="outline">
                    <Settings2Icon className="size-4" aria-hidden="true" />
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
                            <SelectValue />
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
                          Sticky header
                        </FieldLabel>
                        <Switch
                          size="sm"
                          checked={stickyHeader}
                          onCheckedChange={setStickyHeader}
                        />
                      </Field>

                      <Field
                        orientation="horizontal"
                        className="min-h-9 items-center justify-between gap-3"
                      >
                        <FieldLabel className="text-sm font-normal">
                          Resizable columns
                        </FieldLabel>
                        <Switch
                          size="sm"
                          checked={columnsResizable}
                          onCheckedChange={setColumnsResizable}
                        />
                      </Field>

                      <Field
                        orientation="horizontal"
                        className="min-h-9 items-center justify-between gap-3"
                      >
                        <FieldLabel className="text-sm font-normal">
                          Movable columns
                        </FieldLabel>
                        <Switch
                          size="sm"
                          checked={columnsMovable}
                          onCheckedChange={setColumnsMovable}
                        />
                      </Field>
                    </div>
                  </div>

                  <FieldSeparator className="-mx-3.5" />

                  <div className="flex flex-col gap-2">
                    <div className="text-muted-foreground text-xs font-medium">
                      Display properties
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {PROMPT_DISPLAY_PROPERTIES.map((property) => {
                        const active = visibleProperties[property.key]

                        return (
                          <Button
                            key={property.key}
                            type="button"
                            size="sm"
                            variant={active ? "secondary" : "outline"}
                            className={cn(
                              "rounded-full",
                              active && "border-foreground/10"
                            )}
                            onClick={() => toggleProperty(property.key)}
                          >
                            {active ? (
                              <CheckIcon className="size-4" aria-hidden="true" />
                            ) : null}
                            {property.label}
                          </Button>
                        )
                      })}
                    </div>
                  </div>
                </FieldGroup>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <Separator />

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <div className="[scrollbar-width:none] overflow-x-auto overflow-y-visible [&::-webkit-scrollbar]:hidden">
            <TabsList variant="line" className="w-max gap-6">
              {PROMPT_TABS.map((tab) => (
                <TabsTrigger
                  key={tab.value}
                  value={tab.value}
                  className="px-0 pt-3 pb-3 text-sm after:bottom-[-1px]"
                >
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>

        <Separator />

        {hasVisibleFilters ? (
          <>
            <div className="bg-muted/40 flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between lg:px-4">
              <Filters
                filters={filters}
                fields={promptFilterFields}
                onChange={handleFiltersChange}
                size="default"
                radius="default"
                menuPopupClassName="w-52"
                trigger={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label="Add prompt filter"
                  >
                    <FilterPlusIcon className="size-4" aria-hidden="true" />
                  </Button>
                }
              />

              <Button
                type="button"
                size="default"
                variant="outline"
                className="self-start sm:self-auto"
                onClick={handleClearFilters}
              >
                Clear all
              </Button>
            </div>
            <Separator />
          </>
        ) : null}

        {showEmptyState ? (
          <PromptQueueEmptyState
            title={emptyState.title}
            description={emptyState.description}
            actionLabel={emptyState.actionLabel}
            onAction={emptyStateAction}
          />
        ) : (
          <>
            {viewMode === "card" ? (
              <PromptQueueCardGrid
                items={pageRecords}
                visibleProperties={visibleProperties}
                onAction={handlePromptItemAction}
              />
            ) : (
              <DataGridScrollArea>
                <DataGridTable />
              </DataGridScrollArea>
            )}

            <Separator />

            <div className="px-4 py-3">
              <PromptQueueBottomToolbar
                table={table}
                recordCount={filteredRecords.length}
              />
            </div>
          </>
        )}
      </div>
    </DataGrid>
  )
}