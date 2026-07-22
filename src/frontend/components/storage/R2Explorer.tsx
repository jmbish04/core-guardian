/**
 * @fileoverview R2 explorer — bucket inventory and per-bucket object browser.
 *
 * Buckets list largest-first with sortable/filterable headers, object counts,
 * bound Workers, and a link out to the native Cloudflare R2 interface. Clicking
 * a bucket opens its object listing (cursor-paginated), where objects can be
 * selected and deleted, or the whole bucket dropped behind a type-to-confirm
 * barrier.
 */

"use client";

import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  Loader2Icon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { humanSize, relativeTime } from "@/lib/format";

import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { BoundWorkers, ResourceTable, type Column } from "./ResourceTable";

type Bucket = {
  name: string;
  createdAt: string | null;
  location: string | null;
  storageClass: string | null;
  sizeBytes: number;
  objectCount: number;
  workers: { worker: string; binding: string }[];
};

type R2Object = {
  key: string;
  size: number;
  lastModified: string | null;
  storageClass: string | null;
};

/** Deep link into the native Cloudflare dashboard for a bucket. */
function cloudflareBucketUrl(accountHint: string | null, bucket: string): string {
  // The dash resolves `:account` to the signed-in account, so no id is needed.
  return accountHint
    ? `https://dash.cloudflare.com/${accountHint}/r2/default/buckets/${bucket}`
    : `https://dash.cloudflare.com/?to=/:account/r2/default/buckets/${bucket}`;
}

export function R2Explorer({ accountId = null }: { accountId?: string | null }) {
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openBucket, setOpenBucket] = useState<Bucket | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Bucket | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ buckets: Bucket[] }>("/storage/r2");
      setBuckets(data.buckets);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load buckets.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function deleteBucket(bucket: Bucket) {
    await apiSend("DELETE", `/storage/r2/${encodeURIComponent(bucket.name)}`, {
      confirm: bucket.name,
    });
    setOpenBucket(null);
    await load();
  }

  if (openBucket) {
    return (
      <BucketDetail
        bucket={openBucket}
        accountId={accountId}
        onBack={() => setOpenBucket(null)}
        onRequestDelete={() => setPendingDelete(openBucket)}
        pendingDelete={pendingDelete}
        setPendingDelete={setPendingDelete}
        onDeleted={deleteBucket}
      />
    );
  }

  const columns: Column<Bucket>[] = [
    {
      key: "name",
      header: "Bucket",
      sortValue: (b) => b.name,
      render: (b) => <span className="font-mono text-sm">{b.name}</span>,
    },
    {
      key: "size",
      header: "Size",
      align: "right",
      sortValue: (b) => b.sizeBytes,
      render: (b) => (
        <span className="font-mono text-sm tabular-nums">{humanSize(b.sizeBytes)}</span>
      ),
    },
    {
      key: "objects",
      header: "Objects",
      align: "right",
      sortValue: (b) => b.objectCount,
      render: (b) => (
        <span className="font-mono text-sm tabular-nums">{b.objectCount.toLocaleString()}</span>
      ),
    },
    {
      key: "location",
      header: "Location",
      sortValue: (b) => b.location ?? "",
      render: (b) => <span className="text-xs text-muted-foreground">{b.location ?? "—"}</span>,
    },
    {
      key: "workers",
      header: "Bound to",
      render: (b) => <BoundWorkers workers={b.workers} />,
    },
    {
      key: "created",
      header: "Created",
      sortValue: (b) => b.createdAt ?? "",
      render: (b) => (
        <span className="text-xs text-muted-foreground">
          {b.createdAt ? relativeTime(b.createdAt) : "—"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (b) => (
        <div className="flex items-center justify-end gap-1">
          <a
            href={cloudflareBucketUrl(accountId, b.name)}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Open ${b.name} in the Cloudflare dashboard`}
          >
            <ExternalLinkIcon className="size-4" />
          </a>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete ${b.name}`}
            onClick={(e) => {
              e.stopPropagation();
              setPendingDelete(b);
            }}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      ),
    },
  ];

  const totalBytes = buckets.reduce((sum, b) => sum + b.sizeBytes, 0);
  const totalObjects = buckets.reduce((sum, b) => sum + b.objectCount, 0);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">R2 buckets</h2>
          <p className="text-sm text-muted-foreground">
            {buckets.length} buckets · {humanSize(totalBytes)} · {totalObjects.toLocaleString()}{" "}
            objects
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          className="gap-2"
        >
          {loading ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-4" />
          )}
          Refresh
        </Button>
      </header>

      {error && (
        <p className="rounded-xl border border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
          {error}
        </p>
      )}

      <ResourceTable
        rows={buckets}
        columns={columns}
        loading={loading}
        rowKey={(b) => b.name}
        searchText={(b) =>
          `${b.name} ${b.location ?? ""} ${b.workers.map((w) => w.worker).join(" ")}`
        }
        initialSortKey="size"
        empty="No R2 buckets on this account."
        onRowClick={(b) => setOpenBucket(b)}
      />

      <ConfirmDeleteDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        phrase={pendingDelete?.name ?? ""}
        title="Delete bucket and all contents?"
        description={
          pendingDelete ? (
            <>
              This permanently deletes{" "}
              <span className="font-mono text-foreground">{pendingDelete.name}</span> and all{" "}
              {pendingDelete.objectCount.toLocaleString()} objects (
              {humanSize(pendingDelete.sizeBytes)}). This cannot be undone.
            </>
          ) : null
        }
        onConfirm={() => (pendingDelete ? deleteBucket(pendingDelete) : Promise.resolve())}
      />
    </section>
  );
}

/** Object listing for a single bucket. */
function BucketDetail({
  bucket,
  accountId,
  onBack,
  onRequestDelete,
  pendingDelete,
  setPendingDelete,
  onDeleted,
}: {
  bucket: Bucket;
  accountId: string | null;
  onBack: () => void;
  onRequestDelete: () => void;
  pendingDelete: Bucket | null;
  setPendingDelete: (b: Bucket | null) => void;
  onDeleted: (b: Bucket) => Promise<void>;
}) {
  const [objects, setObjects] = useState<R2Object[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (next?: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiGet<{
          objects: R2Object[];
          cursor: string | null;
          truncated: boolean;
        }>(`/storage/r2/${encodeURIComponent(bucket.name)}/objects`, {
          cursor: next,
          perPage: 100,
        });
        setObjects((prev) => (next ? [...prev, ...data.objects] : data.objects));
        setCursor(data.cursor);
        setTruncated(data.truncated);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to list objects.");
      } finally {
        setLoading(false);
      }
    },
    [bucket.name],
  );

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  async function deleteSelected() {
    if (selected.size === 0) return;
    setLoading(true);
    try {
      await apiSend("POST", `/storage/r2/${encodeURIComponent(bucket.name)}/objects/delete`, {
        keys: [...selected],
      });
      setSelected(new Set());
      await loadPage();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete objects.");
      setLoading(false);
    }
  }

  const columns: Column<R2Object>[] = [
    {
      key: "select",
      header: "",
      className: "w-10",
      render: (o) => (
        <Checkbox
          checked={selected.has(o.key)}
          onCheckedChange={(checked) => {
            setSelected((prev) => {
              const next = new Set(prev);
              if (checked) next.add(o.key);
              else next.delete(o.key);
              return next;
            });
          }}
          aria-label={`Select ${o.key}`}
        />
      ),
    },
    {
      key: "key",
      header: "Key",
      sortValue: (o) => o.key,
      render: (o) => <span className="font-mono text-xs break-all">{o.key}</span>,
    },
    {
      key: "size",
      header: "Size",
      align: "right",
      sortValue: (o) => o.size,
      render: (o) => <span className="font-mono text-xs tabular-nums">{humanSize(o.size)}</span>,
    },
    {
      key: "modified",
      header: "Modified",
      sortValue: (o) => o.lastModified ?? "",
      render: (o) => (
        <span className="text-xs text-muted-foreground">
          {o.lastModified ? relativeTime(o.lastModified) : "—"}
        </span>
      ),
    },
  ];

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" onClick={onBack} className="mb-1 gap-1.5 -ml-2">
            <ArrowLeftIcon className="size-4" />
            All buckets
          </Button>
          <h2 className="font-mono text-2xl font-semibold tracking-tight">{bucket.name}</h2>
          <p className="text-sm text-muted-foreground">
            {humanSize(bucket.sizeBytes)} · {bucket.objectCount.toLocaleString()} objects ·{" "}
            {bucket.location ?? "unknown region"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={cloudflareBucketUrl(accountId, bucket.name)}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border/60 px-3 text-sm hover:bg-muted"
          >
            <ExternalLinkIcon className="size-4" />
            Open in Cloudflare
          </a>
          {selected.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void deleteSelected()}
              className="gap-2"
            >
              <Trash2Icon className="size-4" />
              Delete {selected.size} selected
            </Button>
          )}
          <Button variant="destructive" size="sm" onClick={onRequestDelete} className="gap-2">
            <Trash2Icon className="size-4" />
            Delete bucket
          </Button>
        </div>
      </header>

      {error && (
        <p className="rounded-xl border border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
          {error}
        </p>
      )}

      <ResourceTable
        rows={objects}
        columns={columns}
        loading={loading}
        rowKey={(o) => o.key}
        searchText={(o) => o.key}
        initialSortKey="size"
        empty="This bucket is empty."
      />

      {truncated && cursor && (
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void loadPage(cursor)}
          className="self-start gap-2"
        >
          {loading && <Loader2Icon className="size-4 animate-spin" />}
          Load more
        </Button>
      )}

      <ConfirmDeleteDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        phrase={pendingDelete?.name ?? ""}
        title="Delete bucket and all contents?"
        description={
          pendingDelete ? (
            <>
              This permanently deletes{" "}
              <span className="font-mono text-foreground">{pendingDelete.name}</span> and all{" "}
              {pendingDelete.objectCount.toLocaleString()} objects (
              {humanSize(pendingDelete.sizeBytes)}). This cannot be undone.
            </>
          ) : null
        }
        onConfirm={() => (pendingDelete ? onDeleted(pendingDelete) : Promise.resolve())}
      />
    </section>
  );
}
