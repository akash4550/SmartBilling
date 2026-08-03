"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Receipt, Loader2, TrendingUp } from "lucide-react";

interface TaxData {
  points: Array<{ key: string; label: string; tax: number; revenue: number }>;
  totals: {
    totalTax: number;
    totalRevenue: number;
    currentMonthTax: number;
    ytdTax: number;
    effectiveRate: number;
  };
}

function fmtMoney(n: number): string {
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(1)}k`;
  return `₹${n.toFixed(0)}`;
}

export function TaxCollected() {
  const [data, setData] = useState<TaxData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/dashboard/taxes?months=6", { cache: "no-store" });
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
          <Receipt className="h-4 w-4 text-purple-500" /> Tax Collected
        </CardTitle>
        {data && data.totals.effectiveRate > 0 && (
          <Badge variant="secondary" className="text-[10px]">
            {data.totals.effectiveRate.toFixed(1)}% eff.
          </Badge>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="py-6 flex items-center justify-center text-slate-400 text-sm">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
          </div>
        ) : !data ? (
          <p className="text-sm text-slate-500 py-4 text-center">Failed to load tax data.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="p-2.5 rounded-lg bg-purple-50 dark:bg-purple-950/30 border border-purple-100 dark:border-purple-900/40">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-purple-600 dark:text-purple-400">This Month</p>
                <p className="text-base font-bold text-slate-900 dark:text-white tabular-nums mt-0.5">
                  {fmtMoney(data.totals.currentMonthTax)}
                </p>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">6-mo Total</p>
                <p className="text-base font-bold text-slate-900 dark:text-white tabular-nums mt-0.5">
                  {fmtMoney(data.totals.totalTax)}
                </p>
              </div>
              <div className="p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/40">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">YTD</p>
                <p className="text-base font-bold text-slate-900 dark:text-white tabular-nums mt-0.5">
                  {fmtMoney(data.totals.ytdTax)}
                </p>
              </div>
            </div>

            {/* Mini bar chart */}
            <div className="pt-2">
              <div className="flex items-end gap-1.5 h-20">
                {data.points.map((p) => {
                  const max = Math.max(...data.points.map((x) => x.tax), 1);
                  const h = Math.max(4, (p.tax / max) * 64);
                  return (
                    <div key={p.key} className="flex-1 flex flex-col items-center gap-1">
                      <div className="w-full flex items-end h-16 bg-slate-50 dark:bg-slate-900/40 rounded">
                        <div
                          className="w-full bg-gradient-to-t from-purple-500 to-purple-400 dark:from-purple-600 dark:to-purple-500 rounded transition-all"
                          style={{ height: `${h}px` }}
                          title={`${p.label}: ₹${p.tax.toFixed(0)} tax`}
                        />
                      </div>
                      <p className="text-[10px] text-slate-500">{p.label}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            <p className="text-[11px] text-slate-500 dark:text-slate-400 pt-1 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              Based on paid invoices. Use for reference when filing GST/VAT returns.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
