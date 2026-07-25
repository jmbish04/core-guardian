/**
 * @fileoverview CostTraceMap — a reusable mind-map view of the billables trace:
 * account → category → worker/binding → resource, each node carrying its USD
 * cost and a surge flag. Built on the global `mindmap` (Mind Elixir) UI piece so
 * any Guardian page can drop in `<CostTraceMap root={tree} />` to see the whole
 * cost relationship graph — what's billable, which worker/binding it hangs off,
 * and where a surge is coming from.
 *
 * The pure transform lives in ./cost-trace (unit-checkable, no DOM/CSS); this
 * file only wires it to the map.
 */
"use client";

import { MindMap, MindMapControls } from "@/components/ui/mindmap";

import { buildCostTraceData, type CostNode } from "./cost-trace";

export type CostTraceMapProps = {
  root: CostNode;
  /** Container classes. Mind Elixir fills 100% of the parent, so set a height. */
  className?: string;
};

/**
 * Render the cost trace as a read-only mind map with zoom/fit/export controls.
 * Parent must give it a height (the map fills its container).
 */
export function CostTraceMap({ root, className }: CostTraceMapProps) {
  const data = buildCostTraceData(root);
  return (
    <div className={className ?? "relative h-[520px] w-full overflow-hidden rounded-lg border border-border"}>
      <MindMap data={data} readonly direction={1}>
        <MindMapControls />
      </MindMap>
    </div>
  );
}

export { buildCostTraceData, type CostNode };
