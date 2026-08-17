/**
 * Pure-logic checks for the spend attribution pooler. No network / no env.
 * Run: npx tsx --test src/backend/guardian/spend-attribution.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SHARED, UNATTRIBUTED, poolSpend, type PricedLine } from "./spend-attribution";
import type { BindingIndex } from "./resources";

const index: BindingIndex = {
  byResource: {
    "d1:db-solo": [{ worker: "acre", binding: "DB" }], // single owner
    "r2:shared-bucket": [
      { worker: "acre", binding: "R2" },
      { worker: "codra", binding: "R2" }, // two owners → shared
    ],
    "vectorize:orphan-index": [], // bound to no tracked worker → unattributed
  },
  workerCount: 2,
  builtAt: 0,
};

const meta = new Map([
  ["acre", { kind: "worker", criticality: "critical" }],
  ["codra", { kind: "worker", criticality: "normal" }],
]);

test("single-binder resource credits its owner project", () => {
  const out = poolSpend([{ kind: "resource", key: "d1:db-solo", category: "d1", usd: 10 }], index, meta);
  const acre = out.find((p) => p.name === "acre")!;
  assert.equal(acre.byCategory.d1, 10);
  assert.equal(acre.criticality, "critical");
  assert.equal(out.some((p) => p.name === SHARED), false);
});

test("multi-binder resource pools into __shared__, never split", () => {
  const out = poolSpend([{ kind: "resource", key: "r2:shared-bucket", category: "r2", usd: 8 }], index, meta);
  const shared = out.find((p) => p.name === SHARED)!;
  assert.equal(shared.byCategory.r2, 8); // whole amount, not 4+4
  assert.equal(shared.kind, "shared");
  assert.equal(out.some((p) => p.name === "acre"), false);
});

test("resource with no tracked binder pools into __unattributed__", () => {
  const out = poolSpend(
    [{ kind: "resource", key: "vectorize:orphan-index", category: "vectorize", usd: 3 }],
    index,
    meta,
  );
  assert.equal(out[0].name, UNATTRIBUTED);
  assert.equal(out[0].byCategory.vectorize, 3);
});

test("compute + ai attach directly; totals sum and sort desc", () => {
  const lines: PricedLine[] = [
    { kind: "compute", worker: "acre", usd: 5 },
    { kind: "ai", project: "acre", usd: 20 },
    { kind: "ai", project: "codra", usd: 2 },
    { kind: "resource", key: "d1:db-solo", category: "d1", usd: 1 },
    { kind: "resource", key: "unknown:x", category: "r2", usd: 0 }, // zero is dropped
  ];
  const out = poolSpend(lines, index, meta);
  assert.equal(out[0].name, "acre"); // 5+20+1 = 26, ranked first
  assert.equal(out[0].totalUsd, 26);
  assert.equal(out[0].byCategory.compute, 5);
  assert.equal(out[0].byCategory.ai, 20);
  assert.equal(out[0].byCategory.d1, 1);
  const codra = out.find((p) => p.name === "codra")!;
  assert.equal(codra.totalUsd, 2);
});
