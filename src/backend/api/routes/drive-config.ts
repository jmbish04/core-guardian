/**
 * @fileoverview Drive folder self-service config — `/api/drive/*`.
 *
 * The operator pastes a Google Drive folder URL or id per archive purpose; we
 * extract the id, validate the service account can actually read it, and persist
 * the result to `drive_folders`. No hardcoded ids in code, no always-on Durable
 * Object holding config (DOs get expensive) — just a D1 row per purpose.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { guardianAuth } from "@/backend/api/routes/guardian";
import { getDb } from "@/backend/db";
import { driveFolders } from "@/backend/db/schema";
import {
  createDriveFolder,
  extractDriveId,
  getDriveFolder,
  listDriveChildren,
  listSharedDrives,
} from "@/backend/lib/google-drive";
import { getSecret, getSecretStoreBinding } from "@/backend/utils/secrets";

/** Purposes the archive flows target, with seed ids the operator provided. */
const PURPOSES = ["root", "r2", "d1", "cf-image"] as const;
type Purpose = (typeof PURPOSES)[number];

const SEED: Record<Purpose, string> = {
  root: "1SpySGpZIm-LJ-5uUeA2dUEKMvYqrVrF8",
  r2: "1KGXg4NVBir5nLIYbNhJg7p9CLLt21Zne",
  d1: "1obQXC7aeHRhzvPayQoZSTvzMgfZ_Hea-",
  "cf-image": "12Wf_kPMvTcKhDaI7Texwkn07n3e6Qaf9",
};

const errorResponseSchema = z.object({ error: z.string() });

const folderSchema = z.object({
  purpose: z.string(),
  folderId: z.string(),
  url: z.string(),
  name: z.string().nullable(),
  validated: z.boolean(),
  error: z.string().nullable(),
  validatedAt: z.number().nullable(),
  updatedAt: z.number(),
});

export const driveRouter = new OpenAPIHono<{ Bindings: Env }>();
driveRouter.use("*", guardianAuth);

// GET /api/drive/discover — Shared Drives the SA can see + their top folders.
driveRouter.openapi(
  createRoute({
    method: "get",
    path: "/discover",
    operationId: "driveDiscover",
    summary: "List Shared Drives the service account is a member of, and their folders",
    responses: {
      200: {
        description: "Shared Drives + top-level folders, plus the SA email to grant access to",
        content: {
          "application/json": {
            schema: z.object({
              serviceAccountEmail: z.string().nullable(),
              drives: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  folders: z.array(z.object({ id: z.string(), name: z.string() })),
                }),
              ),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const nowSec = Date.now() / 1000;
    const serviceAccountEmail =
      (await getSecretStoreBinding(c.env, "GOOGLE_CREDS_SA_CLIENT_EMAIL")) ??
      getSecret(c.env, "GOOGLE_CREDS_SA_CLIENT_EMAIL") ??
      null;
    const shared = await listSharedDrives(c.env, nowSec);
    const drives = [];
    for (const d of shared) {
      const children = await listDriveChildren(c.env, d.id, nowSec);
      drives.push({
        id: d.id,
        name: d.name,
        folders: children.filter((ch) => ch.isFolder).map((ch) => ({ id: ch.id, name: ch.name })),
      });
    }
    return c.json({ serviceAccountEmail, drives }, 200);
  },
);

// POST /api/drive/autoconfigure — create per-purpose folders in a Shared Drive.
driveRouter.openapi(
  createRoute({
    method: "post",
    path: "/autoconfigure",
    operationId: "driveAutoconfigure",
    summary: "Create/reuse root/r2/d1/cf-image folders in a Shared Drive and save them",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ sharedDriveId: z.string() }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Folders created/reused and saved",
        content: {
          "application/json": {
            schema: z.object({ folders: z.array(folderSchema) }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { sharedDriveId } = c.req.valid("json");
    const nowSec = Date.now() / 1000;
    const now = Date.now();

    // Reuse an existing subfolder by name if present, else create it.
    const existing = await listDriveChildren(c.env, sharedDriveId, nowSec);
    const byName = new Map(existing.filter((c) => c.isFolder).map((c) => [c.name, c.id]));
    const NAMES: Record<Purpose, string> = {
      root: "guardian-archives",
      r2: "r2-archives",
      d1: "d1-archives",
      "cf-image": "cf-image-archives",
    };

    const out = [];
    const db = getDb(c.env);
    for (const purpose of PURPOSES) {
      const name = NAMES[purpose];
      const folderId = byName.get(name) ?? (await createDriveFolder(c.env, sharedDriveId, name, nowSec));
      const row = {
        purpose,
        folderId,
        url: `https://drive.google.com/drive/folders/${folderId}`,
        name,
        validated: true,
        error: null as string | null,
        validatedAt: now,
        updatedAt: now,
      };
      await db.insert(driveFolders).values(row).onConflictDoUpdate({ target: driveFolders.purpose, set: row });
      out.push(row);
    }
    return c.json({ folders: out }, 200);
  },
);

// GET /api/drive/folders — configured folders, seeded with the provided ids.
driveRouter.openapi(
  createRoute({
    method: "get",
    path: "/folders",
    operationId: "driveFolders",
    summary: "Configured Drive folders per archive purpose",
    responses: {
      200: {
        description: "One entry per purpose (seed ids where not yet saved)",
        content: {
          "application/json": {
            schema: z.object({ folders: z.array(folderSchema) }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const rows = await getDb(c.env).select().from(driveFolders);
    const byPurpose = new Map(rows.map((r) => [r.purpose, r]));
    const folders = PURPOSES.map((purpose) => {
      const row = byPurpose.get(purpose);
      if (row) return row;
      // Not saved yet — surface the seed id as an unvalidated suggestion.
      return {
        purpose,
        folderId: SEED[purpose],
        url: SEED[purpose],
        name: null,
        validated: false,
        error: null,
        validatedAt: null,
        updatedAt: 0,
      };
    });
    return c.json({ folders }, 200);
  },
);

// POST /api/drive/folders — extract id, validate SA access, save.
driveRouter.openapi(
  createRoute({
    method: "post",
    path: "/folders",
    operationId: "driveFolderSave",
    summary: "Validate and save a Drive folder for a purpose",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              purpose: z.enum(PURPOSES),
              input: z.string().min(1),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Saved (validated flag reflects whether the SA could read it)",
        content: { "application/json": { schema: folderSchema } },
      },
      400: {
        description: "Could not extract a Drive id from the input",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { purpose, input } = c.req.valid("json");
    const folderId = extractDriveId(input);
    if (!folderId) return c.json({ error: "No Drive folder id found in that input." }, 400);

    const now = Date.now();
    let name: string | null = null;
    let validated = false;
    let error: string | null = null;
    try {
      const folder = await getDriveFolder(c.env, folderId, now / 1000);
      if (folder) {
        name = folder.name;
        validated = true;
        if (!folder.isFolder) error = "That id is a file, not a folder — saved anyway.";
      } else {
        error = "The service account cannot access that folder. Share it with the SA email.";
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Validation failed.";
    }

    const row = {
      purpose,
      folderId,
      url: input,
      name,
      validated,
      error,
      validatedAt: validated ? now : null,
      updatedAt: now,
    };
    await getDb(c.env)
      .insert(driveFolders)
      .values(row)
      .onConflictDoUpdate({ target: driveFolders.purpose, set: row });

    return c.json(row, 200);
  },
);
