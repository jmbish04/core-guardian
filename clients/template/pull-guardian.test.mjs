import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { pull } from "./pull-guardian.mjs";

const TMP = new URL("./.tmp-guardian-client.ts", import.meta.url);

test("pull writes the fetched body to dest", async () => {
  const fake = (async () => new Response("export const X = 1;", { status: 200 }));
  await pull({ ref: "main", dest: TMP, fetchImpl: fake });
  assert.ok(existsSync(TMP));
  assert.match(readFileSync(TMP, "utf8"), /export const X = 1;/);
  rmSync(TMP);
});

test("pull throws (non-zero-worthy) on a non-200 so deploys don't vendor nothing", async () => {
  const fake = (async () => new Response("nope", { status: 404 }));
  await assert.rejects(() => pull({ ref: "main", dest: TMP, fetchImpl: fake }));
  assert.ok(!existsSync(TMP));
});
