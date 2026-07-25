/**
 * @fileoverview Pure cost-trace transform — CostNode tree → MindElixirData.
 * Kept free of the component/CSS import chain so it is unit-checkable on its own
 * (`npx tsx cost-trace.ts`). Consumed by CostTraceMap.tsx.
 */

import type { MindElixirData } from "mind-elixir";

/** One node in the cost trace. Children nest the relationship (worker→binding). */
export type CostNode = {
  /** Human name — worker/binding/resource/category. Never a raw id. */
  label: string;
  /** USD cost attributed to this node (self or rolled-up). Omit if unknown. */
  costUsd?: number;
  /** True when this node is over allowance / anomalous — rendered hot. */
  surge?: boolean;
  /** Short qualifier shown after the label, e.g. "142% projected" or a unit. */
  detail?: string;
  children?: CostNode[];
};

export function usd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Topic line for a node: "label · $X.XX — detail". */
export function topicFor(n: CostNode): string {
  const cost = typeof n.costUsd === "number" ? ` · ${usd(n.costUsd)}` : "";
  const detail = n.detail ? ` — ${n.detail}` : "";
  return `${n.label}${cost}${detail}`;
}

// Mind Elixir node style. Surge = hot amber/red on dark.
const SURGE_STYLE = { background: "#7f1d1d", color: "#fecaca" } as const;

export type MindNode = {
  id: string;
  topic: string;
  style?: Record<string, string>;
  children?: MindNode[];
};

/**
 * Transform a CostNode tree into MindElixirData. Ids are path-derived (stable,
 * no randomness) so re-renders don't churn the map. Surge nodes get the hot
 * style; every node with a cost shows it in the topic.
 */
export function buildCostTraceData(root: CostNode): MindElixirData {
  const toMind = (n: CostNode, id: string): MindNode => ({
    id,
    topic: topicFor(n),
    ...(n.surge ? { style: { ...SURGE_STYLE } } : {}),
    ...(n.children?.length
      ? { children: n.children.map((c, i) => toMind(c, `${id}-${i}`)) }
      : {}),
  });
  return { nodeData: toMind(root, "root") } as MindElixirData;
}

// ---------------------------------------------------------------------------
// Self-check — `npx tsx cost-trace.ts`. Verifies topic formatting, surge
// styling, and stable path-derived ids.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const tree: CostNode = {
    label: "Account",
    costUsd: 32.5,
    children: [
      { label: "Workers AI", costUsd: 32, surge: true, detail: "142% projected" },
      { label: "D1", costUsd: 0.5 },
    ],
  };
  const root = (buildCostTraceData(tree) as unknown as { nodeData: MindNode }).nodeData;
  if (root.id !== "root") throw new Error("root id");
  if (!root.topic.includes("$32.50")) throw new Error(`root cost fmt: ${root.topic}`);
  const [ai, d1] = root.children!;
  if (ai.id !== "root-0" || d1.id !== "root-1") throw new Error("stable child ids");
  if (!ai.style) throw new Error("surge node must be styled");
  if (d1.style) throw new Error("non-surge node must not be styled");
  if (!ai.topic.includes("142% projected")) throw new Error("detail in topic");
  if (!topicFor({ label: "x", costUsd: 0.002 }).includes("$0.0020")) throw new Error("sub-cent fmt");
  console.log("cost-trace self-check ok");
}
