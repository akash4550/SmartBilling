"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2, Clock, ExternalLink } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { InvoiceWithRelations } from "@/types";
import { BulkRemindButton } from "@/components/dashboard/bulk-remind-button";

interface OverdueInvoice extends InvoiceWithRelations {
  daysOverdue: number;
}

interface PaginatedResponse {
  data: OverdueInvoice[];
  metadata: { total: number };
}

export function OverdueInvoices() {
  const [overdue, setOverdue] = useState<OverdueInvoice[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(
          "/api/invoices?overdue=true&limit=100&sortBy=dueDate&sortOrder=asc",
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error("Failed to load overdue invoices");
        const json: PaginatedResponse = await res.json();
        if (!active) return;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const overdueList: OverdueInvoice[] = json.data
          .map((inv) => {
            const due = new Date(inv.dueDate);
            due.setHours(0, 0, 0, 0);
            const days = Math.floor(
              (today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)
            );
            return { ...inv, daysOverdue: days };
          })
          .filter((inv) => inv.daysOverdue > 0)
          .sort((a, b) => b.daysOverdue - a.daysOverdue);

        setOverdue(overdueList);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Error");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const totalOverdueAmount =
    overdue?.reduce((sum, inv) => sum + Number(inv.totalAmount), 0) ?? 0;

  return (
    <Card className="border-slate-200/60 dark:border-slate-800/60">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-red-500" />
          Overdue Invoices
        </CardTitle>
        {overdue && overdue.length > 0 && (
          <div className="flex items-center gap-2">
            <CountBadge count={overdue.length} />
            <BulkRemindButton />
          </div>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-slate-400 text-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
          </div>
        ) : error ? (
          <p className="text-sm text-red-500 py-6 text-center">{error}</p>
        ) : !overdue || overdue.length === 0 ? (
          <div className="py-10 text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center mb-3">
              <Clock className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <p className="font-semibold text-slate-700 dark:text-slate-200 text-sm">All caught up!</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">No overdue invoices.</p>
          </div>
        ) : (
          <>
            <div className="mb-4 p-4 rounded-xl bg-gradient-to-r from-red-50 to-rose-50 dark:from-red-950/40 dark:to-rose-950/40 border border-red-100 dark:border-red-900/50 flex items-center justify-between">
              <div>
                <p className="text-xs text-red-700 dark:text-red-300 font-semibold uppercase tracking-wide">
                  {overdue.length} overdue
                </p>
                <p className="text-xl font-bold text-red-700 dark:text-red-300 mt-0.5 tabular-nums">
                  {formatCurrency(totalOverdueAmount)}
                </p>
              </div>
              <AlertTriangle className="h-8 w-8 text-red-400 dark:text-red-500/70" />
            </div>
            <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1 -mr-1">
              {overdue.slice(0, 6).map((inv) => (
                <Link key={inv.id} href={`/invoices/${inv.id}`}>
                  <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-100 dark:border-slate-800/60 hover:bg-slate-50 dark:hover:bg-slate-800/40 hover:border-red-200 dark:hover:border-red-900/50 transition-all group cursor-pointer">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="h-7 w-7 rounded-full bg-red-100 dark:bg-red-950/50 flex items-center justify-center text-xs font-bold text-red-700 dark:text-red-400 shrink-0">
                          {inv.client.name.charAt(0).toUpperCase()}
                        </div>
                        <p className="font-medium text-sm truncate text-slate-900 dark:text-slate-100 group-hover:text-red-600 dark:group-hover:text-red-400 transition-colors">
                          {inv.client.name}
                        </p>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 ml-9">
                        {inv.invoiceNumber} · Due {formatDate(inv.dueDate)}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-bold text-sm tabular-nums text-slate-900 dark:text-slate-100">{formatCurrency(inv.totalAmount)}</p>
                      <p className="text-xs font-medium text-red-600 dark:text-red-400 flex items-center gap-0.5 justify-end">
                        {inv.daysOverdue}d overdue
                        <ExternalLink className="h-3 w-3 ml-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
            {overdue.length > 6 && (
              <Link href="/invoices?status=PENDING" className="block mt-3">
                <Button variant="ghost" size="sm" className="w-full text-xs text-slate-500 hover:text-red-600">
                  View all {overdue.length} overdue →
                </Button>
              </Link>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CountBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center justify-center h-6 min-w-[24px] px-1.5 rounded-full bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300 text-xs font-bold">
      {count}
    </span>
  );
}
