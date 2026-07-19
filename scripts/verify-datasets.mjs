/**
 * @fileoverview Introspects the Cloudflare GraphQL Analytics schema and reports
 * which account-level datasets exist, plus the fields available under each
 * dataset's `sum` / `max` selection.
 *
 * Use this to fix `src/backend/guardian/probes.ts` when a probe reports
 * `status: "unavailable"` — it prints the real dataset and field names instead
 * of guessing.
 *
 * @example
 * ```sh
 * node scripts/verify-datasets.mjs             # datasets used by the probes
 * node scripts/verify-datasets.mjs --all       # every account-level dataset
 * node scripts/verify-datasets.mjs r2 vectorize  # name filter
 * ```
 */

import { cfGraphQL } from "./config.mjs";

/** Dataset names the probe registry currently uses. */
const PROBE_DATASETS = [
  "d1AnalyticsAdaptiveGroups",
  "r2OperationsAdaptiveGroups",
  "r2StorageAdaptiveGroups",
  "durableObjectsInvocationsAdaptiveGroups",
  "durableObjectsPeriodicGroups",
  "vectorizeQueriesAdaptiveGroups",
  "aiInferenceAdaptiveGroups",
  "aiGatewayRequestsAdaptiveGroups",
  "kvOperationsAdaptiveGroups",
  "workersInvocationsAdaptive",
  "browserRenderingAdaptiveGroups",
];

/**
 * Resolves the account container type name by walking Query → viewer →
 * accounts. The Cloudflare schema uses lowercase type names (`viewer`,
 * `account`), so hardcoding "Account" silently returns null.
 */
const ROOT_WALK = `
  query RootWalk {
    __schema { queryType { fields { name type { name kind ofType { name } } } } }
  }
`;

/**
 * Field listing for one type.
 *
 * The name is inlined rather than passed as a variable: this schema declares
 * `__type(name:)` in a way that rejects a `string!` variable binding.
 * Wrappers nest up to four deep (NON_NULL → LIST → NON_NULL → OBJECT).
 */
const typeFields = (name) => `
  {
    __type(name: ${JSON.stringify(name)}) {
      fields {
        name
        type { name kind ofType { name kind ofType { name kind ofType { name } } } }
      }
    }
  }
`;

/** Unwraps LIST/NON_NULL wrappers to the underlying named type. */
function namedType(type) {
  let t = type;
  while (t && !t.name) t = t.ofType;
  return t?.name;
}

/** Fetches the field list for a named type. */
async function fieldsOf(name) {
  const data = await cfGraphQL(typeFields(name));
  return data.__type?.fields ?? [];
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const filters = args.filter((a) => !a.startsWith("--")).map((a) => a.toLowerCase());

  // Query → viewer → accounts, resolving each container type by name.
  const root = await cfGraphQL(ROOT_WALK);
  const viewerType =
    namedType(root.__schema.queryType.fields.find((f) => f.name === "viewer")?.type) ?? "viewer";

  const viewerFields = await fieldsOf(viewerType);
  const accountType = namedType(viewerFields.find((f) => f.name === "accounts")?.type) ?? "account";

  const fields = await fieldsOf(accountType);
  const available = new Map(fields.map((f) => [f.name, namedType(f.type)]));

  console.log(`${accountType} exposes ${available.size} datasets.\n`);

  // 1. Verdict on every dataset the probe registry references.
  console.log("── Probe registry ──");
  const missing = [];
  for (const name of PROBE_DATASETS) {
    const exists = available.has(name);
    if (!exists) missing.push(name);
    console.log(`${exists ? "  OK  " : " MISS "} ${name}`);
  }

  // 2. Near-miss suggestions for anything that does not exist.
  if (missing.length > 0) {
    console.log("\n── Suggestions for missing datasets ──");
    for (const name of missing) {
      const stem = name.replace(/AdaptiveGroups|Adaptive|Groups$/g, "").toLowerCase();
      const hits = [...available.keys()].filter((k) => k.toLowerCase().includes(stem.slice(0, 6)));
      console.log(`${name}:`);
      console.log(hits.length ? hits.map((h) => `    ${h}`).join("\n") : "    (no near match)");
    }
  }

  // 3. Field listings for the datasets we care about.
  const targets = all
    ? [...available.keys()]
    : PROBE_DATASETS.filter((n) => available.has(n)).concat(
        filters.length
          ? [...available.keys()].filter((k) => filters.some((f) => k.toLowerCase().includes(f)))
          : [],
      );

  const seen = new Set();
  for (const dataset of targets) {
    if (seen.has(dataset)) continue;
    seen.add(dataset);
    if (filters.length && !filters.some((f) => dataset.toLowerCase().includes(f))) continue;

    const typeName = available.get(dataset);
    if (!typeName) continue;
    const detailFields = await fieldsOf(typeName);

    console.log(`\n── ${dataset} (${typeName}) ──`);
    for (const f of detailFields) {
      const inner = namedType(f.type);
      // sum / max / quantiles / dimensions are nested selection sets.
      if (["sum", "max", "min", "avg", "quantiles", "dimensions"].includes(f.name)) {
        const names = (await fieldsOf(inner)).map((x) => x.name);
        console.log(`  ${f.name}: ${names.join(" ") || "(none)"}`);
      } else {
        console.log(`  ${f.name}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(String(err.message ?? err));
  process.exit(1);
});
