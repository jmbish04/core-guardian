# Billable catalog — what causes each Cloudflare charge

**Source of truth:** [`src/shared/billable-catalog.ts`](../../src/shared/billable-catalog.ts).
This doc mirrors that const; the billing UI (`BillableUsage`) annotates each bill
line from the same map. Update the const, then this doc.

Your Cloudflare bill lists a cost per SKU. This maps each SKU to the **metric**
it measures, the concrete **worker action** that increments it, and one **lever**
to reduce it. Where a number is climbing, this is where to look.

| Category | Metric | Unit | Caused by | Lever |
|---|---|---|---|---|
| ai | Workers AI neurons | neurons | Every model inference through Workers AI (`env.AI.run` / the AI Router). Scales with model size × tokens. | Route low-importance calls to a cheaper model; cache/dedupe prompts; cap via the AI-Router budget. |
| d1 | D1 rows read | rows | Every row a `SELECT` **scans** (not returns). An unindexed query scans the whole table. | Add indexes so queries seek instead of scan; avoid `SELECT *` on hot paths. |
| d1 | D1 rows written | rows | Every row an `INSERT`/`UPDATE`/`DELETE` writes, plus index-row writes. | Batch writes; drop unused indexes (each adds a write per row). |
| d1 | D1 storage | GB-months | Total database size held over time (rows + indexes). | Archive/trim old rows; drop unused tables/indexes. |
| do | Durable Object compute | GB-seconds / requests | Wall-clock time a DO is active × memory, plus each request/alarm that wakes it. | Use WebSocket hibernation; coalesce work; avoid tight alarm loops. |
| do | DO SQL rows read | rows | Every row a DO SQLite `SELECT` scans. | Index DO SQL queries; read less per request. |
| do | DO SQL rows written | rows | Every row a DO SQLite write touches. | Batch DO writes; prune DO state. |
| do | DO storage | GB-months | DO SQLite / KV storage held over time. | Delete stale DO state; compact. |
| r2 | R2 Class A operations | requests | Mutating/listing calls: `put`, `delete`, `list`, multipart. | Batch uploads; avoid frequent full `list()`s. |
| r2 | R2 Class B operations | requests | Read calls: `get`, `head`. | Cache reads at the edge; avoid re-fetching unchanged objects. |
| r2 | R2 storage | GB-months | Bytes stored across buckets over time. | Lifecycle-expire old objects (Guardian R2 eviction does this). |
| kv | KV operations | operations | `KV.get`/`put`/`list`/`delete` — one op each. | Cache hot KV per request; batch; widen `cacheTtl`. |
| kv | KV storage | GB-months | Total KV value bytes over time. | Set TTLs; delete stale keys. |
| vectorize | Vectorize queried dimensions | dimension-queries | Each `query()` × index dimensionality × topK. | Lower dimensions/topK; cache frequent queries. |
| vectorize | Vectorize stored dimensions | dimension-months | Vectors held × dimensionality over time. | Prune stale vectors (Guardian Vectorize-drop clears an index). |
| compute | Workers requests | requests | Every Worker invocation (fetch, cron, queue consumer, RPC). | Cut noisy crons; cache to skip invocations; coalesce subrequests. |
| compute | Workers CPU time | ms | CPU milliseconds per invocation (not wall time). | Optimize hot loops; move heavy work off the request path. |
| compute | Dynamic Workers | workers | Each dynamically-created Worker isolate (Code Mode / dynamic dispatch). | Reuse isolates; cap dynamic creation. |
| builds | Workers Build minutes | minutes | CI build minutes on Workers Builds per deploy. | Cache deps; deploy less often; trim the build. |
| browser | Browser Rendering | hours / concurrent | Puppeteer session time and concurrent browser count. | Close sessions promptly; reuse; cap concurrency. |
| queues | Queue operations | operations | Each message write, read, delete (retries re-charge). | Batch messages; fix retry-looping consumers. |
| containers | Containers | vCPU-s / GiB-s / GB egress | Container vCPU, memory, disk, egress while running. | Scale to zero when idle; right-size. |
| images | Images | images | Each transform / stored image / delivery. | Cache variants; limit transform permutations. |
| stream | Stream | minutes / images | Video minutes stored/delivered. | Delete unused assets. |
| observability | Observability / Logpush | requests / logs | Log volume pushed/retained; per-request events. | Sample logs; narrow Logpush filters. |

## How this ties to your bill

- **Billed actual** per SKU comes from `billable_usage` (the Cloudflare Billable
  Usage API — ground truth).
- **This catalog** annotates each of those SKUs with the causing action.
- **The rollup** (`spend_rollup`) allocates the actual to projects by category,
  so you go: *this project* → *this category* → *this action* → *this lever*.
