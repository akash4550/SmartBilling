/**
 * Shared invoice helpers — wraps common state transitions so activity logs,
 * audit stamps, and timestamps are applied consistently across the API
 * (Mark Paid buttons, Stripe/Razorpay webhooks, Razorpay verify endpoint, etc.)
 */
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/activity";
import { sendPaymentReceipt } from "@/lib/send-payment-receipt";
import type { Invoice } from "@prisma/client";

export interface MarkPaidOptions {
  provider?: "stripe" | "razorpay" | "manual";
  ip?: string | null;
  stripePaymentIntentId?: string | null;
  stripeCheckoutSessionId?: string | null;
  razorpayPaymentId?: string | null;
  razorpayOrderId?: string | null;
  razorpaySignature?: string | null;
}

function inr(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(n);
}

/**
 * Mark an invoice PAID (idempotent). Returns true if a state change was made
 * (i.e. we transitioned DRAFT/PENDING → PAID), false if it was already PAID
 * or not found.
 */
export async function markInvoicePaid(
  invoiceId: string,
  opts: MarkPaidOptions & { actorUserId?: string } = {}
): Promise<Invoice | null> {
  const existing = await prisma.invoice.findUnique({
    where: { id: invoiceId },
  });
  if (!existing || existing.status === "PAID") return null;

  const data: Record<string, unknown> = {
    status: "PAID",
    paidAt: new Date(),
  };
  if (opts.stripePaymentIntentId) data.stripePaymentIntentId = opts.stripePaymentIntentId;
  if (opts.stripeCheckoutSessionId) data.stripeCheckoutSessionId = opts.stripeCheckoutSessionId;
  if (opts.razorpayPaymentId) data.razorpayPaymentId = opts.razorpayPaymentId;
  if (opts.razorpayOrderId) data.razorpayOrderId = opts.razorpayOrderId;
  if (opts.razorpaySignature) data.razorpaySignature = opts.razorpaySignature;

  const updated = await prisma.invoice.update({
    where: { id: invoiceId },
    data,
  });

  const providerMsg =
    opts.provider === "stripe"
      ? `Payment received via Stripe — ${inr(Number(existing.totalAmount))}`
      : opts.provider === "razorpay"
      ? `Payment received via Razorpay — ${inr(Number(existing.totalAmount))}`
      : opts.provider === "manual"
      ? `Marked as paid — ${inr(Number(existing.totalAmount))}`
      : `Payment received — ${inr(Number(existing.totalAmount))}`;

  logActivity({
    invoiceId,
    userId: opts.actorUserId ?? existing.userId,
    type: opts.provider === "manual" ? "MARKED_PAID" : "PAID",
    message: providerMsg,
    ip: opts.ip,
    meta: {
      provider: opts.provider ?? null,
      paymentId:
        opts.stripePaymentIntentId ?? opts.razorpayPaymentId ?? null,
      amount: Number(existing.totalAmount),
      invoiceNumber: existing.invoiceNumber,
    },
  });

  // Auto-send a thank-you / payment-receipt email (best-effort; fire and
  // forget so webhook endpoints don't wait on Resend).
  sendPaymentReceipt({
    invoiceId,
    paymentMethod:
      opts.provider === "stripe"
        ? "Stripe (card)"
        : opts.provider === "razorpay"
        ? "Razorpay (UPI / card / netbanking)"
        : opts.provider === "manual"
        ? "Manual (recorded by merchant)"
        : null,
    transactionId:
      opts.stripePaymentIntentId ?? opts.razorpayPaymentId ?? null,
  }).catch((err) => {
    console.error("[invoice-helpers] Receipt send failed:", err);
  });

  return updated;
}

/** Record a payment-failed activity. */
export async function logPaymentFailed(
  invoiceId: string,
  provider: "stripe" | "razorpay",
  reason?: string,
  paymentId?: string
) {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { userId: true },
  });
  if (!inv) return;
  logActivity({
    invoiceId,
    userId: inv.userId,
    type: "PAYMENT_FAILED",
    message: `${provider === "stripe" ? "Stripe" : "Razorpay"} payment failed${reason ? `: ${reason.slice(0, 200)}` : ""}`,
    meta: { provider, paymentId: paymentId ?? null },
  });
}
