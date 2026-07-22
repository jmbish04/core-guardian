/**
 * @fileoverview Type-ahead picker over a live account resource list.
 *
 * Emergency controls used to take free-text bucket / index names, so a typo
 * could be submitted straight into a destructive call. This replaces that with
 * a combobox whose options come from the account itself (`GET /api/storage/*`):
 * you can only act on a resource that actually exists, and each option carries
 * a hint (size, object count) so you pick the right one.
 *
 * Filtering is handled by the base-ui combobox against the `items` array; this
 * component owns only the fetch, the option shape, and the hint lookup.
 */

"use client";

import { useEffect, useState } from "react";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { ApiError, apiGet } from "@/lib/api";

export type PickerOption = { value: string; hint?: string };

export function ResourcePicker<T>({
  endpoint,
  extract,
  value,
  onValueChange,
  placeholder,
  disabled,
  emptyLabel = "No match.",
}: {
  /** API path under `/api`, e.g. `/storage/r2`. */
  endpoint: string;
  /** Map the raw response to the pickable options. */
  extract: (response: T) => PickerOption[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  emptyLabel?: string;
}) {
  const [options, setOptions] = useState<PickerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<T>(endpoint)
      .then((r) => {
        if (!cancelled) setOptions(extract(r));
      })
      .catch((e) => {
        if (!cancelled) {
          setError(
            e instanceof ApiError && e.status === 401
              ? "Sign in to list resources."
              : "Could not load the list.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // extract is defined inline by callers; endpoint is the real identity here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  const hints = new Map(options.map((o) => [o.value, o.hint]));
  const names = options.map((o) => o.value);

  return (
    <Combobox
      items={names}
      value={value}
      onValueChange={(v) => onValueChange((v as string) ?? "")}
    >
      <ComboboxInput
        placeholder={loading ? "Loading…" : (placeholder ?? "Search…")}
        disabled={disabled || loading}
        showClear
        className="font-mono"
      />
      <ComboboxContent>
        <ComboboxEmpty className="px-3 py-2 text-sm text-muted-foreground">
          {error ?? emptyLabel}
        </ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              <span className="min-w-0 flex-1 truncate font-mono">{item}</span>
              {hints.get(item) && (
                <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                  {hints.get(item)}
                </span>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
