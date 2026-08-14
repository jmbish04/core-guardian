# Guardian auto-pull kit (for the worker template)

Drop these into `core-template-cfw-assets-astro-shadcn` so every new worker vendors the guardian client automatically and re-pulls on install/deploy. The vendored file is **committed** (reproducible deploys); re-running the script refreshes it.

## 1. Copy the script

Copy [`pull-guardian.mjs`](./pull-guardian.mjs) to `scripts/pull-guardian.mjs`.

## 2. Wire package.json

```jsonc
"scripts": {
  "postinstall": "node scripts/pull-guardian.mjs",
  "predeploy": "node scripts/pull-guardian.mjs"
}
```

Pin a release instead of `main` when you want stability:

```bash
GUARDIAN_CLIENT_REF=v1.0.0 node scripts/pull-guardian.mjs
```

If the fetch fails but a vendored copy is already committed on disk, the script warns and keeps the existing copy (exit 0) instead of failing the install/deploy — a GitHub-raw outage should never block a deploy that already has a valid committed client.

## 3. Add the config stub to wrangler.jsonc

```jsonc
"vars": {
  "GUARDIAN": {
    "project":  "REPLACE-me-worker-name",
    "repo":     "you/REPLACE-me",
    "priority": "normal",
    "budget":   25,
    "baseUrl":  "https://core-guardian.hacolby.workers.dev"
  }
}
// secrets: wrangler secret put GUARDIAN_AI_TOKEN ; wrangler secret put GUARDIAN_API_KEY
```

## 4. Use it

```ts
import { GuardianClient } from "./lib/guardian/guardian-client";
const g = GuardianClient.fromEnv(env);
```

The vendored path (`src/lib/guardian/guardian-client.ts`) is written by the script — commit it.
