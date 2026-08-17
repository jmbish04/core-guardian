# Guardian clients

Vendorable clients for [core-guardian](https://github.com/jmbish04/core-guardian). One standalone file per language — copy the one you need into your project.

Current version: see [`VERSION`](./VERSION).

## Configure (all languages)

Declare identity once in your `wrangler.jsonc` `vars`, and set two secrets:

```jsonc
"vars": {
  "GUARDIAN": {
    "project":  "my-worker",
    "repo":     "you/my-worker",
    "priority": "normal",
    "budget":   25,
    "baseUrl":  "https://core-guardian.hacolby.workers.dev"
  }
}
```

```bash
wrangler secret put GUARDIAN_AI_TOKEN   # core-guardian CLOUDFLARE_AI_GATEWAY_TOKEN (for /run)
wrangler secret put GUARDIAN_API_KEY    # core-guardian WORKER_API_KEY (metering/budget/project)
```

All consumers share the same core-guardian AI-gateway token; the `project` string is self-declared, so project-scoped circuit breakers are advisory, not a security boundary. Rotate the token to revoke fleet-wide.

## TypeScript / Workers

```bash
curl -fsSL --create-dirs -o src/lib/guardian/guardian-client.ts \
  https://raw.githubusercontent.com/jmbish04/core-guardian/main/clients/ts/guardian-client.ts
```

The `main` pull tracks latest; pin `GUARDIAN_CLIENT_REF=<git tag>` (or a tagged raw URL) when you need a frozen version.

```ts
import { GuardianClient } from "./lib/guardian/guardian-client";
const g = GuardianClient.fromEnv(env);
const r = await g.ai.run({ provider: "openai", model: "gpt-4o-mini", input: { messages: [{ role: "user", content: "hi" }] } });
```

For a template that re-pulls automatically on install/deploy, see [`template/`](./template).

## Python

Zero external dependencies (stdlib `urllib`). Config comes from environment variables — the `GUARDIAN` var holds the same JSON object, and the two tokens are their own env vars.

```bash
curl -fsSL --create-dirs -o guardian_client.py \
  https://raw.githubusercontent.com/jmbish04/core-guardian/main/clients/python/guardian_client.py
```

```python
import os
from guardian_client import GuardianClient

g = GuardianClient.from_env(os.environ)  # reads GUARDIAN (JSON), GUARDIAN_AI_TOKEN, GUARDIAN_API_KEY
r = g.ai.run(provider="openai", model="gpt-4o-mini",
             input={"messages": [{"role": "user", "content": "hi"}]})
g.usage.register(provider="openai", model="gpt-4o-mini", tokens_in=12, tokens_out=8)
```

Surface parity note: the project-record fetch is `g.project_status()` (Python can't have both a `project` attribute and a `project()` method); everything else matches the TS names. Self-check: `python3 clients/python/test_guardian_client.py`.

## Google Apps Script

V8 runtime, uses `UrlFetchApp`. Config comes from Script Properties: `GUARDIAN` (JSON string), `GUARDIAN_AI_TOKEN`, `GUARDIAN_API_KEY`. Copy `gas/GuardianClient.gs` into your Apps Script project (or `clasp push` it).

```js
const g = GuardianClient.fromScriptProperties();
const r = g.ai.run({ provider: "openai", model: "gpt-4o-mini",
                     input: { messages: [{ role: "user", content: "hi" }] } });
```

Streaming is not supported (`UrlFetchApp` is buffered) — `ai.stream` throws. The project-record fetch is `g.projectStatus()`. Run `guardianClientSelfTest_()` from the Apps Script editor to verify (no network needed).
