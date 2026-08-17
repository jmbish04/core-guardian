import type { SVGProps } from "react"

export function FilterPlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M2.25 3.25h11.5L9.5 8.15v2.95l-3 1.5V8.15L2.25 3.25Z" />
      <path d="M11.5 9.75v4" />
      <path d="M9.5 11.75h4" />
    </svg>
  )
}