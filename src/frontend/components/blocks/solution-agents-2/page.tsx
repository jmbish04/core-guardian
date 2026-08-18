import { RunQueue } from "./components/run-queue"

export function Page() {
  return (
    <main
      className="bg-background mx-auto flex min-h-svh w-full max-w-[1320px] items-start justify-center p-3 md:p-4"
      aria-labelledby="page-heading"
    >
      <h1 id="page-heading" className="sr-only">
        Run Queue
      </h1>
      <RunQueue />
    </main>
  )
}