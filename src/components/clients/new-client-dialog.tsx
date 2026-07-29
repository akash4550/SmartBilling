"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Phone, StickyNote, CalendarClock } from "lucide-react";
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

interface NewClientDialogProps {
  /** Optional custom trigger element (replaces default button). */
  trigger?: React.ReactNode;
  /** Called after a client is successfully created. */
  onSuccess?: () => void;
}

interface FormErrors {
  name?: string;
  email?: string;
  address?: string;
  phone?: string;
  notes?: string;
  dueDays?: string;
  _form?: string;
}

export function NewClientDialog({ trigger, onSuccess }: NewClientDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [form, setForm] = useState({ name: "", email: "", address: "", phone: "", notes: "", dueDays: "" });

  function reset() {
    setForm({ name: "", email: "", address: "", phone: "", notes: "", dueDays: "" });
    setErrors({});
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErrors({});

    // Client-side validation (mirrors Zod schema for instant feedback)
    const newErrors: FormErrors = {};
    if (!form.name.trim() || form.name.trim().length < 2) {
      newErrors.name = "Name must be at least 2 characters";
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!form.email.trim() || !emailRe.test(form.email.trim())) {
      newErrors.email = "Please enter a valid email";
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          address: form.address.trim() || undefined,
          phone: form.phone.trim() || undefined,
          notes: form.notes.trim() || undefined,
          dueDays: form.dueDays.trim() === "" ? undefined : Number(form.dueDays),
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.details && Array.isArray(data.details)) {
          const fieldErrors: FormErrors = {};
          for (const d of data.details as Array<{ field: string; message: string }>) {
            if (d.field === "name") fieldErrors.name = d.message;
            else if (d.field === "email") fieldErrors.email = d.message;
            else if (d.field === "address") fieldErrors.address = d.message;
            else if (d.field === "phone") fieldErrors.phone = d.message;
            else if (d.field === "notes") fieldErrors.notes = d.message;
            else if (d.field === "dueDays") fieldErrors.dueDays = d.message;
            else fieldErrors._form = d.message;
          }
          setErrors(fieldErrors);
        } else {
          setErrors({ _form: data.error || "Failed to create client" });
        }
        return;
      }

      // Success
      reset();
      setOpen(false);
      router.refresh();
      onSuccess?.();
    } catch {
      setErrors({ _form: "Network error — please try again" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset(); }}>
      {/* Always use asChild so DialogTrigger never renders its own wrapping
          <button>, which would nest inside <Button> and produce invalid
          HTML / React hydration warnings. */}
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Add Client
          </Button>
        )}
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Client</DialogTitle>
          <DialogDescription>
            Add a new customer. You can create invoices for them once saved.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="p-6 pt-0 space-y-4">
          {errors._form && (
            <div className="p-3 rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300">
              {errors._form}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="client-name">Name <span className="text-red-500">*</span></Label>
            <Input
              id="client-name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Company or person name"
              aria-invalid={!!errors.name}
            />
            {errors.name && <p className="text-xs text-red-600">{errors.name}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="client-email">Email <span className="text-red-500">*</span></Label>
            <Input
              id="client-email"
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="contact@example.com"
              aria-invalid={!!errors.email}
            />
            {errors.email && <p className="text-xs text-red-600">{errors.email}</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="client-phone" className="flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5 text-slate-400" /> Phone
              </Label>
              <Input
                id="client-phone"
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="+91 98765 43210"
                aria-invalid={!!errors.phone}
              />
              {errors.phone && <p className="text-xs text-red-600">{errors.phone}</p>}
            </div>
            <div />
          </div>

          <div className="space-y-2">
            <Label htmlFor="client-address">Address</Label>
            <Input
              id="client-address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="Street, city, state, ZIP"
            />
            {errors.address && <p className="text-xs text-red-600">{errors.address}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="client-duedays" className="flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5 text-slate-400" /> Payment Terms (days)
            </Label>
            <Input
              id="client-duedays"
              type="number"
              min={0}
              max={365}
              value={form.dueDays}
              onChange={(e) => setForm({ ...form, dueDays: e.target.value })}
              placeholder="Optional (uses default)"
            />
            <p className="text-[11px] text-slate-500">Override default due days for this client.</p>
            {errors.dueDays && <p className="text-xs text-red-600">{errors.dueDays}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="client-notes" className="flex items-center gap-1.5">
              <StickyNote className="h-3.5 w-3.5 text-slate-400" /> Notes (internal)
            </Label>
            <Textarea
              id="client-notes"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Billing preferences, account manager… (private)"
              rows={2}
            />
            {errors.notes && <p className="text-xs text-red-600">{errors.notes}</p>}
          </div>

          <DialogFooter className="px-0 pb-0 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => { setOpen(false); reset(); }}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Saving..." : "Save Client"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
