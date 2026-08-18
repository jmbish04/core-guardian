import { IconStack } from "~/components/reui/icon-stack"

import { Button } from "~/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty"
import { InboxIcon } from "lucide-react"

type PromptQueueEmptyStateProps = {
  title: string
  description: string
  actionLabel: string
  onAction: () => void
}

export function PromptQueueEmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: PromptQueueEmptyStateProps) {
  return (
    <div className="flex min-h-[360px] w-full items-center justify-center px-4 py-10 md:py-12">
      <Empty className="w-full flex-none gap-6 rounded-none border-0 bg-transparent p-0 md:p-0">
        <EmptyHeader className="max-w-108 items-center gap-5 text-center">
          <EmptyMedia className="mb-0">
            <IconStack aria-hidden="true">
              <InboxIcon strokeWidth="1.9" aria-hidden="true" />
            </IconStack>
          </EmptyMedia>

          <div className="flex flex-col items-center gap-2">
            <EmptyTitle className="text-xl font-semibold tracking-tight sm:text-2xl">
              {title}
            </EmptyTitle>
            <EmptyDescription className="max-w-96 text-sm/relaxed">
              {description}
            </EmptyDescription>
          </div>
        </EmptyHeader>

        <EmptyContent className="max-w-none items-center gap-0">
          <Button type="button" variant="outline" onClick={onAction}>
            {actionLabel}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}