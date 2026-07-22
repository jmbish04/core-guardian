/**
 * @fileoverview Executes every probe document in `src/backend/guardian/probes.ts`
 * against the live account and reports OK / FAIL per probe.
 *
 * Runs the same GraphQL the Worker runs, without needing a deploy. The probe
 * registry is parsed straight out of the TypeScript source so this script and
 * the Worker can never drift.
 *
 * @example
 * ```sh
 * node scripts/check-probes.mjs        # trailing 24h
 * node scripts/check-probes.mjs 168    # trailing 7 days
 * ```
 */

import { readFile } from "node:fs/promises";

import { cfGraphQL } from "./config.mjs";

/** Extracts `{ id, dataset, selection }` for each probe in the registry. */
async function loadProbes() {
  const source = await readFile(
    new URL("../src/backend/guardian/probes.ts", import.meta.url),
    "utf8",
  );
  const probes = [];
  // Each entry declares id / dataset / selection as string literals.
  const blocks = source.split(/\n  \{\n/).slice(1);
  for (const block of blocks) {
    const id = block.match(/id:\s*"([^"]+)"/)?.[1];
    const datasetRaw = block.match(/dataset:\s*(null|"([^"]+)")/);
    if (!id || !datasetRaw) continue;
    const dataset = datasetRaw[1] === "null" ? null : datasetRaw[2];
    // selection may be a plain or a wrapped multi-line string literal.
    const selection =
      block.match(/selection:\s*\n?\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\"/g, '"') ?? "";
    probes.push({ id, dataset, selection });
  }
  return probes;
}

const query = (dataset, selection) => `
  query CheckProbe($accountTag: string!, $start: Time!, $end: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        result: ${dataset}(
          filter: { datetimeHour_geq: $start, datetimeHour_leq: $end }
          limit: 10000
        ) { ${selection} }
      }
    }
  }
`;

async function main() {
  const hours = Number(process.argv[2] ?? 24);
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  end.setUTCMinutes(0, 0, 0);

  const probes = await loadProbes();
  console.log(`Checking ${probes.length} probes over the trailing ${hours}h.\n`);

  let failed = 0;
  for (const probe of probes) {
    if (!probe.dataset) {
      console.log(`  --   ${probe.id.padEnd(26)} not metered`);
      continue;
    }
    try {
      const data = await cfGraphQL(query(probe.dataset, probe.selection), {
        start: start.toISOString(),
        end: end.toISOString(),
      });
      const rows = data.viewer.accounts[0]?.result ?? [];
      console.log(`  OK   ${probe.id.padEnd(26)} ${rows.length} group(s)`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${probe.id.padEnd(26)} ${err.message}`);
    }
  }

  console.log(`\n${probes.length - failed} passing, ${failed} failing.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(String(err.message ?? err));
  process.exit(1);
});
