/**
 * @fileoverview Streaming forward: pass the provider SSE straight to the caller
 * while tee-ing the bytes to accumulate final usage. Used when the request sets
 * stream:true. Breakers are evaluated BEFORE this opens (see ingress).
 */
import { getSecret, getSecretStoreBinding } from "@/backend/utils/secrets";
import { resolveMode } from "./router";
import { aigSlug, resolveKey } from "./providers";
import type { RouterRequest, Usage } from "./types";

export interface StreamResult {
  status: number; stream: ReadableStream; usagePromise: Promise<Usage>; gateway: string | null;
}

export async function forwardStream(env: Env, req: RouterRequest, _now: number): Promise<StreamResult> {
  const mode = resolveMode(req);
  const account = (await getSecretStoreBinding(env, "CLOUDFLARE_ACCOUNT_ID")) ?? getSecret(env, "CLOUDFLARE_ACCOUNT_ID") ?? "";
  const gwToken = (await getSecretStoreBinding(env, "CLOUDFLARE_AI_GATEWAY_TOKEN")) ?? "";
  const providerKey = await resolveKey(env, req.provider, req.providerApiKey);
  const gateway = mode.startsWith("gateway") ? (mode === "gateway-custom" ? req.aiGatewayId ?? null : "ai-bridge") : null;

  // Ask providers to include usage in the stream where supported.
  const input = req.provider === "openai"
    ? { ...(req.input as object), stream: true, stream_options: { include_usage: true } }
    : { ...(req.input as object), stream: true };

  // Build URL/headers same as forward() (share via a helper in a refactor; inline for v1).
  let url: string; const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (gateway) {
    url = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/${aigSlug(req.provider)}/chat/completions`;
    headers["cf-aig-authorization"] = `Bearer ${gwToken}`; headers["Authorization"] = `Bearer ${providerKey}`;
  } else {
    url = "https://api.openai.com/v1/chat/completions"; headers["Authorization"] = `Bearer ${providerKey}`;
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(input) });
  const [toCaller, toMeter] = res.body!.tee();

  const usagePromise = (async (): Promise<Usage> => {
    const reader = toMeter.getReader();
    const decoder = new TextDecoder();
    let usage: Usage = { tokensIn: 0, tokensOut: 0 };
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const line of buf.split("\n")) {
        const m = line.trim().replace(/^data:\s*/, "");
        if (!m || m === "[DONE]") continue;
        try {
          const j = JSON.parse(m);
          if (j.usage) usage = { tokensIn: j.usage.prompt_tokens ?? usage.tokensIn, tokensOut: j.usage.completion_tokens ?? usage.tokensOut };
        } catch { /* partial chunk; keep buffering */ }
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    }
    return usage;
  })();

  return { status: res.status, stream: toCaller, usagePromise, gateway };
}
