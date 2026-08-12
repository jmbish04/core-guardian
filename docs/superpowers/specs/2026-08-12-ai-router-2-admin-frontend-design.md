# Spec #2 — AI Router: Admin Frontend (design)

**Status:** design approved 2026-08-12; branch `claude/ai-router-admin-frontend` (off merged main).
**Umbrella:** [2026-08-10-ai-router-overview.md](./2026-08-10-ai-router-overview.md). **Consumes** spec #1's management API (`/api/ai-router/*`, merged in PR #17).
**Scope:** one Astro dashboard page + one React island to manage AI Router circuit breakers, the global kill switch, and view a recent-requests audit table. No backend changes — the API already exists.

---

## 1. Goal & non-goals

**Goal:** give an operator a browser page to see current circuits + spend, create/edit/delete circuits, arm/disarm the kill switch (with a confirm barrier), grant temporary break-glass, and scan recent routed requests — all against the existing guardianAuth-gated `/api/ai-router` routes.

**Non-goals:** project-dimensioned cost charts / aggregation (spec #3); Jules recommendations (spec #4); any backend/route change. No new dependencies — reuse the vendored shadcn kit + existing patterns.

---

## 2. Existing conventions to follow (from the frontend map)

- **Page:** `src/frontend/pages/dashboard/ai-router.astro`, copying `dashboard/ai-gateway.astro`'s thin shell (BaseLayout + `<main class="container mx-auto flex max-w-6xl flex-col gap-8 px-4 py-12">` + a `← Core Guardian` back-link). Primary island `client:load`, secondary `client:visible`.
- **Nav (required same change):** add an entry to the `"Dashboards"` group in `src/frontend/lib/config.ts` (~L53-64). AGENTS rule #22: new page ⇒ nav entry in the same change.
- **Data:** `apiGet<T>(path, params?)` / `apiSend<T>(method, path, body?)` from `@/lib/api` (same-origin, throws `ApiError`). Plain `useState`/`useCallback`/`useEffect`. **No** react-query/SWR. Errors → inline banner (`ApiError.status===401` → "Sign in to view …"); **never** `alert()` (AGENTS rule #10).
- **Auth:** guardianAuth accepts the operator's session cookie automatically on same-origin fetch — no extra wiring in the island. A 401 renders the sign-in notice.
- **UI kit (vendored):** `ResourceTable` (sortable/filterable `Column<T>[]`), `Switch`, `Dialog`, `AlertDialog`, `ConfirmDeleteDialog` (type-to-confirm phrase barrier), `Input`/`Label`, `Button`, `Badge`, `Card`, `Progress`, `Select`, `Separator`. Panel const: `const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6"`. OKLCH theme, hairline borders (AGENTS rule #5).
- **Barrels:** island lives in `src/frontend/components/dashboard/`, exported via that folder's `index.ts`; pages import from `@/components/dashboard`, never by file path.
- **Verify:** `pnpm build` + `pnpm lint` (oxlint; `.astro` not linted → build catches frontmatter). Page is not "verified" until opened in a browser with a real session and seen rendering (AGENTS rule #18).

---

## 3. API contract (spec #1, `/api/ai-router`, guardianAuth)

- `GET /circuits` → `{ killSwitch: boolean, circuits: Array<{ scope: string, circuit: { budgetUsd: number, window: "day"|"week"|"month"|"total", enabled: boolean, breakGlassUntil?: number }, spent: number }> }`
- `PUT /circuits/{scope}` body `{ budgetUsd>0, window?="month", enabled?=true }` → `{ ok: true }`
- `DELETE /circuits/{scope}` → `{ ok: true }`
- `POST /circuits/{scope}/break-glass` body `{ hours: 1..168 }` → `{ ok: true }`
- `POST /kill-switch` body `{ on: boolean, confirm?: string }` → `{ killSwitch: boolean }` — **OFF requires `confirm === "disable kill switch"`** else 400.
- `GET /requests?limit=1..200 (default 50)` → `{ requests: AiRouterRequestRow[] }` newest first. Row fields: `id, at, project, importance, provider, model, mode, gateway, tokensIn, tokensOut, tokensInCost, tokensOutCost, costUsd, isError, errorMessage, isCircuitBreaker, circuitBrokenMessage, createdAt`.

**Scope grammar** (`global | provider:<p> | model:<p>/<m> | project:<name>`): the **UI is the enforcement point** — `PUT` does not validate the scope server-side. Build the scope string from a segmented control, never free text, and reject `:` in the provider/model/project segments (mirrors the `/run` guard).

---

## 4. Components

### 4.1 `dashboard/ai-router.astro`
Thin shell mounting `<AiRouterConsole client:load />` (single island). Back-link to `/dashboard/guardian`. Title/description set.

### 4.2 `dashboard/AiRouterConsole.tsx` (the island)
Sections, top→bottom, each in a `PANEL`:

**A. Kill switch** — a prominent card: current state (big status: `ARMED — all AI flowing` vs `KILL SWITCH ACTIVE — all AI blocked`, destructive styling when active), a `Switch`. Turning **ON** → immediate `POST /kill-switch {on:true}` (a confirm is optional but ON is the safe direction; ship immediate). Turning **OFF** → open `ConfirmDeleteDialog` (phrase `"disable kill switch"`, `confirmLabel="Disable kill switch"`); on confirm `POST /kill-switch {on:false, confirm:"disable kill switch"}`. Refresh via `load()`.

**B. Circuits table** (`ResourceTable`) — columns:
- `scope` (mono)
- `budget` ($)
- `window`
- `spent` — number + a `Progress` bar `spent/budgetUsd` (destructive tint ≥100%, warning ≥80%); tripped rows get a `Badge` "TRIPPED"
- `enabled` — a `Switch` (immediate `PUT` with the row's current values and toggled `enabled`)
- `break-glass` — if `breakGlassUntil > now`, a `Badge` "BREAK-GLASS until <time>"
- actions — `Edit`, `Break-glass`, `Delete` buttons.
Toolbar: a "New circuit" button. `searchText` = scope. Empty state: "No circuits configured — all spend flows uncapped except the kill switch."

**C. Recent requests** (`ResourceTable`) — from `GET /requests?limit=50`, columns: time (`at`), project, importance (Badge), provider/model, mode, tokensIn/out, costUsd, and a status cell: `TRIPPED` (isCircuitBreaker), `ERROR` (isError, tooltip errorMessage), else `OK`. Read-only. A limit selector (50/100/200) optional. searchText across project+model.

### 4.3 Circuit create/edit `Dialog`
- **Scope builder** (create only; edit shows scope read-only): `Select` kind = `global | provider | model | project`; conditional fields:
  - `provider` → `Select` provider (`openai|anthropic|google|workers-ai`)
  - `model` → provider `Select` + model `Input`
  - `project` → `Input`
  Reject `:` in provider/model/project (inline field error). Compose scope: `global` | `provider:{p}` | `model:{p}/{m}` | `project:{name}`.
- Fields: `budgetUsd` (`Input` number, >0), `window` (`Select`), `enabled` (`Switch`, default on).
- Submit → `PUT /circuits/{scope}` → close + `load()`. Errors → inline banner in dialog.

### 4.4 Break-glass `Dialog`
`hours` input (1–168) → `POST /circuits/{scope}/break-glass` → `load()`.

### 4.5 Delete
`ConfirmDeleteDialog` (or plain `AlertDialog`) — phrase not required server-side, but use a simple OK/Cancel `AlertDialog` confirming the scope → `DELETE /circuits/{scope}` → `load()`.

### 4.6 `ConfirmDeleteDialog` tweak
Add an optional `confirmLabel?: string` prop (default keeps `"Delete permanently"`) so the kill-switch-off case reads "Disable kill switch". Backward-compatible — existing callers unchanged.

---

## 5. State & data flow
Single island holds: `killSwitch`, `circuits[]`, `requests[]`, `loading`, `error`, plus dialog open/edit state. One `load()` does `GET /circuits` + `GET /requests` (Promise.all), called on mount and after every mutation. All mutations `apiSend` then `load()`. No optimistic UI (keep it simple; matches AiGatewayBilling).

## 6. Diagrams

```mermaid
flowchart TD
  Page["dashboard/ai-router.astro (BaseLayout)"] --> Island["AiRouterConsole (client:load)"]
  Island -->|GET /circuits + GET /requests| API["/api/ai-router (guardianAuth, session cookie)"]
  Island --> KS["Kill switch card (Switch + ConfirmDeleteDialog 'disable kill switch')"]
  Island --> CT["Circuits ResourceTable (+ Progress, Badge, per-row enabled Switch)"]
  Island --> RT["Recent requests ResourceTable (read-only)"]
  CT --> DlgEdit["Circuit Dialog (scope builder + budget/window/enabled)"]
  CT --> DlgBG["Break-glass Dialog (hours)"]
  CT --> DlgDel["Delete AlertDialog"]
  KS -->|POST /kill-switch| API
  DlgEdit -->|PUT /circuits/{scope}| API
  DlgBG -->|POST /circuits/{scope}/break-glass| API
  DlgDel -->|DELETE /circuits/{scope}| API
```

## 7. Testing / verification
No frontend unit runner. Gate: `pnpm build` + `pnpm lint` green. Then a browser render check against a running dev server with a real session (the actual "done" bar per AGENTS #18): kill-switch toggle + confirm, create a `project:` circuit, see it in the table, break-glass it, delete it, and see the recent-requests table populate.

## 8. File list
- Create `src/frontend/pages/dashboard/ai-router.astro`
- Create `src/frontend/components/dashboard/AiRouterConsole.tsx`
- Modify `src/frontend/components/dashboard/index.ts` (barrel export)
- Modify `src/frontend/lib/config.ts` (nav entry, Dashboards group)
- Modify `src/frontend/components/storage/ConfirmDeleteDialog.tsx` (add `confirmLabel?` prop)
