"use client";

import { useState, useEffect } from "react";
import { Pencil, Phone, StickyNote, CalendarClock } from "lucide-react";
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
} from "@/components/ui/dialog";
import type { Client } from "@prisma/client";

interface FormErrors {
  name?: string;
  email?: string;
  address?: string;
  phone?: string;
  notes?: string;
  dueDays?: string;
  _form?: string;
}

interface EditClientDialogProps {
  client: Client | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function EditClientDialog({ client, open, onOpenChange, onSuccess }: EditClientDialogProps) {
  const [form, setForm] = useState({ name: "", email: "", address: "", phone: "", notes: "", dueDays: "" });
  const [errors, setErrors] = useState<FormErrors>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!client || !open) return;
    const timer = setTimeout(() => {
      setForm({
        name: client.name ?? "",
        email: client.email ?? "",
        address: client.address ?? "",
        phone: client.phone ?? "",
        notes: (client as { notes?: string | null }).notes ?? "",
        dueDays: (client as { dueDays?: number | null }).dueDays != null
          ? String((client as { dueDays?: number | null }).dueDays)
          : "",
      });
      setErrors({});
    }, 0);
    return () => clearTimeout(timer);
  }, [client, open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!client) return;
    setLoading(true);
    setErrors({});

    const newErrors: FormErrors = {};
    if (!form.name.trim() || form.name.trim().length < 2) newErrors.name = "Name must be at least 2 characters";
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!form.email.trim() || !emailRe.test(form.email.trim())) newErrors.email = "Please enter a valid email";
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          address: form.address.trim() || undefined,
          phone: form.phone.trim() || undefined,
          notes: form.notes.trim() || undefined,
          dueDays: form.dueDays.trim() === "" ? null : Number(form.dueDays),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.details && Array.isArray(data.details)) {
          const fe: FormErrors = {};
          for (const d of data.details as Array<{ field: string; message: string }>) {
            if (d.field === "name") fe.name = d.message;
            else if (d.field === "email") fe.email = d.message;
            else if (d.field === "address") fe.address = d.message;
            else if (d.field === "phone") fe.phone = d.message;
            else if (d.field === "notes") fe.notes = d.message;
            else if (d.field === "dueDays") fe.dueDays = d.message;
            else fe._form = d.message;
          }
          setErrors(fe);
        } else {
          setErrors({ _form: data.error || "Failed to update client" });
        }
        return;
      }
      onOpenChange(false);
      onSuccess?.();
    } catch {
      setErrors({ _form: "Network error — please try again" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            Edit Client
          </DialogTitle>
          <DialogDescription>
            Update client details. Changes will appear on future invoices.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {errors._form && (
            <div className="p-3 rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300">
              {errors._form}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="edit-client-name">Name <span className="text-red-500">*</span></Label>
            <Input id="edit-client-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-invalid={!!errors.name} />
            {errors.name && <p className="text-xs text-red-600">{errors.name}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-client-email">Email <span className="text-red-500">*</span></Label>
            <Input id="edit-client-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-invalid={!!errors.email} />
            {errors.email && <p className="text-xs text-red-600">{errors.email}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-client-phone" className="flex items-center gap-1.5">
              <Phone className="h-3.5 w-3.5 text-slate-400" /> Phone
            </Label>
            <Input id="edit-client-phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+91 98765 43210" aria-invalid={!!errors.phone} />
            {errors.phone && <p className="text-xs text-red-600">{errors.phone}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-client-address">Address</Label>
            <Input id="edit-client-address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Street, city, state, ZIP" aria-invalid={!!errors.address} />
            {errors.address && <p className="text-xs text-red-600">{errors.address}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-client-duedays" className="flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5 text-slate-400" /> Payment Terms (days)
            </Label>
            <Input
              id="edit-client-duedays"
              type="number"
              min={0}
              max={365}
              value={form.dueDays}
              onChange={(e) => setForm({ ...form, dueDays: e.target.value })}
              placeholder="Leave blank to use default"
              aria-invalid={!!errors.dueDays}
            />
            <p className="text-[11px] text-slate-500">Override default due days for new invoices for this client.</p>
            {errors.dueDays && <p className="text-xs text-red-600">{errors.dueDays}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-client-notes" className="flex items-center gap-1.5">
              <StickyNote className="h-3.5 w-3.5 text-slate-400" /> Internal Notes
            </Label>
            <Textarea
              id="edit-client-notes"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Billing preferences, account manager, preferred contact hours… (private, not shown to client)"
              rows={3}
              aria-invalid={!!errors.notes}
            />
            {errors.notes && <p className="text-xs text-red-600">{errors.notes}</p>}
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? "Saving..." : "Save Changes"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
