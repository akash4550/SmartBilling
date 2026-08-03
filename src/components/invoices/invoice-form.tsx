"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus,
  Trash2,
  Save,
  Loader2,
  AlertCircle,
  Sparkles,
  CheckCircle2,
  ArrowLeft,
  Pencil,
} from "lucide-react";
import { formatCurrency, calculateInvoiceTotals } from "@/lib/utils";
import { invoiceSchema, type InvoiceInput } from "@/lib/validations";
import { AiReceiptButton } from "@/components/invoices/ai-receipt-button";
import type { Client } from "@prisma/client";
import { ZodError } from "zod";
import type { ParsedReceipt } from "@/app/api/parse-receipt/route";
import type { InvoiceWithRelations } from "@/types";

// ---------- Types ----------

interface LineItem {
  /** When editing an existing item, this is the real Prisma id. For new
   *  (unsaved) items we generate a client-side UUID so React has stable keys
   *  and the PATCH handler can distinguish new vs existing. */
  id: string;
  description: string;
  quantity: string;
  price: string;
}

type FormMode = "create" | "edit";

interface InvoiceFormProps {
  mode: FormMode;
  clients: Client[];
  /** When editing: the existing invoice (with items+client). */
  invoice?: InvoiceWithRelations;
  /** When creating: optionally pre-select a client (?clientId=). */
  initialClientId?: string;
  /** User's default tax rate (from settings) used for new invoices. */
  defaultTaxRate?: number;
  /** User's default tax label (e.g. GST/VAT/TAX) used for new invoices. */
  defaultTaxLabel?: string;
  /** User's default due-in-days (from settings) used for new invoices. Default 30. */
  defaultDueDays?: number;
  /** User's default notes/terms (from settings) pre-filled on new invoices. */
  defaultNotes?: string;
}

// ---------- Helpers ----------

const emptyItem = (): LineItem => ({
  id: crypto.randomUUID(),
  description: "",
  quantity: "1",
  price: "0",
});

function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function defaultDates(dueInDays = 30) {
  const today = new Date();
  const due = new Date();
  due.setDate(due.getDate() + Math.max(0, dueInDays | 0));
  return { issue: toLocalISODate(today), due: toLocalISODate(due) };
}

type FormErrors = Record<string, string>;

// ---------- Component ----------

export function InvoiceForm({
  mode,
  clients,
  invoice,
  initialClientId,
  defaultTaxRate = 0,
  defaultTaxLabel = "GST",
  defaultDueDays = 30,
  defaultNotes = "",
}: InvoiceFormProps) {
  const router = useRouter();
  const isEdit = mode === "edit";
  const dates = defaultDates(defaultDueDays);

  // Pull discount fields from the Prisma invoice shape (may be undefined
  // on older rows; safely default to no discount).
  type Disc = {
    discountType?: "PERCENT" | "FIXED" | null;
    discountValue?: number | null;
    taxLabel?: string | null;
  };
  const invDisc = (invoice as unknown as Disc | undefined);

  // Initial values — for edit, hydrate from the existing invoice.
  const initials = useMemo(() => {
    if (isEdit && invoice) {
      const issue = toLocalISODate(new Date(invoice.issueDate));
      const due = toLocalISODate(new Date(invoice.dueDate));
      return {
        clientId: invoice.clientId,
        status: invoice.status as "DRAFT" | "PENDING" | "PAID",
        issueDate: issue,
        dueDate: due,
        taxRate: String(Number(invoice.taxRate)),
        taxLabel: (invDisc?.taxLabel ?? defaultTaxLabel ?? "GST").toUpperCase(),
        discountType: (invDisc?.discountType ?? "") as "" | "PERCENT" | "FIXED",
        discountValue: invDisc?.discountValue != null ? String(Number(invDisc.discountValue)) : "",
        notes: invoice.notes ?? "",
        items:
          invoice.items.length > 0
            ? invoice.items.map((it) => ({
                id: it.id,
                description: it.description,
                quantity: String(it.quantity),
                price: String(Number(it.price)),
              }))
            : [emptyItem()],
      };
    }
    return {
      clientId:
        initialClientId && clients.find((c) => c.id === initialClientId)
          ? initialClientId
          : clients[0]?.id ?? "",
      status: "DRAFT" as const,
      issueDate: dates.issue,
      dueDate: dates.due,
      taxRate: String(defaultTaxRate),
      taxLabel: (defaultTaxLabel || "GST").toUpperCase(),
      discountType: "" as "" | "PERCENT" | "FIXED",
      discountValue: "",
      notes: defaultNotes ?? "",
      items: [emptyItem()] as LineItem[],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, invoice?.id]);

  const [clientId, setClientId] = useState<string>(initials.clientId);
  const [status, setStatus] = useState<"DRAFT" | "PENDING" | "PAID">(initials.status);
  const [issueDate, setIssueDate] = useState<string>(initials.issueDate);
  const [dueDate, setDueDate] = useState<string>(initials.dueDate);
  const [taxRate, setTaxRate] = useState<string>(initials.taxRate);
  const [taxLabel, setTaxLabel] = useState<string>(initials.taxLabel);
  const [discountType, setDiscountType] = useState<"" | "PERCENT" | "FIXED">(initials.discountType);
  const [discountValue, setDiscountValue] = useState<string>(initials.discountValue);
  const [notes, setNotes] = useState<string>(initials.notes);
  const [items, setItems] = useState<LineItem[]>(initials.items);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [aiSuccess, setAiSuccess] = useState(false);

  // Sync selected client once the clients list loads in create mode.
  useEffect(() => {
    if (isEdit || clientId || clients.length === 0) return;
    const timer = setTimeout(() => {
      setClientId(
        initialClientId && clients.find((c) => c.id === initialClientId)
          ? initialClientId
          : clients[0].id
      );
    }, 0);
    return () => clearTimeout(timer);
  }, [clients, clientId, initialClientId, isEdit]);

  // When the client changes in create mode, auto-adjust the due date to match
  // that client's payment terms (if set), falling back to the user default.
  useEffect(() => {
    if (isEdit || !clientId) return;
    const client = clients.find((c) => c.id === clientId);
    if (!client) return;
    const clientDueDays = (client as { dueDays?: number | null }).dueDays;
    const days = typeof clientDueDays === "number" && clientDueDays >= 0 ? clientDueDays : defaultDueDays;
    const baseDate = issueDate ? new Date(issueDate) : new Date();
    if (Number.isNaN(baseDate.getTime())) return;
    const due = new Date(baseDate);
    due.setDate(due.getDate() + days);
    const next = toLocalISODate(due);
    const timer = setTimeout(() => setDueDate((prev) => (prev === next ? prev : next)), 0);
    return () => clearTimeout(timer);
  }, [clientId, clients, defaultDueDays, isEdit, issueDate]);

  const totals = useMemo(() => {
    const parsed = items.map((it) => ({
      quantity: Number(it.quantity) || 0,
      price: Number(it.price) || 0,
    }));
    const dType = discountType === "PERCENT" || discountType === "FIXED" ? discountType : null;
    const dVal = dType ? Number(discountValue) || 0 : 0;
    return calculateInvoiceTotals(parsed, Number(taxRate) || 0, { type: dType, value: dVal });
  }, [items, taxRate, discountType, discountValue]);

  function addItem() {
    setItems([...items, emptyItem()]);
  }
  function removeItem(id: string) {
    if (items.length <= 1) return;
    setItems(items.filter((i) => i.id !== id));
  }
  function updateItem(id: string, field: keyof LineItem, value: string) {
    setItems(items.map((i) => (i.id === id ? { ...i, [field]: value } : i)));
  }

  function validate(): boolean {
    setErrors({});
    setSubmitError(null);
    try {
      const dType = discountType === "PERCENT" || discountType === "FIXED" ? discountType : null;
      const payload: InvoiceInput & { notes?: string } = {
        clientId,
        status,
        issueDate,
        dueDate,
        taxRate: Number(taxRate) || 0,
        taxLabel: (taxLabel.trim().toUpperCase() || "GST").slice(0, 12),
        discountType: dType,
        discountValue: dType ? Number(discountValue) || 0 : null,
        notes: notes.trim() || undefined,
        items: items.map((it) => ({
          // Carry item ids through in edit mode so the PATCH endpoint can
          // upsert existing rows instead of deleting/recreating them.
          ...(isEdit ? { id: it.id } : {}),
          description: it.description,
          quantity: Number(it.quantity),
          price: Number(it.price),
        })),
      };
      invoiceSchema.parse(payload);
      return true;
    } catch (err) {
      if (err instanceof ZodError) {
        const next: FormErrors = {};
        for (const issue of err.issues) {
          const key = issue.path.join(".");
          next[key] = issue.message;
        }
        setErrors(next);
        if (next[""] || Object.keys(next).length === 0) {
          setSubmitError(Object.values(next)[0] ?? "Please fix the errors below");
        }
      }
      return false;
    }
  }

  function itemError(itemId: string, field: string): string | undefined {
    const idx = items.findIndex((i) => i.id === itemId);
    return errors[`items.${idx}.${field}`];
  }

  function handleAiParsed(data: ParsedReceipt) {
    const newItems: LineItem[] = data.items.map((it) => ({
      id: crypto.randomUUID(),
      description: it.description,
      quantity: String(it.quantity),
      price: String(it.price),
    }));
    setItems(newItems);
    const match = clients.find(
      (c) => c.name.toLowerCase() === data.clientName.trim().toLowerCase()
    );
    if (match) setClientId(match.id);
    setErrors((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((k) => {
        if (k.startsWith("items.")) delete next[k];
      });
      return next;
    });
    setAiSuccess(true);
    setTimeout(() => setAiSuccess(false), 2500);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setLoading(true);
    setSubmitError(null);

    const dType = discountType === "PERCENT" || discountType === "FIXED" ? discountType : null;
    const payload = {
      clientId,
      status,
      issueDate,
      dueDate,
      taxRate: Number(taxRate) || 0,
      taxLabel: (taxLabel.trim().toUpperCase() || "GST").slice(0, 12),
      discountType: dType,
      discountValue: dType ? Number(discountValue) || 0 : null,
      notes: notes.trim() || undefined,
      items: items.map((it) => ({
        ...(isEdit ? { id: it.id } : {}),
        description: it.description.trim(),
        quantity: Number(it.quantity),
        price: Number(it.price),
      })),
    };

    try {
      const url = isEdit ? `/api/invoices/${invoice!.id}` : "/api/invoices";
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.details && Array.isArray(data.details)) {
          const next: FormErrors = {};
          for (const d of data.details as Array<{ field: string; message: string }>) {
            next[d.field] = d.message;
          }
          setErrors(next);
        }
        setSubmitError(data.error || (isEdit ? "Failed to update invoice" : "Failed to create invoice"));
        toast.error(data.error || (isEdit ? "Failed to update invoice" : "Failed to create invoice"));
        return;
      }
      if (isEdit) {
        toast.success("Invoice updated", { description: data.invoiceNumber ?? "Changes saved" });
        router.push(`/invoices/${data.id}`);
        router.refresh();
      } else {
        toast.success("Invoice created", { description: data.invoiceNumber ?? "New invoice ready" });
        router.push(`/invoices/${data.id}`);
        router.refresh();
      }
    } catch {
      setSubmitError("Network error — please check your connection and try again");
      toast.error("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  const headerTitle = isEdit ? "Edit Invoice" : "New Invoice";
  const headerSubtitle = isEdit
    ? `Update details for ${invoice?.invoiceNumber ?? "this invoice"}`
    : "Create a new invoice to send to your client";
  const submitLabel = isEdit ? "Save Changes" : "Create Invoice";
  const submittingLabel = isEdit ? "Saving..." : "Creating Invoice...";
  const backHref = isEdit && invoice ? `/invoices/${invoice.id}` : "/invoices";

  return (
    <form onSubmit={handleSubmit} className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-6">
        {/* Header card */}
        <div className="flex items-center justify-between no-print">
          <div className="flex items-center gap-3">
            <Link href={backHref}>
              <Button variant="ghost" size="icon" className="rounded-full">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{headerTitle}</h1>
              <p className="text-slate-500 dark:text-slate-400 text-sm mt-0.5">{headerSubtitle}</p>
            </div>
          </div>
        </div>

        {(submitError || errors.dueDate || errors.clientId) && (
          <div className="flex items-start gap-3 p-4 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 text-sm text-red-700 dark:text-red-300 animate-in fade-in">
            <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">{submitError ?? "Please fix the following errors:"}</p>
              <ul className="list-disc list-inside mt-1 text-red-600 dark:text-red-400">
                {errors.dueDate && <li>{errors.dueDate}</li>}
                {errors.clientId && <li>{errors.clientId}</li>}
              </ul>
            </div>
          </div>
        )}

        {aiSuccess && (
          <div className="flex items-center gap-3 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-sm text-emerald-700 dark:text-emerald-300 animate-in fade-in">
            <CheckCircle2 className="h-5 w-5 shrink-0" />
            <span className="font-medium">Receipt scanned successfully — items imported.</span>
          </div>
        )}

        <Card className="border-slate-200/60 dark:border-slate-800/60 overflow-hidden">
          <CardHeader className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 rounded-t-xl">
            <CardTitle className="text-base flex items-center gap-2">
              <span className="h-7 w-7 rounded-lg bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center">
                {isEdit ? (
                  <Pencil className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                ) : (
                  <Sparkles className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                )}
              </span>
              Invoice Details
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="client" className="text-slate-700 dark:text-slate-300 font-medium">Client <span className="text-red-500">*</span></Label>
                <select
                  id="client"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className={`flex h-11 w-full rounded-lg border bg-white dark:bg-slate-950 dark:text-slate-100 px-3 py-2 text-sm ring-offset-white dark:ring-offset-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400 focus-visible:ring-offset-2 ${
                    errors.clientId ? "border-red-400 dark:border-red-500" : "border-slate-200 dark:border-slate-700"
                  }`}
                >
                  <option value="">Select a client...</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.email})</option>
                  ))}
                </select>
                {errors.clientId && <p className="text-xs text-red-600 dark:text-red-400">{errors.clientId}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="status" className="text-slate-700 dark:text-slate-300 font-medium">Status</Label>
                <select
                  id="status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as "DRAFT" | "PENDING" | "PAID")}
                  className="flex h-11 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 dark:text-slate-100 px-3 py-2 text-sm ring-offset-white dark:ring-offset-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400 focus-visible:ring-offset-2"
                >
                  <option value="DRAFT">📝 Draft</option>
                  <option value="PENDING">⏳ Pending (sent)</option>
                  <option value="PAID">✅ Paid</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="issueDate" className="text-slate-700 dark:text-slate-300 font-medium">Issue Date <span className="text-red-500">*</span></Label>
                <Input id="issueDate" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className="h-11" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dueDate" className="text-slate-700 dark:text-slate-300 font-medium">Due Date <span className="text-red-500">*</span></Label>
                <Input
                  id="dueDate"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className={errors.dueDate ? "h-11 border-red-400 dark:border-red-500" : "h-11"}
                />
                {errors.dueDate && <p className="text-xs text-red-600 dark:text-red-400">{errors.dueDate}</p>}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="taxRate" className="text-slate-700 dark:text-slate-300 font-medium">Tax Rate (%)</Label>
                <Input id="taxRate" type="number" min={0} max={100} step="0.01" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} className="h-11" />
                {errors.taxRate && <p className="text-xs text-red-600 dark:text-red-400">{errors.taxRate}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="taxLabel" className="text-slate-700 dark:text-slate-300 font-medium">Tax Label</Label>
                <Input
                  id="taxLabel"
                  value={taxLabel}
                  onChange={(e) => setTaxLabel(e.target.value.toUpperCase())}
                  maxLength={12}
                  placeholder="GST"
                  className="h-11 uppercase tracking-wide font-medium"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Shown on invoices (e.g. GST, VAT, IGST, TAX).
                </p>
                {errors.taxLabel && <p className="text-xs text-red-600 dark:text-red-400">{errors.taxLabel}</p>}
              </div>
            </div>

            {/* Discount */}
            <div className="space-y-2">
              <Label className="text-slate-700 dark:text-slate-300 font-medium">
                Discount <span className="text-slate-400 font-normal">(optional)</span>
              </Label>
              <div className="flex items-stretch gap-2">
                <select
                  value={discountType}
                  onChange={(e) => setDiscountType(e.target.value as "" | "PERCENT" | "FIXED")}
                  className="h-11 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <option value="">No discount</option>
                  <option value="PERCENT">Percentage (%)</option>
                  <option value="FIXED">Flat amount</option>
                </select>
                <div className="relative flex-1">
                  {discountType === "FIXED" && (
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm pointer-events-none">₹</span>
                  )}
                  <Input
                    type="number"
                    min={0}
                    step={discountType === "PERCENT" ? "0.01" : "0.01"}
                    max={discountType === "PERCENT" ? 100 : undefined}
                    disabled={!discountType}
                    placeholder={discountType === "PERCENT" ? "e.g. 10" : discountType === "FIXED" ? "e.g. 500" : "0"}
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    className={["h-11", discountType === "FIXED" ? "pl-7" : ""].join(" ")}
                  />
                  {discountType === "PERCENT" && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm pointer-events-none">%</span>
                  )}
                </div>
                {totals.discountAmount > 0 && (
                  <div className="flex items-center px-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-emerald-700 dark:text-emerald-300 text-sm font-medium whitespace-nowrap">
                    −{formatCurrency(totals.discountAmount)}
                  </div>
                )}
              </div>
              {errors.discountValue && <p className="text-xs text-red-600 dark:text-red-400">{errors.discountValue}</p>}
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Discount is applied before tax (e.g. 10% off the subtotal, then tax is calculated on the remainder).
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes" className="text-slate-700 dark:text-slate-300 font-medium">
                Notes / Terms <span className="text-slate-400 font-normal">(optional)</span>
              </Label>
              <Textarea
                id="notes"
                rows={3}
                placeholder="Payment terms, bank details, thank-you note, etc."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={2000}
                className="resize-y min-h-[88px]"
              />
              {errors.notes && <p className="text-xs text-red-600 dark:text-red-400">{errors.notes}</p>}
              <p className="text-xs text-slate-400 text-right">{notes.length}/2000</p>
            </div>
          </CardContent>
        </Card>

        {/* Line Items */}
        <Card className="border-slate-200/60 dark:border-slate-800/60 overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 gap-2 flex-wrap border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 rounded-t-xl">
            <CardTitle className="text-base flex items-center gap-2">
              <span className="h-7 w-7 rounded-lg bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center">
                <span className="text-sm">🧾</span>
              </span>
              Line Items
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              {!isEdit && <AiReceiptButton onParsed={handleAiParsed} onError={(msg) => setSubmitError(msg)} />}
              <Button type="button" variant="outline" size="sm" onClick={addItem} className="border-dashed">
                <Plus className="h-4 w-4 mr-1" /> Add Item
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-6 space-y-0">
            <div className="hidden md:grid grid-cols-12 gap-3 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-bold px-1 pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="col-span-6">Description</div>
              <div className="col-span-2 text-right">Qty</div>
              <div className="col-span-2 text-right">Price (₹)</div>
              <div className="col-span-1 text-right">Total</div>
              <div className="col-span-1"></div>
            </div>

            {items.map((item, idx) => {
              const qty = Number(item.quantity) || 0;
              const price = Number(item.price) || 0;
              const lineTotal = qty * price;
              const descErr = itemError(item.id, "description");
              const qtyErr = itemError(item.id, "quantity");
              const priceErr = itemError(item.id, "price");

              return (
                <div
                  key={item.id}
                  className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end md:items-center py-4 md:py-3 border-b md:border-b border-slate-100 dark:border-slate-800 last:border-0 md:last:border-b-0"
                >
                  <div className="md:col-span-6 space-y-1 md:space-y-0">
                    <Label className="md:hidden text-xs font-medium text-slate-500">Description <span className="text-red-500">*</span></Label>
                    <Input
                      placeholder={`Item ${idx + 1} description`}
                      value={item.description}
                      onChange={(e) => updateItem(item.id, "description", e.target.value)}
                      className={descErr ? "border-red-400" : ""}
                    />
                    {descErr && <p className="text-xs text-red-600 dark:text-red-400 md:hidden">{descErr}</p>}
                  </div>
                  <div className="md:col-span-2 space-y-1 md:space-y-0">
                    <Label className="md:hidden text-xs font-medium text-slate-500">Qty <span className="text-red-500">*</span></Label>
                    <Input
                      type="number"
                      min={1}
                      step="1"
                      value={item.quantity}
                      onChange={(e) => updateItem(item.id, "quantity", e.target.value)}
                      className={`md:text-center ${qtyErr ? "border-red-400" : ""}`}
                    />
                  </div>
                  <div className="md:col-span-2 space-y-1 md:space-y-0">
                    <Label className="md:hidden text-xs font-medium text-slate-500">Price (₹) <span className="text-red-500">*</span></Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={item.price}
                      onChange={(e) => updateItem(item.id, "price", e.target.value)}
                      className={`md:text-right ${priceErr ? "border-red-400" : ""}`}
                    />
                  </div>
                  <div className="md:col-span-1 text-right text-sm font-bold px-1 tabular-nums text-slate-900 dark:text-white">
                    <span className="md:hidden text-xs font-normal text-slate-500 mr-2">Total:</span>
                    {formatCurrency(lineTotal)}
                  </div>
                  <div className="md:col-span-1 flex md:justify-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeItem(item.id)}
                      disabled={items.length === 1}
                      className="text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
                      aria-label="Remove item"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {(descErr || qtyErr || priceErr) && (
                    <div className="md:col-span-11 hidden md:block">
                      <p className="text-xs text-red-600 dark:text-red-400 -mt-1 pl-1">{descErr || qtyErr || priceErr}</p>
                    </div>
                  )}
                </div>
              );
            })}
            {errors.items && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{errors.items}</p>}
          </CardContent>
        </Card>
      </div>

      {/* Summary sidebar */}
      <div className="lg:col-span-1">
        <Card className="sticky top-24 border-slate-200/60 dark:border-slate-800/60 shadow-lg shadow-blue-500/5 overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500" />
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-blue-500" />
              Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-600 dark:text-slate-400">Subtotal</span>
              <span className="font-medium tabular-nums text-slate-900 dark:text-white">{formatCurrency(totals.subtotal)}</span>
            </div>
            {totals.discountAmount > 0 && (
              <div className="flex justify-between py-2 border-b border-emerald-100 dark:border-emerald-900/40 text-emerald-700 dark:text-emerald-400">
                <span>
                  Discount
                  {discountType === "PERCENT" && Number(discountValue) > 0
                    ? ` (${Number(discountValue)}%)`
                    : ""}
                </span>
                <span className="font-medium tabular-nums">−{formatCurrency(totals.discountAmount)}</span>
              </div>
            )}
            <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-600 dark:text-slate-400">
                {taxLabel || "TAX"} {Number(taxRate) ? `(${Number(taxRate)}%)` : ""}
              </span>
              <span className="font-medium tabular-nums text-slate-900 dark:text-white">{formatCurrency(totals.taxAmount)}</span>
            </div>
            <Separator />
            <div className="flex justify-between py-2 items-center">
              <span className="text-base font-bold text-slate-900 dark:text-white">Total</span>
              <span className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400 bg-clip-text text-transparent tabular-nums">
                {formatCurrency(totals.total)}
              </span>
            </div>

            <Button type="submit" className="w-full mt-6 h-12 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25 text-base font-medium" size="lg" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> {submittingLabel}
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" /> {submitLabel}
                </>
              )}
            </Button>

            <p className="text-xs text-slate-400 dark:text-slate-500 text-center mt-2 leading-relaxed">
              Totals are recalculated server-side to prevent tampering.
            </p>
          </CardContent>
        </Card>
      </div>
    </form>
  );
}
