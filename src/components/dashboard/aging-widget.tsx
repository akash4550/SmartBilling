"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Clock, Loader2 } from "lucide-react";

interface Bucket {
  label: string;
  count: number;
  amount: number;
}

interface OverdueItem {
  id: string;
  invoiceNumber: string;
  clientName: string;
  clientId: string;
  dueDate: string;
  daysOverdue: number;
  amount: number;
  bucket: string;
}

interface AgingData {
  buckets: Bucket[];
  totalOutstanding: number;
  totalOverdue: number;
  overdueItems: OverdueItem[];
}

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

const BUCKET_META: Record<string, { color: string; bg: string; label: string }> = {
  current: { color: "text-emerald-700 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/30", label: "Current" },
  "1-30": { color: "text-amber-700 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950/30", label: "1–30 days" },
  "31-60": { color: "text-orange-700 dark:text-orange-400", bg: "bg-orange-50 dark:bg-orange-950/30", label: "31–60 days" },
  "61-90": { color: "text-red-700 dark:text-red-400", bg: "bg-red-50 dark:bg-red-950/30", label: "61–90 days" },
  "90+": { color: "text-red-800 dark:text-red-300 bg-red-600/20", bg: "bg-red-100 dark:bg-red-950/50", label: "90+ days" },
};

function fmtDate(d: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    timeZone: "Asia/Calcutta",
  }).format(new Date(d));
}

export function AgingWidget() {
  const [data, setData] = useState<AgingData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/dashboard/aging", { cache: "no-store" });
        if (res.ok) {
          const json = await res.json();
          if (active) setData(json);
        }
      } catch {
        /* ignore */
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <Card className="border-slate-200/60 dark:border-slate-800">
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="h-4 w-4 text-amber-500" /> A/R Aging
        </CardTitle>
        {data && data.totalOverdue > 0 && (
          <Badge className="bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300 hover:bg-red-100">
            {fmtMoney(data.totalOverdue)} overdue
          </Badge>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="py-10 flex items-center justify-center text-slate-400 text-sm">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
          </div>
        ) : !data ? (
          <p className="text-sm text-slate-500 py-6 text-center">Failed to load aging data.</p>
        ) : data.totalOutstanding === 0 ? (
          <div className="py-8 text-center text-sm text-emerald-600 dark:text-emerald-400">
            <AlertCircle className="h-8 w-8 mx-auto mb-2 opacity-40" />
            No outstanding receivables
          </div>
        ) : (
          <div className="space-y-4">
            {/* Bucket bars */}
            <div className="grid grid-cols-5 gap-1.5">
              {data.buckets.map((b) => {
                const meta = BUCKET_META[b.label];
                const maxAmt = Math.max(...data.buckets.map((x) => x.amount), 1);
                const h = Math.max(8, (b.amount / maxAmt) * 72);
                return (
                  <div key={b.label} className="flex flex-col items-center gap-1.5">
                    <div className="w-full flex items-end h-20 bg-slate-50 dark:bg-slate-900/40 rounded-md overflow-hidden">
                      <div
                        className={`w-full rounded-md ${meta.bg} border border-current/10 ${meta.color} transition-all`}
                        style={{ height: `${h}px` }}
                        title={`${meta.label}: ${b.count} inv · ${fmtMoney(b.amount)}`}
                      />
                    </div>
                    <p className={`text-[10px] font-medium ${meta.color}`}>{meta.label}</p>
                    <p className="text-[11px] font-semibold text-slate-900 dark:text-white tabular-nums">{fmtMoney(b.amount)}</p>
                    <p className="text-[10px] text-slate-400">{b.count} inv</p>
                  </div>
                );
              })}
            </div>

            {/* Most overdue invoices */}
            {data.overdueItems.length > 0 && (
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3 text-red-500" /> Most overdue
                </p>
                <ul className="space-y-1.5">
                  {data.overdueItems.slice(0, 4).map((inv) => {
                    const meta = BUCKET_META[inv.bucket];
                    return (
                      <li key={inv.id}>
                        <Link
                          href={`/invoices/${inv.id}`}
                          className="flex items-center justify-between text-xs py-1.5 px-2 rounded-md hover:bg-slate-50 dark:hover:bg-slate-900/60 transition-colors"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-mono font-semibold text-slate-800 dark:text-slate-200 truncate">
                              {inv.invoiceNumber}
                            </p>
                            <p className="text-slate-500 dark:text-slate-400 truncate">{inv.clientName}</p>
                          </div>
                          <div className="text-right shrink-0 ml-2">
                            <p className="font-semibold tabular-nums text-slate-900 dark:text-white">{fmtMoney(inv.amount)}</p>
                            <p className={`text-[10px] ${meta.color}`}>{inv.daysOverdue}d · due {fmtDate(inv.dueDate)}</p>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
