/**
 * @fileoverview Pure builder for per-language integration instructions.
 * No I/O: given a base URL, lang, and pull mode it returns copy-paste strings
 * (pull command, `GUARDIAN` var stub, secret commands, usage snippet) with the
 * live base URL and current client version interpolated. Surfaced by
 * `routes/integration.ts` and the `guardian_integration_instructions` MCP tool.
 */

const REPO = "jmbish04/core-guardian";
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;

// ponytail: keep in sync with clients/VERSION — integration.test.ts asserts equality.
export const CLIENT_VERSION = "1.0.0";

export type IntegrationLang = "ts" | "python" | "gas";
export type IntegrationMode = "curl" | "submodule" | "degit";

export const SUPPORTED_LANGS: IntegrationLang[] = ["ts", "python", "gas"];
export const SUPPORTED_MODES: IntegrationMode[] = ["curl", "submodule", "degit"];

type LangMeta = { path: string; dest: string; usage: string };

const LANGS: Record<IntegrationLang, LangMeta> = {
  ts: {
    path: "clients/ts/guardian-client.ts",
    dest: "src/lib/guardian/guardian-client.ts",
    usage: [
      'import { GuardianClient } from "./lib/guardian/guardian-client";',
      "const g = GuardianClient.fromEnv(env);",
      'const r = await g.ai.run({ provider: "openai", model: "gpt-4o-mini", input: { messages: [{ role: "user", content: "hi" }] } });',
    ].join("\n"),
  },
  python: {
    path: "clients/python/guardian_client.py",
    dest: "guardian_client.py",
    usage: [
      "from guardian_client import GuardianClient",
      "g = GuardianClient.from_env(os.environ)",
      'r = g.ai.run(provider="openai", model="gpt-4o-mini", input={"messages": [{"role": "user", "content": "hi"}]})',
    ].join("\n"),
  },
  gas: {
    path: "clients/gas/GuardianClient.gs",
    dest: "GuardianClient.gs",
    usage: [
      "const g = GuardianClient.fromScriptProperties();",
      'const r = g.ai.run({ provider: "openai", model: "gpt-4o-mini", input: { messages: [{ role: "user", content: "hi" }] } });',
    ].join("\n"),
  },
};

const SECRETS = [
  "wrangler secret put GUARDIAN_AI_TOKEN",
  "wrangler secret put GUARDIAN_API_KEY",
];

/** Strips the trailing `/<file>` segment off a path, e.g. "clients/ts/guardian-client.ts" -> "clients/ts". */
function dirOf(path: string): string {
  return path.replace(/\/[^/]+$/, "");
}

function pullCommand(meta: LangMeta, mode: IntegrationMode): string {
  switch (mode) {
    case "curl":
      return `curl -fsSL --create-dirs -o ${meta.dest} ${RAW}/${meta.path}`;
    case "degit":
      return `npx degit --force ${REPO}/${dirOf(meta.path)} ${dirOf(meta.dest)}`;
    case "submodule":
      return `git submodule add https://github.com/${REPO}.git vendor/core-guardian\n# then reference vendor/core-guardian/${meta.path}`;
    default:
      throw new RangeError(`unknown mode: ${mode as string}`);
  }
}

export function buildInstructions(opts: {
  baseUrl: string;
  lang: IntegrationLang;
  mode: IntegrationMode;
}): {
  version: string;
  lang: IntegrationLang;
  mode: IntegrationMode;
  ref: string;
  pull: string;
  varsStub: string;
  secrets: string[];
  usage: string;
} {
  const meta = LANGS[opts.lang];
  if (!meta) throw new RangeError(`unknown lang: ${opts.lang as string}`);
  const varsStub = JSON.stringify(
    {
      GUARDIAN: {
        project: "my-worker",
        repo: "you/my-worker",
        priority: "normal",
        budget: 25,
        baseUrl: opts.baseUrl,
      },
    },
    null,
    2,
  );
  return {
    version: CLIENT_VERSION,
    lang: opts.lang,
    mode: opts.mode,
    ref: "main", // the pull ref the commands above actually use — RAW is pinned to main
    pull: pullCommand(meta, opts.mode), // throws RangeError on unknown mode — single source of truth
    varsStub,
    secrets: SECRETS,
    usage: meta.usage,
  };
}
