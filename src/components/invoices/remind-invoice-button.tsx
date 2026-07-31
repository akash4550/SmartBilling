"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { BellRing, Loader2 } from "lucide-react";

interface RemindInvoiceButtonProps {
  invoiceId: string;
  clientEmail: string;
  /** Disabled state parent may want to impose (e.g. loading, already paid). */
  disabled?: boolean;
  /** Size override. */
  size?: "sm" | "default" | "lg";
  /** Variant override. */
  variant?: "outline" | "default" | "secondary" | "ghost" | "destructive";
  /** Extra class names. */
  className?: string;
  /** Called after a successful send — parent can refresh data. */
  onSent?: () => void;
}

/**
 * Triggers POST /api/invoices/:id/remind. Surfaces Resend/config errors and
 * cooldown (429) errors via Sonner toasts, and success with the recipient.
 *
 * The button is intended for the invoice detail page. The dashboard has its
 * own bulk-reminder control.
 */
export function RemindInvoiceButton({
  invoiceId,
  clientEmail,
  disabled,
  size = "default",
  variant = "outline",
  className,
  onSent,
}: RemindInvoiceButtonProps) {
  const [loading, setLoading] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  async function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    // ---- Synchronous DOM lock ----
    const btn = e.currentTarget;
    if (btn.disabled) return;
    if (disabled) return;
    btn.disabled = true;

    // Confirm runs AFTER the lock; if user cancels we unlock immediately.
    if (!confirm(`Send a payment reminder to ${clientEmail}?`)) {
      btn.disabled = !!disabled;
      return;
    }

    // ---- Abort prior in-flight reminder ----
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/remind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 429) {
          toast.error(data.error || "Please wait before sending another reminder");
        } else if (res.status === 503) {
          toast.error("Email not configured", {
            description: "RESEND_API_KEY must be set to send reminders.",
          });
        } else {
          toast.error(data.error || "Failed to send reminder");
        }
        return;
      }
      toast.success("Reminder sent", {
        description: `Sent to ${clientEmail}${
          typeof data.daysOverdue === "number" && data.daysOverdue > 0
            ? ` (${data.daysOverdue}d overdue)`
            : ""
        }`,
      });
      onSent?.();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast.error("Network error — please try again");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      btn.disabled = !!disabled;
      setLoading(false);
    }
  }

  return (
    <Button
      type="button"
      ref={buttonRef}
      variant={variant}
      size={size}
      onClick={handleClick}
      disabled={loading || disabled}
      className={className}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <BellRing className="h-4 w-4 mr-2" />
      )}
      Send Reminder
    </Button>
  );
}
