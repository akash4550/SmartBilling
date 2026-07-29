"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft,
  Printer,
  CheckCircle2,
  Trash2,
  Clock,
  FileText,
  Loader2,
  Building2,
  Mail,
  MapPin,
  Calendar,
  Phone,
  Receipt,
  Pencil,
  Ban,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { formatMoney } from "@/lib/format-money";
import type { InvoiceWithRelations } from "@/types";
import { SendInvoiceButton } from "@/components/invoices/send-invoice-button";
import { DownloadPdfButton } from "@/components/invoices/download-pdf-button";
import { RemindInvoiceButton } from "@/components/invoices/remind-invoice-button";
import { PayInvoiceButton } from "@/components/invoices/pay-invoice-button";
import { PayMethods } from "@/components/invoices/pay-methods";
import { ActivityTimeline } from "@/components/invoices/activity-timeline";
import { DuplicateInvoiceButton } from "@/components/invoices/duplicate-invoice-button";
import { CopyLinkButton } from "@/components/invoices/copy-link-button";
import { VoidInvoiceButton } from "@/components/invoices/void-invoice-button";

interface PaymentGatewayConfig {
  stripe: boolean;
  razorpay: boolean;
  razorpayKeyId?: string | null;
}

interface CompanySettings {
  companyName: string;
  companyEmail: string;
  companyAddress?: string | null;
  companyPhone?: string | null;
  currency: string;
  defaultTaxRate: number | string;
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
    <Badge variant={variant} className="gap-1 text-xs px-2.5 py-1">
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [invoice, setInvoice] = useState<InvoiceWithRelations | null>(null);
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [payments, setPayments] = useState<PaymentGatewayConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<"markPaid" | "delete" | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [invRes, setRes, payRes] = await Promise.all([
        fetch(`/api/invoices/${id}`, { cache: "no-store" }),
        fetch(`/api/settings`, { cache: "no-store" }),
        fetch(`/api/site/payments`, { cache: "no-store" }),
      ]);
      if (invRes.status === 404) { setError("Invoice not found"); return; }
      if (!invRes.ok) throw new Error("Failed to load invoice");
      const inv: InvoiceWithRelations = await invRes.json();
      setInvoice(inv);
      if (setRes.ok) {
        const s: CompanySettings = await setRes.json();
        setSettings(s);
      }
      if (payRes.ok) {
        const p: PaymentGatewayConfig = await payRes.json();
        setPayments(p);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  async function handleMarkPaid() {
    if (!invoice || !confirm("Mark this invoice as paid?")) return;
    setActionLoading("markPaid");
    try {
      const res = await fetch(`/api/invoices/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "PAID" }),
      });
      if (res.ok) {
        await fetchAll();
        toast.success("Invoice marked as paid", { description: invoice.invoiceNumber });
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to mark as paid");
      }
    } finally { setActionLoading(null); }
  }

  async function handleDelete() {
    if (!invoice) return;
    if (!confirm("Are you sure you want to delete this invoice? This cannot be undone.")) return;
    setActionLoading("delete");
    try {
      const res = await fetch(`/api/invoices/${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Invoice deleted");
        router.push("/invoices");
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to delete invoice");
        setActionLoading(null);
      }
    } catch {
      toast.error("Network error — please try again");
      setActionLoading(null);
    }
  }

  function handlePrint() { window.print(); }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600 mx-auto" />
          <p className="text-sm text-slate-500 mt-3">Loading invoice...</p>
        </div>
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className="text-center py-24">
        <FileText className="h-12 w-12 mx-auto text-slate-300 dark:text-slate-600 mb-3" />
        <p className="font-medium text-slate-700 dark:text-slate-200">{error ?? "Invoice not found"}</p>
        <Link href="/invoices" className="inline-block mt-4">
          <Button variant="outline">Back to Invoices</Button>
        </Link>
      </div>
    );
  }

  const subtotalNum = Number(invoice.subtotal);
  const discountAmountNum = Number(invoice.discountAmount ?? 0);
  const netNum = subtotalNum - discountAmountNum;
  const taxRateNum = Number(invoice.taxRate);
  const taxLabel =
    (invoice as unknown as { taxLabel?: string }).taxLabel || "GST";
  const taxAmount = (netNum * taxRateNum) / 100;
  const totalNum = Number(invoice.totalAmount);
  const currency = settings?.currency ?? "INR";

  const companyName = settings?.companyName || "Your Business Name";
  const companyEmail = settings?.companyEmail || "billing@example.com";
  const companyAddress = settings?.companyAddress || "";
  const companyPhone = settings?.companyPhone || "";

  const isPaid = invoice.status === "PAID";
  const isPending = invoice.status === "PENDING";
  const isDraft = invoice.status === "DRAFT";
  const isVoid = invoice.status === "VOID";

  const dueDate = new Date(invoice.dueDate);
  const issueDate = new Date(invoice.issueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysOverdue = isPending ? Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)) : 0;
  const isOverdue = daysOverdue > 0;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between no-print">
        <div className="flex items-center gap-3">
          <Link href="/invoices">
            <Button variant="ghost" size="icon" className="rounded-full">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight font-mono">{invoice.invoiceNumber}</h1>
              <StatusBadge status={invoice.status} />
              {isOverdue && (
                <Badge variant="destructive" className="gap-1">
                  <Clock className="h-3 w-3" />
                  {daysOverdue}d overdue
                </Badge>
              )}
            </div>
            <p className="text-slate-500 dark:text-slate-400 mt-1 text-sm">
              Created {formatDate(invoice.createdAt)} · {invoice.client.name}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!isVoid && (
            <Link href={`/invoices/${invoice.id}/edit`}>
              <Button variant="outline">
                <Pencil className="h-4 w-4 mr-2" /> Edit
              </Button>
            </Link>
          )}
          {(isPending || isDraft) && (
            <SendInvoiceButton invoiceId={invoice.id} clientEmail={invoice.client.email} />
          )}
          {isPending && (
            <>
              {payments && (payments.stripe || payments.razorpay) ? (
                payments.razorpay && !payments.stripe ? (
                  <PayInvoiceButton
                    invoiceId={invoice.id}
                    alreadyPaid={isPaid}
                    size="default"
                    provider="razorpay"
                    razorpayKeyId={payments.razorpayKeyId}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-500/25"
                  />
                ) : (
                  <PayInvoiceButton
                    invoiceId={invoice.id}
                    alreadyPaid={isPaid}
                    size="default"
                    className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-500/25"
                  />
                )
              ) : (
                <PayInvoiceButton
                  invoiceId={invoice.id}
                  alreadyPaid={isPaid}
                  size="default"
                  className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-500/25"
                />
              )}
              <RemindInvoiceButton
                invoiceId={invoice.id}
                clientEmail={invoice.client.email}
                disabled={actionLoading !== null}
                onSent={fetchAll}
                variant={isOverdue ? "default" : "outline"}
                className={isOverdue ? "bg-amber-600 hover:bg-amber-700 text-white" : ""}
              />
            </>
          )}
          {!isPaid && !isVoid && (
            <Button onClick={handleMarkPaid} disabled={actionLoading !== null} variant="secondary">
              {actionLoading === "markPaid" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
              Mark as Paid
            </Button>
          )}
          <DownloadPdfButton invoiceId={invoice.id} />
          <CopyLinkButton invoiceId={invoice.id} />
          <DuplicateInvoiceButton invoiceId={invoice.id} />
          <Button variant="outline" onClick={handlePrint}>
            <Printer className="h-4 w-4 mr-2" /> Print
          </Button>
          {!isVoid && (
            <VoidInvoiceButton
              invoiceId={invoice.id}
              invoiceNumber={invoice.invoiceNumber}
              variant="outline"
              disabled={actionLoading !== null}
            />
          )}
          <Button variant="destructive" onClick={handleDelete} disabled={actionLoading !== null}>
            {actionLoading === "delete" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
            Delete
          </Button>
        </div>
      </div>

      {/* Status Banner */}
      {isVoid && (
        <div className="rounded-xl bg-gradient-to-r from-slate-100 to-slate-50 dark:from-slate-900 dark:to-slate-950 border border-slate-300 dark:border-slate-700 p-4 flex items-center gap-3 no-print">
          <div className="h-10 w-10 rounded-full bg-slate-200 dark:bg-slate-800 flex items-center justify-center shrink-0">
            <Ban className="h-5 w-5 text-slate-600 dark:text-slate-400" />
          </div>
          <div>
            <p className="font-semibold text-slate-700 dark:text-slate-300">Invoice Voided</p>
            <p className="text-sm text-slate-600 dark:text-slate-400">This invoice has been cancelled. It is not payable and is excluded from revenue reports.</p>
          </div>
        </div>
      )}
      {isOverdue && (
        <div className="rounded-xl bg-gradient-to-r from-red-50 to-rose-50 dark:from-red-950/40 dark:to-rose-950/40 border border-red-200 dark:border-red-900/50 p-4 flex items-center gap-3 no-print">
          <div className="h-10 w-10 rounded-full bg-red-100 dark:bg-red-900/50 flex items-center justify-center shrink-0">
            <Clock className="h-5 w-5 text-red-600 dark:text-red-400" />
          </div>
          <div>
            <p className="font-semibold text-red-700 dark:text-red-300">Payment Overdue</p>
            <p className="text-sm text-red-600 dark:text-red-400">This invoice was due {daysOverdue} day{daysOverdue !== 1 ? "s" : ""} ago — consider sending a reminder.</p>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3 print:block">
        <div className="lg:col-span-2 space-y-6">

      {/* Invoice Card */}
      <Card className="print-card print-break-avoid border-slate-200/60 dark:border-slate-800/60 shadow-sm overflow-hidden">
        {/* Top accent bar */}
        <div className={`h-1.5 ${
          isPaid ? "bg-gradient-to-r from-emerald-500 to-green-500" :
          isOverdue ? "bg-gradient-to-r from-red-500 to-rose-500" :
          isDraft ? "bg-gradient-to-r from-slate-400 to-slate-500" :
          "bg-gradient-to-r from-blue-500 to-indigo-500"
        }`} />

        <CardContent className="p-8 sm:p-12">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-6 mb-10">
            <div>
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
                  <FileText className="h-6 w-6 text-white" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">INVOICE</h2>
                  <p className="text-slate-500 dark:text-slate-400 mt-0.5 text-sm font-mono">{invoice.invoiceNumber}</p>
                </div>
              </div>
            </div>
            <div className="flex flex-col items-start sm:items-end gap-2">
              <StatusBadge status={invoice.status} />
              <div className="text-right">
                <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">Amount Due</p>
                <p className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400 bg-clip-text text-transparent tabular-nums">
                  {formatMoney(totalNum, currency)}
                </p>
              </div>
            </div>
          </div>

          {/* From / Bill To */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10">
            <div className="bg-slate-50 dark:bg-slate-800/40 rounded-xl p-5">
              <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3 font-bold flex items-center gap-1.5">
                <Building2 className="h-3 w-3" /> From
              </p>
              <div className="space-y-1.5">
                <p className="font-bold text-lg text-slate-900 dark:text-white">{companyName}</p>
                <p className="text-sm text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5 text-slate-400" />
                  <a href={`mailto:${companyEmail}`} className="text-blue-600 dark:text-blue-400 hover:underline">{companyEmail}</a>
                </p>
                {companyPhone && (
                  <p className="text-sm text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5 text-slate-400" /> {companyPhone}
                  </p>
                )}
                {companyAddress && (
                  <p className="text-sm text-slate-600 dark:text-slate-400 flex items-start gap-1.5 whitespace-pre-line pt-1">
                    <MapPin className="h-3.5 w-3.5 text-slate-400 mt-0.5 shrink-0" /> {companyAddress}
                  </p>
                )}
              </div>
            </div>

            <div className="bg-blue-50/50 dark:bg-blue-950/20 rounded-xl p-5 border border-blue-100 dark:border-blue-900/30">
              <p className="text-xs uppercase tracking-wider text-blue-700 dark:text-blue-400 mb-3 font-bold flex items-center gap-1.5">
                <Receipt className="h-3 w-3" /> Bill To
              </p>
              <div className="space-y-1.5">
                <p className="font-bold text-lg text-slate-900 dark:text-white">{invoice.client.name}</p>
                <p className="text-sm text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5 text-slate-400" />
                  <a href={`mailto:${invoice.client.email}`} className="text-blue-600 dark:text-blue-400 hover:underline">{invoice.client.email}</a>
                </p>
                {"phone" in invoice.client && invoice.client.phone && (
                  <p className="text-sm text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5 text-slate-400" /> {invoice.client.phone}
                  </p>
                )}
                {invoice.client.address && (
                  <p className="text-sm text-slate-600 dark:text-slate-400 flex items-start gap-1.5 whitespace-pre-line pt-1">
                    <MapPin className="h-3.5 w-3.5 text-slate-400 mt-0.5 shrink-0" /> {invoice.client.address}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-3 gap-4 mb-8 p-5 bg-slate-50 dark:bg-slate-800/40 rounded-xl">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-lg bg-white dark:bg-slate-900 flex items-center justify-center shadow-sm shrink-0">
                <Calendar className="h-4 w-4 text-blue-600" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Issue Date</p>
                <p className="font-semibold mt-0.5 text-slate-900 dark:text-white">{formatDate(issueDate)}</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className={`h-10 w-10 rounded-lg ${isOverdue ? "bg-red-100 dark:bg-red-900/50" : "bg-white dark:bg-slate-900"} flex items-center justify-center shadow-sm shrink-0`}>
                <Calendar className={`h-4 w-4 ${isOverdue ? "text-red-600" : "text-blue-600"}`} />
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Due Date</p>
                <p className={`font-semibold mt-0.5 ${isOverdue ? "text-red-600 dark:text-red-400" : "text-slate-900 dark:text-white"}`}>
                  {formatDate(dueDate)}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-lg bg-white dark:bg-slate-900 flex items-center justify-center shadow-sm shrink-0">
                <span className="text-sm font-bold text-blue-600">{Math.round(taxRateNum)}%</span>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Tax Rate</p>
                <p className="font-semibold mt-0.5 text-slate-900 dark:text-white">{taxRateNum}% {taxLabel}</p>
              </div>
            </div>
          </div>

          {/* Line Items */}
          <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 mb-8">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-50 dark:hover:bg-slate-800/60 border-slate-200 dark:border-slate-700">
                  <TableHead className="w-12 pl-5">#</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit Price</TableHead>
                  <TableHead className="text-right pr-5">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.items.map((item, i) => (
                  <TableRow key={item.id} className="border-slate-100 dark:border-slate-800">
                    <TableCell className="text-slate-400 dark:text-slate-500 pl-5 font-mono">{i + 1}</TableCell>
                    <TableCell className="font-medium text-slate-900 dark:text-white py-4">{item.description}</TableCell>
                    <TableCell className="text-right tabular-nums text-slate-600 dark:text-slate-400">{item.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums text-slate-600 dark:text-slate-400">{formatMoney(Number(item.price), currency)}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums pr-5 text-slate-900 dark:text-white">{formatMoney(Number(item.total), currency)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Totals */}
          <div className="flex flex-col items-end">
            <div className="w-full sm:w-96 space-y-3 bg-slate-50 dark:bg-slate-800/40 rounded-xl p-5">
              <div className="flex justify-between py-1 text-sm">
                <span className="text-slate-600 dark:text-slate-400">Subtotal</span>
                <span className="font-medium tabular-nums text-slate-900 dark:text-white">{formatMoney(subtotalNum, currency)}</span>
              </div>
              {discountAmountNum > 0 && (
                <div className="flex justify-between py-1 text-sm">
                  <span className="text-emerald-700 dark:text-emerald-400 font-medium">Discount</span>
                  <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                    −{formatMoney(discountAmountNum, currency)}
                  </span>
                </div>
              )}
              <div className="flex justify-between py-1 text-sm">
                <span className="text-slate-600 dark:text-slate-400">{taxLabel} ({taxRateNum}%)</span>
                <span className="font-medium tabular-nums text-slate-900 dark:text-white">{formatMoney(taxAmount, currency)}</span>
              </div>
              <Separator className="bg-slate-300 dark:bg-slate-700" />
              <div className="flex justify-between py-2 items-center">
                <span className="text-base font-bold text-slate-900 dark:text-white">Total Due</span>
                <span className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400 bg-clip-text text-transparent tabular-nums">
                  {formatMoney(totalNum, currency)}
                </span>
              </div>
            </div>

            {/* Status message */}
            <div className="w-full sm:w-96 mt-4">
              {isPaid && (
                <div className="p-4 rounded-xl bg-gradient-to-r from-emerald-50 to-green-50 dark:from-emerald-950/40 dark:to-green-950/40 border border-emerald-200 dark:border-emerald-900/50 flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div>
                    <p className="font-semibold text-emerald-700 dark:text-emerald-300">Payment Received</p>
                    <p className="text-xs text-emerald-600 dark:text-emerald-400">Thank you for your business!</p>
                  </div>
                </div>
              )}
              {isPending && !isOverdue && (
                <div className="p-4 rounded-xl bg-gradient-to-r from-amber-50 to-yellow-50 dark:from-amber-950/40 dark:to-yellow-950/40 border border-amber-200 dark:border-amber-900/50 flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center shrink-0">
                    <Clock className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div>
                    <p className="font-semibold text-amber-700 dark:text-amber-300">Payment Pending</p>
                    <p className="text-xs text-amber-600 dark:text-amber-400">Due by {formatDate(dueDate)}</p>
                  </div>
                </div>
              )}
              {isDraft && (
                <div className="p-4 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-center">
                  <p className="text-sm text-slate-600 dark:text-slate-400">This is a draft invoice — it hasn't been sent to the client yet.</p>
                </div>
              )}
            </div>
          </div>

          {/* Notes */}
          {invoice.notes && (
            <div className="mt-10 rounded-xl bg-slate-50 dark:bg-slate-800/40 p-5 border border-slate-200 dark:border-slate-700">
              <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2 font-bold flex items-center gap-1.5">
                <FileText className="h-3 w-3" /> Notes / Terms
              </p>
              <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line leading-relaxed">{invoice.notes}</p>
            </div>
          )}

          {/* Footer */}
          <div className="mt-12 pt-6 border-t border-slate-200 dark:border-slate-800 text-center">
            <p className="font-semibold text-slate-700 dark:text-slate-300">{companyName}</p>
            {companyEmail && <p className="text-xs text-slate-500 mt-0.5">{companyEmail}</p>}
            <p className="mt-3 text-sm text-slate-400">Thank you for your business!</p>
          </div>
        </CardContent>
      </Card>

      <div className="print-only text-center text-sm text-slate-500 pt-4">
        <p className="font-medium">{companyName}</p>
        {companyEmail && <p>{companyEmail}</p>}
        <p className="mt-2">Thank you for your business!</p>
      </div>
        </div>{/* /lg:col-span-2 */}
        <aside className="no-print lg:col-span-1">
          <div className="lg:sticky lg:top-24">
            <ActivityTimeline invoiceId={invoice.id} />
          </div>
        </aside>
      </div>{/* /grid */}
    </div>
  );
}
