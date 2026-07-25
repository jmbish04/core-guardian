/**
 * @fileoverview CostTraceIsland — Guardian's billables/relationship mind map,
 * one island that adapts to the page via `scope`:
 *
 *   account     Account → Category → binding ($ + surge)        [guardian]
 *   ai-gateway  AI Gateway → provider → model ($)               [ai-gateway]
 *   worker      Worker → Compute + AI → model ($)               [codra / any worker]
 *   attribution Workers → the resources each binds              [storage / overview]
 *   binding     One resource → the workers that bind it         [binding detail]
 *
 * Every scope builds the same recursive CostNode tree and renders it through the
 * global CostTraceMap (Mind Elixir). Builders are pure (see cost-trace-builders)
 * so the tree logic is unit-checkable without the DOM.
 */
"use client";

import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { CostTraceMap } from "@/components/charts/CostTraceMap";
import type { CostNode } from "@/components/charts/cost-trace";
import { ApiError, apiGet } from "@/lib/api";

import {
  buildAccountTree,
  buildAttributionTree,
  buildBindingTree,
  buildGatewayTree,
  buildWorkerTree,
  type AllowancePayload,
  type AttributionPayload,
  type GatewayCostPayload,
  type WorkerSpendPayload,
} from "./cost-trace-builders";

const MS_30D = 30 * 24 * 60 * 60 * 1000;

export type CostTraceScope = "account" | "ai-gateway" | "worker" | "attribution" | "binding";

export type CostTraceIslandProps = {
  scope?: CostTraceScope;
  /** Required for scope="worker" — the worker/gateway name (e.g. "codra"). */
  worker?: string;
  /** Required for scope="binding" — the resource type + id from the route. */
  bindingType?: string;
  bindingId?: string;
  /** Override heading. */
  title?: string;
};

const HEADING: Record<CostTraceScope, { title: string; caption: string }> = {
  account: { title: "Cost trace", caption: "account → category → binding · red = projected surge" },
  "ai-gateway": { title: "Gateway spend trace", caption: "gateway → provider → model · last 30d" },
  worker: { title: "Worker spend trace", caption: "worker → compute + AI → model · last 30d" },
  attribution: { title: "Attribution map", caption: "worker → the resources it binds" },
  binding: { title: "Binding trace", caption: "resource → the workers that bind it" },
};

/** Fetch + build the tree for the given scope. Returns null when nothing to show. */
async function loadTree(props: CostTraceIslandProps, now: number): Promise<CostNode | null> {
  switch (props.scope ?? "account") {
    case "account": {
      const d = await apiGet<AllowancePayload>("/guardian/allowances");
      return buildAccountTree(d.plan, d.allowances);
    }
    case "ai-gateway": {
      const d = await apiGet<GatewayCostPayload>(`/ai-gateway-admin/costs?start=${now - MS_30D}&end=${now}`);
      return buildGatewayTree(d.costs);
    }
    case "worker": {
      if (!props.worker) throw new Error("scope=worker needs a worker name");
      const d = await apiGet<WorkerSpendPayload>(`/guardian/worker/${encodeURIComponent(props.worker)}/spend?hours=720`);
      return buildWorkerTree(d);
    }
    case "attribution": {
      const d = await apiGet<AttributionPayload>("/guardian/attribution");
      return buildAttributionTree(d.workers);
    }
    case "binding": {
      if (!props.bindingType || !props.bindingId) throw new Error("scope=binding needs type + id");
      const d = await apiGet<AttributionPayload>("/guardian/attribution");
      return buildBindingTree(props.bindingType, props.bindingId, d.workers);
    }
  }
}

export function CostTraceIsland(props: CostTraceIslandProps) {
  const scope = props.scope ?? "account";
  const [tree, setTree] = useState<CostNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTree(await loadTree(props, Date.now()));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view the trace."
          : err instanceof ApiError
            ? err.message
            : "Failed to load the trace.",
      );
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, props.worker, props.bindingType, props.bindingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const head = HEADING[scope];
  const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6 text-sm text-muted-foreground";
  if (loading && !tree)
    return (
      <div className={`${PANEL} flex items-center gap-2`}>
        <Loader2Icon className="size-4 animate-spin" /> Building {head.title.toLowerCase()}…
      </div>
    );
  if (!tree) return error ? <p className={PANEL}>{error}</p> : null;
  if (!tree.children?.length)
    return <p className={PANEL}>Nothing to trace here yet.</p>;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">{props.title ?? head.title}</h2>
        <span className="font-mono text-xs text-muted-foreground">{head.caption}</span>
      </div>
      <CostTraceMap root={tree} />
    </section>
  );
}
