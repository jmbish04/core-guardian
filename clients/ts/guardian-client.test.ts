import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GuardianClient, GuardianError } from "./guardian-client.ts";

/** A fetch stub that records the last call and returns a canned Response. */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const cfg = { project: "my-worker", priority: "important" as const, baseUrl: "https://g.example.com" };

test("ai.run posts to /api/ai-router/run with AI token and injected project+importance", async () => {
  const { fn, calls } = stubFetch(200, { request_uuid: "u1", status: 200, provider: "openai", model: "gpt", mode: "gateway", gateway: null, tokens_in: 1, tokens_out: 2, cost_usd: 0.01, body: {} });
  const g = new GuardianClient({ ...cfg, aiToken: "AI", apiKey: "API", fetch: fn });
  const r = await g.ai.run({ provider: "openai", model: "gpt", input: { messages: [] } });
  assert.equal(r.request_uuid, "u1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://g.example.com/api/ai-router/run");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer AI");
  const sent = JSON.parse(calls[0].init.body as string);
  assert.equal(sent.project, "my-worker");
  assert.equal(sent.importance, "medium"); // important → medium
  assert.equal(sent.stream, false);
});

test("unrecognized priority falls back to low importance, never undefined", async () => {
  for (const priority of ["Normal", ""]) {
    const { fn, calls } = stubFetch(200, { request_uuid: "u", status: 200, provider: "p", model: "m", mode: "gateway", gateway: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, body: {} });
    const g = new GuardianClient({ ...cfg, priority: priority as never, aiToken: "AI", apiKey: "API", fetch: fn });
    await g.ai.run({ provider: "p", model: "m", input: {} });
    assert.equal(JSON.parse(calls[0].init.body as string).importance, "low");
  }
});

test("per-call importance overrides config priority", async () => {
  const { fn, calls } = stubFetch(200, { request_uuid: "u", status: 200, provider: "p", model: "m", mode: "gateway", gateway: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, body: {} });
  const g = new GuardianClient({ ...cfg, aiToken: "AI", apiKey: "API", fetch: fn });
  await g.ai.run({ provider: "p", model: "m", input: {}, importance: "low" });
  assert.equal(JSON.parse(calls[0].init.body as string).importance, "low");
});

test("usage.register posts to guardian usage endpoint with API key and worker=project", async () => {
  const { fn, calls } = stubFetch(200, { registrationId: "r", id: "i", day: "2026-08-14", worker: "my-worker", gateway: "direct", provider: "p", model: "m", requests: 1, costUsd: 0, tokensIn: 0, tokensOut: 0, tokensThinking: 0, priced: "scraped" });
  const g = new GuardianClient({ ...cfg, aiToken: "AI", apiKey: "API", fetch: fn });
  await g.usage.register({ provider: "p", model: "m", tokensIn: 10, tokensOut: 5 });
  assert.equal(calls[0].url, "https://g.example.com/api/guardian/usage/register");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer API");
  assert.equal(JSON.parse(calls[0].init.body as string).worker, "my-worker");
});

test("non-2xx throws GuardianError carrying status and body", async () => {
  const { fn } = stubFetch(500, { error: "boom" });
  const g = new GuardianClient({ ...cfg, aiToken: "AI", apiKey: "API", fetch: fn });
  await assert.rejects(() => g.ai.run({ provider: "p", model: "m", input: {} }), (e: unknown) => {
    assert.ok(e instanceof GuardianError);
    assert.equal(e.status, 500);
    assert.deepEqual(e.body, { error: "boom" });
    return true;
  });
});

test("429 breaker body sets isCircuitBreaker", async () => {
  const { fn } = stubFetch(429, { request_uuid: "u", isCircuitBreaker: true, circuitBrokenMessage: "cooling down" });
  const g = new GuardianClient({ ...cfg, aiToken: "AI", apiKey: "API", fetch: fn });
  await assert.rejects(() => g.ai.run({ provider: "p", model: "m", input: {} }), (e: unknown) => {
    assert.ok(e instanceof GuardianError);
    assert.equal((e as GuardianError).isCircuitBreaker, true);
    assert.equal((e as GuardianError).circuitBrokenMessage, "cooling down");
    return true;
  });
});

test("fromEnv parses GUARDIAN as object and as JSON string; missing project throws", () => {
  const asObj = GuardianClient.fromEnv({ GUARDIAN: { project: "p1" }, GUARDIAN_AI_TOKEN: "AI", GUARDIAN_API_KEY: "API" });
  assert.ok(asObj instanceof GuardianClient);
  const asStr = GuardianClient.fromEnv({ GUARDIAN: JSON.stringify({ project: "p2" }), GUARDIAN_AI_TOKEN: "AI", GUARDIAN_API_KEY: "API" });
  assert.ok(asStr instanceof GuardianClient);
  assert.throws(() => GuardianClient.fromEnv({ GUARDIAN: { repo: "x" } }));
  assert.throws(() => GuardianClient.fromEnv({}));
});

test("fromEnv throws a helpful message on malformed GUARDIAN JSON", () => {
  assert.throws(
    () => GuardianClient.fromEnv({ GUARDIAN: "{not valid json" }),
    /GuardianClient\.fromEnv: env\.GUARDIAN is not valid JSON/,
  );
});

test("tokens never leak into a serialized client instance", () => {
  const g = new GuardianClient({ ...cfg, aiToken: "SECRET_AI_TOKEN", apiKey: "SECRET_API_KEY", fetch: stubFetch(200, {}).fn });
  const serialized = JSON.stringify(g);
  assert.ok(!serialized.includes("SECRET_AI_TOKEN"));
  assert.ok(!serialized.includes("SECRET_API_KEY"));
});

test("VERSION file matches the version the client reports", () => {
  const fileVersion = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
  assert.equal(fileVersion, GuardianClient.VERSION);
});
