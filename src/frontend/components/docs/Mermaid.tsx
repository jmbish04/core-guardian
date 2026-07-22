/**
 * @fileoverview Client-side Mermaid diagram renderer.
 *
 * Mermaid is ~500KB, so this island is mounted with `client:visible` and the
 * library is dynamically imported inside the effect — the bytes are only
 * fetched once a diagram scrolls into view, and never on pages that have none.
 *
 * Rendering is deliberately imperative (`mermaid.render` into `innerHTML`)
 * rather than declarative: Mermaid mutates the DOM it is given, so letting
 * React own those children would fight the reconciler.
 */

"use client";

import { useEffect, useId, useRef, useState } from "react";

export function Mermaid({ chart, caption }: { chart: string; caption?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Mermaid ids must be unique per render and valid CSS selectors.
  const domId = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          securityLevel: "strict",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          // Tuned against this app's dark OKLCH palette rather than Mermaid's
          // stock dark theme, which washes out on our near-black background.
          themeVariables: {
            background: "transparent",
            primaryColor: "#161616",
            primaryTextColor: "#ededed",
            primaryBorderColor: "#3a3a3a",
            lineColor: "#7c7c7c",
            secondaryColor: "#1e1e1e",
            tertiaryColor: "#121212",
            mainBkg: "#161616",
            nodeBorder: "#3a3a3a",
            clusterBkg: "#0e0e0e",
            clusterBorder: "#2a2a2a",
            titleColor: "#ededed",
            edgeLabelBackground: "#0a0a0a",
            textColor: "#c9c9c9",
          },
        });

        const { svg } = await mermaid.render(domId, chart);
        if (!cancelled && hostRef.current) hostRef.current.innerHTML = svg;
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Diagram failed to render.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chart, domId]);

  return (
    <figure className="my-6 flex flex-col gap-3">
      <div className="overflow-x-auto rounded-xl border border-border/60 bg-background/40 p-6">
        {error ? (
          <p className="font-mono text-xs text-destructive">Diagram error: {error}</p>
        ) : (
          <div ref={hostRef} className="[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full" />
        )}
      </div>
      {caption && (
        <figcaption className="text-center text-xs text-muted-foreground">{caption}</figcaption>
      )}
    </figure>
  );
}
