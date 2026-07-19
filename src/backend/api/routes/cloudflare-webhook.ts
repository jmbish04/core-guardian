/**
 * @fileoverview Inbound Cloudflare notification receiver + alerting management.
 *
 * `POST /api/webhooks/cloudflare` is the one Guardian route that is **not**
 * behind {@link guardianAuth} — Cloudflare's notification service calls it with
 * no session and no bearer token. It is instead authenticated by the
 * `cf-webhook-auth` header, which carries the shared secret Cloudflare was
 * given when the webhook destination was created.
 *
 * Security posture for a public endpoint:
 *  - **Fails closed.** No secret provisioned → 503, never "accept anything".
 *  - **Constant-time comparison** via the existing `safeEqual`.
 *  - **Body size cap** before parsing, so a large POST cannot be used to burn
 *    CPU or fill D1.
 *  - **Unverified payloads are rejected**, not stored — an unauthenticated
 *    writer must not be able to append to the governance record.
 *  - The secret is never echoed in a response or a log line.
 *
 * The management routes below (destinations, policies) *are* auth-gated and let
 * the panel provision the destination and the billing notification policies
 * without leaving the app.
 *
 * @see {@link file://src/backend/db/schemas/governance/webhook-events.ts}
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { desc } from "drizzle-orm";

import { safeEqual } from "@/backend/api/lib/auth";
import { guardianAuth } from "@/backend/api/routes/guardian";
import { getDb } from "@/backend/db";
import { billingEvents, webhookEvents } from "@/backend/db/schema";
import { cfApi } from "@/backend/guardian/resources";

/** KV key holding the shared secret Cloudflare sends back in `cf-webhook-auth`. */
const WEBHOOK_SECRET_KEY = "GUARDIAN_WEBHOOK_SECRET";

/** Reject bodies larger than this before parsing. Cloudflare payloads are ~1KB. */
const MAX_BODY_BYTES = 64 * 1024;

const errorSchema = z.object({ error: z.string() });

// ---------------------------------------------------------------------------
// Public receiver — no guardianAuth
// ---------------------------------------------------------------------------

export const cloudflareWebhookRouter = new OpenAPIHono<{ Bindings: Env }>();

/**
 * Reads the webhook shared secret.
 *
 * Stored in the `SESSIONS` KV namespace rather than the Secrets Store so it can
 * be rotated at runtime without a redeploy — the same pattern the cookie
 * signing key uses.
 *
 * @param env - Worker env
 * @returns The secret, or `undefined` when none has been provisioned
 */
async function readWebhookSecret(env: Env): Promise<string | undefined> {
  return (await env.SESSIONS.get(WEBHOOK_SECRET_KEY)) ?? undefined;
}

/** Pulls the fields we understand out of a Cloudflare notification payload. */
function parsePayload(payload: Record<string, any>): {
  alertType: string;
  alertName: string | null;
  text: string | null;
  severity: string | null;
  accountId: string | null;
} {
  // Cloudflare wraps the real notification in `data` for some alert types and
  // sends it flat for others; check both rather than assuming one shape.
  const data = (payload.data ?? payload) as Record<string, any>;
  return {
    alertType: String(payload.alert_type ?? data.alert_type ?? "unknown"),
    alertName: (payload.name ?? payload.alert_name ?? data.alert_name ?? null) as string | null,
    text: (payload.text ?? payload.description ?? data.text ?? null) as string | null,
    severity: (payload.severity ?? data.severity ?? null) as string | null,
    accountId: (payload.account_id ?? data.account_id ?? null) as string | null,
  };
}

cloudflareWebhookRouter.post("/cloudflare", async (c) => {
  const secret = await readWebhookSecret(c.env);
  // Fail closed: an unconfigured receiver accepts nothing.
  if (!secret) {
    return c.json(
      { error: "Webhook receiver is not provisioned. Create the destination first." },
      503,
    );
  }

  const presented = c.req.header("cf-webhook-auth");
  if (!presented || !(await safeEqual(presented, secret))) {
    // Deliberately vague — do not reveal whether the header was absent or wrong.
    return c.json({ error: "Unauthorized" }, 401);
  }

  const declaredLength = Number(c.req.header("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return c.json({ error: "Payload too large" }, 413);
  }

  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return c.json({ error: "Payload too large" }, 413);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Cloudflare sends a test payload when you click "Save and Test"; store it
  // like any other so the operator can confirm delivery end to end.
  const parsed = parsePayload(payload);
  const db = getDb(c.env);
  const now = Date.now();

  await db.insert(webhookEvents).values({
    id: crypto.randomUUID(),
    ...parsed,
    payload,
    verified: true,
    receivedAt: now,
  });

  // Billing alerts are governance events, so they also land in the audit trail
  // beside the mitigations — one timeline, not two.
  if (parsed.alertType.startsWith("billing_")) {
    await db.insert(billingEvents).values({
      id: crypto.randomUUID(),
      service: "cloudflare-notification",
      actionTaken: `Cloudflare ${parsed.alertType}: ${parsed.text ?? parsed.alertName ?? "(no text)"}`,
      timestamp: now,
    });
  }

  return c.json({ ok: true }, 200);
});

// ---------------------------------------------------------------------------
// Management surface — auth-gated
// ---------------------------------------------------------------------------

export const alertingRouter = new OpenAPIHono<{ Bindings: Env }>();
alertingRouter.use("*", guardianAuth);

const unauthorized = {
  description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
  content: { "application/json": { schema: errorSchema } },
};

alertingRouter.openapi(
  createRoute({
    method: "get",
    path: "/events",
    operationId: "alertingWebhookEvents",
    summary: "Inbound Cloudflare notifications received by this Worker",
    request: {
      query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50).optional() }),
    },
    responses: {
      200: {
        description: "Events, newest first",
        content: {
          "application/json": {
            schema: z.object({
              events: z.array(
                z.object({
                  id: z.string(),
                  alertType: z.string(),
                  alertName: z.string().nullable(),
                  text: z.string().nullable(),
                  severity: z.string().nullable(),
                  accountId: z.string().nullable(),
                  payload: z.unknown(),
                  verified: z.boolean(),
                  receivedAt: z.number(),
                }),
              ),
            }),
          },
        },
      },
      401: unauthorized,
    },
  }),
  async (c) => {
    const limit = c.req.valid("query").limit ?? 50;
    const events = await getDb(c.env)
      .select()
      .from(webhookEvents)
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(limit);
    return c.json({ events }, 200);
  },
);

alertingRouter.openapi(
  createRoute({
    method: "get",
    path: "/status",
    operationId: "alertingStatus",
    summary: "Whether the webhook receiver is provisioned, and current policies",
    responses: {
      200: {
        description: "Receiver + destination + policy state",
        content: {
          "application/json": {
            schema: z.object({
              provisioned: z.boolean(),
              receiverUrl: z.string(),
              destinations: z.array(
                z.object({ id: z.string(), name: z.string(), url: z.string().nullable() }),
              ),
              policies: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  alertType: z.string(),
                  enabled: z.boolean(),
                }),
              ),
            }),
          },
        },
      },
      401: unauthorized,
    },
  }),
  async (c) => {
    const secret = await readWebhookSecret(c.env);
    const [destinations, policies] = await Promise.all([
      cfApi<{ id: string; name: string; url?: string }[]>(
        c.env,
        "/alerting/v3/destinations/webhooks",
      ).then((r) => r.result ?? []),
      cfApi<{ id: string; name: string; alert_type: string; enabled: boolean }[]>(
        c.env,
        "/alerting/v3/policies",
      ).then((r) => r.result ?? []),
    ]);

    return c.json(
      {
        provisioned: Boolean(secret),
        receiverUrl: `${c.env.WORKER_BASE_URL}/api/webhooks/cloudflare`,
        destinations: destinations.map((d) => ({
          id: d.id,
          name: d.name,
          url: d.url ?? null,
        })),
        policies: policies.map((p) => ({
          id: p.id,
          name: p.name,
          alertType: p.alert_type,
          enabled: p.enabled,
        })),
      },
      200,
    );
  },
);

alertingRouter.openapi(
  createRoute({
    method: "post",
    path: "/provision",
    operationId: "alertingProvision",
    summary: "Create the Cloudflare webhook destination pointing at this Worker",
    responses: {
      200: {
        description: "Destination created and the shared secret stored",
        content: {
          "application/json": {
            schema: z.object({ destinationId: z.string(), receiverUrl: z.string() }),
          },
        },
      },
      401: unauthorized,
      502: {
        description: "Cloudflare API rejected the destination",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  async (c) => {
    // Generate the shared secret here and hand the same value to Cloudflare, so
    // the receiver can verify callbacks without a manual copy-paste step.
    const secret = crypto.randomUUID().replaceAll("-", "");
    const receiverUrl = `${c.env.WORKER_BASE_URL}/api/webhooks/cloudflare`;

    try {
      const { result } = await cfApi<{ id: string }>(c.env, "/alerting/v3/destinations/webhooks", {
        method: "POST",
        body: JSON.stringify({
          name: "Core Guardian",
          url: receiverUrl,
          secret,
        }),
      });

      // Store only after Cloudflare accepted it — otherwise the receiver would
      // start trusting a secret nothing will ever send.
      await c.env.SESSIONS.put(WEBHOOK_SECRET_KEY, secret);

      await getDb(c.env)
        .insert(billingEvents)
        .values({
          id: crypto.randomUUID(),
          service: "cloudflare-notification",
          actionTaken: `Provisioned Cloudflare webhook destination "${result.id}" → ${receiverUrl}`,
          timestamp: Date.now(),
        });

      return c.json({ destinationId: result.id, receiverUrl }, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
);

alertingRouter.openapi(
  createRoute({
    method: "post",
    path: "/policies",
    operationId: "alertingCreatePolicy",
    summary: "Create a billing notification policy delivering to the Guardian webhook",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              destinationId: z.string(),
              alertType: z
                .enum(["billing_usage_alert", "billing_budget_alert"])
                .default("billing_budget_alert"),
              name: z.string().min(1),
              /** billing_budget_alert filter: dollar threshold for the period. */
              totalSpendDollars: z.number().positive().optional(),
              /** billing_usage_alert filters: product + usage limit. */
              product: z.string().optional(),
              limit: z.number().positive().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Policy created",
        content: { "application/json": { schema: z.object({ policyId: z.string() }) } },
      },
      400: {
        description: "Required filter for the chosen alert type is missing",
        content: { "application/json": { schema: errorSchema } },
      },
      401: unauthorized,
      502: {
        description: "Cloudflare API rejected the policy",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");

    // Filter shapes verified against /alerting/v3/available_alerts on this
    // account: budget alerts take total_spend_dollars; usage alerts take
    // product + limit.
    let filters: Record<string, string[]>;
    if (body.alertType === "billing_budget_alert") {
      if (body.totalSpendDollars === undefined) {
        return c.json({ error: "billing_budget_alert requires totalSpendDollars." }, 400);
      }
      filters = { total_spend_dollars: [String(body.totalSpendDollars)] };
    } else {
      if (!body.product || body.limit === undefined) {
        return c.json({ error: "billing_usage_alert requires product and limit." }, 400);
      }
      filters = { product: [body.product], limit: [String(body.limit)] };
    }

    try {
      const { result } = await cfApi<{ id: string }>(c.env, "/alerting/v3/policies", {
        method: "POST",
        body: JSON.stringify({
          name: body.name,
          alert_type: body.alertType,
          enabled: true,
          mechanisms: { webhooks: [{ id: body.destinationId }] },
          filters,
        }),
      });

      await getDb(c.env)
        .insert(billingEvents)
        .values({
          id: crypto.randomUUID(),
          service: "cloudflare-notification",
          actionTaken: `Created notification policy "${body.name}" (${body.alertType})`,
          timestamp: Date.now(),
        });

      return c.json({ policyId: result.id }, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
);
