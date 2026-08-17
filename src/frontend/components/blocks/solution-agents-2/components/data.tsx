import { type ReactNode } from "react"
import { CircleCheckIcon, InfoIcon, CreditCardIcon, SendIcon, DatabaseIcon, BookOpenIcon, SparklesIcon, FileTextIcon } from "lucide-react"

export type RunStatusId = "running" | "waiting" | "failed" | "completed"

export type AgentName =
  | "Refund Resolver"
  | "Outreach Composer"
  | "Data Steward"
  | "Invoice Reconciler"
  | "Lead Enricher"
  | "Contract Summarizer"

export type RunAttention =
  | "Escalated"
  | "Needs approval"
  | "Retrying"
  | "On track"
  | "Done"

export type RunEnvironment = "Production" | "Staging" | "Development"

export interface RunOwner {
  id: string
  name: string
  initials: string
  avatarSrc?: string
  role: string
}

export interface RunStatusGroup {
  id: RunStatusId
  label: "Running" | "Waiting" | "Failed" | "Completed"
  summary: string
  focus: string
  order: number
}

export interface AgentRun {
  id: string
  runKey: string
  title: string
  context: string
  statusId: RunStatusId
  agent: AgentName
  environment: RunEnvironment
  attention: RunAttention
  owner: RunOwner | null
  owners: RunOwner[]
  stepProgress: number | null
  startedAt: string
  startedLabel: string
}

export interface RunGroupRow {
  kind: "group"
  id: string
  group: RunStatusGroup
  subRows?: RunItemRow[]
}

export interface RunItemRow {
  kind: "run"
  id: string
  group: RunStatusGroup
  run: AgentRun
}

export type RunTableRow = RunGroupRow | RunItemRow

export const RUN_STATUS_ORDER: RunStatusId[] = [
  "running",
  "waiting",
  "failed",
  "completed",
]

export const RUN_ATTENTION_OPTIONS: RunAttention[] = [
  "Escalated",
  "Needs approval",
  "Retrying",
  "On track",
  "Done",
]

export const TOAST_SUCCESS_ICON = (
  <CircleCheckIcon className="size-[18px] text-green-600" aria-hidden="true" />
)

export const TOAST_INFO_ICON = (
  <InfoIcon className="text-muted-foreground size-[18px]" aria-hidden="true" />
)

export const AGENT_DETAILS: Record<
  AgentName,
  { label: AgentName; icon: ReactNode }
> = {
  "Refund Resolver": {
    label: "Refund Resolver",
    icon: (
      <CreditCardIcon className="size-3.5" aria-hidden="true" />
    ),
  },
  "Outreach Composer": {
    label: "Outreach Composer",
    icon: (
      <SendIcon className="size-3.5" aria-hidden="true" />
    ),
  },
  "Data Steward": {
    label: "Data Steward",
    icon: (
      <DatabaseIcon className="size-3.5" aria-hidden="true" />
    ),
  },
  "Invoice Reconciler": {
    label: "Invoice Reconciler",
    icon: (
      <BookOpenIcon className="size-3.5" aria-hidden="true" />
    ),
  },
  "Lead Enricher": {
    label: "Lead Enricher",
    icon: (
      <SparklesIcon className="size-3.5" aria-hidden="true" />
    ),
  },
  "Contract Summarizer": {
    label: "Contract Summarizer",
    icon: (
      <FileTextIcon className="size-3.5" aria-hidden="true" />
    ),
  },
}

export const RUN_STATUS_GROUPS: RunStatusGroup[] = [
  {
    id: "running",
    label: "Running",
    summary: "Live executions streaming steps right now",
    focus: "Throughput",
    order: 1,
  },
  {
    id: "waiting",
    label: "Waiting",
    summary: "Queued behind approvals, rate limits, or schedules",
    focus: "Backlog",
    order: 2,
  },
  {
    id: "failed",
    label: "Failed",
    summary: "Stopped runs awaiting retry or escalation",
    focus: "Recovery",
    order: 3,
  },
  {
    id: "completed",
    label: "Completed",
    summary: "Finished in the last 24 hours",
    focus: "Audit",
    order: 4,
  },
]

const MAYA: RunOwner = {
  id: "owner-maya",
  name: "Maya Perez",
  initials: "MP",
  avatarSrc:
    "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=96&h=96&dpr=2&q=80",
  role: "Operations lead",
}

const NOA: RunOwner = {
  id: "owner-noa",
  name: "Noa Kim",
  initials: "NK",
  avatarSrc:
    "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=96&h=96&dpr=2&q=80",
  role: "Reliability engineer",
}

const EMIL: RunOwner = {
  id: "owner-emil",
  name: "Emil Novak",
  initials: "EN",
  avatarSrc:
    "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=96&h=96&dpr=2&q=80",
  role: "Platform engineer",
}

const LARA: RunOwner = {
  id: "owner-lara",
  name: "Lara Chen",
  initials: "LC",
  avatarSrc:
    "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=96&h=96&dpr=2&q=80",
  role: "Support automation",
}

const PAVEL: RunOwner = {
  id: "owner-pavel",
  name: "Pavel Singh",
  initials: "PS",
  avatarSrc:
    "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=96&h=96&dpr=2&q=80",
  role: "Growth engineer",
}

const JONAS: RunOwner = {
  id: "owner-jonas",
  name: "Jonas Reed",
  initials: "JR",
  role: "Safety reviewer",
}

export const RUN_OWNERS: RunOwner[] = [MAYA, NOA, EMIL, LARA, PAVEL, JONAS]

export const AGENT_RUNS: AgentRun[] = [
  // Running
  {
    id: "run-4831",
    runKey: "RUN-4831",
    title: "Refund duplicate charge on ORD-99214 for Acme Corp",
    context:
      "Step 4 of 6 · Matching the second transaction in the payment ledger",
    statusId: "running",
    agent: "Refund Resolver",
    environment: "Production",
    attention: "On track",
    owner: MAYA,
    owners: [],
    stepProgress: 62,
    startedAt: "2026-06-10T12:40:00Z",
    startedLabel: "2m ago",
  },
  {
    id: "run-4830",
    runKey: "RUN-4830",
    title: "Draft renewal outreach for 38 Q3 accounts",
    context: "Step 2 of 5 · Pulling usage summaries for segment B",
    statusId: "running",
    agent: "Outreach Composer",
    environment: "Production",
    attention: "On track",
    owner: PAVEL,
    owners: [],
    stepProgress: 35,
    startedAt: "2026-06-10T12:34:00Z",
    startedLabel: "8m ago",
  },
  {
    id: "run-4829",
    runKey: "RUN-4829",
    title: "Dedupe 412 contacts imported from the spring webinar",
    context: "Step 3 of 4 · Merging 57 confirmed duplicate pairs",
    statusId: "running",
    agent: "Data Steward",
    environment: "Staging",
    attention: "On track",
    owner: EMIL,
    owners: [],
    stepProgress: 70,
    startedAt: "2026-06-10T12:28:00Z",
    startedLabel: "14m ago",
  },
  {
    id: "run-4828",
    runKey: "RUN-4828",
    title: "Refund damaged item claim on ORD-99187 for Globex",
    context: "Step 5 of 6 · Waiting on finance approval for the $1,240 credit",
    statusId: "running",
    agent: "Refund Resolver",
    environment: "Production",
    attention: "Needs approval",
    owner: MAYA,
    owners: [MAYA, JONAS],
    stepProgress: 81,
    startedAt: "2026-06-10T12:20:00Z",
    startedLabel: "22m ago",
  },
  {
    id: "run-4827",
    runKey: "RUN-4827",
    title: "Summarize the Meridian master services agreement",
    context: "Step 1 of 3 · Splitting 84 pages into clause sections",
    statusId: "running",
    agent: "Contract Summarizer",
    environment: "Development",
    attention: "On track",
    owner: LARA,
    owners: [],
    stepProgress: 15,
    startedAt: "2026-06-10T12:11:00Z",
    startedLabel: "31m ago",
  },
  // Waiting
  {
    id: "run-4826",
    runKey: "RUN-4826",
    title: "Reconcile 23 June freight invoices",
    context: "Queued 18 min · Position 2 in the finance lane",
    statusId: "waiting",
    agent: "Invoice Reconciler",
    environment: "Production",
    attention: "On track",
    owner: NOA,
    owners: [],
    stepProgress: null,
    startedAt: "2026-06-10T12:24:00Z",
    startedLabel: "18m ago",
  },
  {
    id: "run-4825",
    runKey: "RUN-4825",
    title: "Send onboarding nudges to 112 trial signups",
    context: "Step 1 of 4 · Rate limited by the email provider, retry at 13:05",
    statusId: "waiting",
    agent: "Outreach Composer",
    environment: "Production",
    attention: "Retrying",
    owner: PAVEL,
    owners: [],
    stepProgress: 10,
    startedAt: "2026-06-10T12:16:00Z",
    startedLabel: "26m ago",
  },
  {
    id: "run-4824",
    runKey: "RUN-4824",
    title: "Enrich 64 new leads from the partner webinar",
    context: "Queued 32 min · Waiting for the enrichment API window",
    statusId: "waiting",
    agent: "Lead Enricher",
    environment: "Staging",
    attention: "On track",
    owner: PAVEL,
    owners: [],
    stepProgress: null,
    startedAt: "2026-06-10T12:10:00Z",
    startedLabel: "32m ago",
  },
  {
    id: "run-4823",
    runKey: "RUN-4823",
    title: "Archive conversations older than 180 days",
    context: "Queued 1 h · Scheduled for the low traffic window at 02:00",
    statusId: "waiting",
    agent: "Data Steward",
    environment: "Production",
    attention: "On track",
    owner: EMIL,
    owners: [],
    stepProgress: null,
    startedAt: "2026-06-10T11:42:00Z",
    startedLabel: "1h ago",
  },
  // Failed
  {
    id: "run-4822",
    runKey: "RUN-4822",
    title: "Refund partial return on ORD-99102 for Acme Corp",
    context:
      "Failed at step 3 of 6 · The processor declined the partial capture",
    statusId: "failed",
    agent: "Refund Resolver",
    environment: "Production",
    attention: "Escalated",
    owner: MAYA,
    owners: [MAYA, NOA],
    stepProgress: 48,
    startedAt: "2026-06-10T11:38:00Z",
    startedLabel: "1h ago",
  },
  {
    id: "run-4821",
    runKey: "RUN-4821",
    title: "Match 9 supplier invoices to June purchase orders",
    context: "Failed at step 2 of 5 · Two invoices reference a closed PO",
    statusId: "failed",
    agent: "Invoice Reconciler",
    environment: "Production",
    attention: "Escalated",
    owner: NOA,
    owners: [],
    stepProgress: 32,
    startedAt: "2026-06-10T10:55:00Z",
    startedLabel: "2h ago",
  },
  {
    id: "run-4820",
    runKey: "RUN-4820",
    title: "Summarize 3 renewal contracts for legal review",
    context:
      "Failed at step 2 of 3 · The Globex renewal PDF is password protected",
    statusId: "failed",
    agent: "Contract Summarizer",
    environment: "Development",
    attention: "Retrying",
    owner: LARA,
    owners: [],
    stepProgress: 55,
    startedAt: "2026-06-10T09:48:00Z",
    startedLabel: "3h ago",
  },
  // Completed
  {
    id: "run-4819",
    runKey: "RUN-4819",
    title: "Send weekly digest to 1,847 subscribers",
    context: "Done in 4m 12s · 1,812 delivered, 35 bounced",
    statusId: "completed",
    agent: "Outreach Composer",
    environment: "Production",
    attention: "Done",
    owner: PAVEL,
    owners: [],
    stepProgress: 100,
    startedAt: "2026-06-09T16:05:00Z",
    startedLabel: "Yesterday",
  },
  {
    id: "run-4818",
    runKey: "RUN-4818",
    title: "Rebuild the product catalog embeddings",
    context: "Done in 18m · 3,072 vectors refreshed",
    statusId: "completed",
    agent: "Data Steward",
    environment: "Staging",
    attention: "Done",
    owner: EMIL,
    owners: [],
    stepProgress: 100,
    startedAt: "2026-06-09T14:30:00Z",
    startedLabel: "Yesterday",
  },
  {
    id: "run-4817",
    runKey: "RUN-4817",
    title: "Score 240 inbound leads from the pricing page",
    context: "Done in 6m 40s · 31 leads routed to sales",
    statusId: "completed",
    agent: "Lead Enricher",
    environment: "Production",
    attention: "Done",
    owner: JONAS,
    owners: [],
    stepProgress: 100,
    startedAt: "2026-06-09T11:20:00Z",
    startedLabel: "Yesterday",
  },
  {
    id: "run-4816",
    runKey: "RUN-4816",
    title: "Refund cancelled subscription for Globex",
    context: "Done in 1m 05s · $89 credited to the original card",
    statusId: "completed",
    agent: "Refund Resolver",
    environment: "Production",
    attention: "Done",
    owner: MAYA,
    owners: [],
    stepProgress: 100,
    startedAt: "2026-06-08T15:42:00Z",
    startedLabel: "Mon",
  },
]