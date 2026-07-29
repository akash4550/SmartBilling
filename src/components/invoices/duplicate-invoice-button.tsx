"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Copy, Loader2 } from "lucide-react";

interface DuplicateInvoiceButtonProps {
  invoiceId: string;
  /** Override label */
  label?: string;
  size?: "sm" | "default" | "icon";
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
  className?: string;
}

/**
 * Creates a new DRAFT invoice that copies the line items, notes, client, and
 * tax rate from the source, then navigates to the new invoice's edit page.
 */
export function DuplicateInvoiceButton({
  invoiceId,
  label = "Duplicate",
  size = "default",
  variant = "outline",
  className,
}: DuplicateInvoiceButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDuplicate() {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/duplicate`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to duplicate invoice");
        return;
      }
      toast.success("Invoice duplicated", {
        description: `New draft created — ${data.invoiceNumber ?? ""}`,
      });
      router.push(`/invoices/${data.id}/edit`);
      router.refresh();
    } catch {
      toast.error("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button type="button" variant={variant} size={size} onClick={handleDuplicate} disabled={loading} className={className}>
      {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Copy className="h-4 w-4 mr-2" />}
      {label}
    </Button>
  );
}
