/**
 * @fileoverview Per-product inventory tables — D1, KV, pipelines, and R2 data
 * catalogs.
 *
 * All four share `ResourceTable` for sorting and filtering, `BoundWorkers` for
 * attribution, and `ConfirmDeleteDialog` for the type-to-confirm barrier. The
 * backend independently re-checks the confirmation phrase and refuses to delete
 * any resource bound to this Worker.
 */

"use client";

import { Loader2Icon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { humanSize, relativeTime } from "@/lib/format";

import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { BoundWorkers, ResourceTable, type Column } from "./ResourceTable";

type Worker = { worker: string; binding: string };

/**
 * Shared page shell: fetch, refresh, error, delete-confirm plumbing.
 *
 * @param resourcePath - API path segment under `/storage`
 * @param extract - Pulls the row array out of the response envelope
 * @param deletePath - Builds the DELETE path for one row
 * @param confirmPhrase - The string the operator must type (the resource name)
 */
function useResource<T>(
  resourcePath: string,
  extract: (body: any) => T[],
): {
  rows: T[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  setError: (e: string | null) => void;
} {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(extract(await apiGet<any>(`/storage/${resourcePath}`)));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view this inventory."
          : err instanceof ApiError
            ? err.message
            : "Failed to load.",
      );
    } finally {
      setLoading(false);
    }
  }, [resourcePath, extract]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload, setError };
}

function PageHeader({
  title,
  subtitle,
  loading,
  onRefresh,
}: {
  title: string;
  subtitle: string;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="flex items-end justify-between gap-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading} className="gap-2">
        {loading ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <RefreshCwIcon className="size-4" />
        )}
        Refresh
      </Button>
    </header>
  );
}

/** Trash button used as the last column on every product table. */
function DeleteCell({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Delete ${label}`}
      onClick={onClick}
      className="text-muted-foreground hover:text-destructive"
    >
      <Trash2Icon className="size-4" />
    </Button>
  );
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

type D1Row = {
  uuid: string;
  name: string;
  createdAt: string | null;
  numTables: number;
  sizeBytes: number;
  workers: Worker[];
};

export function D1Table() {
  const { rows, loading, error, reload, setError } = useResource<D1Row>(
    "d1",
    useCallback((body) => body.databases as D1Row[], []),
  );
  const [pending, setPending] = useState<D1Row | null>(null);

  async function remove(row: D1Row) {
    try {
      await apiSend("DELETE", `/storage/d1/${encodeURIComponent(row.uuid)}`, { confirm: row.name });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Delete failed.");
    }
  }

  const columns: Column<D1Row>[] = [
    {
      key: "name",
      header: "Database",
      sortValue: (r) => r.name,
      render: (r) => <span className="font-mono text-sm">{r.name}</span>,
    },
    {
      key: "size",
      header: "Size",
      align: "right",
      sortValue: (r) => r.sizeBytes,
      render: (r) => (
        <span className="font-mono text-sm tabular-nums">{humanSize(r.sizeBytes)}</span>
      ),
    },
    {
      key: "tables",
      header: "Tables",
      align: "right",
      sortValue: (r) => r.numTables,
      render: (r) => <span className="font-mono text-sm tabular-nums">{r.numTables}</span>,
    },
    { key: "workers", header: "Bound to", render: (r) => <BoundWorkers workers={r.workers} /> },
    {
      key: "created",
      header: "Created",
      sortValue: (r) => r.createdAt ?? "",
      render: (r) => (
        <span className="text-xs text-muted-foreground">
          {r.createdAt ? relativeTime(r.createdAt) : "—"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => <DeleteCell label={r.name} onClick={() => setPending(r)} />,
    },
  ];

  const total = rows.reduce((sum, r) => sum + r.sizeBytes, 0);

  return (
    <section className="flex flex-col gap-4">
      <PageHeader
        title="D1 databases"
        subtitle={`${rows.length} databases · ${humanSize(total)}`}
        loading={loading}
        onRefresh={() => void reload()}
      />
      {error && (
        <p className="rounded-xl border border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
          {error}
        </p>
      )}
      <ResourceTable
        rows={rows}
        columns={columns}
        loading={loading}
        rowKey={(r) => r.uuid}
        searchText={(r) => `${r.name} ${r.workers.map((w) => w.worker).join(" ")}`}
        initialSortKey="size"
        empty="No D1 databases."
      />
      <ConfirmDeleteDialog
        open={Boolean(pending)}
        onOpenChange={(open) => !open && setPending(null)}
        phrase={pending?.name ?? ""}
        title="Delete D1 database?"
        description={
          pending ? (
            <>
              This permanently deletes{" "}
              <span className="font-mono text-foreground">{pending.name}</span> (
              {humanSize(pending.sizeBytes)}, {pending.numTables} tables) and all of its data. There
              is no undo and no export.
            </>
          ) : null
        }
        onConfirm={() => (pending ? remove(pending) : Promise.resolve())}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// KV
// ---------------------------------------------------------------------------

type KVRow = { id: string; title: string; sizeBytes: null; workers: Worker[] };

export function KVTable() {
  const { rows, loading, error, reload, setError } = useResource<KVRow>(
    "kv",
    useCallback((body) => body.namespaces as KVRow[], []),
  );
  const [pending, setPending] = useState<KVRow | null>(null);

  async function remove(row: KVRow) {
    try {
      await apiSend("DELETE", `/storage/kv/${encodeURIComponent(row.id)}`, { confirm: row.title });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Delete failed.");
    }
  }

  const columns: Column<KVRow>[] = [
    {
      key: "title",
      header: "Namespace",
      sortValue: (r) => r.title,
      render: (r) => <span className="font-mono text-sm">{r.title}</span>,
    },
    {
      key: "id",
      header: "ID",
      render: (r) => <span className="font-mono text-xs text-muted-foreground">{r.id}</span>,
    },
    { key: "workers", header: "Bound to", render: (r) => <BoundWorkers workers={r.workers} /> },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => <DeleteCell label={r.title} onClick={() => setPending(r)} />,
    },
  ];

  return (
    <section className="flex flex-col gap-4">
      <PageHeader
        title="KV namespaces"
        subtitle={`${rows.length} namespaces · stored size is not exposed by any Cloudflare API`}
        loading={loading}
        onRefresh={() => void reload()}
      />
      {error && (
        <p className="rounded-xl border border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
          {error}
        </p>
      )}
      <ResourceTable
        rows={rows}
        columns={columns}
        loading={loading}
        rowKey={(r) => r.id}
        searchText={(r) => `${r.title} ${r.id} ${r.workers.map((w) => w.worker).join(" ")}`}
        initialSortKey="title"
        empty="No KV namespaces."
      />
      <ConfirmDeleteDialog
        open={Boolean(pending)}
        onOpenChange={(open) => !open && setPending(null)}
        phrase={pending?.title ?? ""}
        title="Delete KV namespace?"
        description={
          pending ? (
            <>
              This permanently deletes{" "}
              <span className="font-mono text-foreground">{pending.title}</span> and every key in
              it. There is no undo.
            </>
          ) : null
        }
        onConfirm={() => (pending ? remove(pending) : Promise.resolve())}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

type PipelineRow = {
  id: string;
  name: string;
  status: string | null;
  sql: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
};

export function PipelinesTable() {
  const { rows, loading, error, reload, setError } = useResource<PipelineRow>(
    "pipelines",
    useCallback((body) => body.pipelines as PipelineRow[], []),
  );
  const [pending, setPending] = useState<PipelineRow | null>(null);

  async function remove(row: PipelineRow) {
    try {
      await apiSend("DELETE", `/storage/pipelines/${encodeURIComponent(row.id)}`, {
        confirm: row.name,
      });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Delete failed.");
    }
  }

  const columns: Column<PipelineRow>[] = [
    {
      key: "name",
      header: "Pipeline",
      sortValue: (r) => r.name,
      render: (r) => <span className="font-mono text-sm">{r.name}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => r.status ?? "",
      render: (r) => (
        <span
          className={
            r.status === "running"
              ? "font-mono text-xs text-emerald-600 dark:text-emerald-400"
              : "font-mono text-xs text-muted-foreground"
          }
        >
          {r.status ?? "—"}
        </span>
      ),
    },
    {
      key: "sql",
      header: "SQL",
      render: (r) => (
        <span className="line-clamp-2 font-mono text-xs text-muted-foreground">{r.sql ?? "—"}</span>
      ),
    },
    {
      key: "modified",
      header: "Modified",
      sortValue: (r) => r.modifiedAt ?? "",
      render: (r) => (
        <span className="text-xs text-muted-foreground">
          {r.modifiedAt ? relativeTime(r.modifiedAt) : "—"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => <DeleteCell label={r.name} onClick={() => setPending(r)} />,
    },
  ];

  return (
    <section className="flex flex-col gap-4">
      <PageHeader
        title="Pipelines"
        subtitle={`${rows.length} pipelines`}
        loading={loading}
        onRefresh={() => void reload()}
      />
      {error && (
        <p className="rounded-xl border border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
          {error}
        </p>
      )}
      <ResourceTable
        rows={rows}
        columns={columns}
        loading={loading}
        rowKey={(r) => r.id}
        searchText={(r) => `${r.name} ${r.status ?? ""} ${r.sql ?? ""}`}
        initialSortKey="name"
        empty="No pipelines."
      />
      <ConfirmDeleteDialog
        open={Boolean(pending)}
        onOpenChange={(open) => !open && setPending(null)}
        phrase={pending?.name ?? ""}
        title="Delete pipeline?"
        description={
          pending ? (
            <>
              This permanently deletes the pipeline{" "}
              <span className="font-mono text-foreground">{pending.name}</span>. Data already
              delivered to its sink is unaffected.
            </>
          ) : null
        }
        onConfirm={() => (pending ? remove(pending) : Promise.resolve())}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// R2 Data Catalogs
// ---------------------------------------------------------------------------

type CatalogRow = { bucket: string; enabled: boolean };

export function CatalogsTable() {
  const { rows, loading, error, reload } = useResource<CatalogRow>(
    "catalogs",
    useCallback((body) => body.catalogs as CatalogRow[], []),
  );

  const columns: Column<CatalogRow>[] = [
    {
      key: "bucket",
      header: "Bucket",
      sortValue: (r) => r.bucket,
      render: (r) => <span className="font-mono text-sm">{r.bucket}</span>,
    },
    {
      key: "enabled",
      header: "Catalog",
      render: (r) => (
        <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400">
          {r.enabled ? "enabled" : "—"}
        </span>
      ),
    },
  ];

  return (
    <section className="flex flex-col gap-4">
      <PageHeader
        title="R2 Data Catalogs"
        subtitle={`${rows.length} buckets with a catalog · discovered by probing each bucket`}
        loading={loading}
        onRefresh={() => void reload()}
      />
      {error && (
        <p className="rounded-xl border border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
          {error}
        </p>
      )}
      <ResourceTable
        rows={rows}
        columns={columns}
        loading={loading}
        rowKey={(r) => r.bucket}
        searchText={(r) => r.bucket}
        initialSortKey="bucket"
        empty="No buckets on this account have a data catalog enabled."
      />
    </section>
  );
}
