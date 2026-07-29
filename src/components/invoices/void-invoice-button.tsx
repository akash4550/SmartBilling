"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface VoidInvoiceButtonProps {
  invoiceId: string;
  invoiceNumber: string;
  variant?: "outline" | "destructive" | "ghost";
  size?: "default" | "sm";
  /** Disabled state (e.g. already void or paid). */
  disabled?: boolean;
  onVoided?: () => void;
}

export function VoidInvoiceButton({
  invoiceId,
  invoiceNumber,
  variant = "outline",
  size = "default",
  disabled = false,
  onVoided,
}: VoidInvoiceButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleVoid() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "VOID" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to void invoice");
      }
      toast.success(`${invoiceNumber} voided`, {
        description: "The invoice has been cancelled and is no longer payable.",
      });
      setOpen(false);
      onVoided?.();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to void invoice");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} size={size} disabled={disabled}>
          <Ban className="h-4 w-4 mr-2" />
          Void
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void invoice {invoiceNumber}?</DialogTitle>
          <DialogDescription>
            Voiding marks this invoice as cancelled. The client will no longer be able to
            pay it, and it will be excluded from revenue and outstanding totals. This
            action is recorded in the activity timeline.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleVoid} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Yes, void invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
