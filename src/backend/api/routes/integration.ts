/**
 * @fileoverview Public integration-instructions surface — `/api/integration`.
 * Tells any project how to vendor the guardian client and wire its config.
 * PUBLIC by design (integration docs are not secret): NO guardianAuth. The
 * `baseUrl` in the output is derived from the incoming request URL so the
 * instructions always point back at whatever origin served them.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { buildInstructions } from "@/backend/guardian/integration";

export const integrationRouter = new OpenAPIHono<{ Bindings: Env }>();

const querySchema = z.object({
  lang: z.enum(["ts", "python", "gas"]).default("ts"),
  mode: z.enum(["curl", "submodule", "degit"]).default("curl"),
});

const responseSchema = z.object({
  version: z.string(),
  lang: z.enum(["ts", "python", "gas"]),
  mode: z.enum(["curl", "submodule", "degit"]),
  ref: z.string(),
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
    const baseUrl = c.env.WORKER_BASE_URL || new URL(c.req.url).origin;
    return c.json(buildInstructions({ baseUrl, lang, mode }), 200);
  },
);
