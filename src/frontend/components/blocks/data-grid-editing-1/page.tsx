import { LabelsDataGridView } from "./components/data-grid-view"

export function Page() {
  return (
    <main
      className="mx-auto flex min-h-svh w-full items-start justify-center"
      aria-labelledby="page-heading"
    >
      <h1 id="page-heading" className="sr-only">
        Labels data grid
      </h1>
      <LabelsDataGridView />
    </main>
  )
}