import Link from "next/link";
import { notFound } from "next/navigation";
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
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  ArrowLeft,
  Mail,
  MapPin,
  FileText,
  Calendar,
  TrendingUp,
  CheckCircle2,
  Clock,
  Plus,
  Phone,
  StickyNote,
  CalendarClock,
  Ban,
  User,
  Receipt,
  Sparkles,
  ArrowUpRight,
} from "lucide-react";
import { EditClientButton } from "@/components/clients/edit-client-button";
import { DownloadStatementButton } from "@/components/clients/download-statement-button";
import { PortalLinkSection } from "@/components/clients/portal-link-section";

export const revalidate = 10;

async function getClient(userId: string, id: string) {
  try {
    return await prisma.client.findFirst({
      where: { id, userId },
      include: {
        invoices: {
          orderBy: { createdAt: "desc" },
          include: { items: true },
        },
      },
    });
  } catch {
    return null;
  }
}

function StatusBadge({ status }: { status: "DRAFT" | "PENDING" | "PAID" | "VOID" }) {
  const config = {
    DRAFT: { variant: "draft" as const, label: "Draft", icon: Clock },
    PENDING: { variant: "warning" as const, label: "Pending", icon: Clock },
    PAID: { variant: "success" as const, label: "Paid", icon: CheckCircle2 },
    VOID: { variant: "neutral" as const, label: "Void", icon: Ban },
  };
  const { variant, label, icon: Icon } = config[status];
  return (
    <Badge variant={variant} className="gap-1">
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}

// Keep PageHeader server-friendly (no framer-motion dependency) so this RSC
// can use it without pulling in client bundles.
function PageHeader({
  name,
  initials,
  createdAt,
  children,
}: {
  name: string;
  initials: string;
  createdAt: Date;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-200/70 dark:border-slate-800/70 bg-gradient-to-br from-white via-blue-50/30 to-indigo-50/50 dark:from-slate-900 dark:via-slate-900 dark:to-indigo-950/30 shadow-sm">
      <div aria-hidden className="absolute -top-20 -right-20 h-60 w-60 rounded-full bg-blue-400/10 dark:bg-blue-500/10 blur-3xl pointer-events-none" />
      <div aria-hidden className="absolute -bottom-24 -left-20 h-60 w-60 rounded-full bg-indigo-400/10 dark:bg-indigo-500/10 blur-3xl pointer-events-none" />
      <div className="relative p-6 sm:p-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link href="/clients" className="shrink-0">
            <Button variant="ghost" size="icon" className="rounded-full bg-white/70 dark:bg-slate-900/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200/70 dark:border-slate-800">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div className="h-14 w-14 sm:h-16 sm:w-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white font-bold text-xl sm:text-2xl shadow-lg shadow-emerald-500/25 shrink-0">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                {name}
              </h1>
              <Badge variant="secondary" className="gap-1">
                <User className="h-3 w-3" /> Client
              </Badge>
            </div>
            <p className="text-slate-500 dark:text-slate-400 mt-1 text-sm flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              Client since {formatDate(createdAt)}
            </p>
          </div>
        </div>
        <div className="flex gap-2 no-print flex-wrap sm:justify-end">
          {children}
        </div>
      </div>
    </div>
  );
}

function InsightCard({
  icon: Icon,
  label,
  value,
  sub,
  iconColor,
  iconBg,
}: {
  icon: typeof Calendar;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  iconColor: string;
  iconBg: string;
}) {
  return (
    <Card className="surface overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${iconBg} shrink-0`}>
            <Icon className={`h-4 w-4 ${iconColor}`} strokeWidth={2.2} />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {label}
            </p>
            <p className="text-base font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums truncate">
              {value}
            </p>
            {sub && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ContactRow({
  icon: Icon,
  label,
  children,
  iconColor,
  iconBg,
}: {
  icon: typeof Mail;
  label: string;
  children: React.ReactNode;
  iconColor: string;
  iconBg: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className={`h-9 w-9 rounded-lg ${iconBg} flex items-center justify-center shrink-0`}>
        <Icon className={`h-4 w-4 ${iconColor}`} strokeWidth={2.2} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wide">{label}</p>
        <div className="text-sm font-medium text-slate-900 dark:text-white truncate">{children}</div>
      </div>
    </div>
  );
}

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) return null;
  const { id } = await params;
  const client = await getClient(session.user.id, id);
  if (!client) notFound();

  const totalBilled = client.invoices.reduce((s, i) => s + Number(i.totalAmount), 0);
  const paidInvoices = client.invoices.filter((i) => i.status === "PAID");
  const pendingInvoices = client.invoices.filter((i) => i.status === "PENDING");
  const totalPaid = paidInvoices.reduce((s, i) => s + Number(i.totalAmount), 0);
  const totalPending = pendingInvoices.reduce((s, i) => s + Number(i.totalAmount), 0);
  const paidCount = paidInvoices.length;
  const pendingCount = pendingInvoices.length;
  const initials = client.name.charAt(0).toUpperCase();
  const firstName = client.name.split(" ")[0];

  const timedPaid = paidInvoices.filter((i) => i.paidAt);
  const avgDaysToPay = timedPaid.length > 0
    ? Math.round(
        timedPaid.reduce((sum, inv) => {
          const issue = new Date(inv.issueDate).getTime();
          const paid = new Date(inv.paidAt!).getTime();
          return sum + Math.max(0, Math.round((paid - issue) / 86_400_000));
        }, 0) / timedPaid.length,
      )
    : null;

  const avgInvoiceValue = client.invoices.length > 0 ? totalBilled / client.invoices.length : 0;
  const collectionRate = totalBilled > 0 ? (totalPaid / totalBilled) * 100 : 0;

  const lastInvoice = client.invoices[0] ?? null;
  const lastPayment = [...timedPaid].sort(
    (a, b) => new Date(b.paidAt!).getTime() - new Date(a.paidAt!).getTime(),
  )[0] ?? null;

  const dueDays = (client as unknown as { dueDays?: number | null }).dueDays;

  const payerLabel =
    avgDaysToPay == null
      ? "No payments yet"
      : avgDaysToPay <= 7
        ? "Fast payer ⚡"
        : avgDaysToPay <= 20
          ? "On time"
          : avgDaysToPay <= 35
            ? "Average"
            : "Slow payer";

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <PageHeader name={client.name} initials={initials} createdAt={client.createdAt}>
        <EditClientButton client={client} />
        <DownloadStatementButton clientId={client.id} clientName={client.name} />
        <Link href={`/invoices/new?clientId=${client.id}`}>
          <Button className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25">
            <Plus className="h-4 w-4 mr-2" />
            New Invoice
          </Button>
        </Link>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left column */}
        <div className="lg:col-span-1 space-y-6">
          {/* Contact card */}
          <Card className="surface overflow-hidden">
            <CardHeader className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20 rounded-t-xl pb-3">
              <CardTitle className="text-base flex items-center gap-2 text-slate-900 dark:text-white">
                <User className="h-4 w-4 text-blue-600" />
                Contact Info
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-5 space-y-4">
              <ContactRow
                icon={Mail}
                label="Email"
                iconColor="text-blue-600 dark:text-blue-400"
                iconBg="bg-blue-50 dark:bg-blue-950/40"
              >
                <a href={`mailto:${client.email}`} className="text-blue-600 dark:text-blue-400 hover:underline truncate block">
                  {client.email}
                </a>
              </ContactRow>

              {client.phone && (
                <ContactRow
                  icon={Phone}
                  label="Phone"
                  iconColor="text-amber-600 dark:text-amber-400"
                  iconBg="bg-amber-50 dark:bg-amber-950/40"
                >
                  <a href={`tel:${client.phone}`} className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors truncate block">
                    {client.phone}
                  </a>
                </ContactRow>
              )}

              {client.address && (
                <ContactRow
                  icon={MapPin}
                  label="Address"
                  iconColor="text-emerald-600 dark:text-emerald-400"
                  iconBg="bg-emerald-50 dark:bg-emerald-950/40"
                >
                  <span className="whitespace-pre-line leading-relaxed">{client.address}</span>
                </ContactRow>
              )}

              <ContactRow
                icon={Calendar}
                label="Client Since"
                iconColor="text-purple-600 dark:text-purple-400"
                iconBg="bg-purple-50 dark:bg-purple-950/40"
              >
                {formatDate(client.createdAt)}
              </ContactRow>

              {dueDays != null && (
                <ContactRow
                  icon={CalendarClock}
                  label="Payment Terms"
                  iconColor="text-indigo-600 dark:text-indigo-400"
                  iconBg="bg-indigo-50 dark:bg-indigo-950/40"
                >
                  <span>
                    Net {dueDays}
                    <span className="text-xs text-slate-500 dark:text-slate-400 font-normal ml-1">
                      ({dueDays === 0 ? "due on receipt" : `${dueDays} days`})
                    </span>
                  </span>
                </ContactRow>
              )}
            </CardContent>
          </Card>

          {/* Money summary */}
          <Card className="surface overflow-hidden">
            <CardHeader className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20 rounded-t-xl pb-3">
              <CardTitle className="text-base flex items-center gap-2 text-slate-900 dark:text-white">
                <Receipt className="h-4 w-4 text-emerald-600" />
                Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-5 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-gradient-to-br from-emerald-50 to-green-50 dark:from-emerald-950/40 dark:to-green-950/40 border border-emerald-100 dark:border-emerald-900/40">
                  <div className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 mb-1">
                    <CheckCircle2 className="h-3 w-3" />
                    <span className="text-[11px] font-semibold uppercase tracking-wide">Paid</span>
                  </div>
                  <p className="text-lg font-bold text-emerald-700 dark:text-emerald-300 tabular-nums leading-tight">
                    {formatCurrency(totalPaid)}
                  </p>
                  <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5">
                    {paidCount} invoice{paidCount !== 1 ? "s" : ""}
                  </p>
                </div>
                <div className="p-3 rounded-xl bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-950/40 dark:to-yellow-950/40 border border-amber-100 dark:border-amber-900/40">
                  <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400 mb-1">
                    <Clock className="h-3 w-3" />
                    <span className="text-[11px] font-semibold uppercase tracking-wide">Outstanding</span>
                  </div>
                  <p className="text-lg font-bold text-amber-700 dark:text-amber-300 tabular-nums leading-tight">
                    {formatCurrency(totalPending)}
                  </p>
                  <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                    {pendingCount} pending
                  </p>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/40 dark:to-indigo-950/40 border border-blue-100 dark:border-blue-900/40">
                <p className="text-[11px] text-blue-700 dark:text-blue-400 font-semibold uppercase tracking-wide mb-1 flex items-center gap-1">
                  <Sparkles className="h-3 w-3" /> Total Billed
                </p>
                <p className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
                  {formatCurrency(totalBilled)}
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                  {client.invoices.length} total invoice{client.invoices.length !== 1 ? "s" : ""}
                </p>
                {client.invoices.length > 0 && (
                  <div className="mt-3">
                    <div className="flex items-baseline justify-between text-[11px] text-slate-600 dark:text-slate-400 mb-1">
                      <span>Collection rate</span>
                      <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-300">
                        {collectionRate.toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/70 dark:bg-slate-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-500"
                        style={{ width: `${Math.min(100, collectionRate)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <Link href={`/invoices/new?clientId=${client.id}`} className="block">
                <Button className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25 mt-1">
                  <Plus className="h-4 w-4 mr-2" />
                  New invoice for {firstName}
                  <ArrowUpRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </Link>
            </CardContent>
          </Card>

          {client.notes && (
            <Card className="surface overflow-hidden">
              <CardHeader className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20 rounded-t-xl py-3">
                <CardTitle className="text-sm flex items-center gap-2 text-slate-900 dark:text-white">
                  <StickyNote className="h-4 w-4 text-amber-500" />
                  Internal Notes
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">
                  {client.notes}
                </p>
              </CardContent>
            </Card>
          )}

          <PortalLinkSection
            clientId={client.id}
            clientName={client.name}
            clientEmail={client.email}
            initialToken={client.portalToken}
          />
        </div>

        {/* Right column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Insights grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <InsightCard
              icon={Calendar}
              label="Last Invoice"
              value={lastInvoice ? formatDate(lastInvoice.issueDate) : "—"}
              sub={lastInvoice ? <span className="font-mono">{lastInvoice.invoiceNumber}</span> : "No invoices yet"}
              iconColor="text-blue-600 dark:text-blue-400"
              iconBg="bg-blue-50 dark:bg-blue-950/40"
            />
            <InsightCard
              icon={CheckCircle2}
              label="Last Payment"
              value={lastPayment?.paidAt ? formatDate(lastPayment.paidAt) : "—"}
              sub={lastPayment ? formatCurrency(Number(lastPayment.totalAmount)) : "No payments yet"}
              iconColor="text-emerald-600 dark:text-emerald-400"
              iconBg="bg-emerald-50 dark:bg-emerald-950/40"
            />
            <InsightCard
              icon={Clock}
              label="Avg Days to Pay"
              value={avgDaysToPay != null ? `${avgDaysToPay}d` : "—"}
              sub={payerLabel}
              iconColor="text-violet-600 dark:text-violet-400"
              iconBg="bg-violet-50 dark:bg-violet-950/40"
            />
            <InsightCard
              icon={TrendingUp}
              label="Avg Invoice"
              value={client.invoices.length > 0 ? formatCurrency(avgInvoiceValue) : "—"}
              sub={`${client.invoices.length} invoice${client.invoices.length === 1 ? "" : "s"} total`}
              iconColor="text-indigo-600 dark:text-indigo-400"
              iconBg="bg-indigo-50 dark:bg-indigo-950/40"
            />
          </div>

          {/* Invoice history table */}
          <Card className="surface overflow-hidden">
            <CardHeader className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20 rounded-t-none pb-3 flex flex-row items-center justify-between gap-2 flex-wrap">
              <CardTitle className="text-base flex items-center gap-2 text-slate-900 dark:text-white">
                <FileText className="h-4 w-4 text-blue-600" />
                Invoice History
                <span className="ml-1 inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full bg-slate-200/70 dark:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {client.invoices.length}
                </span>
              </CardTitle>
              <Link href={`/invoices/new?clientId=${client.id}`}>
                <Button size="sm" variant="outline" className="bg-white/70 dark:bg-slate-900/60">
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> New
                </Button>
              </Link>
            </CardHeader>
            <CardContent className="p-0">
              {client.invoices.length === 0 ? (
                <div className="py-14 text-center">
                  <div className="mx-auto h-14 w-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-3">
                    <FileText className="h-7 w-7 text-slate-400" />
                  </div>
                  <p className="font-semibold text-slate-700 dark:text-slate-200">No invoices yet</p>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Create the first invoice for {firstName} to get started.</p>
                  <Link href={`/invoices/new?clientId=${client.id}`} className="inline-block mt-4">
                    <Button size="sm" className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25">
                      <Plus className="h-4 w-4 mr-2" />
                      Create invoice
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Invoice #</TableHead>
                        <TableHead>Issue Date</TableHead>
                        <TableHead>Due Date</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {client.invoices.map((inv) => (
                        <TableRow key={inv.id} className="group">
                          <TableCell className="font-medium">
                            <Link
                              href={`/invoices/${inv.id}`}
                              className="text-blue-600 dark:text-blue-400 font-mono font-semibold hover:underline group-hover:text-blue-700 dark:group-hover:text-blue-300"
                            >
                              {inv.invoiceNumber}
                            </Link>
                          </TableCell>
                          <TableCell className="text-slate-600 dark:text-slate-400 tabular-nums">
                            {formatDate(inv.issueDate)}
                          </TableCell>
                          <TableCell className="text-slate-600 dark:text-slate-400 tabular-nums">
                            {formatDate(inv.dueDate)}
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={inv.status} />
                          </TableCell>
                          <TableCell className="text-right font-bold text-slate-900 dark:text-white tabular-nums">
                            {formatCurrency(inv.totalAmount)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
