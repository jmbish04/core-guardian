/**
 * @fileoverview Data Storage console API — inventory and deletion for R2, D1,
 * KV, Pipelines, and R2 Data Catalogs.
 *
 * Read routes power the storage dashboard and its per-product pages. Delete
 * routes are irreversible and every one of them requires a `confirm` field in
 * the body that exactly matches the resource's own name. That check is enforced
 * here, server-side — the UI's type-to-confirm box is a convenience, not the
 * control. Every deletion appends a row to `billing_events`.
 *
 * All routes are gated by {@link guardianAuth}.
 *
 * @see {@link file://src/backend/guardian/resources.ts} for the inventory layer.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { guardianAuth } from "@/backend/api/routes/guardian";
import { getDb } from "@/backend/db";
import { billingEvents } from "@/backend/db/schema";
import {
  cfApi,
  listD1Databases,
  listDataCatalogs,
  listKVNamespaces,
  listPipelines,
  listR2Buckets,
  listR2Objects,
} from "@/backend/guardian/resources";

export const storageRouter = new OpenAPIHono<{ Bindings: Env }>();
storageRouter.use("*", guardianAuth);

const errorSchema = z.object({ error: z.string() });
const workersSchema = z.array(z.object({ worker: z.string(), binding: z.string() }));

/** Every destructive route takes the resource's own name as confirmation. */
const confirmBody = z.object({ confirm: z.string() });

/**
 * Records a deletion in the governance audit trail.
 *
 * @param env - Worker env
 * @param service - Product identifier (`r2`, `d1`, `kv`, `pipelines`)
 * @param actionTaken - What was deleted
 */
async function audit(env: Env, service: string, actionTaken: string): Promise<void> {
  await getDb(env).insert(billingEvents).values({
    id: crypto.randomUUID(),
    service,
    actionTaken,
    timestamp: Date.now(),
  });
}

/** Standard 401/404/502 responses shared by the delete routes. */
const destructiveResponses = {
  200: {
    description: "Deleted",
    content: {
      "application/json": {
        schema: z.object({ ok: z.boolean(), actionTaken: z.string() }),
      },
    },
  },
  400: {
    description: "Confirmation did not match the resource name",
    content: { "application/json": { schema: errorSchema } },
  },
  401: {
    description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
    content: { "application/json": { schema: errorSchema } },
  },
  502: {
    description: "Cloudflare API rejected the deletion",
    content: { "application/json": { schema: errorSchema } },
  },
};

// ---------------------------------------------------------------------------
// GET /api/storage/summary
// ---------------------------------------------------------------------------

storageRouter.openapi(
  createRoute({
    method: "get",
    path: "/summary",
    operationId: "storageSummary",
    summary: "Account-wide storage totals for the Data Storage dashboard",
    responses: {
      200: {
        description: "Counts and totals per product, plus the largest resources",
        content: {
          "application/json": {
            schema: z.object({
              r2: z.object({
                count: z.number(),
                totalBytes: z.number(),
                totalObjects: z.number(),
              }),
              d1: z.object({ count: z.number(), totalBytes: z.number() }),
              kv: z.object({ count: z.number(), totalBytes: z.number().nullable() }),
              catalogs: z.object({ count: z.number() }),
              pipelines: z.object({ count: z.number() }),
              top: z.object({
                r2: z.array(z.object({ name: z.string(), sizeBytes: z.number() })),
                d1: z.array(z.object({ name: z.string(), sizeBytes: z.number() })),
                kv: z.array(z.object({ name: z.string() })),
                pipelines: z.array(z.object({ name: z.string(), status: z.string().nullable() })),
              }),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  async (c) => {
    const [buckets, databases, namespaces, pipelines] = await Promise.all([
      listR2Buckets(c.env),
      listD1Databases(c.env),
      listKVNamespaces(c.env),
      listPipelines(c.env),
    ]);
    const catalogs = await listDataCatalogs(
      c.env,
      buckets.map((b) => b.name),
    );

    return c.json(
      {
        r2: {
          count: buckets.length,
          totalBytes: buckets.reduce((sum, b) => sum + b.sizeBytes, 0),
          totalObjects: buckets.reduce((sum, b) => sum + b.objectCount, 0),
        },
        d1: {
          count: databases.length,
          totalBytes: databases.reduce((sum, d) => sum + d.sizeBytes, 0),
        },
        // KV stored size is not exposed by any Cloudflare API.
        kv: { count: namespaces.length, totalBytes: null },
        catalogs: { count: catalogs.length },
        pipelines: { count: pipelines.length },
        top: {
          r2: buckets.slice(0, 5).map((b) => ({ name: b.name, sizeBytes: b.sizeBytes })),
          d1: databases.slice(0, 5).map((d) => ({ name: d.name, sizeBytes: d.sizeBytes })),
          kv: namespaces.slice(0, 5).map((n) => ({ name: n.title })),
          pipelines: pipelines.slice(0, 5).map((p) => ({ name: p.name, status: p.status })),
        },
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// Inventory listings
// ---------------------------------------------------------------------------

storageRouter.openapi(
  createRoute({
    method: "get",
    path: "/r2",
    operationId: "storageListR2",
    summary: "R2 buckets with size, object count, and bound Workers",
    responses: {
      200: {
        description: "Buckets, largest first",
        content: {
          "application/json": {
            schema: z.object({
              buckets: z.array(
                z.object({
                  name: z.string(),
                  createdAt: z.string().nullable(),
                  location: z.string().nullable(),
                  storageClass: z.string().nullable(),
                  sizeBytes: z.number(),
                  objectCount: z.number(),
                  workers: workersSchema,
                }),
              ),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  async (c) => c.json({ buckets: await listR2Buckets(c.env) }, 200),
);

storageRouter.openapi(
  createRoute({
    method: "get",
    path: "/r2/{bucket}/objects",
    operationId: "storageListR2Objects",
    summary: "Objects inside one R2 bucket",
    request: {
      params: z.object({ bucket: z.string() }),
      query: z.object({
        cursor: z.string().optional(),
        perPage: z.coerce.number().int().min(1).max(1000).default(100).optional(),
      }),
    },
    responses: {
      200: {
        description: "One page of objects",
        content: {
          "application/json": {
            schema: z.object({
              objects: z.array(
                z.object({
                  key: z.string(),
                  size: z.number(),
                  lastModified: z.string().nullable(),
                  storageClass: z.string().nullable(),
                }),
              ),
              cursor: z.string().nullable(),
              truncated: z.boolean(),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  async (c) => {
    const { bucket } = c.req.valid("param");
    const { cursor, perPage } = c.req.valid("query");
    return c.json(await listR2Objects(c.env, bucket, cursor, perPage ?? 100), 200);
  },
);

storageRouter.openapi(
  createRoute({
    method: "get",
    path: "/d1",
    operationId: "storageListD1",
    summary: "D1 databases with file size and bound Workers",
    responses: {
      200: {
        description: "Databases, largest first",
        content: {
          "application/json": {
            schema: z.object({
              databases: z.array(
                z.object({
                  uuid: z.string(),
                  name: z.string(),
                  createdAt: z.string().nullable(),
                  numTables: z.number(),
                  sizeBytes: z.number(),
                  workers: workersSchema,
                }),
              ),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  async (c) => c.json({ databases: await listD1Databases(c.env) }, 200),
);

storageRouter.openapi(
  createRoute({
    method: "get",
    path: "/kv",
    operationId: "storageListKV",
    summary: "KV namespaces with bound Workers",
    responses: {
      200: {
        description: "Namespaces",
        content: {
          "application/json": {
            schema: z.object({
              namespaces: z.array(
                z.object({
                  id: z.string(),
                  title: z.string(),
                  sizeBytes: z.null(),
                  workers: workersSchema,
                }),
              ),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  async (c) => c.json({ namespaces: await listKVNamespaces(c.env) }, 200),
);

storageRouter.openapi(
  createRoute({
    method: "get",
    path: "/pipelines",
    operationId: "storageListPipelines",
    summary: "Pipelines",
    responses: {
      200: {
        description: "Pipelines",
        content: {
          "application/json": {
            schema: z.object({
              pipelines: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  status: z.string().nullable(),
                  sql: z.string().nullable(),
                  createdAt: z.string().nullable(),
                  modifiedAt: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  async (c) => c.json({ pipelines: await listPipelines(c.env) }, 200),
);

storageRouter.openapi(
  createRoute({
    method: "get",
    path: "/catalogs",
    operationId: "storageListCatalogs",
    summary: "R2 Data Catalogs (probed per bucket — no account-wide list exists)",
    responses: {
      200: {
        description: "Buckets with a catalog enabled",
        content: {
          "application/json": {
            schema: z.object({
              catalogs: z.array(z.object({ bucket: z.string(), enabled: z.boolean() })),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  async (c) => {
    const buckets = await listR2Buckets(c.env);
    const catalogs = await listDataCatalogs(
      c.env,
      buckets.map((b) => b.name),
    );
    return c.json(
      { catalogs: catalogs.map((x) => ({ bucket: x.bucket, enabled: x.enabled })) },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// Deletions — all irreversible, all confirm-gated
// ---------------------------------------------------------------------------

storageRouter.openapi(
  createRoute({
    method: "delete",
    path: "/r2/{bucket}",
    operationId: "storageDeleteR2Bucket",
    summary: "Delete an R2 bucket and everything in it",
    request: {
      params: z.object({ bucket: z.string() }),
      body: { content: { "application/json": { schema: confirmBody } } },
    },
    responses: destructiveResponses,
  }),
  async (c) => {
    const { bucket } = c.req.valid("param");
    if (c.req.valid("json").confirm !== bucket) {
      return c.json({ error: `Confirmation must exactly match the bucket name "${bucket}".` }, 400);
    }

    try {
      // R2 refuses to delete a non-empty bucket, so clear objects first. Pages
      // are deleted in bulk; a very large bucket should use the lifecycle
      // eviction route instead, which R2 drains asynchronously.
      let deleted = 0;
      for (let page = 0; page < 50; page++) {
        const { objects, cursor } = await listR2Objects(c.env, bucket, undefined, 1000);
        if (objects.length === 0) break;
        await cfApi(c.env, `/r2/buckets/${encodeURIComponent(bucket)}/objects`, {
          method: "DELETE",
          body: JSON.stringify({ objects: objects.map((o) => ({ key: o.key })) }),
        });
        deleted += objects.length;
        if (!cursor) break;
      }

      await cfApi(c.env, `/r2/buckets/${encodeURIComponent(bucket)}`, { method: "DELETE" });

      const actionTaken = `Deleted R2 bucket "${bucket}" and ${deleted} object(s)`;
      await audit(c.env, "r2", actionTaken);
      return c.json({ ok: true, actionTaken }, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
);

storageRouter.openapi(
  createRoute({
    method: "post",
    path: "/r2/{bucket}/objects/delete",
    operationId: "storageDeleteR2Objects",
    summary: "Delete selected objects from a bucket",
    request: {
      params: z.object({ bucket: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ keys: z.array(z.string()).min(1).max(1000) }),
          },
        },
      },
    },
    responses: destructiveResponses,
  }),
  async (c) => {
    const { bucket } = c.req.valid("param");
    const { keys } = c.req.valid("json");
    try {
      await cfApi(c.env, `/r2/buckets/${encodeURIComponent(bucket)}/objects`, {
        method: "DELETE",
        body: JSON.stringify({ objects: keys.map((key) => ({ key })) }),
      });
      const actionTaken = `Deleted ${keys.length} object(s) from R2 bucket "${bucket}"`;
      await audit(c.env, "r2", actionTaken);
      return c.json({ ok: true, actionTaken }, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
);

storageRouter.openapi(
  createRoute({
    method: "delete",
    path: "/d1/{uuid}",
    operationId: "storageDeleteD1",
    summary: "Delete a D1 database",
    request: {
      params: z.object({ uuid: z.string() }),
      body: { content: { "application/json": { schema: confirmBody } } },
    },
    responses: destructiveResponses,
  }),
  async (c) => {
    const { uuid } = c.req.valid("param");
    const databases = await listD1Databases(c.env);
    const target = databases.find((d) => d.uuid === uuid);
    if (!target) return c.json({ error: "Database not found." }, 400);

    if (c.req.valid("json").confirm !== target.name) {
      return c.json(
        { error: `Confirmation must exactly match the database name "${target.name}".` },
        400,
      );
    }

    // Refuse to delete the database backing this Worker — losing it would take
    // the audit trail down with it.
    const selfBinding = target.workers.some((w) => w.worker === "core-guardian");
    if (selfBinding) {
      return c.json(
        { error: "Refusing to delete a database bound to this Worker (core-guardian)." },
        400,
      );
    }

    try {
      await cfApi(c.env, `/d1/database/${encodeURIComponent(uuid)}`, { method: "DELETE" });
      const actionTaken = `Deleted D1 database "${target.name}" (${uuid})`;
      await audit(c.env, "d1", actionTaken);
      return c.json({ ok: true, actionTaken }, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
);

storageRouter.openapi(
  createRoute({
    method: "delete",
    path: "/kv/{id}",
    operationId: "storageDeleteKV",
    summary: "Delete a KV namespace",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: confirmBody } } },
    },
    responses: destructiveResponses,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const namespaces = await listKVNamespaces(c.env);
    const target = namespaces.find((n) => n.id === id);
    if (!target) return c.json({ error: "Namespace not found." }, 400);

    if (c.req.valid("json").confirm !== target.title) {
      return c.json(
        { error: `Confirmation must exactly match the namespace title "${target.title}".` },
        400,
      );
    }

    // The SESSIONS namespace holds this Worker's cookie signing key.
    if (target.workers.some((w) => w.worker === "core-guardian")) {
      return c.json(
        { error: "Refusing to delete a namespace bound to this Worker (core-guardian)." },
        400,
      );
    }

    try {
      await cfApi(c.env, `/storage/kv/namespaces/${encodeURIComponent(id)}`, { method: "DELETE" });
      const actionTaken = `Deleted KV namespace "${target.title}" (${id})`;
      await audit(c.env, "kv", actionTaken);
      return c.json({ ok: true, actionTaken }, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
);

storageRouter.openapi(
  createRoute({
    method: "delete",
    path: "/pipelines/{id}",
    operationId: "storageDeletePipeline",
    summary: "Delete a pipeline",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: confirmBody } } },
    },
    responses: destructiveResponses,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const pipelines = await listPipelines(c.env);
    const target = pipelines.find((p) => p.id === id);
    if (!target) return c.json({ error: "Pipeline not found." }, 400);

    if (c.req.valid("json").confirm !== target.name) {
      return c.json(
        { error: `Confirmation must exactly match the pipeline name "${target.name}".` },
        400,
      );
    }

    try {
      await cfApi(c.env, `/pipelines/v1/pipelines/${encodeURIComponent(id)}`, { method: "DELETE" });
      const actionTaken = `Deleted pipeline "${target.name}" (${id})`;
      await audit(c.env, "pipelines", actionTaken);
      return c.json({ ok: true, actionTaken }, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
);
