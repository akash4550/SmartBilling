"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Trash2, Loader2, Calendar, RefreshCw } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type { RecurringProfileDetail, RecurringProfileWithRelations, RecurrenceFrequency } from "@/types";
import { formatCurrency } from "@/lib/utils";
import { calculateInvoiceTotals } from "@/lib/utils";

interface LineItem {
  id: string;
  description: string;
  quantity: string;
  price: string;
}

interface ClientOption {
  id: string;
  name: string;
  email: string;
}

interface RecurringProfileDialogProps {
  trigger?: React.ReactNode;
  /** Editing an existing profile (loads it for editing), omit to create. */
  profile?: RecurringProfileDetail | RecurringProfileWithRelations | null;
  onSuccess?: () => void;
}

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


export function RecurringProfileDialog({ trigger, profile, onSuccess }: RecurringProfileDialogProps) {
  const router = useRouter();
  const editing = !!profile;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [clients, setClients] = useState<ClientOption[]>([]);

  const [clientId, setClientId] = useState("");
  const [frequency, setFrequency] = useState<RecurrenceFrequency>("MONTHLY");
  const [intervalDays, setIntervalDays] = useState("30");
  const [dueInDays, setDueInDays] = useState("30");
  const [taxRate, setTaxRate] = useState("0");
  const [notes, setNotes] = useState("");
  const [autoSend, setAutoSend] = useState(true);
  const [active, setActive] = useState(true);
  const [startDate, setStartDate] = useState(toLocalISODate(new Date()));
  const [endDate, setEndDate] = useState("");
  const [items, setItems] = useState<LineItem[]>([emptyItem()]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Load clients on open (so we don't fetch on initial render).
  useEffect(() => {
    if (!open || clients.length > 0) return;
    (async () => {
      try {
        const res = await fetch("/api/clients", { cache: "no-store" });
        if (res.ok) {
          const data: ClientOption[] = await res.json();
          setClients(data);
        }
      } catch {
        /* ignore */
      }
    })();
  }, [open, clients.length]);

  // Hydrate from profile when editing
  useEffect(() => {
    if (!open || !profile) return;
    const timer = setTimeout(() => {
      setClientId(profile.clientId);
      setFrequency(profile.frequency);
      setIntervalDays(String(profile.intervalDays ?? 30));
      setDueInDays(String(profile.dueInDays));
      setTaxRate(String(Number(profile.taxRate)));
      setNotes(profile.notes ?? "");
      setAutoSend(profile.autoSend);
      setActive(profile.active);
      setStartDate(toLocalISODate(new Date(profile.nextRunAt)));
      setEndDate(profile.endDate ? toLocalISODate(new Date(profile.endDate)) : "");
      setItems(profile.items.length > 0 ? profile.items.map((i) => ({ id: i.id, description: i.description, quantity: String(i.quantity), price: String(Number(i.price)) })) : [emptyItem()]);
    }, 0);
    return () => clearTimeout(timer);
  }, [open, profile]);

  function reset() {
    setClientId("");
    setFrequency("MONTHLY");
    setIntervalDays("30");
    setDueInDays("30");
    setTaxRate("0");
    setNotes("");
    setAutoSend(true);
    setActive(true);
    setStartDate(toLocalISODate(new Date()));
    setEndDate("");
    setItems([emptyItem()]);
    setErrors({});
  }

  // Live totals
  const totals = (() => {
    const parsed = items.map((i) => ({
      quantity: Number(i.quantity) || 0,
      price: Number(i.price) || 0,
    }));
    return calculateInvoiceTotals(parsed, Number(taxRate) || 0);
  })();

  function updateItem(id: string, patch: Partial<LineItem>) {
    setItems((current) => current.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function addItem() {
    setItems((current) => [...current, emptyItem()]);
  }

  function removeItem(id: string) {
    setItems((current) => (current.length <= 1 ? current : current.filter((i) => i.id !== id)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErrors({});

    const payload = {
      clientId,
      frequency,
      intervalDays: frequency === "CUSTOM_DAYS" ? Number(intervalDays) : undefined,
      dueInDays: Number(dueInDays),
      taxRate: Number(taxRate),
      notes: notes.trim() || undefined,
      autoSend,
      active,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      items: items.map((i) => ({
        description: i.description.trim(),
        quantity: Number(i.quantity),
        price: Number(i.price),
      })),
    };

    try {
      const res = await fetch(editing ? `/api/recurring/${profile!.id}` : "/api/recurring", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (Array.isArray(data.details)) {
          const fe: Record<string, string> = {};
          for (const d of data.details as Array<{ field: string; message: string }>) {
            fe[d.field] = d.message;
          }
          setErrors(fe);
        } else {
          setErrors({ _form: data.error || "Failed to save recurring profile" });
        }
        return;
      }
      toast.success(editing ? "Recurring profile updated" : "Recurring profile created", {
        description: editing
          ? "Changes saved."
          : autoSend
          ? "Invoices will be automatically generated and emailed."
          : "Invoices will be generated as drafts.",
      });
      setOpen(false);
      reset();
      router.refresh();
      onSuccess?.();
    } catch {
      setErrors({ _form: "Network error — please try again" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <RefreshCw className="h-4 w-4 mr-2" />
            New Recurring Invoice
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Recurring Profile" : "New Recurring Invoice"}</DialogTitle>
          <DialogDescription>
            Automatically generate invoices on a schedule — perfect for retainers, subscriptions, and monthly billing.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {errors._form && (
            <div className="p-3 rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300">
              {errors._form}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="rp-client">Client <span className="text-red-500">*</span></Label>
              <select
                id="rp-client"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                required
              >
                <option value="">Select a client…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} — {c.email}</option>
                ))}
              </select>
              {errors.clientId && <p className="text-xs text-red-600">{errors.clientId}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="rp-freq" className="flex items-center gap-1.5">
                <RefreshCw className="h-3.5 w-3.5 text-slate-400" /> Frequency
              </Label>
              <select
                id="rp-freq"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as RecurrenceFrequency)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly (recommended)</option>
                <option value="YEARLY">Yearly</option>
                <option value="CUSTOM_DAYS">Custom (every N days)</option>
              </select>
            </div>

            {frequency === "CUSTOM_DAYS" && (
              <div className="space-y-2">
                <Label htmlFor="rp-interval">Repeat every (days)</Label>
                <Input
                  id="rp-interval"
                  type="number"
                  min={1}
                  max={365}
                  value={intervalDays}
                  onChange={(e) => setIntervalDays(e.target.value)}
                  required
                />
                {errors.intervalDays && <p className="text-xs text-red-600">{errors.intervalDays}</p>}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="rp-due">Payment due (days after issue)</Label>
              <Input id="rp-due" type="number" min={0} max={365} value={dueInDays} onChange={(e) => setDueInDays(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rp-tax">Tax rate (%)</Label>
              <Input id="rp-tax" type="number" min={0} max={100} step="0.01" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="rp-start" className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 text-slate-400" /> First issue date
              </Label>
              <Input id="rp-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rp-end">End date (optional)</Label>
              <Input id="rp-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              {errors.endDate && <p className="text-xs text-red-600">{errors.endDate}</p>}
            </div>
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} className="h-4 w-4 rounded border-input" />
              Auto-send invoices to client via email
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 rounded border-input" />
              Active
            </label>
          </div>

          <Separator />

          <div>
            <Label className="mb-2 block">Line Items</Label>
            <div className="space-y-2">
              {items.map((item, i) => (
                <div key={item.id} className="flex gap-2 items-start">
                  <Input
                    placeholder="Description"
                    value={item.description}
                    onChange={(e) => updateItem(item.id, { description: e.target.value })}
                    className="flex-1"
                    required
                  />
                  <Input
                    type="number"
                    min={1}
                    placeholder="Qty"
                    value={item.quantity}
                    onChange={(e) => updateItem(item.id, { quantity: e.target.value })}
                    className="w-20"
                  />
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="Price"
                    value={item.price}
                    onChange={(e) => updateItem(item.id, { price: e.target.value })}
                    className="w-28"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => removeItem(item.id)}
                    disabled={items.length <= 1}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  {i === items.length - 1 && false /* hidden index */}
                </div>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addItem} className="mt-2">
              <Plus className="h-4 w-4 mr-1" /> Add item
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="rp-notes">Notes / Terms (optional)</Label>
            <Textarea
              id="rp-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="Thank you for your business! Payment due per terms above."
            />
            <p className="text-xs text-slate-400 text-right">{notes.length}/2000</p>
          </div>

          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/40 p-4 flex items-center justify-between">
            <div className="text-sm text-slate-600 dark:text-slate-400">
              <p>Subtotal: {formatCurrency(totals.subtotal)}</p>
              <p>Tax: {formatCurrency(totals.taxAmount)}</p>
              <p className="font-semibold text-slate-900 dark:text-white mt-1">Per-invoice total</p>
            </div>
            <div className="text-xl font-bold tabular-nums">{formatCurrency(totals.total)}</div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { setOpen(false); reset(); }} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editing ? "Save changes" : "Create recurring profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
