/**
 * Pure allocation checks for the spend rollup. No network.
 * Run: npx tsx --test src/backend/guardian/spend-rollup.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { UNATTRIBUTED, allocateActual, likeForLikeDispute } from "./spend-rollup";

test("dispute is like-for-like: a billed-but-unpriceable category (DO) is excluded", () => {
  const actual = new Map([
    ["ai", 500],
    ["do", 104], // billed but no estimate → must NOT show as a $104 dispute
  ]);
  const estimate = new Map([["ai", 480]]); // only AI is priceable
  const { estimateUsd, disputeUsd } = likeForLikeDispute(actual, estimate);
  assert.equal(estimateUsd, 480);
  assert.equal(disputeUsd, 20); // 500 − 480, DO ignored (not +124)
});

test("dispute is negative when billed under our (upper-bound) estimate", () => {
  const { disputeUsd } = likeForLikeDispute(new Map([["ai", 400]]), new Map([["ai", 500]]));
  assert.equal(disputeUsd, -100);
});

test("allocateActual splits by weight and sums back to the actual", () => {
  const out = allocateActual(100, [
    { key: "a", weight: 3 },
    { key: "b", weight: 1 },
  ]);
  assert.equal(out.find((o) => o.key === "a")!.usd, 75);
  assert.equal(out.find((o) => o.key === "b")!.usd, 25);
  assert.equal(out.reduce((s, o) => s + o.usd, 0), 100);
});

test("rounding drift folds into the first part so parts sum to the whole", () => {
  const out = allocateActual(10, [
    { key: "a", weight: 1 },
    { key: "b", weight: 1 },
    { key: "c", weight: 1 },
  ]);
  assert.equal(out.reduce((s, o) => s + o.usd, 0), 10); // exact, despite 10/3
});

test("no usable weight → whole amount pools to unattributed", () => {
  assert.deepEqual(allocateActual(42, [{ key: "a", weight: 0 }]), [{ key: UNATTRIBUTED, usd: 42 }]);
  assert.deepEqual(allocateActual(42, []), [{ key: UNATTRIBUTED, usd: 42 }]);
});

test("zero actual pools to unattributed (never fabricates a split)", () => {
  assert.deepEqual(allocateActual(0, [{ key: "a", weight: 5 }]), [{ key: UNATTRIBUTED, usd: 0 }]);
});
