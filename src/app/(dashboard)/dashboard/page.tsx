"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  FileText,
  Users,
  TrendingUp,
  RefreshCw,
  Loader2,
  ArrowRight,
  ArrowUpRight,
  ArrowDownRight,
  AlertTriangle,
  CalendarCheck,
  Wallet,
  Receipt,
  Settings as SettingsIcon,
  FilePlus2,
  UserPlus,
  Sparkles,
  Sun,
  Moon,
  Coffee,
  CircleDot,
  HandCoins,
  Activity,
} from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { NewClientDialog } from "@/components/clients/new-client-dialog";
import { RevenueChart, type RevenueDatum } from "@/components/dashboard/revenue-chart";
import { PnlChart, type PnlDatum } from "@/components/dashboard/pnl-chart";
import { OverdueInvoices } from "@/components/dashboard/overdue-invoices";
import { UpcomingRecurring } from "@/components/dashboard/upcoming-recurring";
import { ExpenseTracker } from "@/components/dashboard/expense-tracker";
import { RecentActivity } from "@/components/dashboard/recent-activity";
import { AgingWidget } from "@/components/dashboard/aging-widget";
import { TaxCollected } from "@/components/dashboard/tax-collected";
import { PageTransition } from "@/components/page-transition";
import { motion } from "framer-motion";
import type { InvoiceWithRelations } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface SummaryResponse {
  totalRevenue: number;
  pendingAmount: number;
  overdueCount: number;
  overdueAmount: number;
  draftCount: number;
  pendingCount: number;
  paidCount: number;
  totalInvoices: number;
  totalClients: number;
  monthRevenue: number;
  monthPaidCount: number;
  monthTrend: number | null;
  recentInvoices: InvoiceWithRelations[];
}

interface PnlResponse {
  currency: string;
  points: PnlDatum[];
  totals: { revenue: number; expenses: number; profit: number; margin: number };
  currentMonth: { revenue: number; expenses: number; profit: number } | null;
  categories: Array<{ name: string; amount: number }>;
}

interface RevenueResponse {
  points: Array<{ key: string; label: string; revenue: number }>;
  currency: string;
}

interface SettingsLite {
  currency: string;
  companyName?: string;
}

// ---------------------------------------------------------------------------
// Greeting helpers
// ---------------------------------------------------------------------------
function getGreeting(now: Date): { text: string; Icon: typeof Sun } {
  const h = now.getHours();
  if (h < 5) return { text: "Working late", Icon: Moon };
  if (h < 12) return { text: "Good morning", Icon: Coffee };
  if (h < 17) return { text: "Good afternoon", Icon: Sun };
  if (h < 21) return { text: "Good evening", Icon: Sun };
  return { text: "Good night", Icon: Moon };
}

function formatFriendlyDate(d: Date) {
  return d.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Tiny sparkline — pure SVG, no dependency
// ---------------------------------------------------------------------------
function Sparkline({
  values,
  color,
  height = 36,
  width = 88,
}: {
  values: number[];
  color: string;
  height?: number;
  width?: number;
}) {
  if (values.length < 2) {
    return (
      <svg width={width} height={height} className="opacity-40">
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      </svg>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values
    .map((v, i) => {
      const x = i * step;
      const y = height - 2 - ((v - min) / range) * (height - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const areaPts = `0,${height} ${pts} ${width},${height}`;
  const id = `spark-${color.replace("#", "")}-${Math.round(width)}x${Math.round(height)}`;
  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={areaPts} fill={`url(#${id})`} />
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* last point dot */}
      {(() => {
        const last = values[values.length - 1];
        const y = height - 2 - ((last - min) / range) * (height - 6);
        return <circle cx={width} cy={y} r={2.5} fill={color} />;
      })()}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Stat-card config
// ---------------------------------------------------------------------------
interface StatCard {
  key: "revenue" | "monthRevenue" | "pending" | "overdue" | "clients" | "profit";
  label: string;
  icon: typeof TrendingUp;
  iconBg: string;
  iconColor: string;
  accent: string;
  format: (v: number) => string;
  sub: (s: SummaryResponse, p?: PnlResponse | null) => string;
  trend?: (s: SummaryResponse, p?: PnlResponse | null) => number | null;
  spark?: (s: SummaryResponse, p?: PnlResponse | null, rev?: RevenueDatum[] | null) => number[];
  href?: string;
  tone?: "danger" | "success" | "neutral";
}

const statCards: StatCard[] = [
  {
    key: "monthRevenue",
    label: "Paid This Month",
    icon: CalendarCheck,
    iconBg: "bg-gradient-to-br from-emerald-500 to-teal-500",
    iconColor: "text-white",
    accent: "#10b981",
    format: (v) => formatCurrency(v),
    sub: (s) => `${s.monthPaidCount} paid · ${s.paidCount - s.monthPaidCount} prior`,
    trend: (s) => s.monthTrend,
    spark: (_s, _p, rev) => (rev ?? []).map((r) => r.revenue),
    href: "/invoices?status=PAID",
    tone: "success",
  },
  {
    key: "revenue",
    label: "Total Revenue",
    icon: TrendingUp,
    iconBg: "bg-gradient-to-br from-blue-500 to-indigo-600",
    iconColor: "text-white",
    accent: "#3b82f6",
    format: (v) => formatCurrency(v),
    sub: (s) => `${s.paidCount} paid invoices all-time`,
    spark: (_s, _p, rev) => (rev ?? []).map((r) => r.revenue),
    href: "/invoices?status=PAID",
  },
  {
    key: "profit",
    label: "Net Profit (MTD)",
    icon: Wallet,
    iconBg: "bg-gradient-to-br from-violet-500 to-purple-600",
    iconColor: "text-white",
    accent: "#8b5cf6",
    format: (v) => formatCurrency(v),
    sub: (_s, p) => `${(p?.totals.margin ?? 0).toFixed(1)}% margin`,
    spark: (_s, p) => (p?.points ?? []).map((pt) => pt.profit),
    href: "/expenses",
    tone: "success",
  },
  {
    key: "pending",
    label: "Outstanding",
    icon: HandCoins,
    iconBg: "bg-gradient-to-br from-amber-500 to-orange-500",
    iconColor: "text-white",
    accent: "#f59e0b",
    format: (v) => formatCurrency(v),
    sub: (s) => `${s.pendingCount} pending invoice${s.pendingCount === 1 ? "" : "s"}`,
    href: "/invoices?status=PENDING",
  },
  {
    key: "overdue",
    label: "Overdue",
    icon: AlertTriangle,
    iconBg: "bg-gradient-to-br from-red-500 to-rose-600",
    iconColor: "text-white",
    accent: "#ef4444",
    format: (v) => formatCurrency(v),
    sub: (s) => `${s.overdueCount} overdue invoice${s.overdueCount === 1 ? "" : "s"}`,
    href: "/invoices?status=OVERDUE",
    tone: "danger",
  },
  {
    key: "clients",
    label: "Total Clients",
    icon: Users,
    iconBg: "bg-gradient-to-br from-sky-500 to-cyan-500",
    iconColor: "text-white",
    accent: "#0ea5e9",
    format: (v) => v.toLocaleString("en-IN"),
    sub: () => "Active customers",
    href: "/clients",
  },
];

function StatusBadge({ status }: { status: "DRAFT" | "PENDING" | "PAID" | "VOID" }) {
  const config = {
    DRAFT: { variant: "draft" as const, label: "Draft" },
    PENDING: { variant: "warning" as const, label: "Pending" },
    PAID: { variant: "success" as const, label: "Paid" },
    VOID: { variant: "neutral" as const, label: "Void" },
  };
  const { variant, label } = config[status];
  return <Badge variant={variant}>{label}</Badge>;
}

// ---------------------------------------------------------------------------
// Stat card component
// ---------------------------------------------------------------------------
function StatCardView({
  card,
  value,
  sub,
  trend,
  spark,
  isDanger,
  index,
}: {
  card: StatCard;
  value: number;
  sub: string;
  trend: number | null;
  spark: number[];
  isDanger: boolean;
  index: number;
}) {
  const Icon = card.icon;
  const trendPositive = (trend ?? 0) >= 0;
  const Wrapper: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) =>
    card.href ? <Link href={card.href} className={className}>{children}</Link> : <div className={className}>{children}</div>;

  return (
    <Wrapper>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.05 * index, ease: [0.22, 1, 0.36, 1] }}
        className="h-full"
      >
        <Card
          className={[
            "relative h-full overflow-hidden group cursor-pointer transition-all duration-300",
            "border border-slate-200/70 dark:border-slate-800/70",
            "bg-white/80 dark:bg-slate-900/60 backdrop-blur-sm",
            "hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-200/50 dark:hover:shadow-black/30",
            isDanger
              ? "ring-1 ring-red-300/60 dark:ring-red-900/60 bg-gradient-to-br from-red-50/80 via-white to-white dark:from-red-950/30 dark:via-slate-900/60 dark:to-slate-900/60"
              : "hover:border-slate-300 dark:hover:border-slate-700",
          ].join(" ")}
        >
          {/* Accent corner glow */}
          <div
            aria-hidden
            className="absolute -top-10 -right-10 h-32 w-32 rounded-full blur-3xl opacity-20 group-hover:opacity-40 transition-opacity pointer-events-none"
            style={{ background: card.accent }}
          />

          <CardContent className="p-5 relative">
            <div className="flex items-start justify-between">
              <div className={`p-2.5 rounded-xl shadow-lg ${card.iconBg} ${card.iconColor} group-hover:scale-110 transition-transform`}>
                <Icon className="h-5 w-5" strokeWidth={2.2} />
              </div>
              {trend !== null && trend !== 0 && (
                <span
                  className={[
                    "inline-flex items-center gap-0.5 text-xs font-semibold px-2 py-1 rounded-full",
                    trendPositive
                      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
                      : "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400",
                  ].join(" ")}
                >
                  {trendPositive ? (
                    <ArrowUpRight className="h-3 w-3" />
                  ) : (
                    <ArrowDownRight className="h-3 w-3" />
                  )}
                  {trendPositive ? "+" : ""}
                  {trend}%
                </span>
              )}
            </div>

            <div className="mt-4">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                {card.label}
              </p>
              <p className="mt-1 text-2xl sm:text-[26px] font-bold text-slate-900 dark:text-white tracking-tight tabular-nums leading-tight">
                {card.format(value)}
              </p>
            </div>

            <div className="mt-3 flex items-end justify-between gap-2">
              <p className="text-xs text-slate-500 dark:text-slate-400 min-w-0 flex-1">
                {sub}
              </p>
              <div className="shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
                <Sparkline values={spark} color={card.accent} />
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </Wrapper>
  );
}

// ---------------------------------------------------------------------------
// Quick-action tile
// ---------------------------------------------------------------------------
interface QuickActionProps {
  href?: string;
  onClick?: () => void;
  icon: typeof FilePlus2;
  title: string;
  subtitle: string;
  gradient: string;
  iconColor: string;
  hoverFrom: string;
  hoverTo: string;
  delay?: number;
}

function QuickAction({
  href,
  onClick,
  icon: Icon,
  title,
  subtitle,
  gradient,
  iconColor,
  hoverFrom,
  hoverTo,
  delay = 0,
}: QuickActionProps) {
  const Wrapper: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) =>
    href ? <Link href={href} className={className}>{children}</Link> : <button type="button" onClick={onClick} className={className}>{children}</button>;

  return (
    <Wrapper>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay, ease: [0.22, 1, 0.36, 1] }}
        className="group relative h-full"
      >
        <Card
          className={[
            "relative h-full overflow-hidden cursor-pointer transition-all duration-300 border border-slate-200/70 dark:border-slate-800/70",
            "bg-white/80 dark:bg-slate-900/60 backdrop-blur-sm",
            "hover:-translate-y-0.5 hover:shadow-lg hover:shadow-slate-200/50 dark:hover:shadow-black/30",
          ].join(" ")}
        >
          <div
            className={`absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br ${hoverFrom} ${hoverTo}`}
            aria-hidden
          />
          <CardContent className="relative p-4 flex items-center gap-3">
            <div
              className={`p-2.5 rounded-xl ${gradient} ${iconColor} shadow-md group-hover:scale-110 group-hover:shadow-lg transition-all`}
            >
              <Icon className="h-5 w-5" strokeWidth={2.2} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sm text-slate-900 dark:text-white group-hover:text-slate-900 dark:group-hover:text-white transition-colors">
                {title}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                {subtitle}
              </p>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-400 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
          </CardContent>
        </Card>
      </motion.div>
    </Wrapper>
  );
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------
export default function DashboardPage() {
  const { data: session } = useSession();
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [monthlyRevenue, setMonthlyRevenue] = useState<RevenueDatum[] | null>(null);
  const [pnl, setPnl] = useState<PnlResponse | null>(null);
  const [settings, setSettings] = useState<SettingsLite | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date>(new Date());

  // Live ticking clock for the greeting strip (every 30s is plenty).
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [summaryRes, revenueRes, settingsRes, pnlRes] = await Promise.all([
        fetch("/api/dashboard/summary", { cache: "no-store" }),
        fetch("/api/dashboard/revenue?months=6", { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
        fetch("/api/dashboard/pnl?months=6", { cache: "no-store" }),
      ]);
      if (!summaryRes.ok) throw new Error("Failed to load dashboard summary");
      const summaryData: SummaryResponse = await summaryRes.json();
      setSummary(summaryData);
      if (revenueRes.ok) {
        const rev: RevenueResponse = await revenueRes.json();
        setMonthlyRevenue(rev.points.map((p) => ({ month: p.label, revenue: p.revenue })));
      } else {
        setMonthlyRevenue([]);
      }
      if (settingsRes.ok) {
        const s: SettingsLite = await settingsRes.json();
        setSettings(s);
      }
      if (pnlRes.ok) {
        const p: PnlResponse = await pnlRes.json();
        setPnl(p);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const greeting = useMemo(() => getGreeting(now), [now]);
  const firstName = (session?.user?.name || settings?.companyName || "there").split(" ")[0];

  const health = useMemo(() => {
    if (!summary) return null;
    const outstanding = summary.pendingAmount + summary.overdueAmount;
    const collectRate =
      summary.totalRevenue + outstanding > 0
        ? (summary.totalRevenue / (summary.totalRevenue + outstanding)) * 100
        : 100;
    const score = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          collectRate * 0.6 +
            (summary.overdueCount === 0 ? 40 : Math.max(0, 40 - summary.overdueCount * 6))
        )
      )
    );
    let label = "Doing well";
    let color = "#10b981";
    if (score < 50) { label = "Needs attention"; color = "#ef4444"; }
    else if (score < 75) { label = "On track"; color = "#f59e0b"; }
    return { score, label, color, collectRate };
  }, [summary]);

  return (
    <PageTransition className="space-y-6 pb-8">
      {/* -------------------------------------------------------------- HERO */}
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="relative overflow-hidden rounded-2xl border border-slate-200/70 dark:border-slate-800/70 bg-gradient-to-br from-white via-blue-50/40 to-indigo-50/60 dark:from-slate-900 dark:via-slate-900 dark:to-indigo-950/30 shadow-sm"
      >
        {/* Decorative blobs */}
        <div aria-hidden className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-blue-400/20 dark:bg-blue-500/10 blur-3xl pointer-events-none" />
        <div aria-hidden className="absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-indigo-400/20 dark:bg-indigo-500/10 blur-3xl pointer-events-none" />

        <div className="relative p-6 sm:p-8 flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/30 shrink-0">
              <greeting.Icon className="h-6 w-6 text-white" strokeWidth={2.2} />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                  {greeting.text}, {firstName}
                </h1>
                {health && (
                  <span
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full bg-white/70 dark:bg-slate-900/60 backdrop-blur border border-slate-200/70 dark:border-slate-700/70"
                    style={{ color: health.color }}
                  >
                    <CircleDot className="h-3 w-3" style={{ color: health.color }} />
                    {health.label}
                  </span>
                )}
              </div>
              <p className="text-slate-600 dark:text-slate-400 mt-1 text-sm sm:text-base">
                Here's what's happening with your business today.
              </p>
              <div className="flex items-center gap-2 mt-3 flex-wrap text-xs text-slate-500 dark:text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <CalendarCheck className="h-3.5 w-3.5" />
                  {formatFriendlyDate(now)}
                </span>
                {summary && summary.monthPaidCount > 0 && (
                  <>
                    <span className="text-slate-300 dark:text-slate-700">•</span>
                    <span className="inline-flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                      {summary.monthPaidCount} paid this month
                    </span>
                  </>
                )}
                {summary && summary.overdueCount > 0 && (
                  <>
                    <span className="text-slate-300 dark:text-slate-700">•</span>
                    <span className="inline-flex items-center gap-1.5 text-red-600 dark:text-red-400 font-medium">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {summary.overdueCount} overdue
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchData(true)}
              disabled={refreshing || loading}
              className="bg-white/70 dark:bg-slate-900/60 backdrop-blur border-slate-200 dark:border-slate-700"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <NewClientDialog onSuccess={() => fetchData(true)} />
            <Link href="/invoices/new">
              <Button size="sm" className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25">
                <FilePlus2 className="h-4 w-4 mr-2" />
                New Invoice
              </Button>
            </Link>
          </div>
        </div>

        {/* Health strip */}
        {health && !loading && summary && (
          <div className="relative border-t border-slate-200/60 dark:border-slate-800/60 px-6 sm:px-8 py-3 bg-white/50 dark:bg-slate-900/40">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <Activity className="h-4 w-4 shrink-0" style={{ color: health.color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-3 mb-1">
                    <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                      Business health · Collection rate {health.collectRate.toFixed(0)}%
                    </p>
                    <p className="text-xs font-bold tabular-nums" style={{ color: health.color }}>
                      {health.score}/100
                    </p>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${health.score}%` }}
                      transition={{ duration: 0.9, ease: "easeOut", delay: 0.2 }}
                      className="h-full rounded-full"
                      style={{
                        background: `linear-gradient(90deg, ${health.color}, ${health.color}cc)`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </motion.div>

      {/* -------------------------------------------------------------- LOADING */}
      {loading ? (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i} className="animate-pulse border-slate-200/70 dark:border-slate-800/70 bg-white/60 dark:bg-slate-900/40">
              <CardContent className="p-5">
                <div className="h-10 w-10 rounded-xl bg-slate-200 dark:bg-slate-800 mb-4" />
                <div className="h-3 w-24 bg-slate-200 dark:bg-slate-800 rounded mb-2" />
                <div className="h-7 w-36 bg-slate-200 dark:bg-slate-800 rounded mb-3" />
                <div className="h-3 w-full bg-slate-100 dark:bg-slate-800/50 rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : error ? (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30">
          <CardContent className="py-10 text-center text-red-700 dark:text-red-300">
            <AlertTriangle className="h-10 w-10 mx-auto mb-3 opacity-80" />
            <p className="font-medium">{error}</p>
            <Button onClick={() => fetchData(true)} variant="outline" className="mt-3">
              <RefreshCw className="h-4 w-4 mr-2" /> Retry
            </Button>
          </CardContent>
        </Card>
      ) : summary ? (
        <>
          {/* -------------------------------------------------------------- KPI GRID */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {statCards.map((card, i) => {
              const value =
                card.key === "revenue" ? summary.totalRevenue
                : card.key === "monthRevenue" ? summary.monthRevenue
                : card.key === "pending" ? summary.pendingAmount
                : card.key === "overdue" ? summary.overdueAmount
                : card.key === "clients" ? summary.totalClients
                : pnl?.currentMonth?.profit ?? 0;
              const trend = card.trend ? card.trend(summary, pnl) : null;
              const spark = card.spark ? card.spark(summary, pnl, monthlyRevenue) ?? [] : [];
              const isDanger = card.tone === "danger" && summary.overdueCount > 0;
              return (
                <StatCardView
                  key={card.key}
                  card={card}
                  value={value}
                  sub={card.sub(summary, pnl)}
                  trend={trend}
                  spark={spark}
                  isDanger={isDanger}
                  index={i}
                />
              );
            })}
          </div>

          {/* -------------------------------------------------------------- QUICK ACTIONS */}
          <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-5 no-print">
            <QuickAction
              href="/invoices/new"
              icon={FilePlus2}
              title="New Invoice"
              subtitle="Bill a client"
              gradient="bg-gradient-to-br from-blue-500 to-indigo-600"
              iconColor="text-white"
              hoverFrom="from-blue-50"
              hoverTo="to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30"
              delay={0.05}
            />
            <NewClientDialog
              trigger={
                <QuickAction
                  icon={UserPlus}
                  title="Add Client"
                  subtitle="New customer"
                  gradient="bg-gradient-to-br from-emerald-500 to-teal-500"
                  iconColor="text-white"
                  hoverFrom="from-emerald-50"
                  hoverTo="to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30"
                  delay={0.1}
                />
              }
              onSuccess={() => fetchData(true)}
            />
            <QuickAction
              href="/recurring"
              icon={RefreshCw}
              title="Recurring"
              subtitle="Auto-billing"
              gradient="bg-gradient-to-br from-violet-500 to-purple-600"
              iconColor="text-white"
              hoverFrom="from-violet-50"
              hoverTo="to-purple-50 dark:from-violet-950/30 dark:to-purple-950/30"
              delay={0.15}
            />
            <QuickAction
              href="/expenses"
              icon={Receipt}
              title="Expenses"
              subtitle="Track costs"
              gradient="bg-gradient-to-br from-amber-500 to-orange-500"
              iconColor="text-white"
              hoverFrom="from-amber-50"
              hoverTo="to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30"
              delay={0.2}
            />
            <QuickAction
              href="/settings"
              icon={SettingsIcon}
              title="Settings"
              subtitle="Branding & tax"
              gradient="bg-gradient-to-br from-slate-600 to-slate-700"
              iconColor="text-white"
              hoverFrom="from-slate-50"
              hoverTo="to-slate-100 dark:from-slate-800/40 dark:to-slate-900/40"
              delay={0.25}
            />
          </div>

          {/* -------------------------------------------------------------- CHARTS + SIDE */}
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-6">
              <RevenueChart data={monthlyRevenue ?? []} />
              <PnlChart data={pnl?.points ?? []} />

              {/* Recent invoices table */}
              <Card className="border-slate-200/70 dark:border-slate-800/70 bg-white/80 dark:bg-slate-900/60 backdrop-blur-sm overflow-hidden">
                <CardHeader className="flex flex-row items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <FileText className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                      Recent Invoices
                    </CardTitle>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Your latest {summary.recentInvoices.length} invoice{summary.recentInvoices.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <Link href="/invoices" className="text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 flex items-center gap-1 no-print font-medium hover:gap-2 transition-all">
                    View all <ArrowRight className="h-4 w-4" />
                  </Link>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Invoice #</TableHead>
                        <TableHead>Client</TableHead>
                        <TableHead className="hidden md:table-cell">Issue Date</TableHead>
                        <TableHead className="hidden md:table-cell">Status</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.recentInvoices.map((inv) => (
                        <TableRow key={inv.id} className="group">
                          <TableCell className="font-medium">
                            <Link
                              href={`/invoices/${inv.id}`}
                              className="text-blue-600 dark:text-blue-400 hover:underline group-hover:text-blue-700 dark:group-hover:text-blue-300"
                            >
                              {inv.invoiceNumber}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2.5">
                              <div className="h-8 w-8 rounded-full bg-gradient-to-br from-blue-100 to-indigo-100 dark:from-blue-900 dark:to-indigo-900 flex items-center justify-center text-xs font-semibold text-blue-700 dark:text-blue-300">
                                {inv.client.name.charAt(0).toUpperCase()}
                              </div>
                              <span className="font-medium text-slate-900 dark:text-slate-200 truncate max-w-[140px] sm:max-w-none">
                                {inv.client.name}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-slate-500 dark:text-slate-400">
                            {formatDate(inv.issueDate)}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <StatusBadge status={inv.status} />
                          </TableCell>
                          <TableCell className="text-right font-semibold text-slate-900 dark:text-white tabular-nums">
                            {formatCurrency(inv.totalAmount)}
                          </TableCell>
                        </TableRow>
                      ))}
                      {summary.recentInvoices.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center py-14 text-slate-400">
                            <FileText className="h-12 w-12 mx-auto mb-3 opacity-50" />
                            <p className="text-sm">No invoices yet — create your first one to get started.</p>
                            <Link href="/invoices/new" className="mt-3 inline-block">
                              <Button size="sm" variant="outline">
                                <FilePlus2 className="h-4 w-4 mr-2" />
                                Create invoice
                              </Button>
                            </Link>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>

            {/* Right column — action & insights stack */}
            <div className="space-y-6">
              <OverdueInvoices />
              <AgingWidget />
              <TaxCollected />
              <ExpenseTracker currency={settings?.currency ?? "INR"} />
              <RecentActivity limit={8} />
              <UpcomingRecurring />
            </div>
          </div>
        </>
      ) : null}
    </PageTransition>
  );
}
