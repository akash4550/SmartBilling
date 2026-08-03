"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
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
  Clock,
  FilePlus2,
  UserPlus,
  TrendingUp,
  RefreshCw,
  ArrowRight,
  ArrowUpRight,
  AlertTriangle,
  CalendarCheck,
  Wallet,
  Receipt,
  Settings as SettingsIcon,
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
import type { InvoiceWithRelations } from "@/types";

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
}

interface StatCard {
  key: "revenue" | "monthRevenue" | "pending" | "overdue" | "clients" | "profit";
  label: string;
  icon: typeof TrendingUp;
  iconBg: string;
  iconColor: string;
  format: (v: number) => string;
  sub: (s: SummaryResponse, p?: PnlResponse | null) => string;
  trend?: (s: SummaryResponse, p?: PnlResponse | null) => string | null;
  href?: string;
  highlight?: boolean;
}

const statCards: StatCard[] = [
  {
    key: "monthRevenue",
    label: "Paid This Month",
    icon: CalendarCheck,
    iconBg: "bg-emerald-100 dark:bg-emerald-950/50",
    iconColor: "text-emerald-700 dark:text-emerald-400",
    format: (v) => formatCurrency(v),
    sub: (s) => `${s.monthPaidCount} paid this month`,
    trend: (s) =>
      s.monthTrend === null
        ? null
        : s.monthTrend >= 0
          ? `+${s.monthTrend}% vs last month`
          : `${s.monthTrend}% vs last month`,
    href: "/invoices?status=PAID",
  },
  {
    key: "revenue",
    label: "Total Revenue",
    icon: TrendingUp,
    iconBg: "bg-blue-100 dark:bg-blue-950/50",
    iconColor: "text-blue-700 dark:text-blue-400",
    format: (v) => formatCurrency(v),
    sub: (s) => `${s.paidCount} paid invoices all-time`,
    href: "/invoices?status=PAID",
  },
  {
    key: "pending",
    label: "Outstanding",
    icon: Clock,
    iconBg: "bg-amber-100 dark:bg-amber-950/50",
    iconColor: "text-amber-700 dark:text-amber-400",
    format: (v) => formatCurrency(v),
    sub: (s) => `${s.pendingCount} pending invoice${s.pendingCount === 1 ? "" : "s"}`,
    href: "/invoices?status=PENDING",
  },
  {
    key: "overdue",
    label: "Overdue",
    icon: AlertTriangle,
    iconBg: "bg-red-100 dark:bg-red-950/50",
    iconColor: "text-red-700 dark:text-red-400",
    format: (v) => formatCurrency(v),
    sub: (s) => `${s.overdueCount} overdue invoice${s.overdueCount === 1 ? "" : "s"}`,
    href: "/invoices?status=OVERDUE",
    highlight: true,
  },
  {
    key: "clients",
    label: "Total Clients",
    icon: Users,
    iconBg: "bg-indigo-100 dark:bg-indigo-950/50",
    iconColor: "text-indigo-700 dark:text-indigo-400",
    format: (v) => v.toLocaleString(),
    sub: () => "Active customers",
    href: "/clients",
  },
  {
    key: "profit",
    label: "Net Profit (MTD)",
    icon: Wallet,
    iconBg: "bg-emerald-100 dark:bg-emerald-950/50",
    iconColor: "text-emerald-700 dark:text-emerald-400",
    format: (v) => formatCurrency(v),
    sub: (_s, p) => {
      const m = p?.totals.margin ?? 0;
      return `${m.toFixed(1)}% margin`;
    },
    href: "/expenses",
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



export default function DashboardPage() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [monthlyRevenue, setMonthlyRevenue] = useState<RevenueDatum[] | null>(null);
  const [pnl, setPnl] = useState<PnlResponse | null>(null);
  const [currency, setCurrency] = useState<string>("INR");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
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
        setCurrency(s.currency || "INR");
      }
      if (pnlRes.ok) {
        const p: PnlResponse = await pnlRes.json();
        setPnl(p);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void fetchData(); }, 0);
    return () => clearTimeout(timer);
  }, [fetchData]);

  return (
    <PageTransition className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between no-print">
        <div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">
            Dashboard
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            Welcome back — here&apos;s an overview of your billing
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <NewClientDialog onSuccess={fetchData} />
          <Link href="/invoices/new">
            <Button className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25">
              <FilePlus2 className="h-4 w-4 mr-2" />
              New Invoice
            </Button>
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i} className="animate-pulse border-none">
              <CardHeader className="pb-2"><div className="h-4 w-28 bg-slate-200 dark:bg-slate-800 rounded" /></CardHeader>
              <CardContent><div className="h-8 w-36 bg-slate-200 dark:bg-slate-800 rounded" /><div className="h-3 w-24 bg-slate-100 dark:bg-slate-800/50 rounded mt-2" /></CardContent>
            </Card>
          ))}
        </div>
      ) : error ? (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30">
          <CardContent className="py-8 text-center text-red-700 dark:text-red-300">
            <p>{error}</p>
            <Button onClick={fetchData} variant="outline" className="mt-3">Retry</Button>
          </CardContent>
        </Card>
      ) : summary ? (
        <>
          <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
            {statCards.map((card) => {
              const value =
                card.key === "revenue" ? summary.totalRevenue
                : card.key === "monthRevenue" ? summary.monthRevenue
                : card.key === "pending" ? summary.pendingAmount
                : card.key === "overdue" ? summary.overdueAmount
                : card.key === "clients" ? summary.totalClients
                : pnl?.currentMonth?.profit ?? 0;
              const trend = card.trend ? card.trend(summary, pnl) : null;
              const Icon = card.icon;
              const trendPositive = trend && !trend.startsWith("-");
              const Wrapper: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) =>
                card.href
                  ? (<Link href={card.href} className={className}>{children}</Link>)
                  : (<div className={className}>{children}</div>);
              return (
                <Wrapper key={card.key}>
                  <Card className={[
                    "border-none shadow-sm hover:shadow-xl transition-all duration-300 group overflow-hidden relative h-full",
                    card.highlight && summary.overdueCount > 0 ? "ring-1 ring-red-200 dark:ring-red-900/50 bg-gradient-to-br from-red-50/60 to-transparent dark:from-red-950/20" : "",
                    card.href ? "cursor-pointer hover:border-red-200" : "",
                  ].join(" ")}>
                    <div className="absolute inset-0 bg-gradient-to-br from-white to-transparent dark:from-slate-800/50 dark:to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                    <CardHeader className="flex flex-row items-center justify-between pb-2 relative">
                      <CardTitle className="text-xs sm:text-sm font-medium text-slate-500 dark:text-slate-400">{card.label}</CardTitle>
                      <div className={`p-2.5 rounded-xl ${card.iconBg} transition-transform group-hover:scale-110`}>
                        <Icon className={`h-4 w-4 ${card.iconColor}`} />
                      </div>
                    </CardHeader>
                    <CardContent className="relative">
                      <div className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight break-words">
                        {card.format(value)}
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {trend !== null && (
                          <span className={`inline-flex items-center text-xs font-medium ${trendPositive ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                            <ArrowUpRight className={`h-3 w-3 mr-0.5 ${trendPositive ? "" : "rotate-90"}`} />
                            {trend}
                          </span>
                        )}
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {card.sub(summary, pnl)}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                </Wrapper>
              );
            })}
          </div>

          <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-5 no-print">
            <Link href="/invoices/new">
              <Card className="hover:border-blue-200 dark:hover:border-blue-800 hover:shadow-xl transition-all duration-300 cursor-pointer group relative overflow-hidden border-slate-200/60 dark:border-slate-800/60 h-full">
                <div className="absolute inset-0 bg-gradient-to-r from-blue-500/5 to-indigo-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                <CardContent className="flex items-center gap-3 py-4 relative h-full">
                  <div className="p-2.5 rounded-xl bg-gradient-to-br from-blue-100 to-blue-50 dark:from-blue-900/50 dark:to-blue-950/50 group-hover:from-blue-600 group-hover:to-indigo-600 transition-all duration-300 shrink-0">
                    <FilePlus2 className="h-5 w-5 text-blue-700 dark:text-blue-300 group-hover:text-white transition-colors" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-900 dark:text-white text-sm">New Invoice</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">Bill a client</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
            <NewClientDialog
              trigger={
                <Card className="hover:border-emerald-200 dark:hover:border-emerald-800 hover:shadow-xl transition-all duration-300 cursor-pointer group w-full text-left relative overflow-hidden border-slate-200/60 dark:border-slate-800/60 h-full">
                  <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/5 to-green-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                  <CardContent className="flex items-center gap-3 py-4 relative h-full">
                    <div className="p-2.5 rounded-xl bg-gradient-to-br from-emerald-100 to-emerald-50 dark:from-emerald-900/50 dark:to-emerald-950/50 group-hover:from-emerald-600 group-hover:to-green-600 transition-all duration-300 shrink-0">
                      <UserPlus className="h-5 w-5 text-emerald-700 dark:text-emerald-300 group-hover:text-white transition-colors" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-900 dark:text-white text-sm">Add Client</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400 truncate">New customer</p>
                    </div>
                  </CardContent>
                </Card>
              }
              onSuccess={fetchData}
            />
            <Link href="/recurring">
              <Card className="hover:border-violet-200 dark:hover:border-violet-800 hover:shadow-xl transition-all duration-300 cursor-pointer group relative overflow-hidden border-slate-200/60 dark:border-slate-800/60 h-full">
                <div className="absolute inset-0 bg-gradient-to-r from-violet-500/5 to-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                <CardContent className="flex items-center gap-3 py-4 relative h-full">
                  <div className="p-2.5 rounded-xl bg-gradient-to-br from-violet-100 to-purple-50 dark:from-violet-900/50 dark:to-purple-950/50 group-hover:from-violet-600 group-hover:to-purple-600 transition-all duration-300 shrink-0">
                    <RefreshCw className="h-5 w-5 text-violet-700 dark:text-violet-300 group-hover:text-white transition-colors" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-900 dark:text-white text-sm">Recurring</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">Auto-billing</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
            <Link href="/expenses">
              <Card className="hover:border-amber-200 dark:hover:border-amber-800 hover:shadow-xl transition-all duration-300 cursor-pointer group relative overflow-hidden border-slate-200/60 dark:border-slate-800/60 h-full">
                <div className="absolute inset-0 bg-gradient-to-r from-amber-500/5 to-orange-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                <CardContent className="flex items-center gap-3 py-4 relative h-full">
                  <div className="p-2.5 rounded-xl bg-gradient-to-br from-amber-100 to-orange-50 dark:from-amber-900/50 dark:to-orange-950/50 group-hover:from-amber-600 group-hover:to-orange-600 transition-all duration-300 shrink-0">
                    <Receipt className="h-5 w-5 text-amber-700 dark:text-amber-300 group-hover:text-white transition-colors" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-900 dark:text-white text-sm">Expenses</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">Track costs</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
            <Link href="/settings">
              <Card className="hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-xl transition-all duration-300 cursor-pointer group relative overflow-hidden border-slate-200/60 dark:border-slate-800/60 h-full">
                <div className="absolute inset-0 bg-gradient-to-r from-slate-500/5 to-slate-400/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                <CardContent className="flex items-center gap-3 py-4 relative h-full">
                  <div className="p-2.5 rounded-xl bg-gradient-to-br from-slate-100 to-slate-50 dark:from-slate-800 dark:to-slate-900 group-hover:from-slate-700 group-hover:to-slate-800 transition-all duration-300 shrink-0">
                    <SettingsIcon className="h-5 w-5 text-slate-700 dark:text-slate-300 group-hover:text-white transition-colors" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-900 dark:text-white text-sm">Settings</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">Branding, tax</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-6">
              <RevenueChart data={monthlyRevenue ?? []} />
              <PnlChart data={pnl?.points ?? []} />
            </div>
            <div className="space-y-6">
              <OverdueInvoices />
              <AgingWidget />
              <TaxCollected />
              <ExpenseTracker currency={currency} />
              <RecentActivity limit={8} />
              <UpcomingRecurring />
            </div>
          </div>

          <Card className="border-slate-200/60 dark:border-slate-800/60 overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20">
              <CardTitle className="text-base">Recent Invoices</CardTitle>
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
                        <Link href={`/invoices/${inv.id}`} className="text-blue-600 dark:text-blue-400 hover:underline group-hover:text-blue-700 dark:group-hover:text-blue-300">
                          {inv.invoiceNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <div className="h-8 w-8 rounded-full bg-gradient-to-br from-blue-100 to-indigo-100 dark:from-blue-900 dark:to-indigo-900 flex items-center justify-center text-xs font-semibold text-blue-700 dark:text-blue-300">
                            {inv.client.name.charAt(0).toUpperCase()}
                          </div>
                          <span className="font-medium text-slate-900 dark:text-slate-200">{inv.client.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-slate-500 dark:text-slate-400">{formatDate(inv.issueDate)}</TableCell>
                      <TableCell className="hidden md:table-cell"><StatusBadge status={inv.status} /></TableCell>
                      <TableCell className="text-right font-semibold text-slate-900 dark:text-white tabular-nums">{formatCurrency(inv.totalAmount)}</TableCell>
                    </TableRow>
                  ))}
                  {summary.recentInvoices.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-12 text-slate-400">
                        <FileText className="h-12 w-12 mx-auto mb-3 opacity-50" />
                        <p>No invoices yet — create your first one to get started.</p>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      ) : null}
    </PageTransition>
  );
}
