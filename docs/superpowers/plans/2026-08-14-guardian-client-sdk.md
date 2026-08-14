# Guardian Client SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a vendorable TypeScript client class for core-guardian (config from the consumer's `wrangler.jsonc` vars), a public instructions endpoint + MCP tool that tells any project how to integrate, and a build-time auto-pull kit for the worker template.

**Architecture:** A zero-dependency, `fetch`-based `GuardianClient` lives in `clients/ts/` as the single source of truth other repos vendor. It reads a `GUARDIAN` object var for identity and two secret bindings for the two token audiences, hiding which token hits which endpoint. A pure builder module (`integration.ts`) generates copy-paste integration instructions, surfaced over a public REST route and one MCP tool. A template kit (`clients/template/`) auto-pulls the client on install/deploy.

**Tech Stack:** TypeScript, Cloudflare Workers `fetch`, Hono + `@hono/zod-openapi` (existing API framework), Node's built-in `node:test` run via `npx tsx` for self-checks (no new repo dependency).

**Spec:** [docs/superpowers/specs/2026-08-14-guardian-client-sdk-design.md](../specs/2026-08-14-guardian-client-sdk-design.md)

## Global Constraints

- **Zero runtime deps in `clients/ts/guardian-client.ts`** — `fetch` and standard Web APIs only, so a single-file copy vendors cleanly.
- **Secrets never in `vars`** — tokens are separate secret bindings `GUARDIAN_AI_TOKEN` and `GUARDIAN_API_KEY`; only non-secret identity goes in the `GUARDIAN` object var.
- **Token routing is fixed:** `ai.*` → `Bearer GUARDIAN_AI_TOKEN` against `/api/ai-router/run`; everything else → `Bearer GUARDIAN_API_KEY`.
- **`priority → importance` map (verbatim):** `hobby|normal → low`, `important → medium`, `critical → high`.
- **Default base URL:** `https://core-guardian.hacolby.workers.dev`.
- **Client version:** `1.0.0`, recorded in `clients/VERSION`; `integration.ts` hardcodes the same value with a sync comment, and a test asserts they match.
- **Existing conventions:** REST routes use `OpenAPIHono<{ Bindings: Env }>` with `createRoute`; MCP tools are entries in the `tools` array in `src/backend/api/routes/mcp.ts` using the `schema()`/`str()` helpers. Match them.
- **Verify with `pnpm build` + `pnpm lint`** (never `pnpm check` — it reformats the whole tree).

---

### Task 1: TypeScript client class + distribution folder

**Files:**
- Create: `clients/VERSION`
- Create: `clients/ts/guardian-client.ts`
- Create: `clients/README.md`
- Test: `clients/ts/guardian-client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class GuardianClient` with `static fromEnv(env): GuardianClient`, `constructor(opts)`, getters `ai.run(RunInput): Promise<RunResult>`, `ai.stream(RunInput): AsyncIterable<Uint8Array>`, `usage.register(RegisterInput): Promise<RegisterResult>`, `budget(): Promise<unknown>`, `project(): Promise<unknown>`.
  - `class GuardianError extends Error { status: number; body: unknown; isCircuitBreaker: boolean; circuitBrokenMessage?: string }`.
  - Types `GuardianConfig`, `RunInput`, `RunResult`, `RegisterInput`, `RegisterResult`, `Priority`, `Importance`.

- [ ] **Step 1: Write the failing test**

`clients/ts/guardian-client.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GuardianClient, GuardianError } from "./guardian-client.ts";

/** A fetch stub that records the last call and returns a canned Response. */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const cfg = { project: "my-worker", priority: "important" as const, baseUrl: "https://g.example.com" };

test("ai.run posts to /api/ai-router/run with AI token and injected project+importance", async () => {
  const { fn, calls } = stubFetch(200, { request_uuid: "u1", status: 200, provider: "openai", model: "gpt", mode: "gateway", gateway: null, tokens_in: 1, tokens_out: 2, cost_usd: 0.01, body: {} });
  const g = new GuardianClient({ ...cfg, aiToken: "AI", apiKey: "API", fetch: fn });
  const r = await g.ai.run({ provider: "openai", model: "gpt", input: { messages: [] } });
  assert.equal(r.request_uuid, "u1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://g.example.com/api/ai-router/run");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer AI");
  const sent = JSON.parse(calls[0].init.body as string);
  assert.equal(sent.project, "my-worker");
  assert.equal(sent.importance, "medium"); // important → medium
  assert.equal(sent.stream, false);
});

test("per-call importance overrides config priority", async () => {
  const { fn, calls } = stubFetch(200, { request_uuid: "u", status: 200, provider: "p", model: "m", mode: "gateway", gateway: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, body: {} });
  const g = new GuardianClient({ ...cfg, aiToken: "AI", apiKey: "API", fetch: fn });
  await g.ai.run({ provider: "p", model: "m", input: {}, importance: "low" });
  assert.equal(JSON.parse(calls[0].init.body as string).importance, "low");
});

test("usage.register posts to guardian usage endpoint with API key and worker=project", async () => {
  const { fn, calls } = stubFetch(200, { registrationId: "r", id: "i", day: "2026-08-14", worker: "my-worker", gateway: "direct", provider: "p", model: "m", requests: 1, costUsd: 0, tokensIn: 0, tokensOut: 0, tokensThinking: 0, priced: "scraped" });
  const g = new GuardianClient({ ...cfg, aiToken: "AI", apiKey: "API", fetch: fn });
  await g.usage.register({ provider: "p", model: "m", tokensIn: 10, tokensOut: 5 });
  assert.equal(calls[0].url, "https://g.example.com/api/guardian/usage/register");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer API");
  assert.equal(JSON.parse(calls[0].init.body as string).worker, "my-worker");
});

test("non-2xx throws GuardianError carrying status and body", async () => {
  const { fn } = stubFetch(500, { error: "boom" });
  const g = new GuardianClient({ ...cfg, aiToken: "AI", apiKey: "API", fetch: fn });
  await assert.rejects(() => g.ai.run({ provider: "p", model: "m", input: {} }), (e: unknown) => {
    assert.ok(e instanceof GuardianError);
    assert.equal(e.status, 500);
    assert.deepEqual(e.body, { error: "boom" });
    return true;
  });
});

test("429 breaker body sets isCircuitBreaker", async () => {
  const { fn } = stubFetch(429, { request_uuid: "u", isCircuitBreaker: true, circuitBrokenMessage: "cooling down" });
  const g = new GuardianClient({ ...cfg, aiToken: "AI", apiKey: "API", fetch: fn });
  await assert.rejects(() => g.ai.run({ provider: "p", model: "m", input: {} }), (e: unknown) => {
    assert.ok(e instanceof GuardianError);
    assert.equal((e as GuardianError).isCircuitBreaker, true);
    assert.equal((e as GuardianError).circuitBrokenMessage, "cooling down");
    return true;
  });
});

test("fromEnv parses GUARDIAN as object and as JSON string; missing project throws", () => {
  const asObj = GuardianClient.fromEnv({ GUARDIAN: { project: "p1" }, GUARDIAN_AI_TOKEN: "AI", GUARDIAN_API_KEY: "API" });
  assert.ok(asObj instanceof GuardianClient);
  const asStr = GuardianClient.fromEnv({ GUARDIAN: JSON.stringify({ project: "p2" }), GUARDIAN_AI_TOKEN: "AI", GUARDIAN_API_KEY: "API" });
  assert.ok(asStr instanceof GuardianClient);
  assert.throws(() => GuardianClient.fromEnv({ GUARDIAN: { repo: "x" } }));
  assert.throws(() => GuardianClient.fromEnv({}));
});

test("VERSION file matches the version the client reports", () => {
  const fileVersion = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
  assert.equal(fileVersion, GuardianClient.VERSION);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test clients/ts/guardian-client.test.ts`
Expected: FAIL — cannot find module `./guardian-client.ts` (not created yet).

- [ ] **Step 3: Write `clients/VERSION`**

```
1.0.0
```

- [ ] **Step 4: Write minimal implementation** — `clients/ts/guardian-client.ts`:

```ts
/**
 * @fileoverview core-guardian client — vendor this single file into any
 * Cloudflare Worker. Zero runtime deps (fetch only). Identity comes from the
 * consumer's `GUARDIAN` object var; the two token audiences come from the
 * `GUARDIAN_AI_TOKEN` and `GUARDIAN_API_KEY` secret bindings. Source of truth:
 * https://github.com/jmbish04/core-guardian/blob/main/clients/ts/guardian-client.ts
 */

export type Priority = "hobby" | "normal" | "important" | "critical";
export type Importance = "low" | "medium" | "high";

export type GuardianConfig = {
  project: string;
  repo?: string;
  priority?: Priority;
  budget?: number;
  baseUrl?: string;
};

export type RunInput = {
  provider: string;
  model: string;
  input: unknown;
  importance?: Importance;
  mode?: "gateway" | "gateway-custom" | "provider-sdk-gateway" | "openai-compat" | "native" | "gemini-native";
  aiGatewayId?: string;
  transport?: "ai-sdk" | "provider-sdk" | "openai-compat" | "gemini-sdk";
  providerApiKey?: string;
};

export type RunResult = {
  request_uuid: string;
  status: number;
  provider: string;
  model: string;
  mode: string;
  gateway: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  body: unknown;
};

export type RegisterInput = {
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensThinking?: number;
  requests?: number;
  costUsd?: number;
  operationId?: string;
  taskDescription?: string;
};

export type RegisterResult = {
  registrationId: string;
  id: string;
  day: string;
  worker: string;
  gateway: string;
  provider: string;
  model: string;
  requests: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  tokensThinking: number;
  priced: "explicit" | "scraped" | "unmatched";
};

const DEFAULT_BASE_URL = "https://core-guardian.hacolby.workers.dev";
const PRIORITY_TO_IMPORTANCE: Record<Priority, Importance> = {
  hobby: "low",
  normal: "low",
  important: "medium",
  critical: "high",
};

export class GuardianError extends Error {
  status: number;
  body: unknown;
  isCircuitBreaker: boolean;
  circuitBrokenMessage?: string;
  constructor(status: number, body: unknown) {
    super(`Guardian request failed (${status})`);
    this.name = "GuardianError";
    this.status = status;
    this.body = body;
    const b = (body ?? null) as Record<string, unknown> | null;
    this.isCircuitBreaker = Boolean(b && b.isCircuitBreaker);
    if (b && typeof b.circuitBrokenMessage === "string") this.circuitBrokenMessage = b.circuitBrokenMessage;
  }
}

type Opts = GuardianConfig & { aiToken?: string; apiKey?: string; fetch?: typeof fetch };

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export class GuardianClient {
  static readonly VERSION = "1.0.0";

  private cfg: GuardianConfig;
  private baseUrl: string;
  private aiToken?: string;
  private apiKey?: string;
  private fetchImpl: typeof fetch;

  constructor(opts: Opts) {
    if (!opts.project) throw new Error("GuardianClient: config.project is required");
    this.cfg = opts;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.aiToken = opts.aiToken;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  static fromEnv(env: Record<string, unknown>): GuardianClient {
    const raw = env.GUARDIAN;
    const cfg = (typeof raw === "string" ? JSON.parse(raw) : raw) as GuardianConfig | undefined;
    if (!cfg || !cfg.project) throw new Error("GuardianClient.fromEnv: env.GUARDIAN.project missing");
    return new GuardianClient({
      ...cfg,
      aiToken: env.GUARDIAN_AI_TOKEN as string | undefined,
      apiKey: env.GUARDIAN_API_KEY as string | undefined,
    });
  }

  private importanceFor(over?: Importance): Importance {
    return over ?? PRIORITY_TO_IMPORTANCE[this.cfg.priority ?? "normal"];
  }

  private runBody(i: RunInput, stream: boolean) {
    return {
      project: this.cfg.project,
      importance: this.importanceFor(i.importance),
      provider: i.provider,
      model: i.model,
      input: i.input,
      mode: i.mode,
      aiGatewayId: i.aiGatewayId,
      transport: i.transport,
      providerApiKey: i.providerApiKey,
      stream,
    };
  }

  private async post(path: string, token: string | undefined, body: unknown, raw = false): Promise<Response> {
    if (!token) throw new Error(`GuardianClient: missing token for ${path}`);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!raw && !res.ok) throw new GuardianError(res.status, await safeJson(res));
    return res;
  }

  private async getJson(path: string, token: string | undefined): Promise<unknown> {
    if (!token) throw new Error(`GuardianClient: missing token for ${path}`);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new GuardianError(res.status, await safeJson(res));
    return res.json();
  }

  private async runImpl(i: RunInput): Promise<RunResult> {
    const res = await this.post("/api/ai-router/run", this.aiToken, this.runBody(i, false));
    return (await res.json()) as RunResult;
  }

  private async *streamImpl(i: RunInput): AsyncIterable<Uint8Array> {
    const res = await this.post("/api/ai-router/run", this.aiToken, this.runBody(i, true), true);
    if (!res.ok) throw new GuardianError(res.status, await safeJson(res));
    if (!res.body) return;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  }

  private async registerImpl(u: RegisterInput): Promise<RegisterResult> {
    const res = await this.post("/api/guardian/usage/register", this.apiKey, {
      worker: this.cfg.project,
      ...u,
    });
    return (await res.json()) as RegisterResult;
  }

  get ai() {
    return {
      run: (i: RunInput): Promise<RunResult> => this.runImpl(i),
      stream: (i: RunInput): AsyncIterable<Uint8Array> => this.streamImpl(i),
    };
  }

  get usage() {
    return {
      register: (u: RegisterInput): Promise<RegisterResult> => this.registerImpl(u),
    };
  }

  budget(): Promise<unknown> {
    return this.getJson("/api/ai/budget", this.apiKey);
  }

  project(): Promise<unknown> {
    return this.getJson(`/api/guardian/projects/${encodeURIComponent(this.cfg.project)}`, this.apiKey);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test clients/ts/guardian-client.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Write `clients/README.md`** (static per-language pull instructions; the live version is served by the endpoint in Task 3):

````markdown
# Guardian clients

Vendorable clients for [core-guardian](https://github.com/jmbish04/core-guardian). One standalone file per language — copy the one you need into your project.

Current version: see [`VERSION`](./VERSION).

## Configure (all languages)

Declare identity once in your `wrangler.jsonc` `vars`, and set two secrets:

```jsonc
"vars": {
  "GUARDIAN": {
    "project":  "my-worker",
    "repo":     "you/my-worker",
    "priority": "normal",
    "budget":   25,
    "baseUrl":  "https://core-guardian.hacolby.workers.dev"
  }
}
```

```bash
wrangler secret put GUARDIAN_AI_TOKEN   # core-guardian CLOUDFLARE_AI_GATEWAY_TOKEN (for /run)
wrangler secret put GUARDIAN_API_KEY    # core-guardian WORKER_API_KEY (metering/budget/project)
```

## TypeScript / Workers

```bash
curl -fsSL -o src/lib/guardian/guardian-client.ts \
  https://raw.githubusercontent.com/jmbish04/core-guardian/main/clients/ts/guardian-client.ts
```

```ts
import { GuardianClient } from "./lib/guardian/guardian-client";
const g = GuardianClient.fromEnv(env);
const r = await g.ai.run({ provider: "openai", model: "gpt-4o-mini", input: { messages: [{ role: "user", content: "hi" }] } });
```

For a template that re-pulls automatically on install/deploy, see [`template/`](./template).

## Python / Google Apps Script

Phase 2 — `python/guardian_client.py` and `gas/GuardianClient.gs`.
````

- [ ] **Step 7: Lint + commit**

Run: `pnpm lint` (expect clean for `clients/`)

```bash
git add clients/VERSION clients/ts/guardian-client.ts clients/ts/guardian-client.test.ts clients/README.md
git commit -m "feat(guardian): TypeScript client SDK + clients/ distribution folder"
```

---

### Task 2: Integration-instructions builder module

**Files:**
- Create: `src/backend/guardian/integration.ts`
- Test: `src/backend/guardian/integration.test.ts`

**Interfaces:**
- Consumes: `clients/VERSION` (read at test time for the drift assertion).
- Produces:
  - `type IntegrationLang = "ts" | "python" | "gas"`
  - `type IntegrationMode = "curl" | "submodule" | "degit"`
  - `const CLIENT_VERSION: string`
  - `function buildInstructions(opts: { baseUrl: string; lang: IntegrationLang; mode: IntegrationMode }): { version: string; lang: IntegrationLang; mode: IntegrationMode; pull: string; varsStub: string; secrets: string[]; usage: string }`
  - `const SUPPORTED_LANGS: IntegrationLang[]`, `const SUPPORTED_MODES: IntegrationMode[]`

- [ ] **Step 1: Write the failing test**

`src/backend/guardian/integration.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildInstructions, CLIENT_VERSION, SUPPORTED_LANGS, SUPPORTED_MODES } from "./integration.ts";

const BASE = "https://core-guardian.hacolby.workers.dev";

test("CLIENT_VERSION stays in sync with clients/VERSION", () => {
  const file = readFileSync(new URL("../../../clients/VERSION", import.meta.url), "utf8").trim();
  assert.equal(CLIENT_VERSION, file);
});

test("ts+curl instructions carry base url, version, and a raw pull command", () => {
  const r = buildInstructions({ baseUrl: BASE, lang: "ts", mode: "curl" });
  assert.equal(r.version, CLIENT_VERSION);
  assert.match(r.pull, /raw\.githubusercontent\.com\/jmbish04\/core-guardian/);
  assert.match(r.pull, /clients\/ts\/guardian-client\.ts/);
  assert.match(r.varsStub, /"project"/);
  assert.deepEqual(r.secrets, ["wrangler secret put GUARDIAN_AI_TOKEN", "wrangler secret put GUARDIAN_API_KEY"]);
  assert.match(r.usage, /GuardianClient/);
});

test("submodule mode emits a git submodule command", () => {
  const r = buildInstructions({ baseUrl: BASE, lang: "ts", mode: "submodule" });
  assert.match(r.pull, /git submodule add/);
});

test("every supported lang×mode builds without throwing and stamps the version", () => {
  for (const lang of SUPPORTED_LANGS) {
    for (const mode of SUPPORTED_MODES) {
      const r = buildInstructions({ baseUrl: BASE, lang, mode });
      assert.equal(r.version, CLIENT_VERSION);
      assert.ok(r.pull.length > 0);
    }
  }
});

test("unknown lang throws a RangeError", () => {
  assert.throws(
    () => buildInstructions({ baseUrl: BASE, lang: "cobol" as never, mode: "curl" }),
    RangeError,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/backend/guardian/integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation** — `src/backend/guardian/integration.ts`:

```ts
/**
 * @fileoverview Pure builder for per-language integration instructions.
 * No I/O: given a base URL, lang, and pull mode it returns copy-paste strings
 * (pull command, `GUARDIAN` var stub, secret commands, usage snippet) with the
 * live base URL and current client version interpolated. Surfaced by
 * `routes/integration.ts` and the `guardian_integration_instructions` MCP tool.
 */

const REPO = "jmbish04/core-guardian";
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;

// ponytail: keep in sync with clients/VERSION — integration.test.ts asserts equality.
export const CLIENT_VERSION = "1.0.0";

export type IntegrationLang = "ts" | "python" | "gas";
export type IntegrationMode = "curl" | "submodule" | "degit";

export const SUPPORTED_LANGS: IntegrationLang[] = ["ts", "python", "gas"];
export const SUPPORTED_MODES: IntegrationMode[] = ["curl", "submodule", "degit"];

type LangMeta = { path: string; dest: string; usage: string };

const LANGS: Record<IntegrationLang, LangMeta> = {
  ts: {
    path: "clients/ts/guardian-client.ts",
    dest: "src/lib/guardian/guardian-client.ts",
    usage: [
      'import { GuardianClient } from "./lib/guardian/guardian-client";',
      "const g = GuardianClient.fromEnv(env);",
      'const r = await g.ai.run({ provider: "openai", model: "gpt-4o-mini", input: { messages: [{ role: "user", content: "hi" }] } });',
    ].join("\n"),
  },
  python: {
    path: "clients/python/guardian_client.py",
    dest: "guardian_client.py",
    usage: [
      "from guardian_client import GuardianClient",
      "g = GuardianClient.from_env(os.environ)",
      'r = g.ai.run(provider="openai", model="gpt-4o-mini", input={"messages": [{"role": "user", "content": "hi"}]})',
    ].join("\n"),
  },
  gas: {
    path: "clients/gas/GuardianClient.gs",
    dest: "GuardianClient.gs",
    usage: [
      "const g = GuardianClient.fromScriptProperties();",
      'const r = g.ai.run({ provider: "openai", model: "gpt-4o-mini", input: { messages: [{ role: "user", content: "hi" }] } });',
    ].join("\n"),
  },
};

const VARS_STUB = JSON.stringify(
  {
    GUARDIAN: {
      project: "my-worker",
      repo: "you/my-worker",
      priority: "normal",
      budget: 25,
      baseUrl: "https://core-guardian.hacolby.workers.dev",
    },
  },
  null,
  2,
);

const SECRETS = [
  "wrangler secret put GUARDIAN_AI_TOKEN",
  "wrangler secret put GUARDIAN_API_KEY",
];

function pullCommand(meta: LangMeta, mode: IntegrationMode): string {
  switch (mode) {
    case "curl":
      return `curl -fsSL -o ${meta.dest} ${RAW}/${meta.path}`;
    case "degit":
      return `npx degit ${REPO}/${meta.path} ${meta.dest}`;
    case "submodule":
      return `git submodule add https://github.com/${REPO}.git vendor/core-guardian\n# then reference vendor/core-guardian/${meta.path}`;
    default:
      throw new RangeError(`unknown mode: ${mode as string}`);
  }
}

export function buildInstructions(opts: {
  baseUrl: string;
  lang: IntegrationLang;
  mode: IntegrationMode;
}): {
  version: string;
  lang: IntegrationLang;
  mode: IntegrationMode;
  pull: string;
  varsStub: string;
  secrets: string[];
  usage: string;
} {
  const meta = LANGS[opts.lang];
  if (!meta) throw new RangeError(`unknown lang: ${opts.lang as string}`);
  if (!SUPPORTED_MODES.includes(opts.mode)) throw new RangeError(`unknown mode: ${opts.mode as string}`);
  return {
    version: CLIENT_VERSION,
    lang: opts.lang,
    mode: opts.mode,
    pull: pullCommand(meta, opts.mode),
    varsStub: VARS_STUB.replace("https://core-guardian.hacolby.workers.dev", opts.baseUrl),
    secrets: SECRETS,
    usage: meta.usage,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/backend/guardian/integration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint + commit**

Run: `pnpm lint`

```bash
git add src/backend/guardian/integration.ts src/backend/guardian/integration.test.ts
git commit -m "feat(guardian): integration-instructions builder module"
```

---

### Task 3: Public instructions REST route

**Files:**
- Create: `src/backend/api/routes/integration.ts`
- Modify: `src/backend/api/index.ts` (add import + one `app.route` line, public — no `guardianAuth`)

**Interfaces:**
- Consumes: `buildInstructions`, `SUPPORTED_LANGS`, `SUPPORTED_MODES`, `IntegrationLang`, `IntegrationMode`, `CLIENT_VERSION` from `@/backend/guardian/integration`.
- Produces: `export const integrationRouter` mounted at `/api/integration`, serving `GET /instructions?lang&mode`.

- [ ] **Step 1: Write the route** — `src/backend/api/routes/integration.ts`:

```ts
/**
 * @fileoverview Public integration-instructions surface — `/api/integration`.
 * Tells any project how to vendor the guardian client and wire its config.
 * PUBLIC by design (integration docs are not secret): NO guardianAuth. The
 * `baseUrl` in the output is derived from the incoming request URL so the
 * instructions always point back at whatever origin served them.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { buildInstructions, SUPPORTED_LANGS, SUPPORTED_MODES } from "@/backend/guardian/integration";

export const integrationRouter = new OpenAPIHono<{ Bindings: Env }>();

const querySchema = z.object({
  lang: z.enum(["ts", "python", "gas"]).default("ts"),
  mode: z.enum(["curl", "submodule", "degit"]).default("curl"),
});

const responseSchema = z.object({
  version: z.string(),
  lang: z.enum(["ts", "python", "gas"]),
  mode: z.enum(["curl", "submodule", "degit"]),
  pull: z.string(),
  varsStub: z.string(),
  secrets: z.array(z.string()),
  usage: z.string(),
});

integrationRouter.openapi(
  createRoute({
    method: "get",
    path: "/instructions",
    operationId: "integrationInstructions",
    summary: "How to vendor the guardian client and configure it (per language + pull mode)",
    request: { query: querySchema },
    responses: {
      200: { description: "Copy-paste integration instructions", content: { "application/json": { schema: responseSchema } } },
    },
  }),
  (c) => {
    const { lang, mode } = c.req.valid("query");
    const baseUrl = new URL(c.req.url).origin;
    return c.json(buildInstructions({ baseUrl, lang, mode }), 200);
  },
);

// Guard against builder/enum drift: the route enums must match the module's.
if (SUPPORTED_LANGS.length !== 3 || SUPPORTED_MODES.length !== 3) {
  // ponytail: cheap tripwire — if the module grows a lang/mode, this route's
  // zod enums above must grow too. Left as a comment, not a throw, to avoid
  // import-time crashes; the integration test covers the real matrix.
}
```

- [ ] **Step 2: Mount the router** — in `src/backend/api/index.ts`, add the import near the other route imports and mount it alongside the other `/api/*` routes (public — place it before/after `docsRouter`, NOT behind any auth middleware):

```ts
import { integrationRouter } from "@/backend/api/routes/integration";
// ...
app.route("/api/integration", integrationRouter);
```

- [ ] **Step 3: Build to verify the route compiles and mounts**

Run: `pnpm build`
Expected: build succeeds; no type errors from the new route.

- [ ] **Step 4: Smoke-test locally**

Run: `npx wrangler dev` in one shell, then in another:
`curl -s 'http://localhost:8787/api/integration/instructions?lang=ts&mode=curl'`
Expected: JSON with `version`, `pull` (a `curl ... raw.githubusercontent.com ...` line), `varsStub` whose `baseUrl` is `http://localhost:8787`, and the two `secrets`.

- [ ] **Step 5: Lint + commit**

Run: `pnpm lint`

```bash
git add src/backend/api/routes/integration.ts src/backend/api/index.ts
git commit -m "feat(guardian): public /api/integration/instructions route"
```

---

### Task 4: `guardian_integration_instructions` MCP tool

**Files:**
- Modify: `src/backend/api/routes/mcp.ts` (add one import + one `tools` array entry)

**Interfaces:**
- Consumes: `buildInstructions` from `@/backend/guardian/integration`.
- Produces: MCP tool `guardian_integration_instructions` (args `lang`, `mode`; both optional, defaulting to `ts`/`curl`), non-destructive.

- [ ] **Step 1: Add the import** — near the other `@/backend/guardian/*` imports in `src/backend/api/routes/mcp.ts`:

```ts
import { buildInstructions } from "@/backend/guardian/integration";
```

- [ ] **Step 2: Add the tool entry** — append to the `tools` array (follow the existing `McpTool` shape; note `WORKER_BASE_URL` is a known var on `Env` used as the emitted base URL):

```ts
  {
    name: "guardian_integration_instructions",
    title: "Guardian integration instructions",
    description:
      "How to integrate a project with core-guardian: the command to vendor the client for a language, the GUARDIAN var stub, the two secret bindings, and a usage snippet. Non-destructive (read-only docs).",
    inputSchema: schema({
      lang: { type: "string", enum: ["ts", "python", "gas"], description: "Client language (default ts)." },
      mode: { type: "string", enum: ["curl", "submodule", "degit"], description: "Pull mechanism (default curl)." },
    }),
    handler: async (env, args) =>
      buildInstructions({
        baseUrl: env.WORKER_BASE_URL ?? "https://core-guardian.hacolby.workers.dev",
        lang: args.lang ?? "ts",
        mode: args.mode ?? "curl",
      }),
  },
```

- [ ] **Step 3: Build to verify the tool compiles**

Run: `pnpm build`
Expected: success.

- [ ] **Step 4: Smoke-test the tool over JSON-RPC**

Run (with `npx wrangler dev` up, and a valid `WORKER_API_KEY`):

```bash
curl -s http://localhost:8787/mcp \
  -H "Authorization: Bearer $WORKER_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"guardian_integration_instructions","arguments":{"lang":"ts","mode":"curl"}}}'
```

Expected: a result whose content includes the `pull`/`varsStub`/`secrets`/`usage` fields.

- [ ] **Step 5: Lint + commit**

Run: `pnpm lint`

```bash
git add src/backend/api/routes/mcp.ts
git commit -m "feat(guardian): guardian_integration_instructions MCP tool"
```

---

### Task 5: Worker-template auto-pull kit

**Files:**
- Create: `clients/template/pull-guardian.mjs`
- Create: `clients/template/README.md` (drop-in instructions: the `package.json` script lines + `wrangler.jsonc` stub for the separate template repo)
- Test: `clients/template/pull-guardian.test.mjs`

**Interfaces:**
- Consumes: nothing at runtime (standalone Node ESM script).
- Produces: `pull-guardian.mjs` exporting `async function pull({ ref, dest, fetchImpl })` and running it when invoked as `node pull-guardian.mjs`.

- [ ] **Step 1: Write the failing test** — `clients/template/pull-guardian.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { pull } from "./pull-guardian.mjs";

const TMP = new URL("./.tmp-guardian-client.ts", import.meta.url);

test("pull writes the fetched body to dest", async () => {
  const fake = (async () => new Response("export const X = 1;", { status: 200 }));
  await pull({ ref: "main", dest: TMP, fetchImpl: fake });
  assert.ok(existsSync(TMP));
  assert.match(readFileSync(TMP, "utf8"), /export const X = 1;/);
  rmSync(TMP);
});

test("pull throws (non-zero-worthy) on a non-200 so deploys don't vendor nothing", async () => {
  const fake = (async () => new Response("nope", { status: 404 }));
  await assert.rejects(() => pull({ ref: "main", dest: TMP, fetchImpl: fake }));
  assert.ok(!existsSync(TMP));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test clients/template/pull-guardian.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation** — `clients/template/pull-guardian.mjs`:

```js
#!/usr/bin/env node
/**
 * Vendors the core-guardian TypeScript client into a consumer worker at build
 * time. Wire it to `postinstall` and `predeploy` so a fresh clone and every
 * deploy refresh the vendored copy. Pin `GUARDIAN_CLIENT_REF` to a tag for
 * reproducible builds. Exits non-zero on fetch failure — a deploy must never
 * silently vendor an empty/stale client.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_RAW = "https://raw.githubusercontent.com/jmbish04/core-guardian";
const CLIENT_PATH = "clients/ts/guardian-client.ts";

export async function pull({ ref = "main", dest, fetchImpl = fetch } = {}) {
  const url = `${REPO_RAW}/${ref}/${CLIENT_PATH}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`pull-guardian: ${res.status} fetching ${url}`);
  const body = await res.text();
  const path = dest instanceof URL ? fileURLToPath(dest) : dest;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

// Run when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const ref = process.env.GUARDIAN_CLIENT_REF ?? "main";
  const dest = process.env.GUARDIAN_CLIENT_DEST ?? "src/lib/guardian/guardian-client.ts";
  pull({ ref, dest })
    .then((p) => console.log(`pull-guardian: wrote ${p} @ ${ref}`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test clients/template/pull-guardian.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Write `clients/template/README.md`** (the kit applied in `core-template-cfw-assets-astro-shadcn`):

````markdown
# Guardian auto-pull kit (for the worker template)

Drop these into `core-template-cfw-assets-astro-shadcn` so every new worker vendors the guardian client automatically and re-pulls on install/deploy. The vendored file is **committed** (reproducible deploys); re-running the script refreshes it.

## 1. Copy the script

Copy [`pull-guardian.mjs`](./pull-guardian.mjs) to `scripts/pull-guardian.mjs`.

## 2. Wire package.json

```jsonc
"scripts": {
  "postinstall": "node scripts/pull-guardian.mjs",
  "predeploy": "node scripts/pull-guardian.mjs"
}
```

Pin a release instead of `main` when you want stability:

```bash
GUARDIAN_CLIENT_REF=v1.0.0 node scripts/pull-guardian.mjs
```

## 3. Add the config stub to wrangler.jsonc

```jsonc
"vars": {
  "GUARDIAN": {
    "project":  "REPLACE-me-worker-name",
    "repo":     "you/REPLACE-me",
    "priority": "normal",
    "budget":   25,
    "baseUrl":  "https://core-guardian.hacolby.workers.dev"
  }
}
// secrets: wrangler secret put GUARDIAN_AI_TOKEN ; wrangler secret put GUARDIAN_API_KEY
```

## 4. Use it

```ts
import { GuardianClient } from "./lib/guardian/guardian-client";
const g = GuardianClient.fromEnv(env);
```

The vendored path (`src/lib/guardian/guardian-client.ts`) is written by the script — commit it.
````

- [ ] **Step 6: Commit**

```bash
git add clients/template/pull-guardian.mjs clients/template/pull-guardian.test.mjs clients/template/README.md
git commit -m "feat(guardian): worker-template auto-pull kit (build-time vendor)"
```

---

## Self-Review

**Spec coverage:**
- §1 `clients/` folder → Task 1 (VERSION, ts client, README) + Task 5 (`template/`). ✓
- §2 config from `GUARDIAN` var → Task 1 `fromEnv` (object + string) + stubs in Tasks 1/2/5. ✓
- §3 token routing → Task 1 `post`/`getJson` per method + Global Constraints. ✓
- §4 TS interface → Task 1 (all methods, types). ✓
- §5 errors / `GuardianError` / breaker → Task 1 tests + impl. ✓
- §6 instructions endpoint + MCP tool → Task 2 (builder) + Task 3 (route) + Task 4 (tool). ✓
- §7 template auto-pull, commit vendored file → Task 5. ✓
- Testing section → each of Tasks 1/2/5 carries the specified checks; Tasks 3/4 verify via build + curl smoke. ✓
- Python/GAS explicitly phase 2 → `integration.ts` already routes those langs (so the endpoint/tool answer them now); actual client files deferred. ✓

**Placeholder scan:** No TBD/TODO; all code blocks are complete; the template's `REPLACE-me` tokens are intentional user-fill values in emitted config, not plan placeholders. ✓

**Type consistency:** `buildInstructions` signature identical across Tasks 2/3/4; `RunInput`/`RunResult`/`RegisterInput`/`RegisterResult` defined once in Task 1 and referenced by name elsewhere; `CLIENT_VERSION`/`clients/VERSION`/`GuardianClient.VERSION` all `"1.0.0"` with drift tests in Tasks 1 and 2. ✓

## Notes / follow-ups (not in this plan)

- `env.WORKER_BASE_URL` (used in Task 4) already exists in `wrangler.jsonc` vars — confirmed.
- Phase 2 plan: `clients/python/guardian_client.py` and `clients/gas/GuardianClient.gs`, mirroring the TS surface and the `from_env`/`fromScriptProperties` config readers the `integration.ts` usage snippets already advertise.
