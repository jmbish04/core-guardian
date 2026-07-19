/**
 * @fileoverview Core Guardian MCP server — stateless Streamable HTTP transport.
 *
 * Exposes Guardian's whole capability surface to MCP clients (Claude, Cursor,
 * MCP Inspector) at `POST /mcp`, implementing `initialize`, `tools/list`, and
 * `tools/call` over JSON-RPC 2.0. Stateless: every request is self-contained,
 * so no session store and no Durable Object are required.
 *
 * The tool registry below wraps the *same* modules the REST routes use, so an
 * agent and the dashboard cannot drift apart. Destructive tools carry the same
 * server-side confirmation checks as their REST equivalents — an MCP client is
 * not a trusted caller just because it speaks MCP.
 *
 * Authentication reuses {@link guardianAuth}: a bearer `WORKER_API_KEY` or a
 * signed session cookie.
 *
 * @example
 * ```jsonc
 * // claude_desktop_config.json / .mcp.json
 * {
 *   "mcpServers": {
 *     "core-guardian": {
 *       "url": "https://core-guardian.hacolby.workers.dev/mcp",
 *       "headers": { "Authorization": "Bearer <WORKER_API_KEY>" }
 *     }
 *   }
 * }
 * ```
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";

import { guardianAuth } from "@/backend/api/routes/guardian";
import { getDb } from "@/backend/db";
import { alertRules, billingEvents, cronRuns, usageSnapshots } from "@/backend/db/schema";
import {
  getCreditBalance,
  getInvoiceHistory,
  getInvoicePreview,
  getSpendingLimit,
  getUsageHistory,
  listGateways,
} from "@/backend/guardian/ai-gateway";
import { collectUsage } from "@/backend/guardian/collect";
import {
  cfApi,
  listD1Databases,
  listKVNamespaces,
  listPipelines,
  listR2Buckets,
  listR2Objects,
} from "@/backend/guardian/resources";
import { seedDefaultRules } from "@/backend/guardian/rules";

export const mcpRouter = new OpenAPIHono<{ Bindings: Env }>();
mcpRouter.use("*", guardianAuth);

const PROTOCOL_VERSION = "2025-06-18";

/** One MCP tool: JSON Schema for the client, Zod + handler for execution. */
type McpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True for tools that change infrastructure or billing state. */
  destructive?: boolean;
  handler: (env: Env, args: any) => Promise<unknown>;
};

/** Shorthand for a JSON Schema object with the given properties. */
const schema = (
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });

/** Appends an audit row for any state change an agent makes. */
async function audit(env: Env, service: string, actionTaken: string): Promise<void> {
  await getDb(env)
    .insert(billingEvents)
    .values({
      id: crypto.randomUUID(),
      service,
      actionTaken: `[via MCP] ${actionTaken}`,
      timestamp: Date.now(),
    });
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const TOOLS: McpTool[] = [
  // --- Telemetry ----------------------------------------------------------
  {
    name: "guardian_usage",
    title: "Read binding usage",
    description:
      "Current usage for every Cloudflare binding type (D1, R2, Durable Objects, Vectorize, Workers AI, AI Gateway, KV, Workers, Browser Rendering, Workflows, Queues, Containers) over a trailing window, with each value compared to its alert threshold.",
    inputSchema: schema({ hours: num("Trailing window in hours (1-744). Default 24.") }),
    handler: async (env, args) => ({ readings: await collectUsage(env, args?.hours ?? 24) }),
  },
  {
    name: "guardian_usage_history",
    title: "Read stored usage snapshots",
    description:
      "Hourly usage snapshots recorded by the Guardian cron, for trend analysis over time. Optionally filtered to one service.",
    inputSchema: schema({
      service: str("Probe id to filter by (e.g. d1, r2-storage, ai-gateway)."),
      limit: num("Maximum rows. Default 200."),
    }),
    handler: async (env, args) => {
      const db = getDb(env);
      const rows = args?.service
        ? await db
            .select()
            .from(usageSnapshots)
            .where(eq(usageSnapshots.service, args.service))
            .orderBy(desc(usageSnapshots.timestamp))
            .limit(args?.limit ?? 200)
        : await db
            .select()
            .from(usageSnapshots)
            .orderBy(desc(usageSnapshots.timestamp))
            .limit(args?.limit ?? 200);
      return { snapshots: rows };
    },
  },
  {
    name: "guardian_cron_status",
    title: "Check the evaluation heartbeat",
    description:
      "Recent hourly cron runs and whether the trigger is stale. Use this to confirm Guardian's numbers are fresh before acting on them.",
    inputSchema: schema({ limit: num("Maximum runs. Default 24.") }),
    handler: async (env, args) => {
      const runs = await getDb(env)
        .select()
        .from(cronRuns)
        .orderBy(desc(cronRuns.ranAt))
        .limit(args?.limit ?? 24);
      return {
        runs,
        stale: runs.length === 0 || Date.now() - runs[0].ranAt > 2 * 3_600_000,
      };
    },
  },
  {
    name: "guardian_events",
    title: "Read the governance audit trail",
    description:
      "Every mitigation executed and every surge detected, newest first, from the billing_events table.",
    inputSchema: schema({ limit: num("Maximum rows. Default 50.") }),
    handler: async (env, args) => ({
      events: await getDb(env)
        .select()
        .from(billingEvents)
        .orderBy(desc(billingEvents.timestamp))
        .limit(args?.limit ?? 50),
    }),
  },

  // --- Storage inventory ---------------------------------------------------
  {
    name: "storage_list_r2",
    title: "List R2 buckets",
    description:
      "Every R2 bucket with exact size in bytes, object count, region, and the Workers bound to it. Sorted largest first.",
    inputSchema: schema(),
    handler: async (env) => ({ buckets: await listR2Buckets(env) }),
  },
  {
    name: "storage_list_r2_objects",
    title: "List objects in an R2 bucket",
    description: "One cursor-paginated page of objects in a bucket, with sizes and modified dates.",
    inputSchema: schema(
      {
        bucket: str("Bucket name."),
        cursor: str("Opaque cursor from a previous page."),
        perPage: num("Page size (1-1000). Default 100."),
      },
      ["bucket"],
    ),
    handler: async (env, args) =>
      await listR2Objects(env, args.bucket, args?.cursor, args?.perPage ?? 100),
  },
  {
    name: "storage_list_d1",
    title: "List D1 databases",
    description:
      "Every D1 database with file size, table count, and the Workers bound to it. Sorted largest first.",
    inputSchema: schema(),
    handler: async (env) => ({ databases: await listD1Databases(env) }),
  },
  {
    name: "storage_list_kv",
    title: "List KV namespaces",
    description:
      "Every KV namespace and the Workers bound to it. Cloudflare exposes no stored-size API for KV, so size is always null.",
    inputSchema: schema(),
    handler: async (env) => ({ namespaces: await listKVNamespaces(env) }),
  },
  {
    name: "storage_list_pipelines",
    title: "List pipelines",
    description: "Every configured pipeline with its status and SQL.",
    inputSchema: schema(),
    handler: async (env) => ({ pipelines: await listPipelines(env) }),
  },

  // --- AI Gateway billing --------------------------------------------------
  {
    name: "ai_gateway_billing",
    title: "Read AI Gateway billing",
    description:
      "Credit balance, payment method, auto top-up configuration, the enforced spending limit, and the draft invoice with per-model line items. This is the only Cloudflare surface reporting real dollars.",
    inputSchema: schema(),
    handler: async (env) => {
      const [balance, spendingLimit, invoicePreview] = await Promise.all([
        getCreditBalance(env),
        getSpendingLimit(env),
        getInvoicePreview(env),
      ]);
      return { balance, spendingLimit, invoicePreview };
    },
  },
  {
    name: "ai_gateway_usage_history",
    title: "Read AI Gateway metered usage",
    description: "Metered AI Gateway usage bucketed by day or hour over a trailing window.",
    inputSchema: schema({
      window: { type: "string", enum: ["day", "hour"], description: "Bucket size. Default day." },
      days: num("Trailing window in days (1-90). Default 30."),
    }),
    handler: async (env, args) => {
      const end = Date.now();
      const start = end - (args?.days ?? 30) * 86_400_000;
      return { history: await getUsageHistory(env, args?.window ?? "day", start, end) };
    },
  },
  {
    name: "ai_gateway_invoices",
    title: "Read AI Gateway invoices",
    description: "Invoice history with amounts, status, and PDF links.",
    inputSchema: schema({
      type: {
        type: "string",
        enum: ["auto", "manual", "all"],
        description: "Invoice type filter.",
      },
    }),
    handler: async (env, args) => ({ invoices: await getInvoiceHistory(env, args?.type) }),
  },
  {
    name: "ai_gateway_list_gateways",
    title: "List AI Gateways",
    description:
      "Every AI Gateway with its rate limiting, cache TTL, log retention, and retry configuration.",
    inputSchema: schema(),
    handler: async (env) => ({ gateways: await listGateways(env) }),
  },

  // --- Alert rules ---------------------------------------------------------
  {
    name: "rules_list",
    title: "List alert rules",
    description:
      "Every alert rule with its threshold, severity, action, and whether it is armed to execute that action automatically.",
    inputSchema: schema(),
    handler: async (env) => ({
      rules: await getDb(env).select().from(alertRules).orderBy(desc(alertRules.createdAt)),
    }),
  },
  {
    name: "rules_seed",
    title: "Seed default alert rules",
    description:
      "Create starter alert rules from the probe registry's built-in thresholds. No-op when rules already exist. Seeded rules are notify-only and disarmed.",
    inputSchema: schema(),
    handler: async (env) => ({ created: await seedDefaultRules(env) }),
  },
  {
    name: "rules_upsert",
    title: "Create or update an alert rule",
    description:
      "Create a new alert rule, or update an existing one by id. Rules are always left disarmed by this tool — arming requires a human in the dashboard.",
    inputSchema: schema(
      {
        id: str("Rule id to update. Omit to create."),
        name: str("Rule name."),
        description: str("What the rule watches for."),
        service: str("Probe id to evaluate (e.g. d1, r2-storage, ai-gateway)."),
        comparator: { type: "string", enum: ["gt", "gte", "lt", "lte"] },
        threshold: num("Threshold in the probe's unit."),
        severity: { type: "string", enum: ["info", "moderate", "significant", "critical"] },
        action: {
          type: "string",
          enum: ["notify", "evict_r2", "drop_vectorize", "disable_topup"],
        },
        actionTarget: str("Bucket or index the action applies to."),
        enabled: bool("Whether the cron evaluates this rule."),
        cooldownMinutes: num("Minimum gap between firings. Default 60."),
      },
      ["name", "service"],
    ),
    handler: async (env, args) => {
      const db = getDb(env);
      const now = Date.now();
      if (args.id) {
        const [row] = await db
          .update(alertRules)
          // Any edit disarms — see routes/rules.ts for the rationale.
          .set({ ...args, id: undefined, armed: false, updatedAt: now })
          .where(eq(alertRules.id, args.id))
          .returning();
        if (!row) throw new Error(`Rule not found: ${args.id}`);
        await audit(env, "alert-rules", `Updated rule "${row.name}"`);
        return row;
      }
      const [row] = await db
        .insert(alertRules)
        .values({
          id: crypto.randomUUID(),
          name: args.name,
          description: args.description ?? "",
          service: args.service,
          comparator: args.comparator ?? "gt",
          threshold: args.threshold ?? null,
          windowHours: args.windowHours ?? 1,
          severity: args.severity ?? "moderate",
          action: args.action ?? "notify",
          actionTarget: args.actionTarget ?? null,
          armed: false,
          enabled: args.enabled ?? true,
          cooldownMinutes: args.cooldownMinutes ?? 60,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await audit(env, "alert-rules", `Created rule "${row.name}" on ${row.service}`);
      return row;
    },
  },

  // --- Destructive mitigations --------------------------------------------
  {
    name: "r2_evict_bucket",
    title: "Emergency-evict an R2 bucket",
    description:
      "Apply a 1-day Expire lifecycle rule so R2 drains the bucket asynchronously. Merges with existing lifecycle rules. IRREVERSIBLE: every object in the bucket expires within 24 hours. Requires confirm to equal the bucket name.",
    destructive: true,
    inputSchema: schema(
      { bucket: str("Bucket name."), confirm: str("Must exactly equal the bucket name.") },
      ["bucket", "confirm"],
    ),
    handler: async (env, args) => {
      if (args.confirm !== args.bucket) {
        throw new Error(`confirm must exactly equal the bucket name "${args.bucket}".`);
      }
      const path = `/r2/buckets/${encodeURIComponent(args.bucket)}/lifecycle`;
      let existing: unknown[] = [];
      try {
        const current = await cfApi<{ rules?: unknown[] }>(env, path);
        existing = (current.result?.rules ?? []).filter(
          (r) => (r as { id?: string }).id !== "core-guardian-emergency-expire",
        );
      } catch {
        // No lifecycle configuration yet.
      }
      await cfApi(env, path, {
        method: "PUT",
        body: JSON.stringify({
          rules: [
            ...existing,
            {
              id: "core-guardian-emergency-expire",
              enabled: true,
              conditions: { prefix: "" },
              action: { type: "Expire", parameters: { days: 1 } },
            },
          ],
        }),
      });
      const actionTaken = `Applied 1-day Expire lifecycle rule to R2 bucket "${args.bucket}"`;
      await audit(env, "r2", actionTaken);
      return { ok: true, actionTaken };
    },
  },
  {
    name: "vectorize_drop_index",
    title: "Drop a Vectorize index",
    description:
      "Delete a Vectorize index to halt runaway read/write metering. IRREVERSIBLE: the vectors are not recoverable. Requires confirm to equal the index name.",
    destructive: true,
    inputSchema: schema(
      { index: str("Index name."), confirm: str("Must exactly equal the index name.") },
      ["index", "confirm"],
    ),
    handler: async (env, args) => {
      if (args.confirm !== args.index) {
        throw new Error(`confirm must exactly equal the index name "${args.index}".`);
      }
      await cfApi(env, `/vectorize/v2/indexes/${encodeURIComponent(args.index)}`, {
        method: "DELETE",
      });
      const actionTaken = `Deleted Vectorize index "${args.index}"`;
      await audit(env, "vectorize", actionTaken);
      return { ok: true, actionTaken };
    },
  },
  {
    name: "ai_gateway_disable_topup",
    title: "Disable AI Gateway auto top-up",
    description:
      "Remove the auto top-up configuration so the account stops automatically charging the card on file. Tightens spend; safe to call.",
    destructive: true,
    inputSchema: schema(),
    handler: async (env) => {
      await cfApi(env, "/ai-gateway/billing/topup/config", { method: "DELETE" });
      await audit(env, "ai-gateway", "Disabled auto top-up");
      return { ok: true };
    },
  },
];

const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/**
 * Handles one JSON-RPC message.
 *
 * @param env - Worker env
 * @param message - Parsed JSON-RPC request
 * @returns The response object, or `null` for notifications (no `id`)
 */
async function handleRpc(env: Env, message: JsonRpcRequest): Promise<unknown | null> {
  const { id, method, params } = message;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "core-guardian", version: "1.0.0" },
        instructions:
          "Cloudflare spend governance. Read telemetry with guardian_usage before acting; " +
          "confirm freshness with guardian_cron_status. Destructive tools require an exact " +
          "confirm value and are recorded in the audit trail.",
      });

    // Notifications carry no id and expect no response.
    case "notifications/initialized":
      return null;

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: {
            readOnlyHint: !t.destructive,
            destructiveHint: Boolean(t.destructive),
          },
        })),
      });

    case "tools/call": {
      const tool = TOOL_INDEX.get(params?.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const output = await tool.handler(env, params?.arguments ?? {});
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        });
      } catch (err) {
        // Tool errors are reported in-band so the model can react and retry,
        // per the MCP spec — they are not protocol-level errors.
        return rpcResult(id, {
          content: [
            { type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * MCP Streamable HTTP endpoint.
 *
 * Accepts a single JSON-RPC message or a batch. Responds with JSON (not SSE) —
 * valid under the Streamable HTTP transport for a stateless server that never
 * initiates server-to-client messages.
 */
mcpRouter.post("/", async (c) => {
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((m) => handleRpc(c.env, m)))).filter(
      (r) => r !== null,
    );
    return responses.length > 0 ? c.json(responses) : c.body(null, 202);
  }

  const response = await handleRpc(c.env, body);
  return response === null ? c.body(null, 202) : c.json(response);
});

/** Tool catalog as plain JSON — handy for humans and for smoke tests. */
mcpRouter.get("/tools", (c) =>
  c.json({
    server: "core-guardian",
    protocolVersion: PROTOCOL_VERSION,
    count: TOOLS.length,
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      destructive: Boolean(t.destructive),
    })),
  }),
);
