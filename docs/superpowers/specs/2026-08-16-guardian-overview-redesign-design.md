# Guardian Overview Redesign — 1000ft aggregating cockpit

**Date:** 2026-08-16
**Status:** Design — awaiting review
**Scope:** The `/dashboard/guardian` overview page, a cross-cutting chart-theme
standard, and grouping-table upgrades on the existing detail pages.

## Problem

`/dashboard/guardian` stacks ~14 full islands. Most are the *same components*
already mounted on dedicated detail pages, so the overview is every detail
page's heaviest widget concatenated into one endless scroll:

| Overview island | Duplicates detail page |
|---|---|
| `ActionItems` (widget) | `/dashboard/action-items` (full) |
| `DailyCost` | `/dashboard/daily-cost` |
| `ModelAdvisor` (widget) | `/dashboard/recommendations` (full) |
| `CostTraceIsland` (attribution) | scoped trace pages (`/ai-gateway`, `/codra`, `/storage`, `/binding/*`) |

Overview-only islands (no detail page today): `BudgetMeter`, `SpendHeadline`,
`SpendOverview`, `SpendByProject`, `RiskTargetsPanel`, `IncidentsPanel`,
`GuardianPanel`.

Second defect: **charts are black-on-black in dark mode.** 19 uses of
`hsl(var(--token))` across 8 files. This repo's tokens are `oklch(...)`, so
`hsl(oklch(0.985 0 0))` is an invalid CSS color and the SVG falls back to black.

## Principles

1. **1000ft → micro.** The overview is the highest-altitude view. Each domain
   summarizes; the detail page holds the micro. Navigation walks you down.
2. **Aggregate, attribute, link.** Every overview widget that mirrors another
   page shows a source note ("from Daily Cost") and a deep-link to it, and does
   **not** re-render that page's full detail.
3. **Attention first.** Immediate-attention items float to the top of the
   overview, merged and severity-sorted across domains.
4. **Theme parity.** Every chart and widget is legible in light *and* dark.
   Enforced, not hoped for.
5. **One surface.** The app is Card-surfaced. Stay Card. Use the ReUI
   `data-grid` *component* (surface-neutral) for detail tables; adapt any
   Frame-surfaced ReUI block composition to Card. Never mix Card + Frame.

## Phase 1 — Chart theme standard (prerequisite, ships first)

**Rule:** charts never write `hsl(var(--x))`. The oklch tokens are already
complete color functions.

**Fix, in priority order per usage:**
1. Prefer `ChartContainer`'s built-in axis/grid theming (it already sets
   `[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground` and grid
   `stroke-border/40`). Delete the inline `tick={{ fill: "hsl(...)" }}`
   overrides — the container handles it correctly in both themes.
2. Where an explicit value is still needed, use the Tailwind utility
   (`fill-muted-foreground`, `stroke-border`) via `className`, or the bare
   token `var(--foreground)` / `var(--border)` (valid oklch).

**Reusable preset:** export `CHART_AXIS` from `components/ui/chart.tsx` — a small
object of shared `XAxis`/`YAxis`/`CartesianGrid` props (tickLine/axisLine off,
correct fill/stroke via tokens) so there is exactly one right way to spread onto
an axis.

**Guard:** a pre-commit + CI grep that fails on `hsl(var(` in `src/frontend/**`
`.tsx`/`.ts`. Cheap, permanent, catches the next regression.

**Files:** `chart.tsx`, `DailyCost.tsx`, `UsageTrend.tsx`, `CategoryCharts.tsx`,
`BillableUsage.tsx`, `TimeSeriesCharts.tsx`, `AiRouterUsage.tsx`,
`SpendCharts.tsx`.

**Verification:** build + oxlint; visual check of one chart page in both themes
(axis text visible on dark). Guard script rejects a seeded `hsl(var(` line.

## Phase 2 — Overview restructure

Three bands, top to bottom.

### Band 1 — Needs-attention strip

Merge, dedupe, and severity-sort into one list: guardian alerts
(`/guardian/alerts`), offense incidents (`/guardian/offense/incidents`), budget
breaches (`/guardian/billing/budget-status`), and project anomalies
(the `AnomaliesPanel` signal). Each row: severity chip, one-line what+where,
relative time, and a deep-link to the owning page. Empty state = an explicit
"All clear" — never a blank void.

### Band 2 — KPI meter row

Compact meters (the `stats-11` quota shape, OKLCH-correct): spend vs budget,
allowance headroom, month-end projection. Sourced from
`/guardian/billing/insights` + `/guardian/allowances`.

### Band 3 — Domain summary grid

One compact Card per domain — **Spend, Offense/Governance, Resources/Storage,
AI Router, Projects.** Each: a headline metric, a top-3 list (e.g. top spenders,
top targets), and a `SourceLink` footer. No full charts, no full tables.

`SpendByProject` (already built) stays as the Spend card, trimmed to summary
size. `RiskTargetsPanel` collapses to the Offense card's top-3 (full table moves
to a dedicated targets page or stays linked). `GuardianPanel`'s kill switches
move to a dedicated control surface (linked from the Offense card) so the
overview carries no destructive controls.

### New aggregation endpoint

`GET /api/guardian/overview` — server merges the attention list + KPI figures +
per-domain summaries into ONE payload, so the 1000ft page is one fetch, not
eight. Pure D1 + arithmetic reuse of existing guardian services; NO AI. Cached
briefly in KV like the other guardian rollups.

### `SourceLink` component

`components/dashboard/SourceLink.tsx`: `{ page: string; href: string }` → a
muted footer row "Sourced from {page}" + an arrow link. Used by every band-3
card and every aggregating widget. One consistent, honest attribution affordance.

### Removed from the overview

The duplicated full islands: full `DailyCost`, full `ModelAdvisor`, full
`ActionItems`, `CostTraceIsland`, `BillableUsage`. They remain on their pages;
the overview links to them.

## Phase 3 — Detail-page grouping tables

Upgrade the list-heavy detail pages to ReUI expandable `data-grid`s (TanStack
v9, `dataGridFeatures`), adapted to Card surface:

- `/dashboard/action-items`, `/dashboard/alerts`, offense targets → row-expansion
  grids (parent row → child detail), replacing hand-rolled `<table>`s.
- Storage pages already tabular — align them to the same `data-grid` engine for
  consistency (sorting/filtering/pagination for free).

Reference blocks: `data-grid-expansion-2` (expandable parent→child lines),
`data-grid-expansion-3` (row expands into a card rail). Reuse the engine, adapt
the composition to Card, wire real endpoints.

## Data flow

Overview: browser → `GET /api/guardian/overview` (one aggregating fetch) →
render three bands. Deep-links are plain `<a href>` to existing pages. Detail
pages keep their current per-domain endpoints; Phase 3 only changes their table
*presentation*, not their data.

## Testing

- P1: build + oxlint; guard-script self-check (seeded `hsl(var(` fails); manual
  dark/light legibility on a chart page.
- P2: a pure unit test for the attention merge/severity-sort/dedupe function
  (node:test, no network) — the one piece of real logic. Endpoint returns
  well-formed empty payload when everything is calm.
- P3: data-grid renders real rows; expansion reveals child detail; empty/error
  states hold.

## Out of scope

- No new detail pages beyond what exists (Phase 3 upgrades presentation only).
- No change to the underlying guardian data model or cost math.
- The legacy `AdminDashboard`/`useDashboardData` stack (unmounted) is untouched.

## Open questions

- Kill-switch relocation: dedicated `/dashboard/guardian/controls` page, or keep
  `GuardianPanel` on the overview behind a collapsed "Emergency controls"
  section? (Leaning dedicated page, linked from the Offense card.)
