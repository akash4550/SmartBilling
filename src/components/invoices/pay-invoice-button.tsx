"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CreditCard, Loader2, IndianRupee } from "lucide-react";

interface PayInvoiceButtonProps {
  invoiceId: string;
  alreadyPaid?: boolean;
  size?: "sm" | "default" | "lg";
  className?: string;
  /** Preferred provider: "stripe" redirects to Stripe Checkout; "razorpay" opens
   *  the Razorpay Checkout modal inline. If omitted, defaults to stripe. */
  provider?: "stripe" | "razorpay";
  /** Razorpay key id (required when provider=razorpay). */
  razorpayKeyId?: string | null;
  variant?: "default" | "outline" | "secondary" | "destructive" | "ghost" | "link";
  /** Optional label override (e.g. "Pay with UPI / Card" vs "Pay Now"). */
  label?: string;
  /** Called after a successful payment. */
  onPaid?: () => void;
}

/**
 * Pay button that supports both Stripe (redirect to hosted Checkout) and
 * Razorpay (inline Checkout modal, loads SDK via <script> on demand). The
 * Razorpay flow creates an order via POST /api/invoices/:id/pay-razorpay,
 * opens the Razorpay modal, and verifies the returned signature via PATCH
 * /api/invoices/:id/pay-razorpay before marking PAID client-side.
 */
export function PayInvoiceButton({
  invoiceId,
  alreadyPaid,
  size = "default",
  className,
  provider = "stripe",
  razorpayKeyId,
  variant = "default",
  label,
  onPaid,
}: PayInvoiceButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleStripe() {
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data?.alreadyPaid) {
        toast.success("This invoice is already paid");
        router.refresh();
        return;
      }
      if (!res.ok) {
        if (res.status === 503) {
          toast.error("Payments not set up", {
            description: "This merchant hasn't enabled online card payments yet.",
          });
        } else {
          toast.error(data.error || "Failed to start payment");
        }
        return;
      }
      if (!data.url) {
        toast.error("Failed to start payment — no checkout URL returned");
        return;
      }
      window.location.href = data.url;
    } catch {
      toast.error("Network error — please try again");
    }
  }

  async function handleRazorpay() {
    try {
      // 1. Ensure Razorpay checkout script is loaded.
      await loadRazorpayScript();
      if (!(window as Window & { Razorpay?: unknown }).Razorpay) {
        toast.error("Razorpay failed to load — please check your ad blocker");
        return;
      }

      // 2. Create order on server.
      const res = await fetch(`/api/invoices/${invoiceId}/pay-razorpay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data?.alreadyPaid) {
        toast.success("This invoice is already paid");
        router.refresh();
        return;
      }
      if (!res.ok) {
        if (res.status === 503) {
          toast.error("Payments not set up", {
            description: "This merchant hasn't enabled online payments yet.",
          });
        } else {
          toast.error(data.error || "Failed to start payment");
        }
        return;
      }

      const { orderId, amount, currency, name, description, prefill } = data as {
        orderId: string;
        amount: number;
        currency: string;
        name: string;
        description: string;
        prefill?: { name?: string; email?: string; contact?: string };
      };

      // 3. Open Razorpay modal.
      const w = window as unknown as {
        Razorpay?: new (opts: Record<string, unknown>) => {
          open: () => void;
          on: (ev: string, cb: (response: unknown) => void) => void;
        };
      };
      const Rzp = w.Razorpay;
      if (!Rzp) {
        toast.error("Razorpay failed to load");
        setLoading(false);
        return;
      }
      const options = {
        key: razorpayKeyId ?? data.keyId,
        amount,
        currency,
        name,
        description,
        order_id: orderId,
        prefill: {
          name: prefill?.name ?? "",
          email: prefill?.email ?? "",
          contact: prefill?.contact ?? "",
        },
        theme: { color: "#7c3aed" },
        modal: {
          ondismiss: () => {
            setLoading(false);
          },
        },
        handler: async (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
          try {
            const v = await fetch(`/api/invoices/${invoiceId}/pay-razorpay`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(response),
            });
            if (!v.ok) {
              const err = await v.json().catch(() => ({}));
              toast.error(err.error || "Payment verification failed");
              setLoading(false);
              return;
            }
            toast.success("Payment successful!", {
              description: "Thank you — your payment has been received.",
            });
            try { onPaid?.(); } catch { /* ignore */ }
            router.refresh();
            // Stay on the current page if onPaid was supplied (portal page),
            // otherwise navigate to the invoice view.
            if (!onPaid) {
              window.location.href = `/view/${invoiceId}?paid=1`;
            }
          } catch {
            toast.error("Could not verify payment — contact merchant if amount was debited");
            setLoading(false);
          }
        },
      };

      const rzp = new Rzp(options as Record<string, unknown>);
      rzp.on("payment.failed", () => {
        toast.error("Payment failed — please try again or use a different method");
        setLoading(false);
      });
      rzp.open();
    } catch {
      toast.error("Something went wrong — please try again");
      setLoading(false);
    }
  }

  async function handleClick() {
    if (loading || alreadyPaid) return;
    setLoading(true);
    if (provider === "razorpay") {
      await handleRazorpay();
    } else {
      await handleStripe();
    }
    // Note: stripe path navigates away; razorpay resets via modal lifecycle.
    if (provider !== "razorpay") setLoading(false);
  }

  const Icon = provider === "razorpay" ? IndianRupee : CreditCard;
  const defaultLabel = provider === "razorpay"
    ? (alreadyPaid ? "Paid" : "Pay with UPI / Card")
    : (alreadyPaid ? "Paid" : "Pay with Card");

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={handleClick}
      disabled={loading || alreadyPaid}
      className={className}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <Icon className="h-4 w-4 mr-2" />
      )}
      {label ?? defaultLabel}
    </Button>
  );
}

// Dynamically load the Razorpay checkout.js script (one-time).
let rzpLoadPromise: Promise<boolean> | null = null;
function loadRazorpayScript(): Promise<boolean> {
  if (rzpLoadPromise) return rzpLoadPromise;
  rzpLoadPromise = new Promise((resolve) => {
    if ((window as Window & { Razorpay?: unknown }).Razorpay) {
      resolve(true);
      return;
    }
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
  return rzpLoadPromise;
}
