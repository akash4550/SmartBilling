"use client";

import { useCallback, useEffect, useMemo, useState, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FileText,
  Plus,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Search,
  Pencil,
  Eye,
  X,
  CheckCheck,
  Bell,
  Trash2,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrency, formatDate, isInvoiceOverdue, dueLabel } from "@/lib/utils";
import { downloadInvoicesCSV, type InvoiceForExport } from "@/lib/export-csv";
import { PageTransition } from "@/components/page-transition";
import type { InvoiceWithRelations } from "@/types";

interface StatusCounts {
  all: number;
  draft: number;
  pending: number;
  overdue: number;
  paid: number;
  void: number;
}

interface PaginatedResponse {
  data: InvoiceWithRelations[];
  metadata: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  counts?: StatusCounts;
}

const STATUS_TABS = [
  { value: "ALL", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING", label: "Pending" },
  { value: "OVERDUE", label: "Overdue" },
  { value: "PAID", label: "Paid" },
  { value: "VOID", label: "Void" },
] as const;

type StatusFilter = (typeof STATUS_TABS)[number]["value"];
const PAGE_SIZE = 10;

function StatusBadge({ status, dueDate }: { status: "DRAFT" | "PENDING" | "PAID" | "VOID"; dueDate?: Date | string }) {
  if (status === "PENDING" && dueDate && isInvoiceOverdue({ status, dueDate })) {
    const info = dueLabel({ status, dueDate });
    return <Badge variant="danger">{info.label}</Badge>;
  }
  const config = {
    DRAFT: { variant: "draft" as const, label: "Draft" },
    PENDING: { variant: "warning" as const, label: "Pending" },
    PAID: { variant: "success" as const, label: "Paid" },
    VOID: { variant: "neutral" as const, label: "Void" },
  };
  const { variant, label } = config[status];
  return <Badge variant={variant}>{label}</Badge>;
}

/**
 * Compute a compact list of page numbers for the pagination control,
 * with ellipses between nearby blocks (e.g., 1 … 4 5 6 … 20).
 */
function getPageNumbers(current: number, total: number): (number | "...")[] {
  const pages: (number | "...")[] = [];
  const delta = 1;
  const range: number[] = [];
  for (
    let i = Math.max(2, current - delta);
    i <= Math.min(total - 1, current + delta);
    i++
  ) {
    range.push(i);
  }
  pages.push(1);
  if (current - delta > 2) pages.push("...");
  pages.push(...range);
  if (current + delta < total - 1) pages.push("...");
  if (total > 1) pages.push(total);
  return pages;
}

/**
 * The actual invoices list, pulled out into its own component so it can be
 * wrapped in <Suspense> (required by useSearchParams() in Next.js 15).
 */
function InvoicesList() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialPage = Math.max(1, Number(searchParams.get("page")) || 1);
  const initialStatus = (searchParams.get("status") as StatusFilter) || "ALL";
  const initialSearch = searchParams.get("q") || "";

  const [page, setPage] = useState(initialPage);
  const [status, setStatus] = useState<StatusFilter>(initialStatus);
  const [search, setSearch] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);
  const [data, setData] = useState<PaginatedResponse | null>(null);
  const [counts, setCounts] = useState<StatusCounts>({ all: 0, draft: 0, pending: 0, overdue: 0, paid: 0, void: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Sync state to URL
  useEffect(() => {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    if (status !== "ALL") params.set("status", status);
    if (debouncedSearch) params.set("q", debouncedSearch);
    const qs = params.toString();
    router.replace(`/invoices${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [page, status, debouncedSearch, router]);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      if (status !== "ALL") params.set("status", status);
      // Server-side search (q param) — case-insensitive, matches invoice #,
      // client name, and client email across ALL pages, not just the current
      // one, fixing the previous "page 2 results never match" bug.
      if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
      const res = await fetch(`/api/invoices?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Failed to load invoices");
      const json: PaginatedResponse = await res.json();
      setData(json);
      if (json.counts) setCounts(json.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, [page, status, debouncedSearch]);

  useEffect(() => {
    const timer = setTimeout(() => { void fetchInvoices(); }, 0);
    return () => clearTimeout(timer);
  }, [fetchInvoices]);

  // The server now handles filtering — we render the page as-is.
  const filteredInvoices = useMemo(() => (data ? data.data : []), [data]);

  const pageIds = useMemo(() => filteredInvoices.map((i) => i.id), [filteredInvoices]);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleAllOnPage() {
    setSelected((prev) => {
      const n = new Set(prev);
      if (allOnPageSelected) {
        pageIds.forEach((id) => n.delete(id));
      } else {
        pageIds.forEach((id) => n.add(id));
      }
      return n;
    });
  }
  function clearSelection() { setSelected(new Set()); }

  async function runBulk(action: "mark_paid" | "remind" | "delete") {
    if (selected.size === 0 || bulkRunning) return;
    const ids = Array.from(selected);
    const label = action === "mark_paid" ? "mark as paid" : action === "remind" ? "send reminders" : "delete drafts";
    if (!confirm(`Are you sure you want to ${label} for ${ids.length} invoice${ids.length === 1 ? "" : "s"}?`)) return;
    setBulkRunning(true);
    try {
      const res = await fetch("/api/invoices/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Bulk action failed");
      toast.success(
        action === "delete" ? "Bulk delete complete" :
        action === "mark_paid" ? "Invoices marked as paid" :
        "Reminders sent",
        {
          description: `${json.succeeded} succeeded${json.skipped ? `, ${json.skipped} skipped` : ""}${json.failed ? `, ${json.failed} failed` : ""}`,
        },
      );
      clearSelection();
      await fetchInvoices();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk action failed");
    } finally {
      setBulkRunning(false);
    }
  }

  async function handleExportCSV() {
    if (!data) return;
    setExporting(true);
    try {
      let toExport: InvoiceForExport[] = data.data;
      if (data.metadata.totalPages > 1 || data.metadata.total > data.data.length) {
        const params = new URLSearchParams();
        // Use the newly-raised 1000 cap so we can export up to 1000 invoices
        params.set("limit", "1000");
        params.set("page", "1");
        if (status !== "ALL") params.set("status", status);
        // Apply the same server-side search filter to the export
        if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
        const res = await fetch(`/api/invoices?${params.toString()}`);
        if (res.ok) {
          const allJson: PaginatedResponse = await res.json();
          toExport = allJson.data;
        }
      }
      // No need to re-filter client-side; the server already applied search.
      downloadInvoicesCSV(toExport);
      toast.success("CSV exported", { description: `${toExport.length} invoices downloaded` });
    } catch {
      toast.error("Failed to export CSV. Please try again.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <PageTransition className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">Invoices</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            Create, track, and manage all your invoices
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={handleExportCSV}
            disabled={exporting || loading || !data || data.metadata.total === 0}
            className="border-slate-200 dark:border-slate-700"
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            Export CSV
          </Button>
          <Link href="/invoices/new">
            <Button className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25">
              <Plus className="h-4 w-4 mr-2" />
              New Invoice
            </Button>
          </Link>
        </div>
      </div>

      <Card className="border-slate-200/60 dark:border-slate-800/60">
        <CardContent className="p-4 space-y-4">
          <div
            className="inline-flex rounded-xl bg-slate-100 dark:bg-slate-800/60 p-1"
            role="tablist"
          >
            {STATUS_TABS.map((tab) => {
              const active = status === tab.value;
              const tabCount =
                tab.value === "ALL" ? counts.all
                : tab.value === "DRAFT" ? counts.draft
                : tab.value === "PENDING" ? counts.pending
                : tab.value === "OVERDUE" ? counts.overdue
                : tab.value === "PAID" ? counts.paid
                : counts.void;
              const isDanger = tab.value === "OVERDUE" && tabCount > 0;
              return (
                <button
                  key={tab.value}
                  role="tab"
                  aria-selected={active}
                  onClick={() => { setStatus(tab.value); setPage(1); setSelected(new Set()); }}
                  className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-lg transition-all ${
                    active
                      ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  {tab.label}
                  <span className={`inline-flex min-w-[20px] h-5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold ${
                    isDanger
                      ? "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300"
                      : active
                      ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                      : "bg-slate-200/60 text-slate-500 dark:bg-slate-700/50 dark:text-slate-400"
                  }`}>
                    {tabCount}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
            <div className="relative w-full sm:w-80">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                placeholder="Search invoice #, client name or email..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); setSelected(new Set()); }}
                className="pl-9 h-10"
              />
            </div>
            {data && !loading && (
              <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">
                {data.metadata.total} invoice{data.metadata.total !== 1 ? "s" : ""}
                {status !== "ALL" ? ` · ${status.toLowerCase()}` : ""}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-200/60 dark:border-slate-800/60 overflow-hidden">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-slate-400 dark:text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading invoices...
            </div>
          ) : error ? (
            <div className="text-center py-16 px-4">
              <p className="text-red-600 dark:text-red-400">{error}</p>
              <Button onClick={fetchInvoices} variant="outline" className="mt-3">
                Retry
              </Button>
            </div>
          ) : filteredInvoices.length === 0 ? (
            <div className="text-center py-16 px-4">
              <FileText className="h-12 w-12 mx-auto mb-3 text-slate-300 dark:text-slate-600" />
              <p className="font-medium text-slate-700 dark:text-slate-200">
                {debouncedSearch ? "No matching invoices" : "No invoices yet"}
              </p>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                {debouncedSearch
                  ? "Try a different search term or clear the filter."
                  : "Create your first invoice to get started."}
              </p>
              {!debouncedSearch && (
                <Link href="/invoices/new" className="inline-block mt-4">
                  <Button>Create Invoice</Button>
                </Link>
              )}
            </div>
          ) : (
            <>
              {someSelected && (
                <div className="sticky top-0 z-10 bg-blue-50 dark:bg-blue-950/40 border-b border-blue-200 dark:border-blue-900 px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap no-print">
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCheck className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    <span className="font-semibold text-blue-900 dark:text-blue-200">
                      {selected.size} invoice{selected.size === 1 ? "" : "s"} selected
                    </span>
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="ml-1 text-xs text-blue-700 dark:text-blue-300 hover:underline inline-flex items-center gap-1"
                    >
                      <X className="h-3 w-3" /> Clear
                    </button>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={bulkRunning}
                      onClick={() => runBulk("mark_paid")}
                      className="gap-1.5"
                    >
                      <CheckCheck className="h-3.5 w-3.5" /> Mark Paid
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={bulkRunning}
                      onClick={() => runBulk("remind")}
                      className="gap-1.5"
                    >
                      <Bell className="h-3.5 w-3.5" /> Send Reminder
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={bulkRunning}
                      onClick={() => runBulk("delete")}
                      className="gap-1.5"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete Drafts
                    </Button>
                  </div>
                </div>
              )}
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40px]">
                        <Checkbox
                          checked={allOnPageSelected}
                          indeterminate={someSelected && !allOnPageSelected}
                          onChange={toggleAllOnPage}
                          aria-label="Select all on page"
                        />
                      </TableHead>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead className="hidden md:table-cell">Issue Date</TableHead>
                      <TableHead className="hidden sm:table-cell">Due Date</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="w-[100px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredInvoices.map((inv) => (
                      <TableRow
                        key={inv.id}
                        className={[
                          "group cursor-pointer",
                          selected.has(inv.id) ? "bg-blue-50/70 dark:bg-blue-950/20" : "",
                        ].join(" ")}
                        onClick={() => window.location.href = `/invoices/${inv.id}`}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selected.has(inv.id)}
                            onChange={() => toggleOne(inv.id)}
                            aria-label={`Select ${inv.invoiceNumber}`}
                          />
                        </TableCell>
                        <TableCell className="font-medium">
                          <Link
                            href={`/invoices/${inv.id}`}
                            className="text-blue-600 dark:text-blue-400 font-mono font-semibold hover:text-blue-700 dark:hover:text-blue-300"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {inv.invoiceNumber}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-blue-100 to-indigo-100 dark:from-blue-900 dark:to-indigo-900 flex items-center justify-center text-xs font-semibold text-blue-700 dark:text-blue-300 shrink-0">
                              {inv.client.name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <p className="font-medium text-slate-900 dark:text-slate-100">{inv.client.name}</p>
                              <p className="text-xs text-slate-500 dark:text-slate-400 hidden sm:block">
                                {inv.client.email}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-slate-500 dark:text-slate-400 tabular-nums">
                          {formatDate(inv.issueDate)}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-slate-500 dark:text-slate-400 tabular-nums">
                          <div className="flex flex-col">
                            <span>{formatDate(inv.dueDate)}</span>
                            {inv.status === "PENDING" && (() => {
                              const dl = dueLabel({ status: inv.status, dueDate: inv.dueDate });
                              if (dl.tone === "overdue") return <span className="text-red-600 dark:text-red-400 text-xs font-medium">{dl.label}</span>;
                              if (dl.tone === "today") return <span className="text-amber-600 dark:text-amber-400 text-xs font-medium">{dl.label}</span>;
                              if (dl.tone === "soon") return <span className="text-amber-600 dark:text-amber-400 text-xs">{dl.label}</span>;
                              return null;
                            })()}
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={inv.status} dueDate={inv.dueDate} />
                        </TableCell>
                        <TableCell className="text-right font-bold text-slate-900 dark:text-white tabular-nums">
                          {formatCurrency(inv.totalAmount)}
                        </TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                            <Link
                              href={`/invoices/${inv.id}`}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 dark:hover:text-blue-400"
                              aria-label={`View ${inv.invoiceNumber}`}
                            >
                              <Eye className="h-4 w-4" />
                            </Link>
                            <Link
                              href={`/invoices/${inv.id}/edit`}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 dark:hover:text-indigo-400"
                              aria-label={`Edit ${inv.invoiceNumber}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Link>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {data && data.metadata.totalPages > 1 && (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-slate-200 dark:border-slate-800">
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Page{" "}
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {data.metadata.page}
                    </span>{" "}
                    of{" "}
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {data.metadata.totalPages}
                    </span>{" "}
                    · {data.metadata.total} total
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={!data.metadata.hasPrevPage || loading}
                    >
                      <ChevronLeft className="h-4 w-4 mr-1" />
                      Previous
                    </Button>
                    <div className="hidden sm:flex items-center gap-1">
                      {getPageNumbers(data.metadata.page, data.metadata.totalPages).map(
                        (p, i) =>
                          p === "..." ? (
                            <span key={`dots-${i}`} className="px-2 text-slate-400">
                              …
                            </span>
                          ) : (
                            <Button
                              key={p}
                              variant={p === data.metadata.page ? "default" : "ghost"}
                              size="sm"
                              className="w-9 px-0"
                              onClick={() => setPage(p as number)}
                              disabled={loading}
                            >
                              {p}
                            </Button>
                          )
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => p + 1)}
                      disabled={!data.metadata.hasNextPage || loading}
                    >
                      Next
                      <ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </PageTransition>
  );
}

export default function InvoicesPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Loading invoices...
        </div>
      }
    >
      <InvoicesList />
    </Suspense>
  );
}
