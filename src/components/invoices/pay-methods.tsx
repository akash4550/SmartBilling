"use client";

import { PayInvoiceButton } from "@/components/invoices/pay-invoice-button";

interface PaymentGatewayConfig {
  stripe: boolean;
  razorpay: boolean;
  razorpayKeyId?: string | null;
}

interface PayMethodsProps {
  invoiceId: string;
  alreadyPaid?: boolean;
  /** Payment config from /api/public/settings. */
  payments: PaymentGatewayConfig;
  size?: "sm" | "default" | "lg";
  /** Stack direction; default is vertical (full-width buttons). */
  direction?: "vertical" | "horizontal";
  className?: string;
  /** Called after a successful payment (used by the client portal to refresh list). */
  onPaid?: () => void;
}

/**
 * Renders one or both Pay buttons (Stripe / Razorpay) based on what is
 * configured for the deployment. Falls back to a Stripe-only button if
 * both are enabled (Stripe first), with an "or" divider for the second
 * option. Defaults to Razorpay (INR-friendly) as the primary button when
 * only Razorpay is configured, Stripe as primary otherwise.
 */
export function PayMethods({
  invoiceId,
  alreadyPaid,
  payments,
  size = "default",
  direction = "vertical",
  className,
  onPaid,
}: PayMethodsProps) {
  const hasStripe = payments?.stripe;
  const hasRazorpay = payments?.razorpay;
  const both = hasStripe && hasRazorpay;

  if (!hasStripe && !hasRazorpay) {
    // Merchant has no online pay configured — render nothing (parent should
    // show offline payment instructions elsewhere).
    return null;
  }

  const stack = direction === "vertical" ? "flex flex-col w-full gap-3" : "flex flex-wrap gap-3 items-center";

  return (
    <div className={`${stack} ${className ?? ""}`}>
      {hasRazorpay && (
        <PayInvoiceButton
          invoiceId={invoiceId}
          alreadyPaid={alreadyPaid}
          provider="razorpay"
          razorpayKeyId={payments.razorpayKeyId}
          size={size}
          className={direction === "vertical" ? "w-full" : ""}
          variant="default"
          label={both ? "Pay with UPI / Card (Razorpay)" : undefined}
          onPaid={onPaid}
        />
      )}
      {both && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground w-full">
          <div className="h-px bg-border flex-1" />
          <span>or</span>
          <div className="h-px bg-border flex-1" />
        </div>
      )}
      {hasStripe && (
        <PayInvoiceButton
          invoiceId={invoiceId}
          alreadyPaid={alreadyPaid}
          provider="stripe"
          size={size}
          className={direction === "vertical" ? "w-full" : ""}
          variant={both ? "outline" : "default"}
          label={both ? "Pay via Stripe (international)" : undefined}
          onPaid={onPaid}
        />
      )}
    </div>
  );
}
