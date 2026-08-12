/**
 * @fileoverview Split an AI call's cost into input vs output USD, pricing from
 * the MAINTAINED model catalog so current-generation models are priced — not a
 * stale hardcoded map. $0 = model genuinely unpriced in the catalog.
 * getModelCatalog is KV-cached (one read on the hot path).
 */
import { getModelCatalog, matchCatalogModel } from "@/backend/guardian/model-catalog";
import type { Usage } from "./types";

export async function priceSplit(
  env: Env, model: string, usage: Usage,
): Promise<{ tokensInCost: number; tokensOutCost: number; costUsd: number }> {
  const catalog = await getModelCatalog(env);
  const match = matchCatalogModel(catalog, model);
  if (!match || match.inPerM === null || match.outPerM === null) {
    return { tokensInCost: 0, tokensOutCost: 0, costUsd: 0 };
  }
  const tokensInCost = (usage.tokensIn / 1_000_000) * match.inPerM;
  const tokensOutCost = (usage.tokensOut / 1_000_000) * match.outPerM;
  return { tokensInCost, tokensOutCost, costUsd: tokensInCost + tokensOutCost };
}
