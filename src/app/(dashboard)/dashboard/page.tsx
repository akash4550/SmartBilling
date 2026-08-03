"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarCheck,
  CheckCircle2,
  Clock,
  FileText,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";

import { NewClientDialog } from "@/components/clients/new-client-dialog";
import { AgingWidget } from "@/components/dashboard/aging-widget";
import { ExpenseTracker } from "@/components/dashboard/expense-tracker";
import { OverdueInvoices } from "@/components/dashboard/overdue-invoices";
import { PnlChart, type PnlDatum } from "@/components/dashboard/pnl-chart";
import { RecentActivity } from "@/components/dashboard/recent-activity";
import {
  RevenueChart,
  type RevenueDatum,
} from "@/components/dashboard/revenue-chart";
import { TaxCollected } from "@/components/dashboard/tax-collected";
import { UpcomingRecurring } from "@/components/dashboard/upcoming-recurring";
import { PageTransition } from "@/components/page-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/utils";
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
  totals: {
    revenue: number;
    expenses: number;
    profit: number;
    margin: number;
  };
  currentMonth: {
    revenue: number;
    expenses: number;
    profit: number;
  } | null;
  categories: Array<{ name: string; amount: number }>;
}

interface RevenueResponse {
  points: Array<{
    key: string;
    label: string;
    revenue: number;
  }>;
  currency: string;
}

interface SettingsLite {
  currency: string;
}

type StatTone = "blue" | "amber" | "red" | "emerald";

interface PrimaryStat {
  label: string;
  value: number;
  detail: string;
  href: string;
  icon: typeof TrendingUp;
  tone: StatTone;
}

const toneClasses: Record<
  StatTone,
  {
    icon: string;
    iconBox: string;
    accent: string;
    hover: string;
  }
> = {
  blue: {
    icon: "text-blue-600 dark:text-blue-300",
    iconBox: "bg-blue-50 dark:bg-blue-950/60",
    accent: "bg-blue-500",
    hover: "hover:border-blue-300 dark:hover:border-blue-800",
  },
  amber: {
    icon: "text-amber-600 dark:text-amber-300",
    iconBox: "bg-amber-50 dark:bg-amber-950/60",
    accent: "bg-amber-500",
    hover: "hover:border-amber-300 dark:hover:border-amber-800",
  },
  red: {
    icon: "text-red-600 dark:text-red-300",
    iconBox: "bg-red-50 dark:bg-red-950/60",
    accent: "bg-red-500",
    hover: "hover:border-red-300 dark:hover:border-red-900",
  },
  emerald: {
    icon: "text-emerald-600 dark:text-emerald-300",
    iconBox: "bg-emerald-50 dark:bg-emerald-950/60",
    accent: "bg-emerald-500",
    hover: "hover:border-emerald-300 dark:hover:border-emerald-800",
  },
};

function formatCompactAmount(value: number, currency: string): string {
  if (currency.toUpperCase() !== "INR") {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }

  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (absolute >= 10_000_000) {
    return `${sign}₹${new Intl.NumberFormat("en-IN", {
      maximumFractionDigits: 1,
    }).format(absolute / 10_000_000)}Cr`;
  }

  if (absolute >= 100_000) {
    return `${sign}₹${new Intl.NumberFormat("en-IN", {
      maximumFractionDigits: 1,
    }).format(absolute / 100_000)}L`;
  }

  if (absolute >= 1_000) {
    return `${sign}₹${new Intl.NumberFormat("en-IN", {
      maximumFractionDigits: 1,
    }).format(absolute / 1_000)}K`;
  }

  return formatCurrency(value);
}

function StatusBadge({
  status,
}: {
  status: "DRAFT" | "PENDING" | "PAID" | "VOID";
}) {
  const config = {
    DRAFT: { variant: "draft" as const, label: "Draft" },
    PENDING: { variant: "warning" as const, label: "Pending" },
    PAID: { variant: "success" as const, label: "Paid" },
    VOID: { variant: "neutral" as const, label: "Void" },
  };

  const { variant, label } = config[status];
  return <Badge variant={variant}>{label}</Badge>;
}

function WidgetSlot({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 [&>*]:h-full ${className}`}>
      {children}
    </div>
  );
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [monthlyRevenue, setMonthlyRevenue] = useState<RevenueDatum[]>([]);
  const [pnl, setPnl] = useState<PnlResponse | null>(null);
  const [currency, setCurrency] = useState("INR");
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

      if (!summaryRes.ok) {
        throw new Error("Failed to load dashboard summary");
      }

      const summaryData: SummaryResponse = await summaryRes.json();
      setSummary(summaryData);

      if (revenueRes.ok) {
        const revenueData: RevenueResponse = await revenueRes.json();
        setMonthlyRevenue(
          revenueData.points.map((point) => ({
            month: point.label,
            revenue: point.revenue,
          }))
        );
      } else {
        setMonthlyRevenue([]);
      }

      if (settingsRes.ok) {
        const settings: SettingsLite = await settingsRes.json();
        setCurrency(settings.currency || "INR");
      }

      if (pnlRes.ok) {
        const pnlData: PnlResponse = await pnlRes.json();
        setPnl(pnlData);
      }
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to load dashboard"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchData();
    }, 0);

    return () => clearTimeout(timer);
  }, [fetchData]);

  const currentMonthProfit = pnl?.currentMonth?.profit ?? 0;
  const currentMonthRevenue = pnl?.currentMonth?.revenue ?? 0;
  const currentMonthMargin =
    currentMonthRevenue > 0
      ? (currentMonthProfit / currentMonthRevenue) * 100
      : 0;

  const primaryStats: PrimaryStat[] = summary
    ? [
        {
          label: "Total Revenue",
          value: summary.totalRevenue,
          detail: `${summary.paidCount} paid invoices`,
          href: "/invoices?status=PAID",
          icon: TrendingUp,
          tone: "blue",
        },
        {
          label: "Outstanding",
          value: summary.pendingAmount,
          detail: `${summary.pendingCount} pending invoice${
            summary.pendingCount === 1 ? "" : "s"
          }`,
          href: "/invoices?status=PENDING",
          icon: Clock,
          tone: "amber",
        },
        {
          label: "Overdue",
          value: summary.overdueAmount,
          detail: `${summary.overdueCount} overdue invoice${
            summary.overdueCount === 1 ? "" : "s"
          }`,
          href: "/invoices?status=OVERDUE",
          icon: AlertTriangle,
          tone: "red",
        },
        {
          label: "Net Profit (MTD)",
          value: currentMonthProfit,
          detail: `${currentMonthMargin.toFixed(1)}% margin`,
          href: "/expenses",
          icon: Wallet,
          tone: "emerald",
        },
      ]
    : [];

  return (
    <PageTransition className="space-y-6 lg:space-y-8">
      <section className="no-print flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-1 text-sm font-medium text-blue-600 dark:text-blue-400">
            Business overview
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-950 dark:text-white">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 sm:text-base">
            Revenue, receivables, expenses, and recent billing activity.
          </p>
        </div>

        <NewClientDialog onSuccess={fetchData} />
      </section>

      {loading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[1, 2, 3, 4].map((item) => (
              <Card
                key={item}
                className="min-h-40 animate-pulse border-slate-200/70 dark:border-slate-800"
              >
                <CardHeader className="pb-3">
                  <div className="h-4 w-28 rounded bg-slate-200 dark:bg-slate-800" />
                </CardHeader>
                <CardContent>
                  <div className="h-9 w-36 rounded bg-slate-200 dark:bg-slate-800" />
                  <div className="mt-3 h-3 w-24 rounded bg-slate-100 dark:bg-slate-800/60" />
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid gap-6 xl:grid-cols-12">
            <div className="h-[420px] animate-pulse rounded-xl bg-slate-100 xl:col-span-8 dark:bg-slate-900" />
            <div className="h-[420px] animate-pulse rounded-xl bg-slate-100 xl:col-span-4 dark:bg-slate-900" />
          </div>
        </div>
      ) : error ? (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30">
          <CardContent className="py-10 text-center text-red-700 dark:text-red-300">
            <p>{error}</p>
            <Button onClick={fetchData} variant="outline" className="mt-4">
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : summary ? (
        <>
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {primaryStats.map((stat) => {
              const Icon = stat.icon;
              const tone = toneClasses[stat.tone];
              const isOverdue = stat.tone === "red" && summary.overdueCount > 0;

              return (
                <Link key={stat.label} href={stat.href} className="min-w-0">
                  <Card
                    className={[
                      "group relative h-full min-h-40 overflow-hidden border-slate-200/70 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md dark:border-slate-800",
                      tone.hover,
                      isOverdue
                        ? "bg-red-50/50 dark:bg-red-950/15"
                        : "bg-white dark:bg-slate-900",
                    ].join(" ")}
                  >
                    <div
                      className={`absolute inset-x-0 top-0 h-1 ${tone.accent}`}
                    />

                    <CardContent className="flex h-full flex-col justify-between p-5">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
                            {stat.label}
                          </p>
                          <p
                            className="mt-3 truncate text-3xl font-bold tracking-tight text-slate-950 dark:text-white"
                            title={formatCurrency(stat.value)}
                          >
                            {formatCompactAmount(stat.value, currency)}
                          </p>
                        </div>

                        <div
                          className={`shrink-0 rounded-xl p-2.5 ${tone.iconBox}`}
                        >
                          <Icon className={`h-5 w-5 ${tone.icon}`} />
                        </div>
                      </div>

                      <div className="mt-5 flex items-center justify-between gap-3">
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {stat.detail}
                        </p>
                        <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition-transform group-hover:translate-x-1 group-hover:text-slate-500 dark:text-slate-700" />
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </section>

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card className="border-slate-200/70 shadow-none dark:border-slate-800">
              <CardContent className="flex items-center gap-3 p-4">
                <div className="rounded-lg bg-emerald-50 p-2 dark:bg-emerald-950/50">
                  <CalendarCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Paid this month
                  </p>
                  <div className="mt-0.5 flex items-center gap-2">
                    <p
                      className="truncate font-semibold text-slate-950 dark:text-white"
                      title={formatCurrency(summary.monthRevenue)}
                    >
                      {formatCompactAmount(summary.monthRevenue, currency)}
                    </p>
                    {summary.monthTrend !== null && (
                      <span
                        className={`hidden items-center text-xs font-medium sm:inline-flex ${
                          summary.monthTrend >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }`}
                      >
                        {summary.monthTrend >= 0 ? (
                          <ArrowUpRight className="mr-0.5 h-3 w-3" />
                        ) : (
                          <ArrowDownRight className="mr-0.5 h-3 w-3" />
                        )}
                        {Math.abs(summary.monthTrend)}%
                      </span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200/70 shadow-none dark:border-slate-800">
              <CardContent className="flex items-center gap-3 p-4">
                <div className="rounded-lg bg-indigo-50 p-2 dark:bg-indigo-950/50">
                  <Users className="h-4 w-4 text-indigo-600 dark:text-indigo-300" />
                </div>
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Active clients
                  </p>
                  <p className="mt-0.5 font-semibold text-slate-950 dark:text-white">
                    {summary.totalClients.toLocaleString("en-IN")}
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200/70 shadow-none dark:border-slate-800">
              <CardContent className="flex items-center gap-3 p-4">
                <div className="rounded-lg bg-blue-50 p-2 dark:bg-blue-950/50">
                  <CheckCircle2 className="h-4 w-4 text-blue-600 dark:text-blue-300" />
                </div>
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Paid invoices
                  </p>
                  <p className="mt-0.5 font-semibold text-slate-950 dark:text-white">
                    {summary.paidCount.toLocaleString("en-IN")}
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200/70 shadow-none dark:border-slate-800">
              <CardContent className="flex items-center gap-3 p-4">
                <div className="rounded-lg bg-slate-100 p-2 dark:bg-slate-800">
                  <FileText className="h-4 w-4 text-slate-600 dark:text-slate-300" />
                </div>
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Total invoices
                  </p>
                  <p className="mt-0.5 font-semibold text-slate-950 dark:text-white">
                    {summary.totalInvoices.toLocaleString("en-IN")}
                  </p>
                </div>
              </CardContent>
            </Card>
          </section>

          <section className="grid grid-cols-1 gap-6 xl:grid-cols-12">
            <WidgetSlot className="xl:col-span-8">
              <RevenueChart data={monthlyRevenue} />
            </WidgetSlot>

            <WidgetSlot className="xl:col-span-4">
              <OverdueInvoices />
            </WidgetSlot>

            <WidgetSlot className="xl:col-span-8">
              <PnlChart data={pnl?.points ?? []} />
            </WidgetSlot>

            <WidgetSlot className="xl:col-span-4">
              <AgingWidget />
            </WidgetSlot>
          </section>

          <Card className="overflow-hidden border-slate-200/70 shadow-sm dark:border-slate-800">
            <CardHeader className="flex flex-row items-center justify-between border-b border-slate-100 bg-slate-50/70 py-4 dark:border-slate-800 dark:bg-slate-900/60">
              <div>
                <CardTitle className="text-base">Recent Invoices</CardTitle>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Latest billing activity across your clients
                </p>
              </div>

              <Link
                href="/invoices"
                className="no-print flex items-center gap-1 text-sm font-medium text-blue-600 transition-all hover:gap-2 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
              >
                View all
                <ArrowRight className="h-4 w-4" />
              </Link>
            </CardHeader>

            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="min-w-40">Invoice #</TableHead>
                    <TableHead className="min-w-48">Client</TableHead>
                    <TableHead className="hidden md:table-cell">
                      Issue Date
                    </TableHead>
                    <TableHead className="hidden md:table-cell">
                      Status
                    </TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {summary.recentInvoices.map((invoice) => (
                    <TableRow key={invoice.id} className="group">
                      <TableCell className="font-medium">
                        <Link
                          href={`/invoices/${invoice.id}`}
                          className="text-blue-600 hover:underline group-hover:text-blue-700 dark:text-blue-400 dark:group-hover:text-blue-300"
                        >
                          {invoice.invoiceNumber}
                        </Link>
                      </TableCell>

                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                            {invoice.client.name.charAt(0).toUpperCase()}
                          </div>
                          <span className="truncate font-medium text-slate-900 dark:text-slate-200">
                            {invoice.client.name}
                          </span>
                        </div>
                      </TableCell>

                      <TableCell className="hidden text-slate-500 md:table-cell dark:text-slate-400">
                        {formatDate(invoice.issueDate)}
                      </TableCell>

                      <TableCell className="hidden md:table-cell">
                        <StatusBadge status={invoice.status} />
                      </TableCell>

                      <TableCell className="text-right font-semibold tabular-nums text-slate-900 dark:text-white">
                        {formatCurrency(invoice.totalAmount)}
                      </TableCell>
                    </TableRow>
                  ))}

                  {summary.recentInvoices.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="py-14 text-center text-slate-400"
                      >
                        <FileText className="mx-auto mb-3 h-10 w-10 opacity-50" />
                        <p>
                          No invoices yet — create your first one to get
                          started.
                        </p>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <section className="grid grid-cols-1 gap-6 xl:grid-cols-12">
            <WidgetSlot className="xl:col-span-6">
              <TaxCollected />
            </WidgetSlot>

            <WidgetSlot className="xl:col-span-6">
              <ExpenseTracker currency={currency} />
            </WidgetSlot>

            <WidgetSlot className="xl:col-span-8">
              <RecentActivity limit={5} />
            </WidgetSlot>

            <WidgetSlot className="xl:col-span-4">
              <UpcomingRecurring />
            </WidgetSlot>
          </section>
        </>
      ) : null}
    </PageTransition>
  );
}