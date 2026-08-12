# Claude AI Design brief — Spend / Billing surface (core-guardian)

**Design system**: Monolith — dark shadcn, no traditional 1px borders (use `ring-1 ring-border/40`,
`divide-y divide-border/40`, `bg-card`), OKLCH chart palette, Inter, rounded-lg. Recharts inside
shadcn `<ChartContainer>`. Chart text forced to `hsl(var(--foreground))`.

**Goal**: Replace the current "Cost trace" page (a static mindmap that mislabels *overage* as
*billables* and buries the real surge) with a **legible, live spend dashboard** whose headline is
true spend and whose scariest signal (a service projected to 214× its allowance) is impossible to miss.

**The bug this fixes**: today the headline reads "Account billables · $36.74 — paid plan". That
$36.74 is the sum of *overage-above-allowance* (`overageCostUsd`), not billable spend. Real metered
spend is ~$20–23/day (~$240+ MTD). Headline must be **true MTD metered spend**; overage + projection
are secondary.

---

## Layout (top → bottom)

### 1. Headline stat row (badge counters)
- **Billables this month (MTD)** — big number, the hero. Source: sum of
  `GET /api/guardian/daily-cost?days=31` → `totalByDay[].costUsd` for days in the current month.
- **Projected month-end** — run-rate (MTD ÷ elapsed days × days-in-month). Red when it exceeds last
  month or a configured cap.
- **Today so far** — latest `totalByDay` entry.
- **Day-over-day delta** — `totalDeltaUsd`, arrow up/down.
Each is a compact stat tile (no borders; `bg-card`, subtle ring). Red tile = surging.

### 2. Billable usage over time (line/area chart) — the centerpiece
- X = day, Y = USD. Series = `daily-cost.totalByDay[].costUsd` (solid line).
- **Dashed projected continuation** from today to month-end at current run-rate — visually distinct
  (dashed, muted-red). This is "where the bill lands if nothing changes".
- Optional stacked area by service using `daily-cost.services[]` (workers-ai, d1, r2, browser-rendering).
- Tooltip: per-day USD + top service that day.

### 3. Billables added per day (bullet / bar)
- One bar per day = that day's `costUsd` (added billables).
- Overlay a **target/threshold marker** (the auto-break daily threshold, default $35) so days that
  breach it read instantly.
- A faint **projected** ghost bar for future days at run-rate.

### 4. Cost-trace tree (kept, corrected)
- Keep the account → category → binding tree, but the root label = **true billables**, and surge
  (`projectedFraction > 1`) is shown as a loud badge, e.g. "workers-ai · 21471% projected" in
  alarm-red with a warning icon — not tiny grey text. Non-surging billables render normal.

### 5. Alerts panel (date-stamped, live)
Each alert card shows:
- **Date stamp** (raised-at) — always.
- "Overage today: $X" and "Overage this month (total): $Y".
- "Projected month spend if no action: $Z".
- Status pill. Alerts are **not static** — they reflect the latest cron each load, and stale ones age visibly.
Source: `GET /api/guardian/billable-usage` + allowances (`overageCostUsd`, `projectedFraction`).

### 6. Active incidents banner (top of page, only when present)
- Live list of circuit-break events: `GET /api/guardian/offense/incidents?status=active` →
  `incidents[]` with `{ reason, source, createdAt(ms), scope, recommendation }`.
- Loud banner (alarm-red) with the date stamp and reason.
- Two actions per incident → `POST /api/guardian/offense/incidents/{id}/resolve`:
  - **Mark erroneous** (lifts any kill switch) — body `{ action: "erroneous" }`.
  - **Mark read** (acknowledge; stays visible as a live breaker) — body `{ action: "read" }`.
- Use a shadcn `AlertDialog` to confirm "erroneous" (it lifts a breaker).

---

## States (every widget)
- **LOADING** — skeletons, no layout shift.
- **EMPTY** — "No billable overage this month" / "No active incidents" (positive, not error styling).
- **ERROR** — inline, routed through the global ErrorLogger; never a blank widget.
- **DATA** — as above.

## Mobile
- Stat tiles → 2-up grid. Charts full-width, horizontal-scroll if dense. Incidents banner stays pinned top.

## Data contract (already live)
- `GET /api/guardian/daily-cost?days=31` → `{ totalByDay:[{day,costUsd}], totalDeltaUsd, services:[{service,product,totalUsd,points:[{day,rawUsage,costUsd}]}], workersAiModels:{models:[{model,neurons,costUsd}]} }`
- `GET /api/guardian/billable-usage?days=31` → per-service billable series + estimate.
- `GET /api/guardian/offense/incidents?status=active` → `{ incidents:[{id,reason,source,scope,createdAt,recommendation,status}] }`
- `POST /api/guardian/offense/incidents/{id}/resolve` body `{ action:"read"|"erroneous" }`.
All under bearer auth (session cookie or `WORKER_API_KEY`).

## Anti-slop
- No mock data — wire real endpoints. No 1px borders. Dark only. Charts theme-aware. Every number
  labeled with its window (MTD / today / projected). The surge and the incidents must be the most
  visually dominant elements when present.
