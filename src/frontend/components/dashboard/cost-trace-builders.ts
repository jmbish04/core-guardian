/**
 * @fileoverview Pure CostNode-tree builders for CostTraceIsland — one per scope.
 * No DOM, no fetch, no clock: fed the API payloads, they return a CostNode tree.
 * Self-checked at the bottom (`npx tsx cost-trace-builders.ts`).
 */

import type { CostNode } from "@/components/charts/cost-trace";

// ---- payload shapes (mirror the API responses) ----------------------------

export type Allowance = {
  service: string;
  projectedFraction: number | null;
  overageCostUsd: number | null;
  unit: string;
  comparable: boolean;
};
export type AllowancePayload = { plan: "free" | "paid"; allowances: Allowance[] };

export type GatewayCost = {
  provider: string;
  model: string;
  gateway: string;
  requests: number;
  costUsd: number;
};
export type GatewayCostPayload = { costs: GatewayCost[] };

export type WorkerSpendPayload = {
  worker: string;
  cloudflare: { requests: number; errors: number; subrequests: number };
  ai: {
    routed: boolean;
    upstreamCostUsd: number;
    requests: number;
    byModel: { provider: string; model: string; costUsd: number }[];
  };
};

export type AttributedResource = { key: string; type: string; id: string; name: string; binding: string };
export type AttributionPayload = { workers: { worker: string; resources: AttributedResource[] }[] };

// ---- helpers ---------------------------------------------------------------

const CATEGORY: Record<string, string> = {
  workers: "Compute",
  containers: "Compute",
  workflows: "Compute",
  d1: "Storage",
  kv: "Storage",
  "r2-storage": "Storage",
  queues: "Messaging",
  vectorize: "AI",
  "workers-ai": "AI",
};

const sumCost = (ns: CostNode[]) => ns.reduce((s, c) => s + (c.costUsd ?? 0), 0);
const byCostDesc = (a: CostNode, b: CostNode) => (b.costUsd ?? 0) - (a.costUsd ?? 0);

// ---- builders --------------------------------------------------------------

/** account: Account → Category → binding ($ + surge). Keeps only billable/surging. */
export function buildAccountTree(plan: string, rows: Allowance[]): CostNode {
  const byCat = new Map<string, CostNode[]>();
  for (const a of rows) {
    const cost = a.overageCostUsd ?? 0;
    const surge = (a.projectedFraction ?? 0) > 1;
    if (cost === 0 && !surge) continue;
    const cat = CATEGORY[a.service] ?? "Other";
    const detail = a.projectedFraction !== null ? `${Math.round(a.projectedFraction * 100)}% projected` : a.unit;
    (byCat.get(cat) ?? byCat.set(cat, []).get(cat)!).push({
      label: a.service,
      costUsd: cost > 0 ? cost : undefined,
      surge,
      detail,
    });
  }
  const categories = [...byCat.entries()]
    .map(([label, children]) => ({
      label,
      costUsd: sumCost(children) > 0 ? sumCost(children) : undefined,
      surge: children.some((c) => c.surge),
      children: children.sort(byCostDesc),
    }))
    .sort(byCostDesc);
  const total = sumCost(categories);
  return {
    label: "Account billables",
    costUsd: total > 0 ? total : undefined,
    detail: `${plan} plan`,
    children: categories,
  };
}

/** ai-gateway: AI Gateway → provider → model ($). */
export function buildGatewayTree(costs: GatewayCost[]): CostNode {
  const gw = new Map<string, Map<string, CostNode[]>>();
  for (const c of costs) {
    const providers = gw.get(c.gateway) ?? gw.set(c.gateway, new Map()).get(c.gateway)!;
    (providers.get(c.provider) ?? providers.set(c.provider, []).get(c.provider)!).push({
      label: c.model,
      costUsd: c.costUsd,
      detail: `${c.requests.toLocaleString()} req`,
    });
  }
  const gateways = [...gw.entries()]
    .map(([gname, providers]) => {
      const provNodes = [...providers.entries()]
        .map(([pname, models]) => ({
          label: pname,
          costUsd: sumCost(models),
          children: models.sort(byCostDesc),
        }))
        .sort(byCostDesc);
      return { label: gname, costUsd: sumCost(provNodes), children: provNodes };
    })
    .sort(byCostDesc);
  return { label: "AI Gateway spend", costUsd: sumCost(gateways), detail: "last 30d", children: gateways };
}

/** worker: Worker → {Compute counts, AI $ → model}. */
export function buildWorkerTree(s: WorkerSpendPayload): CostNode {
  const compute: CostNode = {
    label: "Compute",
    detail: `${s.cloudflare.requests.toLocaleString()} req · ${s.cloudflare.subrequests.toLocaleString()} subreq · ${s.cloudflare.errors.toLocaleString()} err`,
  };
  const ai: CostNode = {
    label: "AI",
    costUsd: s.ai.upstreamCostUsd > 0 ? s.ai.upstreamCostUsd : undefined,
    surge: !s.ai.routed && s.ai.requests > 0,
    detail: s.ai.routed ? `${s.ai.requests.toLocaleString()} req` : "not routed through a gateway — cost invisible",
    children: s.ai.byModel
      .map((m) => ({ label: `${m.provider}/${m.model}`, costUsd: m.costUsd }))
      .sort(byCostDesc),
  };
  return {
    label: s.worker,
    costUsd: s.ai.upstreamCostUsd > 0 ? s.ai.upstreamCostUsd : undefined,
    detail: "worker spend",
    children: [ai, compute],
  };
}

/** attribution: Workers → the resources each binds (relationship map, no $). */
export function buildAttributionTree(workers: AttributionPayload["workers"]): CostNode {
  const nodes = workers
    .map((w) => ({
      label: w.worker,
      detail: `${w.resources.length} binding${w.resources.length === 1 ? "" : "s"}`,
      children: w.resources.map((r) => ({ label: r.name, detail: `${r.type} · ${r.binding}` })),
    }))
    .sort((a, b) => (b.children?.length ?? 0) - (a.children?.length ?? 0));
  return { label: "Workers → bindings", detail: `${workers.length} workers`, children: nodes };
}

/** binding: one resource → the workers that bind it (reverse attribution). */
export function buildBindingTree(type: string, id: string, workers: AttributionPayload["workers"]): CostNode {
  let name = id;
  const owners: CostNode[] = [];
  for (const w of workers) {
    for (const r of w.resources) {
      if (r.type === type && r.id === id) {
        name = r.name || id;
        owners.push({ label: w.worker, detail: `binds as "${r.binding}"` });
      }
    }
  }
  return {
    label: name,
    detail: owners.length ? `${type} · ${owners.length} worker${owners.length === 1 ? "" : "s"}` : `${type} · unbound`,
    children: owners,
  };
}

// ---------------------------------------------------------------------------
// Self-check — `npx tsx cost-trace-builders.ts`.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  // account: surge kept, non-billable dropped, category rollup
  const acct = buildAccountTree("paid", [
    { service: "workers-ai", projectedFraction: 1.42, overageCostUsd: 32, unit: "neurons", comparable: true },
    { service: "d1", projectedFraction: 0.5, overageCostUsd: 0, unit: "rows", comparable: true },
    { service: "kv", projectedFraction: 1.1, overageCostUsd: 0.4, unit: "reads", comparable: true },
  ]);
  if (acct.children!.length !== 2) throw new Error("d1 (no cost, no surge) must drop → 2 categories");
  if (Math.abs((acct.costUsd ?? 0) - 32.4) > 1e-9) throw new Error(`acct total ${acct.costUsd}`);
  const ai = acct.children!.find((c) => c.label === "AI")!;
  if (!ai.surge) throw new Error("AI category inherits surge");

  // gateway: provider rollup + sort
  const gwt = buildGatewayTree([
    { gateway: "default-gateway", provider: "workers-ai", model: "gpt-oss-120b", requests: 6000, costUsd: 30 },
    { gateway: "default-gateway", provider: "workers-ai", model: "kimi", requests: 10, costUsd: 2 },
  ]);
  if ((gwt.costUsd ?? 0) !== 32) throw new Error("gateway total 32");
  const prov = gwt.children![0].children![0];
  if (prov.children![0].label !== "gpt-oss-120b") throw new Error("models sorted by cost desc");

  // worker: unrouted AI flagged as surge, compute has no cost
  const wt = buildWorkerTree({
    worker: "codra",
    cloudflare: { requests: 100, errors: 1, subrequests: 20 },
    ai: { routed: false, upstreamCostUsd: 0, requests: 50, byModel: [] },
  });
  const wai = wt.children!.find((c) => c.label === "AI")!;
  if (!wai.surge) throw new Error("unrouted AI with traffic must surge");
  if (wt.children!.find((c) => c.label === "Compute")!.costUsd !== undefined) throw new Error("compute no $");

  // attribution + binding reverse lookup
  const workers = [
    { worker: "core-guardian", resources: [{ key: "k1", type: "d1", id: "db1", name: "guardian-db", binding: "DB" }] },
    { worker: "core-codra", resources: [{ key: "k1", type: "d1", id: "db1", name: "guardian-db", binding: "DATA" }] },
  ];
  const at = buildAttributionTree(workers);
  if (at.children!.length !== 2) throw new Error("2 workers");
  const bt = buildBindingTree("d1", "db1", workers);
  if (bt.label !== "guardian-db" || bt.children!.length !== 2) throw new Error("binding → 2 owner workers");

  console.log("cost-trace-builders self-check ok");
}
