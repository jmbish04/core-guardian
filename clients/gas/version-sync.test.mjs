import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// GAS can't read clients/VERSION at runtime, so its version is a hardcoded
// literal. This guard fails CI if that literal drifts from clients/VERSION.
test("GuardianClient.gs version matches clients/VERSION", () => {
  const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
  const gas = readFileSync(new URL("./GuardianClient.gs", import.meta.url), "utf8");
  const m = gas.match(/GUARDIAN_CLIENT_VERSION\s*=\s*'([^']+)'/);
  assert.ok(m, "GUARDIAN_CLIENT_VERSION literal not found in GuardianClient.gs");
  assert.equal(m[1], version);
});
