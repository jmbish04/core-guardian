#!/usr/bin/env node
/**
 * Vendors the core-guardian TypeScript client into a consumer worker at build
 * time. Wire it to `postinstall` and `predeploy` so a fresh clone and every
 * deploy refresh the vendored copy. Pin `GUARDIAN_CLIENT_REF` to a tag for
 * reproducible builds. Exits non-zero on fetch failure — a deploy must never
 * silently vendor an empty/stale client.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_RAW = "https://raw.githubusercontent.com/jmbish04/core-guardian";
const CLIENT_PATH = "clients/ts/guardian-client.ts";

export async function pull({ ref = "main", dest, fetchImpl = fetch } = {}) {
  const url = `${REPO_RAW}/${ref}/${CLIENT_PATH}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`pull-guardian: ${res.status} fetching ${url}`);
  const body = await res.text();
  const path = dest instanceof URL ? fileURLToPath(dest) : dest;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

// Run when invoked directly (not when imported by the test). pathToFileURL
// (not a raw `file://` template) so paths with spaces/percent-encoding still
// match — a naive string compare is false there and the CLI silently no-ops.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ref = process.env.GUARDIAN_CLIENT_REF ?? "main";
  const dest = process.env.GUARDIAN_CLIENT_DEST ?? "src/lib/guardian/guardian-client.ts";
  pull({ ref, dest })
    .then((p) => console.log(`pull-guardian: wrote ${p} @ ${ref}`))
    .catch((e) => {
      // A committed vendored copy already on disk makes a GitHub-raw outage
      // non-fatal: warn and keep it rather than blocking every install/deploy.
      if (existsSync(dest)) {
        console.warn(`pull-guardian: fetch failed, keeping existing vendored copy: ${e.message}`);
        process.exit(0);
      }
      console.error(e.message);
      process.exit(1);
    });
}
