# D1 Read-Cost Remediation & Index Automation

A workflow for turning a D1 read-cost overage into a reviewed index fix. See
`.agent/rules/d1-automation-rules.md` for the hard rules; this file is the
step-by-step. Adapted to this repo's real stack — **Drizzle on D1, one database
bound `DB`, migrations in `./drizzle`. No Prisma, no Jules dependency.**

## 1. Context

`core-guardian` monitors Cloudflare cost/usage. D1 read overages come from
full-table scans on hot tables (append-only tables with unindexed `WHERE`/`ORDER
BY` columns are the usual culprit). This workflow diagnoses the scan, backs up
the data, adds the index in the Drizzle schema, and opens a PR.

## 2. Technical scope

- **Analytics:** aggregate D1 cost is already in-app (`guardian/billable-usage.ts`,
  `guardian/daily-cost.ts`). For the per-query breakdown, run
  `wrangler d1 insights DB --sort-by reads --sort-direction DESC` and read off the
  `SCAN TABLE` rows.
- **Backup:** reuse the existing Drive archive — `src/backend/lib/google-drive.ts`
  (resumable upload + byte-count audit), surfaced by the `ArchiveD1Dialog` UI.
  Not a new script.
- **Remediation:** add `index()` to the offending table under
  `src/backend/db/schemas/**`, then `pnpm run db:generate` (output → `./drizzle`).
- **Orchestration:** the schema edit + PR is done by the coding agent
  (Antigravity / Claude Code) directly. There is no Jules integration wired in
  this repo; do not assume one.

## 3. Steps

1. **Diagnose.** `wrangler d1 insights DB --sort-by reads --sort-direction DESC`.
   Extract the queries doing `SCAN TABLE` and the columns they filter/sort on.
2. **Back up first.** Archive the affected table(s) to Drive via the existing
   flow and wait for the byte-count audit to confirm (the `action_items` audit
   row). Do not touch the schema until the archive is confirmed.
3. **Add the index.** In the table's file under `src/backend/db/schemas/**`, add
   an `index()` covering the scan's filter/sort/FK columns. Match the column
   order to the query (equality columns before range/sort columns).
4. **Generate the migration.** `pnpm run db:generate` — drizzle-kit writes a new
   migration under `./drizzle`. Never hand-write the SQL; never target a
   `prisma/` path.
5. **Open a PR** with the schema change + generated migration for manual review.
   `migrate:remote` applies it on merge (part of `deploy`).
6. **Report.** Log: database (`DB`), Drive archive link + audited byte count, the
   `SCAN TABLE` queries found, the index(es) added, and the PR link.

## Validation checklist

- [ ] Migration file landed in `./drizzle`, not `prisma/`.
- [ ] No change made to the `wrangler.jsonc` Durable Object `migrations` block
      (`new_sqlite_classes` is unrelated to D1 indexes).
- [ ] Drive archive confirmed (byte-count audit) before the schema change.
- [ ] Index columns match the diagnosed `SCAN TABLE` query's filter/sort order.
