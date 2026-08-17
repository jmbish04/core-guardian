/**
 * Window-math checks for the billable-usage backfill. No network.
 * Run: npx tsx --test src/backend/guardian/backfill-billable-usage.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { maxBackfillWindows } from "./backfill-billable-usage";

test("maxBackfillWindows chunks retention into <=chunkDays spans, oldest first, ending at now (UTC)", () => {
  const now = Date.UTC(2026, 2, 15); // 2026-03-15
  const wins = maxBackfillWindows(now, 90, 31);
  assert.ok(wins.length >= 3 && wins.length <= 4, `got ${wins.length} windows`);
  assert.match(wins[0].from, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(wins[wins.length - 1].to, "2026-03-15"); // ends at now
  for (let i = 1; i < wins.length; i++) {
    assert.ok(wins[i - 1].to <= wins[i].from, "windows are ordered oldest-first and contiguous");
  }
});

test("each chunk span is at most chunkDays wide", () => {
  const now = Date.UTC(2026, 5, 1);
  const wins = maxBackfillWindows(now, 90, 31);
  for (const w of wins) {
    const span = (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000;
    assert.ok(span <= 31, `span ${span} exceeds 31`);
  }
});
