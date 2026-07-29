"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";

export interface PnlDatum {
  key: string;
  label: string;
  revenue: number;
  expenses: number;
  profit: number;
}

interface PnlChartProps {
  data: PnlDatum[];
  currencyFormatter?: (v: number) => string;
  title?: string;
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 shadow-xl text-sm space-y-1">
      <p className="font-semibold text-slate-900 dark:text-slate-100 mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="text-slate-600 dark:text-slate-400">{p.name}:</span>
          <span className="font-semibold tabular-nums text-slate-900 dark:text-white">
            {formatCurrency(p.value)}
          </span>
        </p>
      ))}
    </div>
  );
}

export function PnlChart({ data, title = "Profit & Loss (Last 6 Months)" }: PnlChartProps) {
  const hasData = data.length > 0 && data.some((d) => d.revenue > 0 || d.expenses > 0);

  const totals = data.reduce(
    (acc, d) => ({
      revenue: acc.revenue + d.revenue,
      expenses: acc.expenses + d.expenses,
      profit: acc.profit + d.profit,
    }),
    { revenue: 0, expenses: 0, profit: 0 }
  );

  const lastTwo = data.slice(-2);
  const prevProfit = lastTwo[0]?.profit || 0;
  const currProfit = lastTwo[1]?.profit || 0;
  const pctChange = prevProfit > 0 ? Math.round(((currProfit - prevProfit) / prevProfit) * 100) : null;
  const positive = (pctChange ?? 0) >= 0;

  return (
    <Card className="border-slate-200/60 dark:border-slate-800/60 overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <div className="flex items-baseline gap-2 mt-1 flex-wrap">
            <span className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatCurrency(totals.profit)}
            </span>
            <span className="text-sm text-slate-500">net profit</span>
            {pctChange !== null && pctChange !== 0 && (
              <span className={`inline-flex items-center text-xs font-medium ${positive ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                {positive ? <TrendingUp className="h-3 w-3 mr-0.5" /> : <TrendingDown className="h-3 w-3 mr-0.5" />}
                {positive ? "+" : ""}{pctChange}%
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Revenue {formatCurrency(totals.revenue)} · Expenses {formatCurrency(totals.expenses)}
          </p>
        </div>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <div className="flex items-center justify-center h-64 text-slate-400 text-sm flex-col gap-2">
            <TrendingUp className="h-12 w-12 opacity-30" />
            <p>No data yet — create invoices and log expenses to see your P&amp;L</p>
          </div>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} strokeOpacity={0.5} />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#94a3b8", fontSize: 12, fontWeight: 500 }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `₹${(v / 1000).toFixed(0)}k` : `₹${v}`)}
                  width={55}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(99, 102, 241, 0.06)" }} />
                <Legend
                  wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
                  iconType="circle"
                  iconSize={8}
                />
                <Bar dataKey="revenue" name="Revenue" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="expenses" name="Expenses" fill="#f43f5e" radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
