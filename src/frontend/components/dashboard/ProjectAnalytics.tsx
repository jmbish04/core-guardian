/**
 * @fileoverview `ProjectAnalytics` — task/project analytics for the Projects page.
 *
 * Rehomes the `StatCards` (Projects / Tasks / Completed / Overdue KPIs) and
 * `ChartsGrid` (task-status + throughput recharts) panels that used to live in
 * the now-retired `AdminDashboardChrome`. They render task/project analytics —
 * incoherent on the cost/usage dashboards, at home here on `/dashboard/projects`
 * beneath the projects registry.
 *
 * Self-contained island: fixed default filters (no FilterBar — this page is a
 * registry, not a filterable analytics surface), fetching `/dashboard/stats` and
 * `/dashboard/charts` via the shared `useStats` / `useCharts` hooks. Every panel
 * carries its own LOADING / ERROR / EMPTY state, so no guard is needed here.
 */

"use client";

import { ChartsGrid } from "./ChartsGrid";
import { SectionTitle } from "./shared";
import { StatCards } from "./StatCards";
import type { DashboardFilters } from "./types";
import { useCharts, useStats } from "./useDashboardData";

/** Registry view is unfiltered: last-30d window, all statuses, no query. */
const FILTERS: DashboardFilters = { q: "", range: "30d", status: "all" };

export function ProjectAnalytics() {
  const stats = useStats(FILTERS);
  const charts = useCharts(FILTERS);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <SectionTitle>Overview</SectionTitle>
        <StatCards resource={stats} />
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle>Analytics</SectionTitle>
        <ChartsGrid resource={charts} />
      </section>
    </div>
  );
}
