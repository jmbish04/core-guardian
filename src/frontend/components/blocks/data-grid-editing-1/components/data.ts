export const LABEL_COLOR_VALUES = [
  "#7C3AED",
  "#F97316",
  "#E11D48",
  "#14B8A6",
  "#0EA5E9",
  "#64748B",
  "#22C55E",
  "#F59E0B",
  "#EC4899",
  "#4F46E5",
  "#84CC16",
  "#A16207",
] as const

export type LabelColor = string

export type LabelRecord = {
  id: string
  title: string
  color: LabelColor
  displayOrder: number
}

export type LabelColorOption = {
  value: LabelColor
  label: string
}

export const LABEL_COLOR_OPTIONS: LabelColorOption[] = [
  { value: "#7C3AED", label: "Violet" },
  { value: "#F97316", label: "Orange" },
  { value: "#E11D48", label: "Rose" },
  { value: "#14B8A6", label: "Teal" },
  { value: "#0EA5E9", label: "Sky" },
  { value: "#64748B", label: "Slate" },
  { value: "#22C55E", label: "Green" },
  { value: "#F59E0B", label: "Amber" },
  { value: "#EC4899", label: "Pink" },
  { value: "#4F46E5", label: "Indigo" },
  { value: "#84CC16", label: "Lime" },
  { value: "#A16207", label: "Umber" },
]

export const LABEL_RECORDS: LabelRecord[] = [
  {
    id: "customer-impact",
    title: "Customer impact",
    color: "#7C3AED",
    displayOrder: 1,
  },
  {
    id: "engineering",
    title: "Engineering",
    color: "#F97316",
    displayOrder: 2,
  },
  {
    id: "release-risk",
    title: "Release risk",
    color: "#E11D48",
    displayOrder: 3,
  },
  {
    id: "growth",
    title: "Growth",
    color: "#14B8A6",
    displayOrder: 4,
  },
  {
    id: "documentation",
    title: "Documentation",
    color: "#0EA5E9",
    displayOrder: 5,
  },
  {
    id: "support",
    title: "Support",
    color: "#22C55E",
    displayOrder: 6,
  },
  {
    id: "ux-polish",
    title: "UX polish",
    color: "#EC4899",
    displayOrder: 7,
  },
  {
    id: "operations",
    title: "Operations",
    color: "#4F46E5",
    displayOrder: 8,
  },
]