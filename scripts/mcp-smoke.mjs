/**
 * @fileoverview Smoke-tests the Core Guardian MCP server over JSON-RPC.
 *
 * Runs initialize → tools/list → a read-only tools/call against the deployed
 * Worker, using the same WORKER_API_KEY the dashboard uses.
 *
 * @example
 * ```sh
 * node scripts/mcp-smoke.mjs
 * ```
 */

import { API_BASE, getWorkerApiKey } from "./config.mjs";

async function rpc(key, method, params) {
  const res = await fetch(`${API_BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const key = await getWorkerApiKey();
if (!key) throw new Error("WORKER_API_KEY not available from the tokens CLI.");

const init = await rpc(key, "initialize", {});
console.log("initialize →", init.result?.serverInfo, init.result?.protocolVersion);

const list = await rpc(key, "tools/list", {});
console.log(`tools/list  → ${list.result?.tools?.length} tools`);
for (const t of list.result?.tools ?? []) {
  console.log(`   ${t.annotations?.destructiveHint ? "!" : " "} ${t.name}`);
}

const call = await rpc(key, "tools/call", { name: "guardian_cron_status", arguments: {} });
console.log("tools/call  →", call.result?.isError ? "ERROR" : "ok");
console.log(JSON.stringify(call.result?.structuredContent ?? call.result).slice(0, 200));
