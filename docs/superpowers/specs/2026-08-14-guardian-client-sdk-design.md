# Guardian Client SDK — design

**Date:** 2026-08-14
**Status:** approved (brainstorming), pending implementation plan
**Topic:** a per-language integration class other projects use to talk to core-guardian, distributed from a `clients/` folder in this repo, configured from the consumer's own `wrangler.jsonc` vars.

## Problem

Other projects (Workers, Python services, Google Apps Script) need to call core-guardian — chiefly the AI Router `/run` ingress ("heavy help for AI tasks"), plus usage metering, budget, and project status. Today each consumer would hand-roll `fetch` calls with hardcoded URLs, tokens, and its project name embedded as static strings scattered through the code. That drifts and is painful to update.

Standardize: the consumer declares its identity **once** in its own `wrangler.jsonc` `vars` (a JSON object — project name, repo, priority, budget, base URL); a thin shared class reads that config and owns every core-guardian call. Update identity = edit vars. Update behavior = re-pull the class. One source of truth for the class, in this repo.

## Non-goals

- No npm / PyPI publish pipeline. GAS has no package manager anyway, so publish-based distribution can't cover the whole fleet. Distribution is git-based (vendor the file per language).
- No new auth model. The class uses the two existing token audiences unchanged.
- Python and GAS clients are **phase 2** — this spec ships the TS client, the distribution folder, the instructions endpoint + MCP tool, and the worker-template auto-pull. Python/GAS reuse the same endpoints and config shape.

## Architecture

### 1. `clients/` folder (source of truth, in core-guardian)

```
clients/
  VERSION                      # semver, e.g. 1.0.0 — bump on breaking change; endpoint + MCP tool echo it
  README.md                    # pull instructions per language (curl / submodule / degit)
  ts/guardian-client.ts        # Workers — fetch-based, zero runtime deps
  python/guardian_client.py    # phase 2
  gas/GuardianClient.gs        # phase 2
```

Each file is standalone and dependency-free so vendoring is a single-file copy. `VERSION` is the contract marker consumers pin to.

### 2. Config — consumer's `wrangler.jsonc` vars

A single object var, plus two secret bindings (secrets never go in vars):

```jsonc
// consumer wrangler.jsonc
"vars": {
  "GUARDIAN": {
    "project":  "my-worker",                          // required → ai-router `project` / register `worker`
    "repo":     "jmbish04/my-worker",                 // optional, informational
    "priority": "normal",                             // hobby | normal | important | critical
    "budget":   25,                                   // monthly USD hint, informational
    "baseUrl":  "https://core-guardian.hacolby.workers.dev"
  }
}
// secrets (wrangler secret put): GUARDIAN_AI_TOKEN, GUARDIAN_API_KEY
```

Wrangler supports JSON-object `vars` values, so `env.GUARDIAN` arrives as a parsed object (in Workers it may be an object or a JSON string depending on platform serialization — the class accepts both: object as-is, string via `JSON.parse`).

- `priority` mirrors core-guardian's `criticality` enum, so a consumer's declared priority is portable to the project registry later.
- `baseUrl` defaults to the production origin if omitted.

### 3. Token routing

Two audiences already exist in core-guardian; the class hides which is which:

| Class method | Endpoint | Auth header |
|---|---|---|
| `ai.run`, `ai.stream` | `POST /api/ai-router/run` | `Bearer GUARDIAN_AI_TOKEN` (= `CLOUDFLARE_AI_GATEWAY_TOKEN`) |
| `usage.register` | `POST /api/guardian/usage/register` | `Bearer GUARDIAN_API_KEY` (= `WORKER_API_KEY`) |
| `budget` | `GET /api/ai/budget` | `Bearer GUARDIAN_API_KEY` |
| `project` | `GET /api/guardian/projects/{project}` | `Bearer GUARDIAN_API_KEY` |

### 4. TS class interface

```ts
export type GuardianConfig = {
  project: string;
  repo?: string;
  priority?: "hobby" | "normal" | "important" | "critical";
  budget?: number;
  baseUrl?: string;
};

export class GuardianClient {
  static fromEnv(env: unknown): GuardianClient;   // reads env.GUARDIAN + env.GUARDIAN_AI_TOKEN + env.GUARDIAN_API_KEY
  constructor(opts: GuardianConfig & { aiToken?: string; apiKey?: string; fetch?: typeof fetch });

  ai: {
    // project auto-injected from config; importance defaults from config.priority mapping
    run(input: RunInput): Promise<RunResult>;
    stream(input: RunInput): AsyncIterable<Uint8Array>;   // stream:true; yields raw body chunks
  };
  usage: {
    register(u: RegisterInput): Promise<RegisterResult>;  // config.project → `worker`
  };
  budget(): Promise<BudgetStatus>;
  project(): Promise<ProjectStatus>;
}
```

`RunInput` maps to the `/run` body: `{ provider, model, input, importance?, mode?, aiGatewayId?, transport?, providerApiKey? }`. `project` and default `importance` come from config; caller may override `importance` per call.

**`importance` from `priority`:** `hobby|normal → low`, `important → medium`, `critical → high`. Overridable per call.

### 5. Errors

`GuardianError extends Error { status: number; body: unknown }`. Any non-2xx throws. A 429 whose body carries `isCircuitBreaker` sets `err.isCircuitBreaker = true` and exposes `circuitBrokenMessage` so callers can back off without parsing the body.

### 6. Instructions endpoint + MCP tool

Served **from** core-guardian so it is always current. Public — integration docs are not secret.

```
GET /api/integration/instructions?lang=ts|python|gas&mode=curl|submodule|degit
```

Response (JSON) contains, with the live `baseUrl` and current `VERSION` interpolated:
- `pull` — the exact command(s) for the chosen `lang`+`mode`.
- `varsStub` — the `GUARDIAN` var block for the consumer's `wrangler.jsonc`.
- `secrets` — the two `wrangler secret put` commands.
- `usage` — a minimal snippet for that language.
- `version` — the current client VERSION.

Backed by a pure module `src/backend/guardian/integration.ts` (string builders, no I/O beyond reading `clients/VERSION` — bundled as a static import so no filesystem read at runtime). Mounted as a new public router at `/api/integration` in `src/backend/api/index.ts`.

MCP tool `guardian_integration_instructions` (args: `lang`, `mode`) wraps the same module, matching the existing tool-registry pattern in `routes/mcp.ts`. Non-destructive.

### 7. Worker-template auto-pull (recommended: build-time fetch, commit the vendored file)

For `core-template-cfw-assets-astro-shadcn` (separate repo — delivered here as drop-in files, applied there by the user):

- `scripts/pull-guardian.mjs` — sparse-fetches `clients/ts/guardian-client.ts` at ref `GUARDIAN_CLIENT_REF` (default `main`) into `src/lib/guardian/guardian-client.ts`.
- `package.json`: `"postinstall": "node scripts/pull-guardian.mjs"` and a `"predeploy"` hook so a fresh clone and every deploy refresh the vendored copy.
- The vendored file is **committed** (not gitignored): deploys are reproducible and don't depend on a fetch succeeding at deploy time; re-running the script refreshes on demand. Pin `GUARDIAN_CLIENT_REF` to a tag for stability.
- The template's `wrangler.jsonc` ships the `GUARDIAN` var stub and a comment naming the two secrets.

## Data flow

```
consumer worker
  └─ GuardianClient.fromEnv(env)
       reads env.GUARDIAN (config) + env.GUARDIAN_AI_TOKEN + env.GUARDIAN_API_KEY
  └─ g.ai.run({provider, model, input})
       POST {baseUrl}/api/ai-router/run   Bearer GUARDIAN_AI_TOKEN
       body: {project: config.project, importance: map(config.priority), provider, model, input}
  └─ g.usage.register({...})
       POST {baseUrl}/api/guardian/usage/register  Bearer GUARDIAN_API_KEY
       body: {worker: config.project, ...}
```

New project bootstrap:
```
GET {baseUrl}/api/integration/instructions?lang=ts&mode=curl
  → pull command + vars stub + secret commands + usage snippet (version-stamped)
```

## Testing

- **TS client (unit, injected `fetch`):** config resolution from `env.GUARDIAN` as object and as JSON string; missing `project` throws; `priority → importance` mapping; correct URL, method, and Authorization header per method; non-2xx → `GuardianError`; 429 breaker body → `isCircuitBreaker`. No network.
- **`integration.ts` (unit):** for each `lang`×`mode`, output contains the live `baseUrl`, the current `VERSION`, and a syntactically plausible pull command; unknown `lang`/`mode` → 400-shaped error.
- **`pull-guardian.mjs` (self-check):** dry-run against a fixture ref writes the expected target path; failure to fetch exits non-zero (deploy must not silently vendor nothing).

## Files touched

New in core-guardian:
- `clients/VERSION`, `clients/README.md`, `clients/ts/guardian-client.ts`
- `src/backend/guardian/integration.ts`
- `src/backend/api/routes/integration.ts`
- one tool entry in `src/backend/api/routes/mcp.ts`
- mount line in `src/backend/api/index.ts`

Delivered for the template repo (applied by user):
- `scripts/pull-guardian.mjs`, `package.json` script lines, `wrangler.jsonc` `GUARDIAN` stub.

Phase 2 (separate plan): `clients/python/guardian_client.py`, `clients/gas/GuardianClient.gs`, and their `lang` branches in `integration.ts`.
