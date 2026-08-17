/**
 * Verify the catalog matchers hit the REAL Cloudflare service_name strings
 * (allowance note appended). Run: npx tsx --test src/shared/billable-catalog.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { lookupBillable } from "./billable-catalog";

// Real service_name values observed in billable_usage.
const CASES: [name: string, category: string, metricIncludes: string][] = [
  ["Regular Twitch Neurons", "ai", "neuron"],
  ["D1 - Rows Read (first 25 billion included)", "d1", "rows read"],
  ["D1 - Rows Written (first 50 million included)", "d1", "rows written"],
  ["D1 - Storage GB-mo (first 5GB included)", "d1", "storage"],
  ["Durable Objects Compute Duration (GB*S, First 400,000 GB*S is included)", "do", "compute"],
  ["Durable Objects Storage Rows Read (First 25B included)", "do", "sql rows read"],
  ["R2 Storage Class A Operations (First 1M included)", "r2", "class a"],
  ["R2 Storage Class B Operations (First 10M included)", "r2", "class b"],
  ["R2 Data Storage (First 10GB-Month included)", "r2", "storage"],
  ["KV Read Operations (First 10M is included)", "kv", "operations"],
  ["Vectorize - Queried Dimensions (First 50 million included)", "vectorize", "queried"],
  ["Vectorize - Stored Dimensions (First 10 million dimension-month included)", "vectorize", "stored"],
  ["Workers Standard Requests (first 10M are included)", "compute", "requests"],
  ["Workers CPU ms (first 30M are included)", "compute", "cpu"],
  ["Dynamic Workers (First 1,000 are included)", "compute", "dynamic"],
];

for (const [name, category, metricIncludes] of CASES) {
  test(`maps: ${name}`, () => {
    const e = lookupBillable(name);
    assert.ok(e, `no catalog entry for "${name}"`);
    assert.equal(e!.category, category, `wrong category for "${name}"`);
    assert.ok(
      e!.metric.toLowerCase().includes(metricIncludes),
      `metric "${e!.metric}" missing "${metricIncludes}"`,
    );
    assert.ok(e!.action.length > 10 && e!.lever.length > 5, "action/lever present");
  });
}

test("R2 Class B is matched before the generic R2 storage catch-all (order)", () => {
  assert.equal(lookupBillable("R2 Storage Class B Operations")!.metric, "R2 Class B operations");
});

test("unknown SKU returns null (never guesses)", () => {
  assert.equal(lookupBillable("Some Future Cloudflare SKU"), null);
});
