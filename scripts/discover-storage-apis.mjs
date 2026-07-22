/**
 * @fileoverview Probes the Cloudflare REST endpoints the Data Storage console
 * needs, and reports which exist plus the shape of what they return.
 *
 * Run this before writing code against any of these — several storage APIs are
 * newer or differently-shaped than the docs suggest.
 *
 * @example
 * ```sh
 * node scripts/discover-storage-apis.mjs
 * ```
 */

import { cfFetch } from "./config.mjs";

/** Endpoints to probe, in dashboard-section order. */
const ENDPOINTS = [
  { label: "R2 buckets", path: "/r2/buckets" },
  { label: "D1 databases", path: "/d1/database" },
  { label: "KV namespaces", path: "/storage/kv/namespaces" },
  { label: "Pipelines", path: "/pipelines" },
  { label: "Pipelines (v1)", path: "/pipelines/v1/pipelines" },
  { label: "Workers scripts", path: "/workers/scripts" },
  { label: "Vectorize indexes", path: "/vectorize/v2/indexes" },
  { label: "Queues", path: "/queues" },
  { label: "Hyperdrive", path: "/hyperdrive/configs" },
];

/** Summarizes an unknown result shape without dumping everything. */
function describe(result) {
  if (Array.isArray(result)) {
    const first = result[0];
    return {
      count: result.length,
      keys: first && typeof first === "object" ? Object.keys(first) : typeof first,
      sample: first,
    };
  }
  if (result && typeof result === "object") return { keys: Object.keys(result), sample: result };
  return { value: result };
}

async function main() {
  const found = [];

  for (const { label, path } of ENDPOINTS) {
    try {
      const body = await cfFetch(path);
      const info = describe(body.result);
      found.push({ label, path, info });
      console.log(`\n== ${label}  (${path})`);
      console.log(`   count: ${info.count ?? "n/a"}`);
      console.log(`   keys : ${JSON.stringify(info.keys)}`);
      if (info.sample) console.log(`   sample: ${JSON.stringify(info.sample).slice(0, 420)}`);
    } catch (err) {
      console.log(`\n== ${label}  (${path})`);
      console.log(`   FAIL: ${err.message}`);
    }
  }

  // Per-bucket follow-ups: object listing + data catalog, using a real bucket.
  const r2 = found.find((f) => f.label === "R2 buckets");
  const bucket = r2?.info?.sample?.name;
  if (bucket) {
    console.log(`\n\n--- per-bucket probes using "${bucket}" ---`);
    for (const path of [
      `/r2/buckets/${bucket}/objects`,
      `/r2/buckets/${bucket}/usage`,
      `/r2/buckets/${bucket}/lifecycle`,
      `/r2-catalog/${bucket}`,
    ]) {
      try {
        const body = await cfFetch(path);
        console.log(`\n== ${path}`);
        console.log(`   ${JSON.stringify(body.result).slice(0, 420)}`);
      } catch (err) {
        console.log(`\n== ${path}\n   FAIL: ${err.message}`);
      }
    }
  }

  // Worker bindings — needed to show which Worker uses each resource.
  const scripts = found.find((f) => f.label === "Workers scripts");
  const script = scripts?.info?.sample?.id;
  if (script) {
    console.log(`\n\n--- bindings probe using worker "${script}" ---`);
    for (const path of [
      `/workers/scripts/${script}/settings`,
      `/workers/scripts/${script}/bindings`,
    ]) {
      try {
        const body = await cfFetch(path);
        console.log(`\n== ${path}`);
        console.log(`   ${JSON.stringify(body.result).slice(0, 600)}`);
      } catch (err) {
        console.log(`\n== ${path}\n   FAIL: ${err.message}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(String(err.message ?? err));
  process.exit(1);
});
