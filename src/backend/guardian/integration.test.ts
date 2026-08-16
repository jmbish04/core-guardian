import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildInstructions, CLIENT_VERSION, SUPPORTED_LANGS, SUPPORTED_MODES } from "./integration.ts";

const BASE = "https://core-guardian.hacolby.workers.dev";

test("CLIENT_VERSION stays in sync with clients/VERSION", () => {
  const file = readFileSync(new URL("../../../clients/VERSION", import.meta.url), "utf8").trim();
  assert.equal(CLIENT_VERSION, file);
});

test("ts+curl instructions carry base url, version, and a raw pull command", () => {
  const distinctBase = "https://staging.example.com";
  const r = buildInstructions({ baseUrl: distinctBase, lang: "ts", mode: "curl" });
  assert.equal(r.version, CLIENT_VERSION);
  assert.match(r.pull, /raw\.githubusercontent\.com\/jmbish04\/core-guardian/);
  assert.match(r.pull, /clients\/ts\/guardian-client\.ts/);
  assert.match(r.varsStub, /"project"/);
  assert.ok(r.varsStub.includes(distinctBase));
  assert.ok(!r.varsStub.includes("core-guardian.hacolby.workers.dev"));
  assert.deepEqual(r.secrets, ["wrangler secret put GUARDIAN_AI_TOKEN", "wrangler secret put GUARDIAN_API_KEY"]);
  assert.match(r.usage, /GuardianClient/);
});

test("ref is honestly stamped as main — the pull ref the commands actually use", () => {
  const r = buildInstructions({ baseUrl: BASE, lang: "ts", mode: "curl" });
  assert.equal(r.ref, "main");
});

test("submodule mode emits a git submodule command", () => {
  const r = buildInstructions({ baseUrl: BASE, lang: "ts", mode: "submodule" });
  assert.match(r.pull, /git submodule add/);
});

test("every supported lang×mode builds without throwing and stamps the version", () => {
  for (const lang of SUPPORTED_LANGS) {
    for (const mode of SUPPORTED_MODES) {
      const r = buildInstructions({ baseUrl: BASE, lang, mode });
      assert.equal(r.version, CLIENT_VERSION);
      assert.ok(r.pull.length > 0);
    }
  }
});

test("unknown lang throws a RangeError", () => {
  assert.throws(
    () => buildInstructions({ baseUrl: BASE, lang: "cobol" as never, mode: "curl" }),
    RangeError,
  );
});

test("unknown mode throws a RangeError", () => {
  assert.throws(
    () => buildInstructions({ baseUrl: BASE, lang: "ts", mode: "sftp" as never }),
    RangeError,
  );
});
