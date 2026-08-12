/** @fileoverview AI Router provider registry: key resolution + usage extraction. */
import type { Usage } from "./types";

export const PROVIDER_KEY_BINDING: Record<string, keyof Env> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
};

/** Caller-supplied key wins, else the secret-store binding for the provider. */
export function resolveKey(env: Env, provider: string, override?: string): string {
  if (override) return override;
  const binding = PROVIDER_KEY_BINDING[provider];
  const key = binding ? (env[binding] as unknown as string | undefined) : undefined;
  if (!key) throw new Error(`No API key for provider "${provider}" (no override, no ${String(binding)} binding).`);
  return key;
}

/** Read {tokensIn, tokensOut} from a provider's JSON response. Mirrors ai-proxy.ts. */
export function extractUsage(provider: string, json: any): Usage {
  switch (provider) {
    case "openai":
    case "workers-ai":
      return { tokensIn: json?.usage?.prompt_tokens ?? 0, tokensOut: json?.usage?.completion_tokens ?? 0 };
    case "anthropic":
      return { tokensIn: json?.usage?.input_tokens ?? 0, tokensOut: json?.usage?.output_tokens ?? 0 };
    case "google":
      return {
        tokensIn: json?.usageMetadata?.promptTokenCount ?? 0,
        tokensOut: json?.usageMetadata?.candidatesTokenCount ?? 0,
      };
    default:
      return { tokensIn: json?.usage?.prompt_tokens ?? 0, tokensOut: json?.usage?.completion_tokens ?? 0 };
  }
}

export const aigSlug = (provider: string): string =>
  provider === "google" ? "google-ai-studio" : provider;
export const nativeBaseUrl = (provider: string): string => ({
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
}[provider] ?? "");

if (import.meta.main) {
  const eq = (a: unknown, b: unknown, m: string) => { if (a !== b) throw new Error(`${m}: ${a} != ${b}`); };
  eq(extractUsage("openai", { usage: { prompt_tokens: 5, completion_tokens: 7 } }).tokensOut, 7, "openai usage");
  eq(extractUsage("anthropic", { usage: { input_tokens: 3, output_tokens: 9 } }).tokensIn, 3, "anthropic usage");
  eq(extractUsage("google", { usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 4 } }).tokensOut, 4, "google usage");
  eq(resolveKey({} as Env, "openai", "sk-override"), "sk-override", "override wins");
  // eslint-disable-next-line no-console
  console.log("ok — providers verified");
}
