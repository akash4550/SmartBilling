"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  FileText,
  ShieldCheck,
  ExternalLink,
  Loader2,
  AlertCircle,
  Receipt,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Mail,
  Phone,
  MapPin,
  Printer,
  CreditCard,
} from "lucide-react";
import { PayMethods } from "@/components/invoices/pay-methods";
import { DownloadPdfButton } from "@/components/invoices/download-pdf-button";

// Print styles injected inline (global CSS imports are restricted to root layout
// in App Router, and colocated print.css would fail to load).
const PRINT_STYLES = `
@media print {
  @page { margin: 0.5in; size: A4; }
  html, body { background: white !important; color: black !important; font-size: 11pt; }
  .no-print, .no-print * { display: none !important; }
  .print-only, .print-only.hidden { display: block !important; }
  .no-print-break { page-break-inside: avoid; break-inside: avoid; }
  .dark * { color: black !important; background: white !important; border-color: #94a3b8 !important; }
  * { box-shadow: none !important; text-shadow: none !important; background-image: none !important; }
  a { color: black !important; text-decoration: none !important; }
}
@media screen { .print-only { display: none !important; } }
`;

// ------------- Types -------------

interface PortalInvoice {
  id: string;
  invoiceNumber: string;
  status: "DRAFT" | "PENDING" | "PAID";
  issueDate: string;
  dueDate: string;
  subtotal: number;
  discountAmount: number;
  totalAmount: number;
  taxRate: number;
  taxLabel?: string;
  paidAt: string | null;
}

interface CompanyInfo {
  name: string;
  email: string;
  phone: string | null;
  address: string | null;
  currency: string;
  brandColor: string;
  logoUrl: string | null;
}

interface ClientInfo {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  address: string | null;
}

interface PaymentsConfig {
  stripe: boolean;
  razorpay: boolean;
  razorpayKeyId?: string | null;
}

interface PortalSummary {
  totalBilled: number;
  totalPaid: number;
  openAmount: number;
  overdueAmount: number;
  overdueCount: number;
  invoiceCount: number;
}

interface PortalData {
  client: ClientInfo;
  company: CompanyInfo;
  invoices: PortalInvoice[];
  payments: PaymentsConfig;
  summary: PortalSummary;
}

// ------------- Utilities -------------

function fmtMoney(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function fmtDate(d: string | Date): string {
  try {
    return new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "Asia/Calcutta",
    }).format(new Date(d));
  } catch {
    return new Date(d).toDateString();
  }
}

function daysOverdue(due: string): number {
  const d = new Date(due);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86400000));
}

// ------------- Inner (uses useParams) -------------

function PortalInner() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusInvId, setFocusInvId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/public/portal?token=${encodeURIComponent(token)}`, {
          cache: "no-store",
        });
        if (res.status === 404) {
          setError("This portal link is invalid or has been revoked. Please contact the merchant for a new link.");
          return;
        }
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        const json: PortalData = await res.json();
        if (!active) return;
        setData(json);
        // Auto-select the first overdue or pending invoice for the Pay panel.
        const firstOpen =
          json.invoices.find((i) => i.status === "PENDING" && daysOverdue(i.dueDate) > 0) ||
          json.invoices.find((i) => i.status === "PENDING");
        setFocusInvId(firstOpen?.id ?? null);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Failed to load portal");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [token]);

  // When a payment succeeds, refresh data to pick up status changes.
  const refresh = async () => {
    try {
      const res = await fetch(`/api/public/portal?token=${encodeURIComponent(token)}`, { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } catch {
      /* ignore */
    }
  };

  // ------------- Loading / Error -------------
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900">
        <div className="text-center">
          <Loader2 className="h-10 w-10 animate-spin text-blue-600 mx-auto" />
          <p className="text-sm text-slate-500 mt-3">Loading your portal…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-red-50 dark:from-slate-950 dark:to-red-950/30 p-6">
        <Card className="max-w-md w-full border-red-200 dark:border-red-900">
          <CardContent className="py-10 text-center">
            <AlertCircle className="h-10 w-10 text-red-500 mx-auto" />
            <h1 className="text-lg font-semibold mt-3 text-slate-900 dark:text-white">Link not found</h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-2">{error}</p>
            <Link href="/login">
              <Button variant="outline" className="mt-5">Admin login</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { client, company, invoices, payments, summary } = data;
  const brand = company.brandColor;
  const canPayOnline = payments.stripe || payments.razorpay;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 py-8 px-4">
      <style dangerouslySetInnerHTML={{ __html: PRINT_STYLES }} />
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Secure banner */}
        <div className="no-print flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            <span>
              Secure billing portal for <strong className="font-semibold text-slate-900 dark:text-white">{client.name}</strong>
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Link href="/login" className="hover:text-blue-600">Admin login</Link>
          </div>
        </div>

        {/* Header card */}
        <Card className="overflow-hidden border-slate-200/60 dark:border-slate-800 shadow-lg">
          <div className="h-2" style={{ background: `linear-gradient(90deg, ${brand}, ${shadeHex(brand, -15)})` }} />
          <CardContent className="p-6 sm:p-8">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-6">
              <div className="flex items-start gap-4">
                {company.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={company.logoUrl}
                    alt={company.name}
                    className="max-h-14 max-w-[180px] object-contain rounded"
                  />
                ) : (
                  <div
                    className="h-14 w-14 rounded-xl flex items-center justify-center text-white font-bold text-xl shadow-lg"
                    style={{
                      background: `linear-gradient(135deg, ${brand}, ${shadeHex(brand, -20)})`,
                    }}
                  >
                    {company.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                    {company.name}
                  </h1>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                    Client portal for <strong className="text-slate-700 dark:text-slate-300">{client.name}</strong>
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{company.email}</span>
                    {company.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{company.phone}</span>}
                    {company.address && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{company.address.split("\n")[0]}</span>}
                  </div>
                </div>
              </div>
              <div className="text-left sm:text-right">
                <p className="text-xs uppercase tracking-wider text-slate-500 font-medium">Balance due</p>
                <p className={`text-3xl sm:text-4xl font-bold tabular-nums ${summary.overdueAmount > 0 ? "text-red-600 dark:text-red-400" : "text-slate-900 dark:text-white"}`}>
                  {fmtMoney(summary.openAmount, company.currency)}
                </p>
                {summary.overdueCount > 0 && (
                  <p className="text-xs text-red-600 dark:text-red-400 mt-1 inline-flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    {fmtMoney(summary.overdueAmount, company.currency)} overdue across {summary.overdueCount} invoice{summary.overdueCount === 1 ? "" : "s"}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Summary tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 no-print-break">
          <SummaryTile label="Total Billed" value={fmtMoney(summary.totalBilled, company.currency)} icon={Receipt} tint={brand} />
          <SummaryTile label="Total Paid" value={fmtMoney(summary.totalPaid, company.currency)} icon={CheckCircle2} tint="#10b981" />
          <SummaryTile label="Outstanding" value={fmtMoney(summary.openAmount, company.currency)} icon={Clock} tint="#f59e0b" />
          <SummaryTile label="Invoices" value={String(summary.invoiceCount)} icon={FileText} tint="#6366f1" />
        </div>

        {/* Quick actions */}
        <div className="no-print flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => window.print()}
            className="gap-2"
          >
            <Printer className="h-4 w-4" />
            Print / Save as PDF
          </Button>
          {summary.openAmount > 0 && canPayOnline && (
            <Button
              type="button"
              size="sm"
              className="gap-2"
              style={{ background: brand }}
              onClick={() => {
                // Focus the first open/overdue invoice to show payment UI
                const firstOpen =
                  invoices.find((i) => i.status === "PENDING" && daysOverdue(i.dueDate) > 0) ||
                  invoices.find((i) => i.status === "PENDING");
                if (firstOpen) {
                  setFocusInvId(firstOpen.id);
                  // Scroll into the invoices card
                  const el = document.getElementById("portal-invoices");
                  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                }
              }}
            >
              <CreditCard className="h-4 w-4" />
              Pay {fmtMoney(summary.openAmount, company.currency)} Open
            </Button>
          )}
        </div>

        {/* Print-only statement header */}
        <div className="print-only hidden">
          <div className="p-6 border-2 border-slate-300 rounded-lg bg-white">
            <div className="flex items-start justify-between pb-4 border-b border-slate-300">
              <div>
                {company.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={company.logoUrl} alt={company.name} className="max-h-14 max-w-[180px] object-contain mb-2" />
                ) : (
                  <h1 className="text-2xl font-bold" style={{ color: brand }}>{company.name}</h1>
                )}
                <p className="text-sm text-slate-600">{company.email}{company.phone ? ` · ${company.phone}` : ""}</p>
                {company.address && <p className="text-sm text-slate-600 whitespace-pre-line">{company.address}</p>}
              </div>
              <div className="text-right">
                <h2 className="text-xl font-bold text-slate-900">Account Statement</h2>
                <p className="text-sm text-slate-600">As of {fmtDate(new Date().toISOString())}</p>
              </div>
            </div>
            <div className="py-4 border-b border-slate-300">
              <p className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Bill To</p>
              <p className="font-semibold text-slate-900 mt-1">{client.name}</p>
              <p className="text-sm text-slate-600">{client.email}{client.phone ? ` · ${client.phone}` : ""}</p>
              {client.address && <p className="text-sm text-slate-600 whitespace-pre-line">{client.address}</p>}
            </div>
            <table className="w-full mt-4 text-sm border-collapse">
              <thead>
                <tr className="border-b-2 border-slate-300">
                  <th className="text-left py-2 pr-2">Date</th>
                  <th className="text-left py-2 pr-2">Invoice #</th>
                  <th className="text-left py-2 pr-2">Status</th>
                  <th className="text-right py-2 px-2">Total</th>
                  <th className="text-right py-2 pl-2">Balance</th>
                </tr>
              </thead>
              <tbody>
                {[...invoices].reverse().map((inv) => (
                  <tr key={inv.id} className="border-b border-slate-200">
                    <td className="py-2 pr-2">{fmtDate(inv.issueDate)}</td>
                    <td className="py-2 pr-2 font-mono">{inv.invoiceNumber}</td>
                    <td className="py-2 pr-2">{inv.status === "PAID" ? "Paid" : inv.status === "PENDING" ? (daysOverdue(inv.dueDate) > 0 ? "Overdue" : "Open") : "Draft"}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{fmtMoney(inv.totalAmount, company.currency)}</td>
                    <td className="py-2 pl-2 text-right tabular-nums">{inv.status === "PAID" ? "—" : fmtMoney(inv.totalAmount, company.currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-semibold">
                  <td colSpan={3} className="py-2 text-right pr-2">Balance Due</td>
                  <td colSpan={2} className="py-2 pl-2 text-right text-lg tabular-nums" style={{ color: brand }}>{fmtMoney(summary.openAmount, company.currency)}</td>
                </tr>
              </tfoot>
            </table>
            <p className="mt-6 pt-4 border-t border-slate-300 text-xs text-slate-500 text-center">
              Thank you for your business. Please contact {company.name} with any questions.
            </p>
          </div>
        </div>

        {/* Invoices list */}
        <Card id="portal-invoices" className="border-slate-200/60 dark:border-slate-800 no-print-break">
          <CardHeader className="border-b border-slate-100 dark:border-slate-800 pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4" /> Your Invoices
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {invoices.length === 0 ? (
                <div className="p-10 text-center text-sm text-slate-500">No invoices yet.</div>
              ) : (
                invoices.map((inv) => {
                  const od = inv.status === "PENDING" ? daysOverdue(inv.dueDate) : 0;
                  const isOverdue = od > 0;
                  const isFocus = focusInvId === inv.id;
                  return (
                    <div key={inv.id}>
                      <button
                        type="button"
                        onClick={() => setFocusInvId(inv.id)}
                        className={[
                          "w-full text-left px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 transition-colors",
                          isFocus ? "bg-blue-50/70 dark:bg-blue-950/30" : "hover:bg-slate-50 dark:hover:bg-slate-900/40",
                        ].join(" ")}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-semibold text-slate-900 dark:text-white">{inv.invoiceNumber}</span>
                            <StatusBadge status={inv.status} overdue={isOverdue} />
                            {isOverdue && (
                              <span className="text-xs text-red-600 dark:text-red-400 inline-flex items-center gap-1">
                                <AlertTriangle className="h-3 w-3" />{od}d overdue
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                            Issued {fmtDate(inv.issueDate)} · Due {fmtDate(inv.dueDate)}
                            {inv.paidAt ? <> · Paid {fmtDate(inv.paidAt)}</> : null}
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <p className="font-bold tabular-nums text-slate-900 dark:text-white">{fmtMoney(inv.totalAmount, company.currency)}</p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                            <Link href={`/view/${inv.id}`} target="_blank" rel="noopener noreferrer">
                              <Button type="button" size="sm" variant="ghost">
                                <ExternalLink className="h-4 w-4" />
                              </Button>
                            </Link>
                            <DownloadPdfButton invoiceId={inv.id} publicDownload size="sm" variant="ghost" />
                          </div>
                        </div>
                      </button>

                      {/* Expanded actions for focused invoice */}
                      {isFocus && (
                        <div className="px-5 pb-5 pt-1 bg-blue-50/40 dark:bg-blue-950/20">
                          {/* Totals breakdown */}
                          <div className="rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 mb-4">
                            <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">Invoice Summary</p>
                            <div className="space-y-1.5 text-sm">
                              <div className="flex justify-between">
                                <span className="text-slate-600 dark:text-slate-400">Subtotal</span>
                                <span className="tabular-nums text-slate-900 dark:text-white">{fmtMoney(inv.subtotal, company.currency)}</span>
                              </div>
                              {inv.discountAmount > 0 && (
                                <div className="flex justify-between">
                                  <span className="text-emerald-700 dark:text-emerald-400 font-medium">Discount</span>
                                  <span className="tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">−{fmtMoney(inv.discountAmount, company.currency)}</span>
                                </div>
                              )}
                              <div className="flex justify-between">
                                <span className="text-slate-600 dark:text-slate-400">{(inv.taxLabel || "GST").toUpperCase()} ({inv.taxRate}%)</span>
                                <span className="tabular-nums text-slate-900 dark:text-white">
                                  {fmtMoney(Math.round((inv.totalAmount - inv.subtotal + inv.discountAmount) * 100) / 100, company.currency)}
                                </span>
                              </div>
                              <div className="flex justify-between pt-2 mt-1 border-t border-slate-200 dark:border-slate-800">
                                <span className="font-semibold text-slate-900 dark:text-white">Total due</span>
                                <span className="tabular-nums font-bold text-lg" style={{ color: brand }}>{fmtMoney(inv.totalAmount, company.currency)}</span>
                              </div>
                            </div>
                          </div>

                          {inv.status === "PAID" ? (
                            <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                              <CheckCircle2 className="h-4 w-4" />
                              This invoice has been paid. Thank you!
                            </div>
                          ) : (
                            <div className="space-y-3">
                              {isOverdue && (
                                <div className="text-sm text-red-600 dark:text-red-400 inline-flex items-center gap-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-lg px-3 py-2">
                                  <AlertTriangle className="h-4 w-4" />
                                  This invoice is {od} day{od === 1 ? "" : "s"} overdue.
                                </div>
                              )}
                              {canPayOnline ? (
                                <PayMethods
                                  invoiceId={inv.id}
                                  alreadyPaid={false}
                                  payments={payments}
                                  size="default"
                                  direction="horizontal"
                                  onPaid={refresh}
                                />
                              ) : (
                                <p className="text-sm text-slate-600 dark:text-slate-400">
                                  Online payments are not yet configured. Please contact {company.name} to arrange payment.
                                </p>
                              )}
                              <div className="flex items-center gap-2">
                                <Link href={`/view/${inv.id}`} target="_blank" rel="noopener noreferrer">
                                  <Button type="button" variant="outline" size="sm">
                                    <ExternalLink className="h-4 w-4 mr-2" /> View full invoice
                                  </Button>
                                </Link>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>

        {/* Footer */}
        <p className="no-print text-center text-xs text-slate-400 pt-4">
          Secured by SmartBill · © {new Date().getFullYear()} {company.name}
        </p>
      </div>
    </div>
  );
}

// ------------- Helpers -------------

function SummaryTile({
  label,
  value,
  icon: Icon,
  tint,
}: {
  label: string;
  value: string;
  icon: typeof FileText;
  tint: string;
}) {
  return (
    <Card className="border-slate-200/60 dark:border-slate-800">
      <CardContent className="p-4 flex items-center gap-3">
        <div
          className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${tint}1f`, color: tint }}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">{label}</p>
          <p className="font-bold text-slate-900 dark:text-white truncate">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status, overdue }: { status: "DRAFT" | "PENDING" | "PAID"; overdue: boolean }) {
  if (status === "PAID") {
    return (
      <Badge variant="success" className="gap-1 text-xs">
        <CheckCircle2 className="h-3 w-3" /> Paid
      </Badge>
    );
  }
  if (overdue) {
    return (
      <Badge className="bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300 hover:bg-red-100 gap-1 text-xs">
        <AlertTriangle className="h-3 w-3" /> Overdue
      </Badge>
    );
  }
  if (status === "PENDING") {
    return <Badge variant="warning" className="text-xs">Awaiting Payment</Badge>;
  }
  return <Badge variant="draft" className="text-xs">Draft</Badge>;
}

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

// ------------- Page -------------

export default function PortalPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      }
    >
      <PortalInner />
    </Suspense>
  );
}
