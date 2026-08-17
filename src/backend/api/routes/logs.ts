/**
 * @fileoverview Log ingestion surface. `POST /api/logs/ingest` accepts a batch
 * of log entries and enqueues them to the `LOG_QUEUE` producer — it does NOT
 * write D1 on the request path (the queue consumer batch-inserts into LOGS_DB).
 *
 * Auth mirrors the AI Router `/run` ingress: a bearer token equal to the
 * `CLOUDFLARE_AI_GATEWAY_TOKEN` Secret Store binding — NOT guardianAuth. This
 * router is mounted top-level at `/api/logs` (outside the guardianAuth-gated
 * `/api/guardian` prefix) so automated callers can post without a session.
 *
 * @see {@link file://src/backend/guardian/log-sink.ts} for the consumer sink.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { getSecretStoreBinding } from "@/backend/utils/secrets";
import type { LogMessage } from "@/backend/guardian/log-sink";

export const logsRouter = new OpenAPIHono<{ Bindings: Env }>();

/** Cloudflare Queues caps a single sendBatch at 100 messages. */
const QUEUE_BATCH_MAX = 100;

const ingestBody = z.object({
  source: z.string().min(1),
  entries: z
    .array(
      z.object({
        ts: z.number().optional(),
        level: z.string().optional(),
        message: z.string().min(1),
        fields: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

// Ingress bearer check — mirrors ai-router /run, NOT guardianAuth.
logsRouter.use("/ingest", async (c, next) => {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const expected = await getSecretStoreBinding(c.env, "CLOUDFLARE_AI_GATEWAY_TOKEN");
  if (!token || !expected || token !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

logsRouter.openapi(
  createRoute({
    method: "post",
    path: "/ingest",
    operationId: "logsIngest",
    summary: "Enqueue a batch of log entries for async insert into the logs DB",
    request: { body: { content: { "application/json": { schema: ingestBody } } } },
    responses: {
      200: {
        description: "Accepted for ingestion",
        content: { "application/json": { schema: z.object({ accepted: z.number() }) } },
      },
      401: {
        description: "Bad ingress token",
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
      },
    },
  }),
  async (c) => {
    const { source, entries } = c.req.valid("json");
    const now = Date.now();
    const messages: LogMessage[] = entries.map((e) => ({
      source,
      ts: e.ts ?? now,
      level: e.level ?? null,
      message: e.message,
      fields: e.fields,
    }));

    // Enqueue in ≤100-message sendBatch calls (Queues' per-call cap).
    for (let i = 0; i < messages.length; i += QUEUE_BATCH_MAX) {
      const chunk = messages.slice(i, i + QUEUE_BATCH_MAX);
      await c.env.LOG_QUEUE.sendBatch(chunk.map((body) => ({ body })));
    }

    return c.json({ accepted: messages.length }, 200);
  },
);
