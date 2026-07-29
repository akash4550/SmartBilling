import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) {
    // Middleware should have redirected; this is a safety net.
    return null;
  }
  const { id } = await params;
  const client = await getClient(session.user.id, id);
  if (!client) notFound();

  const totalBilled = client.invoices.reduce((s, i) => s + Number(i.totalAmount), 0);
  const totalPaid = client.invoices
    .filter((i) => i.status === "PAID")
    .reduce((s, i) => s + Number(i.totalAmount), 0);
  const totalPending = client.invoices
    .filter((i) => i.status === "PENDING")
    .reduce((s, i) => s + Number(i.totalAmount), 0);
  const paidCount = client.invoices.filter((i) => i.status === "PAID").length;
  const pendingCount = client.invoices.filter((i) => i.status === "PENDING").length;
  const initials = client.name.charAt(0).toUpperCase();

  // Compute "average days to pay" across PAID invoices (issueDate → paidAt).
  const paidInvoices = client.invoices.filter((i) => i.status === "PAID" && i.paidAt);
  const avgDaysToPay = paidInvoices.length > 0
    ? Math.round(
        paidInvoices.reduce((sum, inv) => {
          const issue = new Date(inv.issueDate).getTime();
          const paid = new Date(inv.paidAt!).getTime();
          return sum + Math.max(0, Math.round((paid - issue) / 86_400_000));
        }, 0) / paidInvoices.length,
      )
    : null;

  // Last invoice date (issueDate, newest first) and last payment date.
  const lastInvoice = client.invoices[0] ?? null; // already sorted desc by createdAt
  const lastPayment = [...paidInvoices].sort(
    (a, b) => new Date(b.paidAt!).getTime() - new Date(a.paidAt!).getTime(),
  )[0] ?? null;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <Link href="/clients">
          <Button variant="ghost" size="icon" className="rounded-full">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex items-center gap-4 flex-1">
          <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center text-white font-bold text-xl shadow-lg shadow-blue-500/25">
            {initials}
          </div>
          <div className="flex-1">
            <h1 className="text-3xl font-bold tracking-tight">{client.name}</h1>
            <p className="text-slate-500 dark:text-slate-400 mt-0.5 text-sm">Client since {formatDate(client.createdAt)}</p>
          </div>
        </div>
        <div className="flex gap-2 no-print flex-wrap">
          <EditClientButton client={client} />
          <DownloadStatementButton clientId={client.id} clientName={client.name} />
          <Link href={`/invoices/new?clientId=${client.id}`}>
            <Button className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25">
              <Plus className="h-4 w-4 mr-2" /> New Invoice
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left column */}
        <div className="lg:col-span-1 space-y-6">
        <Card className="border-slate-200/60 dark:border-slate-800/60">
          <CardHeader className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 rounded-t-xl">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4 text-blue-600" /> Contact Info
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-lg bg-blue-50 dark:bg-blue-950/40 flex items-center justify-center shrink-0">
                <Mail className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wide">Email</p>
                <a href={`mailto:${client.email}`} className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline">
                  {client.email}
                </a>
              </div>
            </div>

            {client.phone && (
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-lg bg-amber-50 dark:bg-amber-950/40 flex items-center justify-center shrink-0">
                  <Phone className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wide">Phone</p>
                  <a href={`tel:${client.phone}`} className="text-sm font-medium text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                    {client.phone}
                  </a>
                </div>
              </div>
            )}

            {client.address && (
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 flex items-center justify-center shrink-0">
                  <MapPin className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wide">Address</p>
                  <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line">{client.address}</p>
                </div>
              </div>
            )}

            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-lg bg-purple-50 dark:bg-purple-950/40 flex items-center justify-center shrink-0">
                <Calendar className="h-4 w-4 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wide">Client Since</p>
                <p className="text-sm font-medium text-slate-900 dark:text-white">{formatDate(client.createdAt)}</p>
              </div>
            </div>

            {(client as unknown as { dueDays?: number | null }).dueDays != null && (
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-lg bg-indigo-50 dark:bg-indigo-950/40 flex items-center justify-center shrink-0">
                  <CalendarClock className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                </div>
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wide">Payment Terms</p>
                  <p className="text-sm font-medium text-slate-900 dark:text-white">
                    Net {(client as unknown as { dueDays: number }).dueDays}
                    <span className="text-xs text-slate-500 font-normal ml-1">
                      ({(client as unknown as { dueDays: number }).dueDays === 0 ? "due on receipt" : `${(client as unknown as { dueDays: number }).dueDays} days`})
                    </span>
                  </p>
                </div>
              </div>
            )}

            <Separator />

            <div className="grid grid-cols-2 gap-3 pt-2">
              <div className="p-3 rounded-lg bg-gradient-to-br from-emerald-50 to-green-50 dark:from-emerald-950/40 dark:to-green-950/40 border border-emerald-100 dark:border-emerald-900/40">
                <div className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 mb-1">
                  <TrendingUp className="h-3 w-3" />
                  <span className="text-xs font-semibold uppercase tracking-wide">Paid</span>
                </div>
                <p className="text-lg font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">{formatCurrency(totalPaid)}</p>
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">{paidCount} invoice{paidCount !== 1 ? "s" : ""}</p>
              </div>
              <div className="p-3 rounded-lg bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-950/40 dark:to-yellow-950/40 border border-amber-100 dark:border-amber-900/40">
                <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400 mb-1">
                  <Clock className="h-3 w-3" />
                  <span className="text-xs font-semibold uppercase tracking-wide">Pending</span>
                </div>
                <p className="text-lg font-bold text-amber-700 dark:text-amber-300 tabular-nums">{formatCurrency(totalPending)}</p>
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">{pendingCount} pending</p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/40 dark:to-indigo-950/40 border border-blue-100 dark:border-blue-900/40 mt-2">
              <p className="text-xs text-blue-700 dark:text-blue-400 font-semibold uppercase tracking-wide mb-1">Total Billed</p>
              <p className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">{formatCurrency(totalBilled)}</p>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">{client.invoices.length} total invoices</p>
            </div>

            <Link href={`/invoices/new?clientId=${client.id}`} className="block">
              <Button className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25 mt-2">
                <Plus className="h-4 w-4 mr-2" /> New Invoice for {client.name.split(" ")[0]}
              </Button>
            </Link>
          </CardContent>
        </Card>

        {(client as { notes?: string | null }).notes && (
          <Card className="border-slate-200/60 dark:border-slate-800/60">
            <CardHeader className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 rounded-t-xl py-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <StickyNote className="h-4 w-4 text-amber-500" /> Internal Notes
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                {(client as { notes?: string | null }).notes}
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
        </div>{/* /left col */}

        {/* Right column */}
        <div className="lg:col-span-2 space-y-6">
        {/* Insights row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="border-slate-200/60 dark:border-slate-800/60">
            <CardContent className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1">
                <Calendar className="h-3 w-3" /> Last Invoice
              </p>
              <p className="text-base font-bold text-slate-900 dark:text-white mt-1 tabular-nums">
                {lastInvoice ? formatDate(lastInvoice.issueDate) : "—"}
              </p>
              {lastInvoice && (
                <p className="text-xs text-slate-500 truncate font-mono">{lastInvoice.invoiceNumber}</p>
              )}
            </CardContent>
          </Card>
          <Card className="border-slate-200/60 dark:border-slate-800/60">
            <CardContent className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-500" /> Last Payment
              </p>
              <p className="text-base font-bold text-slate-900 dark:text-white mt-1 tabular-nums">
                {lastPayment?.paidAt ? formatDate(lastPayment.paidAt) : "—"}
              </p>
              {lastPayment && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">{formatCurrency(Number(lastPayment.totalAmount))}</p>
              )}
            </CardContent>
          </Card>
          <Card className="border-slate-200/60 dark:border-slate-800/60">
            <CardContent className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1">
                <Clock className="h-3 w-3" /> Avg Days to Pay
              </p>
              <p className="text-base font-bold text-slate-900 dark:text-white mt-1 tabular-nums">
                {avgDaysToPay != null ? `${avgDaysToPay}d` : "—"}
              </p>
              <p className="text-xs text-slate-500">
                {avgDaysToPay != null
                  ? avgDaysToPay <= 7
                    ? "Fast payer"
                    : avgDaysToPay <= 30
                    ? "On time"
                    : "Slow payer"
                  : "No payments yet"}
              </p>
            </CardContent>
          </Card>
          <Card className="border-slate-200/60 dark:border-slate-800/60">
            <CardContent className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-blue-500" /> Avg Invoice
              </p>
              <p className="text-base font-bold text-slate-900 dark:text-white mt-1 tabular-nums">
                {client.invoices.length > 0 ? formatCurrency(totalBilled / client.invoices.length) : "—"}
              </p>
              <p className="text-xs text-slate-500">across {client.invoices.length} invoice{client.invoices.length === 1 ? "" : "s"}</p>
            </CardContent>
          </Card>
        </div>

        <Card className="lg:col-span-2 border-slate-200/60 dark:border-slate-800/60 overflow-hidden">
          <CardHeader className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 rounded-t-none">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4 text-blue-600" />
              Invoice History ({client.invoices.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {client.invoices.length === 0 ? (
              <div className="text-center py-16 text-slate-400">
                <FileText className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p className="font-medium text-slate-600 dark:text-slate-400">No invoices yet</p>
                <p className="text-sm mt-1">Create the first invoice for this client to get started.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20">
                      <th className="px-6 py-3 font-semibold">Invoice #</th>
                      <th className="px-4 py-3 font-semibold">Issue Date</th>
                      <th className="px-4 py-3 font-semibold">Due Date</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-6 py-3 text-right font-semibold">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {client.invoices.map((inv) => (
                      <tr key={inv.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors group">
                        <td className="px-6 py-4">
                          <Link
                            href={`/invoices/${inv.id}`}
                            className="text-blue-600 dark:text-blue-400 font-semibold font-mono hover:underline group-hover:text-blue-700 dark:group-hover:text-blue-300"
                          >
                            {inv.invoiceNumber}
                          </Link>
                        </td>
                        <td className="px-4 py-4 text-slate-600 dark:text-slate-400 tabular-nums">{formatDate(inv.issueDate)}</td>
                        <td className="px-4 py-4 text-slate-600 dark:text-slate-400 tabular-nums">{formatDate(inv.dueDate)}</td>
                        <td className="px-4 py-4"><StatusBadge status={inv.status} /></td>
                        <td className="px-6 py-4 text-right font-bold text-slate-900 dark:text-white tabular-nums">{formatCurrency(inv.totalAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
        </div>{/* /right col */}
      </div>
    </div>
  );
}
