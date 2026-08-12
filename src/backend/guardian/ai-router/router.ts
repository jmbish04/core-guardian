/**
 * @fileoverview AI Router mode dispatch. Builds the target URL + headers per
 * mode and forwards the caller's body, reading usage from the response.
 * Google/Gemini is always forced to gemini-native (AIG can't proxy the
 * interactions API). Streaming lives in router-stream.ts (Task 9).
 */
import { getSecret, getSecretStoreBinding } from "@/backend/utils/secrets";
import { aigSlug, extractUsage, nativeBaseUrl, resolveKey } from "./providers";
import type { Mode, RouterRequest, Usage } from "./types";

const AIG_BASE = (account: string, gateway: string) =>
  `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}`;

/** Google always → gemini-native; otherwise honor the requested mode. */
export function resolveMode(req: RouterRequest): Mode {
  if (req.provider === "google" || req.provider === "gemini") return "gemini-native";
  return req.mode;
}

export interface ForwardResult { status: number; body: unknown; usage: Usage; gateway: string | null }

export async function forward(env: Env, req: RouterRequest, _now: number): Promise<ForwardResult> {
  const mode = resolveMode(req);
  // Secret Store bindings are async .get() — read via helpers, never string casts.
  const account = (await getSecretStoreBinding(env, "CLOUDFLARE_ACCOUNT_ID")) ?? getSecret(env, "CLOUDFLARE_ACCOUNT_ID") ?? "";
  const gwToken = (await getSecretStoreBinding(env, "CLOUDFLARE_AI_GATEWAY_TOKEN")) ?? "";
  const cfApiToken = (await getSecretStoreBinding(env, "CLOUDFLARE_API_TOKEN")) ?? gwToken; // compat mode
  const providerKey = await resolveKey(env, req.provider, req.providerApiKey);

  // Resolve URL + headers + which gateway (if any) per mode.
  let url: string; const headers: Record<string, string> = { "Content-Type": "application/json" };
  let gateway: string | null = null;

  if (mode === "gateway" || mode === "gateway-custom" || mode === "provider-sdk-gateway") {
    gateway = mode === "gateway-custom" ? (req.aiGatewayId ?? env.AI_GATEWAY_ID as unknown as string) : "ai-bridge";
    const slug = aigSlug(req.provider);
    // Provider-specific passthrough path on the gateway.
    url = `${AIG_BASE(account, gateway)}/${slug}/${req.provider === "openai" ? "chat/completions" : ""}`.replace(/\/$/, "");
    headers["cf-aig-authorization"] = `Bearer ${gwToken}`;
    headers["Authorization"] = `Bearer ${providerKey}`;
  } else if (mode === "openai-compat") {
    url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`;
    headers["Authorization"] = `Bearer ${cfApiToken}`; // CLOUDFLARE_API_TOKEN, falls back to gwToken
  } else if (mode === "native") {
    url = `${nativeBaseUrl(req.provider)}/${req.provider === "anthropic" ? "messages" : "chat/completions"}`;
    if (req.provider === "anthropic") {
      headers["x-api-key"] = providerKey; headers["anthropic-version"] = "2023-06-01";
    } else headers["Authorization"] = `Bearer ${providerKey}`;
  } else {
    // gemini-native
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;
    headers["x-goog-api-key"] = providerKey;
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(req.input) });
  const body = await res.json().catch(() => ({}));
  const usage = extractUsage(req.provider, body);
  return { status: res.status, body, usage, gateway };
}

if (import.meta.main) {
  const base = { project: "p", importance: "low", provider: "openai", model: "m", input: {}, extra: {} } as RouterRequest;
  const eq = (a: unknown, b: unknown, m: string) => { if (a !== b) throw new Error(`${m}: ${a} != ${b}`); };
  eq(resolveMode({ ...base, mode: "gateway" }), "gateway", "default gateway");
  eq(resolveMode({ ...base, provider: "google", mode: "gateway" }), "gemini-native", "gemini forced");
  // eslint-disable-next-line no-console
  console.log("ok — resolveMode verified");
}
