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
  private fetchImpl: typeof fetch;
  // `declare` emits NO runtime field — the tokens are defined as non-enumerable
  // properties in the constructor, so neither JSON.stringify nor
  // util.inspect/console.log (Workers Logs) ever surfaces them.
  private declare readonly aiToken?: string;
  private declare readonly apiKey?: string;

  constructor(opts: Opts) {
    if (!opts.project) throw new Error("GuardianClient: config.project is required");
    // Narrowed copy — never spread aiToken/apiKey into cfg, or a logged/serialized
    // client instance would leak both secrets.
    this.cfg = { project: opts.project, repo: opts.repo, priority: opts.priority, budget: opts.budget, baseUrl: opts.baseUrl };
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    // Non-enumerable so the tokens are excluded from every serialization path
    // (JSON.stringify, util.inspect, structured loggers) while staying readable
    // as this.aiToken / this.apiKey.
    Object.defineProperty(this, "aiToken", { value: opts.aiToken, enumerable: false });
    Object.defineProperty(this, "apiKey", { value: opts.apiKey, enumerable: false });
  }

  static fromEnv(env: Record<string, unknown>): GuardianClient {
    const raw = env.GUARDIAN;
    let cfg: GuardianConfig | undefined;
    try {
      cfg = (typeof raw === "string" ? JSON.parse(raw) : raw) as GuardianConfig | undefined;
    } catch {
      throw new Error("GuardianClient.fromEnv: env.GUARDIAN is not valid JSON");
    }
    if (!cfg || !cfg.project) throw new Error("GuardianClient.fromEnv: env.GUARDIAN.project missing");
    return new GuardianClient({
      ...cfg,
      aiToken: env.GUARDIAN_AI_TOKEN as string | undefined,
      apiKey: env.GUARDIAN_API_KEY as string | undefined,
    });
  }

  private importanceFor(over?: Importance): Importance {
    return over ?? (PRIORITY_TO_IMPORTANCE[this.cfg.priority ?? "normal"] ?? "low");
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

  // The non-enumerable token properties already keep secrets out of
  // JSON.stringify; toJSON additionally drops the fetch impl for a tidy dump.
  toJSON(): unknown {
    return { cfg: this.cfg, baseUrl: this.baseUrl };
  }
}
