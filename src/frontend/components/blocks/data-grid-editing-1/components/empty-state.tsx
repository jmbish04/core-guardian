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
import { TagIcon, PlusIcon } from "lucide-react"

type LabelsEmptyStateProps = {
  onCreate: () => void
}

export function LabelsEmptyState({ onCreate }: LabelsEmptyStateProps) {
  return (
    <div className="flex w-full justify-center py-8">
      <Empty className="text-foreground max-w-md flex-none gap-6 border-0 bg-transparent p-0">
        <EmptyHeader className="items-center gap-5 text-center">
          <EmptyMedia className="mb-0">
            <IconStack aria-hidden="true">
              <TagIcon strokeWidth="1.9" aria-hidden="true" />
            </IconStack>
          </EmptyMedia>

          <div className="flex flex-col items-center gap-1.5">
            <EmptyTitle>No Labels Yet</EmptyTitle>
            <EmptyDescription className="max-w-80">
              Create labels to group project work, filter records, and keep
              teams aligned.
            </EmptyDescription>
          </div>
        </EmptyHeader>

        <EmptyContent className="max-w-none items-center gap-0">
          <Button type="button" onClick={onCreate}>
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Add label
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}