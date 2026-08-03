"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
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
  Printer,
  CheckCircle2,
  Clock,
  Loader2,
  Mail,
  MapPin,
  Calendar,
  Phone,
  ShieldCheck,
  Lock,
  Building2,
  Receipt,
  ArrowLeft,
  Ban,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { formatMoney } from "@/lib/format-money";
import type { InvoiceWithRelations } from "@/types";
import { DownloadPdfButton } from "@/components/invoices/download-pdf-button";
import { PayInvoiceButton } from "@/components/invoices/pay-invoice-button";
import { PayMethods } from "@/components/invoices/pay-methods";
import { toast } from "sonner";

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
  logoUrl?: string | null;
  brandColor?: string;
  payments?: PaymentGatewayConfig;
}

function StatusBadge({ status }: { status: "DRAFT" | "PENDING" | "PAID" | "VOID" }) {
  const config = {
    DRAFT: { variant: "draft" as const, label: "Draft", icon: Clock },
    PENDING: { variant: "warning" as const, label: "Awaiting Payment", icon: Clock },
    PAID: { variant: "success" as const, label: "Paid", icon: CheckCircle2 },
    VOID: { variant: "neutral" as const, label: "Void / Cancelled", icon: Ban },
  };
  const { variant, label, icon: Icon } = config[status] ?? config.DRAFT;
  return (
    <Badge variant={variant} className="gap-1 text-xs px-2.5 py-1">
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}

function InitialsAvatar({ name }: { name: string }) {
  const initials = name.charAt(0).toUpperCase();
  return (
    <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center text-white font-bold text-lg shadow-lg shadow-violet-500/25 shrink-0">
      {initials}
    </div>
  );
}

function PublicInvoiceViewInner() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const id = params.id;

  const [invoice, setInvoice] = useState<InvoiceWithRelations | null>(null);
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [invRes, setRes] = await Promise.all([
          fetch(`/api/invoices/${id}`, { cache: "no-store" }),
          fetch(`/api/public/settings?invoiceId=${encodeURIComponent(id)}`, { cache: "no-store" }),
        ]);
        if (invRes.status === 404) {
          setError("This invoice was not found. It may have been deleted or the link is incorrect.");
          return;
        }
        if (!invRes.ok) throw new Error("Unable to load invoice");
        const inv: InvoiceWithRelations = await invRes.json();
        if (!active) return;
        setInvoice(inv);
        if (setRes.ok) {
          const s: CompanySettings = await setRes.json();
          setSettings(s);
        }
        // Show toast when redirected back from Stripe
        if (searchParams.get("paid") === "1") {
          toast.success("Payment successful!", { description: `Thank you for paying ${inv.invoiceNumber}.` });
        } else if (searchParams.get("cancelled") === "1") {
          toast.message("Payment cancelled", { description: "You can retry payment at any time." });
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [id, searchParams]);

  function handlePrint() {
    window.print();
  }

  function getDaysOverdue(dueDate: string | Date): number {
    const due = new Date(dueDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffMs = today.getTime() - due.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 relative overflow-hidden">
        <div className="absolute top-0 -left-40 w-96 h-96 bg-blue-400/20 dark:bg-blue-500/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 -right-40 w-96 h-96 bg-indigo-400/20 dark:bg-indigo-500/10 rounded-full blur-3xl" />
        <div className="relative z-10 text-center">
          <Loader2 className="h-10 w-10 animate-spin text-blue-600 mx-auto" />
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-4">Loading invoice...</p>
        </div>
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 flex items-center justify-center p-4 relative overflow-hidden">
        <div className="absolute top-0 -left-40 w-96 h-96 bg-blue-400/20 dark:bg-blue-500/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 -right-40 w-96 h-96 bg-indigo-400/20 dark:bg-indigo-500/10 rounded-full blur-3xl" />
        <Card className="max-w-md w-full relative z-10 shadow-xl border-slate-200/60 dark:border-slate-800/60 backdrop-blur-sm">
          <CardContent className="py-12 px-8 text-center">
            <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-200 to-slate-300 dark:from-slate-800 dark:to-slate-700 shadow-inner">
              <Lock className="h-7 w-7 text-slate-500 dark:text-slate-400" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">
              Invoice not found
            </h1>
            <p className="text-slate-500 dark:text-slate-400 text-sm mt-2 leading-relaxed">
              {error ?? "This invoice doesn't exist or the link is invalid."}
            </p>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
              If you believe this is an error, please contact the sender.
            </p>
            <div className="mt-6">
              <Link href="/login">
                <Button variant="outline" size="sm">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Admin Login
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const companyName = settings?.companyName || "Your Business Name";
  const companyEmail = settings?.companyEmail || "billing@example.com";
  const companyAddress = settings?.companyAddress || "";
  const companyPhone = settings?.companyPhone || "";
  const currency = settings?.currency || "INR";
  const logoUrl = settings?.logoUrl ?? null;
  const brandColor = settings?.brandColor && /^#([0-9a-fA-F]{3}){1,2}$/.test(settings.brandColor)
    ? settings.brandColor
    : "#2563eb";

  const subtotalNum = Number(invoice.subtotal);
  const discInv = invoice as unknown as {
    discountAmount?: number | null;
    discountType?: string | null;
    taxLabel?: string | null;
  };
  const discountAmount = discInv.discountAmount != null ? Number(discInv.discountAmount) : 0;
  const netNum = Math.max(0, subtotalNum - (Number.isFinite(discountAmount) ? discountAmount : 0));
  const taxRateNum = Number(invoice.taxRate);
  const taxLabel = (discInv.taxLabel || "GST").toUpperCase();
  const taxAmount = (netNum * taxRateNum) / 100;
  const totalNum = Number(invoice.totalAmount);
  const isPaid = invoice.status === "PAID";
  const isPending = invoice.status === "PENDING";
  const isDraft = invoice.status === "DRAFT";
  const isVoid = invoice.status === "VOID";

  const dueDate = new Date(invoice.dueDate);
  const issueDate = new Date(invoice.issueDate);
  const daysOverdue = isPending ? getDaysOverdue(invoice.dueDate) : 0;
  const isOverdue = daysOverdue > 0;

  const accentGradient = isPaid
    ? "from-emerald-500 to-green-500"
    : isVoid
    ? "from-slate-400 to-slate-500"
    : isOverdue
    ? "from-red-500 to-rose-500"
    : isDraft
    ? "from-slate-400 to-slate-500"
    : "from-blue-500 to-indigo-500";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 py-8 px-4 relative overflow-hidden">
      {/* Decorative orbs */}
      <div className="absolute top-0 -left-40 w-96 h-96 bg-blue-400/20 dark:bg-blue-500/10 rounded-full blur-3xl pointer-events-none no-print" />
      <div className="absolute bottom-0 -right-40 w-96 h-96 bg-indigo-400/20 dark:bg-indigo-500/10 rounded-full blur-3xl pointer-events-none no-print" />

      <div className="max-w-3xl mx-auto space-y-4 relative z-10">
        {/* Secure banner */}
          <div className="no-print flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 rounded-xl bg-gradient-to-r from-emerald-50 to-green-50 dark:from-emerald-950/40 dark:to-green-950/40 border border-emerald-200/70 dark:border-emerald-900/50 text-emerald-700 dark:text-emerald-300 text-sm shadow-sm">
            {/* Action buttons only render once invoice is loaded (guaranteed by outer render branch) */}
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center shrink-0">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <span>
              Secure invoice from <strong className="font-semibold">{companyName}</strong>
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {isPending && settings?.payments && (settings.payments.stripe || settings.payments.razorpay) ? (
              <PayMethods
                invoiceId={invoice.id}
                alreadyPaid={isPaid}
                payments={settings.payments}
                size="sm"
                direction="horizontal"
              />
            ) : isPending ? (
              <PayInvoiceButton
                invoiceId={invoice.id}
                alreadyPaid={isPaid}
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
              />
            ) : null}
            <DownloadPdfButton invoiceId={invoice.id} publicDownload size="sm" />
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrint}
              className="bg-white/80 dark:bg-slate-900/80 border-emerald-200 dark:border-emerald-900 hover:bg-white dark:hover:bg-slate-900 shadow-sm"
            >
              <Printer className="h-4 w-4 mr-2" />
              Print
            </Button>
          </div>
        </div>

        {/* Void banner */}
        {isVoid && (
          <div className="p-4 rounded-xl bg-gradient-to-r from-slate-100 to-slate-50 dark:from-slate-900 dark:to-slate-950 border border-slate-300 dark:border-slate-700 flex items-center gap-3 shadow-sm">
            <div className="h-10 w-10 rounded-full bg-slate-200 dark:bg-slate-800 flex items-center justify-center shrink-0">
              <Ban className="h-5 w-5 text-slate-600 dark:text-slate-400" />
            </div>
            <div>
              <p className="font-semibold text-slate-700 dark:text-slate-300">Invoice Voided</p>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                This invoice has been cancelled by the merchant and is no longer payable.
              </p>
            </div>
          </div>
        )}

        {/* Overdue banner */}
        {isOverdue && !isVoid && (
          <div className="no-print p-4 rounded-xl bg-gradient-to-r from-red-50 to-rose-50 dark:from-red-950/40 dark:to-rose-950/40 border border-red-200/70 dark:border-red-900/50 flex items-center gap-3 shadow-sm">
            <div className="h-10 w-10 rounded-full bg-red-100 dark:bg-red-900/50 flex items-center justify-center shrink-0">
              <Clock className="h-5 w-5 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <p className="font-semibold text-red-700 dark:text-red-300">Payment Overdue</p>
              <p className="text-sm text-red-600 dark:text-red-400">
                This invoice is {daysOverdue} day{daysOverdue !== 1 ? "s" : ""} overdue. Please submit payment at your earliest convenience.
              </p>
            </div>
          </div>
        )}

        {/* Invoice card */}
        <Card className="print-card shadow-xl shadow-slate-200/50 dark:shadow-black/20 print:shadow-none border-slate-200/60 dark:border-slate-800/60 backdrop-blur-sm overflow-hidden relative">
          {/* Top accent bar */}
          <div className={`h-1.5 bg-gradient-to-r ${accentGradient}`} />

          {/* PAID watermark stamp */}
          {isPaid && (
            <div
              className="absolute top-16 sm:top-20 right-6 sm:right-10 z-20 pointer-events-none -rotate-12 select-none"
              aria-hidden="true"
            >
              <div className="border-4 border-emerald-500 text-emerald-600 dark:border-emerald-400 dark:text-emerald-400 rounded-md px-4 py-1.5 text-2xl sm:text-3xl font-black tracking-widest uppercase opacity-80">
                PAID
              </div>
            </div>
          )}

          {/* VOID watermark stamp */}
          {isVoid && (
            <div
              className="absolute top-16 sm:top-20 right-6 sm:right-10 z-20 pointer-events-none -rotate-12 select-none"
              aria-hidden="true"
            >
              <div className="border-4 border-slate-500 text-slate-600 dark:border-slate-400 dark:text-slate-400 rounded-md px-4 py-1.5 text-2xl sm:text-3xl font-black tracking-widest uppercase opacity-70">
                VOID
              </div>
            </div>
          )}

          <CardContent className="p-6 sm:p-10">
            {/* Header — logo or colored initial */}
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-6 mb-10">
              <div className="flex items-center gap-3">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoUrl}
                    alt={`${companyName} logo`}
                    className="max-h-14 max-w-[180px] object-contain"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <div
                    className="h-12 w-12 rounded-xl flex items-center justify-center text-white font-bold text-lg shadow-lg"
                    style={{
                      background: `linear-gradient(135deg, ${brandColor}, ${shadeHex(brandColor, -20)})`,
                      boxShadow: `0 10px 20px -8px ${brandColor}55`,
                    }}
                  >
                    {companyName.charAt(0).toUpperCase()}
                  </div>
                )}
                <div>
                  <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">INVOICE</h2>
                  <p className="text-slate-500 dark:text-slate-400 mt-0.5 text-sm font-mono">{invoice.invoiceNumber}</p>
                </div>
              </div>
              <div className="flex flex-col items-start sm:items-end gap-2">
                <StatusBadge status={invoice.status} />
                <div className="text-right">
                  <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">Amount Due</p>
                  <p className={`text-3xl font-bold bg-gradient-to-r ${
                    isPaid
                      ? "from-emerald-600 to-green-600 dark:from-emerald-400 dark:to-green-400"
                      : isOverdue
                      ? "from-red-600 to-rose-600 dark:from-red-400 dark:to-rose-400"
                      : "from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400"
                  } bg-clip-text text-transparent tabular-nums`}>
                    {formatMoney(totalNum, currency)}
                  </p>
                </div>
              </div>
            </div>

            {/* From / Bill To */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-8">
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
                <div className="flex items-start gap-3">
                  <InitialsAvatar name={invoice.client.name} />
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <p className="font-bold text-lg text-slate-900 dark:text-white truncate">{invoice.client.name}</p>
                    <p className="text-sm text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                      <Mail className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      <a href={`mailto:${invoice.client.email}`} className="text-blue-600 dark:text-blue-400 hover:underline truncate">{invoice.client.email}</a>
                    </p>
                    {invoice.client.phone && (
                      <p className="text-sm text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                        <Phone className="h-3.5 w-3.5 text-slate-400 shrink-0" /> {invoice.client.phone}
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
            </div>

            {/* Dates */}
            <div className="grid grid-cols-3 gap-3 sm:gap-4 mb-8 p-5 bg-slate-50 dark:bg-slate-800/40 rounded-xl">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-lg bg-white dark:bg-slate-900 flex items-center justify-center shadow-sm shrink-0">
                  <Calendar className="h-4 w-4 text-blue-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Issue Date</p>
                  <p className="font-semibold mt-0.5 text-slate-900 dark:text-white text-sm sm:text-base">{formatDate(issueDate)}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className={`h-10 w-10 rounded-lg ${isOverdue ? "bg-red-100 dark:bg-red-900/50" : "bg-white dark:bg-slate-900"} flex items-center justify-center shadow-sm shrink-0`}>
                  <Calendar className={`h-4 w-4 ${isOverdue ? "text-red-600" : "text-blue-600"}`} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Due Date</p>
                  <p className={`font-semibold mt-0.5 text-sm sm:text-base ${isOverdue ? "text-red-600 dark:text-red-400" : "text-slate-900 dark:text-white"}`}>
                    {formatDate(dueDate)}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-lg bg-white dark:bg-slate-900 flex items-center justify-center shadow-sm shrink-0">
                  <span className="text-sm font-bold text-blue-600">{Math.round(taxRateNum)}%</span>
                </div>
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{taxLabel}</p>
                  <p className="font-semibold mt-0.5 text-slate-900 dark:text-white text-sm sm:text-base">{taxRateNum}%</p>
                </div>
              </div>
            </div>

            {/* Line items */}
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
                {discountAmount > 0 && (
                  <div className="flex justify-between py-1 text-sm text-emerald-600 dark:text-emerald-400">
                    <span>Discount</span>
                    <span className="font-medium tabular-nums">−{formatMoney(discountAmount, currency)}</span>
                  </div>
                )}
                <div className="flex justify-between py-1 text-sm">
                  <span className="text-slate-600 dark:text-slate-400">{taxLabel} ({taxRateNum}%)</span>
                  <span className="font-medium tabular-nums text-slate-900 dark:text-white">{formatMoney(taxAmount, currency)}</span>
                </div>
                <Separator className="bg-slate-300 dark:bg-slate-700" />
                <div className="flex justify-between py-2 items-center">
                  <span className="text-base font-bold text-slate-900 dark:text-white">Total Due</span>
                  <span className={`text-2xl font-bold bg-gradient-to-r ${
                    isPaid
                      ? "from-emerald-600 to-green-600 dark:from-emerald-400 dark:to-green-400"
                      : isOverdue
                      ? "from-red-600 to-rose-600 dark:from-red-400 dark:to-rose-400"
                      : "from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400"
                  } bg-clip-text text-transparent tabular-nums`}>
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
                    <p className="text-sm text-slate-600 dark:text-slate-400">This is a draft invoice — it hasn&apos;t been sent to the client yet.</p>
                  </div>
                )}
                {isPending && settings?.payments && (settings.payments.stripe || settings.payments.razorpay) && (
                  <div className="no-print mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
                    <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-bold mb-3 text-center">
                      Pay Online
                    </p>
                    <PayMethods
                      invoiceId={invoice.id}
                      alreadyPaid={isPaid}
                      payments={settings.payments}
                      size="default"
                      direction="vertical"
                    />
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 text-center mt-3 leading-relaxed">
                      Secured payment via Razorpay / Stripe. We never store your card details.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Notes */}
            {invoice.notes && (
              <div className="mt-8 p-5 bg-slate-50 dark:bg-slate-800/40 rounded-xl">
                <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-bold mb-2">Notes</p>
                <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line">{invoice.notes}</p>
              </div>
            )}

            {/* Footer */}
            <div className="mt-10 pt-6 border-t border-slate-200 dark:border-slate-800 text-center">
              <p className="font-semibold text-slate-700 dark:text-slate-300">{companyName}</p>
              {companyEmail && <p className="text-xs text-slate-500 mt-0.5">{companyEmail}</p>}
              <p className="mt-3 text-sm text-slate-400">Thank you for your business!</p>
            </div>
          </CardContent>
        </Card>

        {/* Admin link */}
        <div className="text-center text-xs text-slate-400 dark:text-slate-600 no-print pt-2">
          <Link href="/login" className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline transition-colors">Admin login</Link>
          <span className="mx-2">·</span>
          <span>Secured by SmartBill</span>
        </div>
      </div>
    </div>
  );
}

export default function PublicInvoiceViewPage() {
  return (
    <Suspense fallback={null}>
      <PublicInvoiceViewInner />
    </Suspense>
  );
}

/** Shift a hex color's lightness by percent (negative = darker, positive = lighter). */
function shadeHex(hex: string, percent: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6) return hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const amt = Math.round(2.55 * percent);
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  return `#${[clamp(r + amt), clamp(g + amt), clamp(b + amt)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}
