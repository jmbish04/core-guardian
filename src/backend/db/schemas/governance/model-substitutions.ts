/**
 * @fileoverview `model_substitutions` — the AI Router "translation" table.
 *
 * One row means: for a given AI-Router `project` scope, when a request asks for
 * `from_model`, the router dispatches `to_model` instead (P12 smart proxy). This
 * lets an operator retarget a project off an expensive/deprecated model WITHOUT
 * touching the calling code — the resolver ({@link
 * file://src/backend/guardian/ai-router/resolve-model.ts}) reads these rules on
 * the `/run` hot path.
 *
 * Non-breaking by construction: a request whose (project, model) has no enabled
 * rule here is passed through unchanged. The unique index on (project,
 * from_model) makes "one active rule per model per project" a DB invariant so an
 * upsert can't create two conflicting substitutions.
 *
 * @see {@link file://src/backend/api/routes/model-substitutions.ts} for the CRUD.
 */
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const MODEL_SUBSTITUTIONS_TABLE_DESCRIPTION =
  "AI Router model-substitution rules: per project, map a requested from_model to a to_model dispatched instead.";

export const MODEL_SUBSTITUTIONS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Rule UUID.",
  project: "AI-Router project scope this rule applies to.",
  from_model: "Requested model id that triggers the substitution.",
  to_model: "Model id dispatched instead of from_model.",
  enabled: "1 = active. Disabled rules are ignored (request passes through).",
  note: "Optional operator note (why this substitution exists).",
  created_at: "Unix ms the rule was created.",
};

export const modelSubstitutions = sqliteTable(
  "model_substitutions",
  {
    id: text("id").primaryKey(),
    project: text("project").notNull(),
    fromModel: text("from_model").notNull(),
    toModel: text("to_model").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    note: text("note"),
    createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  },
  (t) => [
    // One rule per (project, from_model) — makes upsert-on-conflict well-defined
    // and prevents two rules fighting over the same requested model.
    uniqueIndex("idx_model_substitutions_project_from").on(t.project, t.fromModel),
  ],
);

export const insertModelSubstitutionSchema = createInsertSchema(modelSubstitutions);
export const selectModelSubstitutionSchema = createSelectSchema(modelSubstitutions);
export type ModelSubstitutionRow = typeof modelSubstitutions.$inferSelect;
export type NewModelSubstitutionRow = typeof modelSubstitutions.$inferInsert;
