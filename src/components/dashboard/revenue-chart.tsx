"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { TrendingUp } from "lucide-react";

export interface RevenueDatum {
  month: string;
  revenue: number;
}

interface RevenueChartProps {
  data: RevenueDatum[];
  title?: string;
}

const BAR_COLOR = "url(#barGradient)";
const BAR_HIGHLIGHT_COLOR = "url(#barGradientActive)";

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 shadow-xl text-sm">
      <p className="font-semibold text-slate-900 dark:text-slate-100 mb-1">{label}</p>
      <p className="text-blue-600 dark:text-blue-400 font-bold text-lg">
        {formatCurrency(payload[0].value)}
      </p>
    </div>
  );
}

export function RevenueChart({ data, title = "Monthly Revenue" }: RevenueChartProps) {
  const hasData = data.length > 0 && data.some((d) => d.revenue > 0);

  const total = data.reduce((s, d) => s + d.revenue, 0);
  const lastTwo = data.slice(-2);
  const prev = lastTwo[0]?.revenue || 0;
  const curr = lastTwo[1]?.revenue || 0;
  const pctChange = prev > 0 ? Math.round(((curr - prev) / prev) * 100) : 0;

  return (
    <Card className="border-slate-200/60 dark:border-slate-800/60 overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
              {formatCurrency(total)}
            </span>
            {pctChange !== 0 && (
              <span className={`inline-flex items-center text-xs font-medium ${pctChange >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                <TrendingUp className={`h-3 w-3 mr-0.5 ${pctChange < 0 ? "rotate-180" : ""}`} />
                {pctChange >= 0 ? "+" : ""}{pctChange}%
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Last 6 months</p>
        </div>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <div className="flex items-center justify-center h-64 text-slate-400 text-sm flex-col gap-2">
            <TrendingUp className="h-12 w-12 opacity-30" />
            <p>No revenue data yet</p>
          </div>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                <defs>
                  <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.9} />
                    <stop offset="100%" stopColor="#6366f1" stopOpacity={0.6} />
                  </linearGradient>
                  <linearGradient id="barGradientActive" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2563eb" stopOpacity={1} />
                    <stop offset="100%" stopColor="#4f46e5" stopOpacity={0.8} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} strokeOpacity={0.5} />
                <XAxis
                  dataKey="month"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#94a3b8", fontSize: 12, fontWeight: 500 }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  tickFormatter={(v: number) => (v >= 1000 ? `₹${(v / 1000).toFixed(0)}k` : `₹${v}`)}
                  width={55}
                />
                <Tooltip
                  content={<CustomTooltip />}
                  cursor={{ fill: "rgba(59, 130, 246, 0.08)" }}
                />
                <Bar dataKey="revenue" radius={[6, 6, 0, 0]} maxBarSize={48}>
                  {data.map((_entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={index === data.length - 1 ? BAR_HIGHLIGHT_COLOR : BAR_COLOR}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
