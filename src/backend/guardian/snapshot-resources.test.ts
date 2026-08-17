/**
 * Pure-helper checks for snapshot-resources. No network / no env.
 * Run: npx tsx --test src/backend/guardian/snapshot-resources.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PROBE_TO_PRODUCT, bindingRowsFrom, resourceIdOf } from "./snapshot-resources";
import type { BindingIndex } from "./resources";

test("resourceIdOf is deterministic product:cfId and matches binding-key form", () => {
  assert.equal(resourceIdOf("r2", "logs-bucket"), "r2:logs-bucket");
  assert.equal(resourceIdOf("d1", "abc-123"), "d1:abc-123");
});

test("PROBE_TO_PRODUCT maps the resource-attributable probes", () => {
  assert.equal(PROBE_TO_PRODUCT["d1"].product, "d1");
  assert.equal(PROBE_TO_PRODUCT["r2-operations"].product, "r2");
  assert.equal(PROBE_TO_PRODUCT["r2-storage"].product, "r2");
  assert.equal(PROBE_TO_PRODUCT["vectorize"].product, "vectorize");
  assert.equal(PROBE_TO_PRODUCT["kv"], undefined); // kv breakdown is by action-type, not namespace
});

test("bindingRowsFrom flattens the index; each binder becomes one row", () => {
  const index: BindingIndex = {
    byResource: {
      "r2:logs": [{ worker: "acre", binding: "R2" }],
      "d1:db-1": [
        { worker: "acre", binding: "DB" },
        { worker: "codra", binding: "DB" },
      ],
    },
    workerCount: 2,
    builtAt: 0,
  };
  const rows = bindingRowsFrom(index);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.find((r) => r.worker === "codra"),
    { worker: "codra", resourceId: "d1:db-1", bindingName: "DB" },
  );
});
