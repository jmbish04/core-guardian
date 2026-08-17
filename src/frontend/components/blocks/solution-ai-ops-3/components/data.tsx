export type PromptTabId = "overview" | "mine" | "review" | "stale" | "activity"

export type PromptPriority = "Critical" | "High" | "Medium" | "Low"

export type PromptStatus =
  | "Draft"
  | "Live"
  | "Review required"
  | "Stale"
  | "Ready"

export type PromptType = "Safety" | "Evaluation" | "Routing" | "Owner"

export type PromptOwnerName =
  | "Mira Stone"
  | "Nora Vale"
  | "Theo Park"
  | "Sana Qureshi"

export type PromptDisplayProperty =
  | "owner"
  | "priority"
  | "status"
  | "type"
  | "source"
  | "dueAt"
  | "updatedAt"

export type PromptFilterValue =
  | PromptPriority
  | PromptStatus
  | PromptType
  | PromptOwnerName
  | string

export type PromptOwner = {
  name: PromptOwnerName
  role: string
  avatarSrc?: string
  initials: string
}

export type PromptItemRecord = {
  id: string
  title: string
  owner: PromptOwner
  priority: PromptPriority
  status: PromptStatus
  type: PromptType
  source: string
  updatedAt: string
  dueAt: string
  tabs: PromptTabId[]
}

export const PROMPT_TABS: { value: PromptTabId; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "mine", label: "My queue" },
  { value: "review", label: "Review" },
  { value: "stale", label: "Stale" },
  { value: "activity", label: "Activity" },
]

export const PROMPT_PRIORITY_OPTIONS: {
  value: PromptPriority
  label: string
}[] = [
  { value: "Critical", label: "Critical" },
  { value: "High", label: "High" },
  { value: "Medium", label: "Medium" },
  { value: "Low", label: "Low" },
]

export const PROMPT_STATUS_OPTIONS: { value: PromptStatus; label: string }[] = [
  { value: "Draft", label: "Draft" },
  { value: "Live", label: "Live" },
  { value: "Review required", label: "Review required" },
  { value: "Stale", label: "Stale" },
  { value: "Ready", label: "Ready" },
]

export const PROMPT_TYPE_OPTIONS: { value: PromptType; label: string }[] = [
  { value: "Safety", label: "Safety" },
  { value: "Evaluation", label: "Evaluation" },
  { value: "Routing", label: "Routing" },
  { value: "Owner", label: "Owner" },
]

export const PROMPT_DISPLAY_PROPERTIES: {
  key: PromptDisplayProperty
  label: string
}[] = [
  { key: "owner", label: "Owner" },
  { key: "priority", label: "Risk" },
  { key: "status", label: "Status" },
  { key: "type", label: "Check" },
  { key: "source", label: "Provider" },
  { key: "dueAt", label: "Eval due" },
  { key: "updatedAt", label: "Updated" },
]

const OWNERS: Record<PromptOwnerName, PromptOwner> = {
  "Mira Stone": {
    name: "Mira Stone",
    role: "AI product operator",
    avatarSrc:
      "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=96&h=96&dpr=2&q=80",
    initials: "MS",
  },
  "Nora Vale": {
    name: "Nora Vale",
    role: "Safety reviewer",
    initials: "NV",
  },
  "Theo Park": {
    name: "Theo Park",
    role: "ML engineer",
    avatarSrc:
      "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=96&h=96&dpr=2&q=80",
    initials: "TP",
  },
  "Sana Qureshi": {
    name: "Sana Qureshi",
    role: "Prompt librarian",
    avatarSrc:
      "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=96&h=96&dpr=2&q=80",
    initials: "SQ",
  },
}

export const PROMPT_ITEMS: PromptItemRecord[] = [
  {
    id: "PRM-4821",
    title: "Renewal Risk Summary",
    owner: OWNERS["Mira Stone"],
    priority: "Critical",
    status: "Review required",
    type: "Safety",
    source: "PROV-2042 SAFE-0914",
    updatedAt: "2026-06-11",
    dueAt: "2026-06-12",
    tabs: ["overview", "mine", "review"],
  },
  {
    id: "PRM-4834",
    title: "Support Reply Draft",
    owner: OWNERS["Sana Qureshi"],
    priority: "High",
    status: "Stale",
    type: "Safety",
    source: "PROV-2041 SAFE-0915",
    updatedAt: "2026-06-11",
    dueAt: "2026-06-12",
    tabs: ["overview", "stale", "activity"],
  },
  {
    id: "PRM-4860",
    title: "Invoice Variance Explainer",
    owner: OWNERS["Theo Park"],
    priority: "Medium",
    status: "Draft",
    type: "Evaluation",
    source: "PROV-2043 SAFE-0914",
    updatedAt: "2026-06-10",
    dueAt: "2026-06-13",
    tabs: ["overview", "review"],
  },
  {
    id: "PRM-4872",
    title: "Safety Refusal Classifier",
    owner: OWNERS["Nora Vale"],
    priority: "Medium",
    status: "Live",
    type: "Safety",
    source: "PROV-2044 SAFE-0916",
    updatedAt: "2026-06-10",
    dueAt: "2026-06-14",
    tabs: ["overview", "activity"],
  },
  {
    id: "PRM-4886",
    title: "Provider Fallback Router",
    owner: OWNERS["Theo Park"],
    priority: "Low",
    status: "Ready",
    type: "Routing",
    source: "PROV-2042 SAFE-0916",
    updatedAt: "2026-06-12",
    dueAt: "2026-06-15",
    tabs: ["overview", "mine", "activity"],
  },
  {
    id: "PRM-4891",
    title: "Admin Action Explainer",
    owner: OWNERS["Mira Stone"],
    priority: "High",
    status: "Review required",
    type: "Owner",
    source: "PROV-2045 SAFE-0917",
    updatedAt: "2026-06-12",
    dueAt: "2026-06-13",
    tabs: ["overview", "review"],
  },
  {
    id: "PRM-4906",
    title: "Usage Cap Explainer",
    owner: OWNERS["Mira Stone"],
    priority: "Low",
    status: "Live",
    type: "Evaluation",
    source: "PROV-2041 SAFE-0918",
    updatedAt: "2026-06-09",
    dueAt: "2026-06-16",
    tabs: ["overview", "activity"],
  },
  {
    id: "PRM-4918",
    title: "Tool Call Policy",
    owner: OWNERS["Nora Vale"],
    priority: "Critical",
    status: "Review required",
    type: "Safety",
    source: "PROV-2044 SAFE-0918",
    updatedAt: "2026-06-12",
    dueAt: "2026-06-12",
    tabs: ["overview", "review"],
  },
  {
    id: "PRM-4927",
    title: "Retrieval Grounding Note",
    owner: OWNERS["Sana Qureshi"],
    priority: "Medium",
    status: "Ready",
    type: "Evaluation",
    source: "PROV-2043 SAFE-0919",
    updatedAt: "2026-06-12",
    dueAt: "2026-06-17",
    tabs: ["overview", "activity"],
  },
  {
    id: "PRM-4930",
    title: "Refund Policy Clarifier",
    owner: OWNERS["Mira Stone"],
    priority: "Critical",
    status: "Stale",
    type: "Owner",
    source: "PROV-2045 SAFE-0920",
    updatedAt: "2026-06-10",
    dueAt: "2026-06-12",
    tabs: ["overview", "stale", "review"],
  },
  {
    id: "PRM-4938",
    title: "Locale Escalation Router",
    owner: OWNERS["Theo Park"],
    priority: "High",
    status: "Draft",
    type: "Routing",
    source: "PROV-2042 SAFE-0921",
    updatedAt: "2026-06-11",
    dueAt: "2026-06-18",
    tabs: ["overview", "review"],
  },
  {
    id: "PRM-4942",
    title: "Contract Clause Summary",
    owner: OWNERS["Sana Qureshi"],
    priority: "Medium",
    status: "Live",
    type: "Evaluation",
    source: "PROV-2043 SAFE-0922",
    updatedAt: "2026-06-08",
    dueAt: "2026-06-19",
    tabs: ["overview", "activity"],
  },
  {
    id: "PRM-4951",
    title: "Medical Advice Refusal",
    owner: OWNERS["Nora Vale"],
    priority: "Critical",
    status: "Review required",
    type: "Safety",
    source: "PROV-2044 SAFE-0923",
    updatedAt: "2026-06-12",
    dueAt: "2026-06-13",
    tabs: ["overview", "review"],
  },
  {
    id: "PRM-4959",
    title: "Segment Rollout Planner",
    owner: OWNERS["Theo Park"],
    priority: "Low",
    status: "Draft",
    type: "Routing",
    source: "PROV-2042 SAFE-0924",
    updatedAt: "2026-06-11",
    dueAt: "2026-06-20",
    tabs: ["overview", "mine", "review"],
  },
]

export function getPromptSearchBlob(item: PromptItemRecord) {
  return [
    item.title,
    item.owner.name,
    item.owner.role,
    item.priority,
    item.status,
    item.type,
    item.source,
    item.updatedAt,
    item.dueAt,
  ]
    .join(" ")
    .toLowerCase()
}