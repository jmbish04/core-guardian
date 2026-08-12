# AI Router Admin Frontend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** a `/dashboard/ai-router` page + one React island to manage AI Router circuit breakers, the global kill switch, and view a recent-requests audit table, against the existing `/api/ai-router` guardianAuth routes.

**Architecture:** thin Astro page (copy `dashboard/ai-gateway.astro`) mounting one island `AiRouterConsole.tsx`. Data via `apiGet`/`apiSend` from `@/lib/api` (same-origin, session cookie). shadcn kit already vendored. No backend changes.

**Tech Stack:** Astro SSR + React island + shadcn/ui (base-ui), oxlint. Verify = `pnpm build` + `pnpm lint`; final = browser render with a real session.

**Spec:** [2026-08-12-ai-router-2-admin-frontend-design.md](../specs/2026-08-12-ai-router-2-admin-frontend-design.md).

## Global Constraints
- Zod not involved (frontend). Import ONLY via aliases `@/components/...`, `@/lib/...`, `@/components/ui/...` (never file paths across features; use the folder barrels).
- Data: `apiGet<T>(path, params?)` / `apiSend<T>(method, path, body?)` from `@/lib/api`; plain `useState`/`useCallback`/`useEffect`; errors → inline banner, `ApiError.status===401` → "Sign in to view …". **Never** `alert()`.
- Panel style verbatim: `const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";` Hairline borders, OKLCH theme — no heavy borders.
- New page ⇒ nav entry in the SAME change (AGENTS #22).
- Verify each task with `pnpm build` && `pnpm lint` (NEVER `pnpm check` — oxfmt rewrites the tree). `.astro` isn't oxlinted → `astro build` is what catches frontmatter errors.
- Scope grammar is UI-enforced: build scope from a segmented control, reject `:` in provider/model/project segments. `global | provider:{p} | model:{p}/{m} | project:{name}`.

---

### Task 1: `ConfirmDeleteDialog` gains a `confirmLabel` prop

**Files:** Modify `src/frontend/components/storage/ConfirmDeleteDialog.tsx`

**Interfaces:** Produces: an optional `confirmLabel?: string` prop; the confirm button uses it, defaulting to the current `"Delete permanently"`. All existing callers unchanged.

- [ ] **Step 1:** Read the file. Add `confirmLabel?: string` to its props type/interface.
- [ ] **Step 2:** Where the confirm button label is hardcoded `"Delete permanently"` (~L132), replace with `{confirmLabel ?? "Delete permanently"}`.
- [ ] **Step 3:** Verify no existing caller breaks: `grep -rn "ConfirmDeleteDialog" src/frontend` — confirm they still typecheck (new prop is optional).
- [ ] **Step 4:** `pnpm build && pnpm lint` → exit 0.
- [ ] **Step 5:** Commit `feat(ui): ConfirmDeleteDialog optional confirmLabel prop`.

---

### Task 2: `AiRouterConsole` island

**Files:**
- Create `src/frontend/components/dashboard/AiRouterConsole.tsx`
- Modify `src/frontend/components/dashboard/index.ts` (add `export { AiRouterConsole } from "./AiRouterConsole";` — match the file's existing export style)

**Interfaces:**
- Consumes: `apiGet`/`apiSend`/`ApiError` from `@/lib/api`; `ResourceTable` + `ConfirmDeleteDialog` from `@/components/storage`; `Switch`, `Dialog` (+ parts), `AlertDialog` (+ parts), `Button`, `Input`, `Label`, `Badge`, `Progress`, `Select` (+ parts), `Separator` from `@/components/ui/*`; `Task 1`'s `confirmLabel`.
- Produces: default export `AiRouterConsole` React component (no props).

**Reference templates to read first (copy their patterns, do not import):** `src/frontend/components/storage/AiGatewayBilling.tsx` (load/mutation/dialog/error-banner shape), `src/frontend/components/storage/ResourceTable.tsx` (Column<T> API), `src/frontend/components/settings/WebhooksTable.tsx` (Switch usage), `src/frontend/components/storage/ConfirmDeleteDialog.tsx` (phrase barrier).

**Types (declare at top of file):**
```ts
type Window = "day" | "week" | "month" | "total";
interface Circuit { budgetUsd: number; window: Window; enabled: boolean; breakGlassUntil?: number }
interface CircuitRow { scope: string; circuit: Circuit; spent: number }
interface CircuitsResponse { killSwitch: boolean; circuits: CircuitRow[] }
interface RouterRequestRow {
  id: string; at: number; project: string; importance: string; provider: string; model: string;
  mode: string; gateway: string | null; tokensIn: number; tokensOut: number; costUsd: number;
  isError: boolean; errorMessage: string | null; isCircuitBreaker: boolean; circuitBrokenMessage: string | null;
}
```

**Data layer (verbatim shape):**
```ts
const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";
const [killSwitch, setKillSwitch] = useState(false);
const [circuits, setCircuits] = useState<CircuitRow[]>([]);
const [requests, setRequests] = useState<RouterRequestRow[]>([]);
const [loading, setLoading] = useState(true);
const [error, setError] = useState<string | null>(null);

const load = useCallback(async () => {
  setError(null);
  try {
    const [c, r] = await Promise.all([
      apiGet<CircuitsResponse>("/ai-router/circuits"),
      apiGet<{ requests: RouterRequestRow[] }>("/ai-router/requests", { limit: 50 }),
    ]);
    setKillSwitch(c.killSwitch);
    setCircuits(c.circuits);
    setRequests(r.requests);
  } catch (err) {
    setError(err instanceof ApiError && err.status === 401 ? "Sign in to manage the AI Router." : err instanceof ApiError ? err.message : "Failed to load AI Router state.");
  } finally {
    setLoading(false);
  }
}, []);
useEffect(() => { void load(); }, [load]);
```
> Confirm the exact `apiGet` path convention by reading `@/lib/api` + an existing caller: paths are passed WITHOUT the `/api` prefix (e.g. `apiGet("/ai-gateway/billing")`). Match whatever the real callers do — adjust the strings above if the convention differs.

**Mutations (all `apiSend` then `await load()`):**
```ts
// kill switch ON (immediate)
await apiSend("POST", "/ai-router/kill-switch", { on: true }); await load();
// kill switch OFF (from ConfirmDeleteDialog confirm handler)
await apiSend("POST", "/ai-router/kill-switch", { on: false, confirm: "disable kill switch" }); await load();
// toggle a circuit's enabled (per-row Switch)
await apiSend("PUT", `/ai-router/circuits/${encodeURIComponent(row.scope)}`, { budgetUsd: row.circuit.budgetUsd, window: row.circuit.window, enabled: next }); await load();
// create/edit
await apiSend("PUT", `/ai-router/circuits/${encodeURIComponent(scope)}`, { budgetUsd, window, enabled }); await load();
// break-glass
await apiSend("POST", `/ai-router/circuits/${encodeURIComponent(scope)}/break-glass`, { hours }); await load();
// delete
await apiSend("DELETE", `/ai-router/circuits/${encodeURIComponent(scope)}`); await load();
```

**Scope builder (create dialog only; edit shows scope read-only):**
```ts
type ScopeKind = "global" | "provider" | "model" | "project";
const PROVIDERS = ["openai", "anthropic", "google", "workers-ai"] as const;
function buildScope(kind: ScopeKind, provider: string, model: string, project: string): { scope?: string; err?: string } {
  const bad = (s: string) => s.includes(":");
  if (kind === "global") return { scope: "global" };
  if (kind === "provider") return provider ? { scope: `provider:${provider}` } : { err: "Pick a provider." };
  if (kind === "model") {
    if (!provider || !model) return { err: "Provider and model required." };
    if (bad(model)) return { err: "Model must not contain ':'." };
    return { scope: `model:${provider}/${model}` };
  }
  if (!project) return { err: "Project required." };
  if (bad(project)) return { err: "Project must not contain ':'." };
  return { scope: `project:${project}` };
}
```

- [ ] **Step 1:** Read the 4 reference templates + `@/lib/api` + `dashboard/index.ts`. Confirm the `apiGet`/`apiSend` path convention and the exact `ResourceTable` `Column<T>` shape and `Switch` props.
- [ ] **Step 2:** Write `AiRouterConsole.tsx` per the spec §4.2: three PANEL sections — (A) kill-switch card (big ARMED/ACTIVE status, destructive styling when active, `Switch`; OFF opens `ConfirmDeleteDialog` phrase `"disable kill switch"` `confirmLabel="Disable kill switch"`), (B) circuits `ResourceTable` (scope, budget, window, spent+`Progress` bar with warning≥80%/destructive≥100% tint, "TRIPPED" `Badge` when `spent>=budgetUsd`, per-row `enabled` `Switch`, break-glass `Badge` when `breakGlassUntil>Date.now()`, row actions Edit/Break-glass/Delete, a "New circuit" button, empty state), (C) recent-requests `ResourceTable` (time, project, importance `Badge`, provider/model, mode, tokensIn/out, costUsd, status cell TRIPPED/ERROR/OK). Loading → `Skeleton` or a "Loading…" line; error/401 → inline banner. Include the create/edit `Dialog` (scope builder + budget/window/enabled), break-glass `Dialog` (hours 1–168), and delete `AlertDialog`.
- [ ] **Step 3:** Add the barrel export in `dashboard/index.ts`.
- [ ] **Step 4:** `pnpm build && pnpm lint` → exit 0. Fix any type/lint errors (esp. a11y: label associations, button types).
- [ ] **Step 5:** Commit `feat(ai-router): AiRouterConsole admin island (circuits, kill switch, requests)`.

---

### Task 3: page + nav entry

**Files:**
- Create `src/frontend/pages/dashboard/ai-router.astro`
- Modify `src/frontend/lib/config.ts` (nav entry in the "Dashboards" group)

**Interfaces:** Consumes `AiRouterConsole` from `@/components/dashboard`.

- [ ] **Step 1:** Copy `src/frontend/pages/dashboard/ai-gateway.astro` structure to `ai-router.astro`: `BaseLayout` with a title/description, `<main class="container mx-auto flex max-w-6xl flex-col gap-8 px-4 py-12">`, a `← Core Guardian` back-link to `/dashboard/guardian`, and `<AiRouterConsole client:load />` imported from `@/components/dashboard`.
- [ ] **Step 2:** Read `src/frontend/lib/config.ts` ~L48-64. Add an entry to the `"Dashboards"` `navGroup` (match the existing item shape exactly): label "AI Router", href "/dashboard/ai-router" (+ description/icon if the shape has those).
- [ ] **Step 3:** `pnpm build && pnpm lint` → exit 0 (build compiles the `.astro` + confirms the import resolves and nav typechecks).
- [ ] **Step 4:** Commit `feat(ai-router): dashboard/ai-router page + nav entry`.

---

## Final verification (whole feature)
- `pnpm build` + `pnpm lint` green on the branch.
- **Browser render check** (the real "done" bar, AGENTS #18): `pnpm dev`, open `/dashboard/ai-router` signed in — kill-switch toggle + confirm-to-disable works, create a `project:test` circuit at $1, see it in the table with a spend bar, break-glass it, delete it, and the recent-requests table renders rows (or a clean empty state). Screenshot for the PR.

## Self-review notes
- Spec coverage: kill switch (T2-A) · circuits CRUD + break-glass (T2-B + dialogs) · recent requests (T2-C) · confirm barrier (T1 + T2) · page+nav (T3). All mapped.
- The one novel-logic bit (scope builder) has verbatim code + guards; everything else is convention-following against named templates.
- No backend touched; no new deps.
