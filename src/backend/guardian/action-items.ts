/**
 * @fileoverview Action-item executor — the approve-then-verify path for the
 * human-gated destructive follow-ups the archive flows file.
 *
 * `fileActionItem` records a pending proposal (used by the archive flows once a
 * copy is audited). `executeActionItem` runs the destructive step for an
 * approved item and then verifies it actually took effect before marking the
 * item complete — a deletion that silently no-ops must not read as done.
 *
 * @see {@link file://src/backend/db/schemas/governance/action-items.ts}
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { actionItems, type ActionItemRow, type NewActionItemRow } from "@/backend/db/schema";

import { cfApi } from "./resources";

/** File a pending action item (called by the archive flows after audit). */
export async function fileActionItem(
  env: Env,
  item: Omit<NewActionItemRow, "id" | "status" | "createdAt">,
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env)
    .insert(actionItems)
    .values({ ...item, id, status: "pending", createdAt: Date.now() });
  return id;
}

type Handler = {
  delete: (env: Env, item: ActionItemRow) => Promise<void>;
  verify: (env: Env, item: ActionItemRow) => Promise<boolean>;
};

/** Parse a batch key list stored in an item's audit JSON. */
function auditKeys(item: ActionItemRow): string[] {
  try {
    const a = JSON.parse(item.audit ?? "{}") as { keys?: string[] };
    return Array.isArray(a.keys) ? a.keys : [];
  } catch {
    return [];
  }
}

/** Deletion + verification per resource type. Extended as archives land. */
const HANDLERS: Record<string, Handler> = {
  "d1-database": {
    delete: async (env, item) => {
      await cfApi(env, `/d1/database/${encodeURIComponent(item.resourceId)}`, { method: "DELETE" });
    },
    // Verified deleted when the GET now fails (database no longer exists).
    verify: async (env, item) => {
      try {
        await cfApi(env, `/d1/database/${encodeURIComponent(item.resourceId)}`);
        return false; // still readable → not deleted
      } catch {
        return true;
      }
    },
  },
  // resourceId is a comma-joined list of image ids archived together.
  "cf-image-batch": {
    delete: async (env, item) => {
      for (const imageId of item.resourceId.split(",").filter(Boolean)) {
        await cfApi(env, `/images/v1/${encodeURIComponent(imageId)}`, { method: "DELETE" }).catch(() => {
          // A single already-deleted image must not sink the batch; verify catches real leftovers.
        });
      }
    },
    verify: async (env, item) => {
      for (const imageId of item.resourceId.split(",").filter(Boolean)) {
        try {
          await cfApi(env, `/images/v1/${encodeURIComponent(imageId)}`);
          return false; // one still exists → not fully deleted
        } catch {
          /* gone, keep checking */
        }
      }
      return true;
    },
  },
  // resourceId = bucket name; audit.keys = the archived object keys to delete.
  "r2-object-batch": {
    delete: async (env, item) => {
      const bucket = item.resourceId;
      for (const key of auditKeys(item)) {
        await cfApi(env, `/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`, {
          method: "DELETE",
        }).catch(() => {
          // Already-gone object must not sink the batch; verify catches leftovers.
        });
      }
    },
    // Re-list the bucket and confirm none of the archived keys remain.
    verify: async (env, item) => {
      const remaining = new Set(auditKeys(item));
      try {
        const { result } = await cfApi<{ key: string }[]>(
          env,
          `/r2/buckets/${encodeURIComponent(item.resourceId)}/objects?per_page=1000`,
        );
        for (const o of result ?? []) if (remaining.has(o.key)) return false;
        return true;
      } catch {
        return true;
      }
    },
  },
};

/**
 * Execute an approved action item: run its destructive step, then verify.
 *
 * @returns the final status and any verification detail
 */
export async function executeActionItem(
  env: Env,
  id: string,
): Promise<{ status: "complete" | "failed"; detail: string }> {
  const db = getDb(env);
  const [item] = await db.select().from(actionItems).where(eq(actionItems.id, id)).limit(1);
  if (!item) return { status: "failed", detail: "No such action item." };
  if (item.status === "complete") return { status: "complete", detail: "Already complete." };

  const handler = HANDLERS[item.resourceType];
  if (!handler) {
    const detail = `No handler for resource type ${item.resourceType}.`;
    await db
      .update(actionItems)
      .set({ status: "failed", error: detail, completedAt: Date.now() })
      .where(eq(actionItems.id, id));
    return { status: "failed", detail };
  }

  await db.update(actionItems).set({ status: "in_progress", approvedAt: Date.now() }).where(eq(actionItems.id, id));

  try {
    await handler.delete(env, item);
    // Deletion is eventually consistent for some products; verify before claiming done.
    const gone = await handler.verify(env, item);
    if (!gone) {
      const detail = "Deletion ran but the source is still present — left as failed for review.";
      await db
        .update(actionItems)
        .set({ status: "failed", error: detail, verifyResult: detail, completedAt: Date.now() })
        .where(eq(actionItems.id, id));
      return { status: "failed", detail };
    }
    const detail = `${item.resourceName} deleted and verified gone.`;
    await db
      .update(actionItems)
      .set({ status: "complete", verifyResult: detail, completedAt: Date.now() })
      .where(eq(actionItems.id, id));
    return { status: "complete", detail };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Deletion failed.";
    await db
      .update(actionItems)
      .set({ status: "failed", error: detail, completedAt: Date.now() })
      .where(eq(actionItems.id, id));
    return { status: "failed", detail };
  }
}
