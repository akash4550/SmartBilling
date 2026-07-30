/**
 * Shared invoice helpers — wraps common state transitions so activity logs,
 * audit stamps, and timestamps are applied consistently across the API
 * (Mark Paid buttons, Stripe/Razorpay webhooks, Razorpay verify endpoint,
 * etc.).
 *
 * Concurrency safety: `markInvoicePaid` uses an atomic conditional UPDATE
 * (`WHERE status NOT IN ('PAID','VOID')`) rather than read-then-write. This
 * guarantees that at most ONE concurrent caller wins the race to transition
 * the invoice; all others (including replayed webhooks, double-clicks, and
 * retries) are idempotent no-ops.
 *
 * Ledger integration: every mutation that changes financial state (mark
 * paid, void, manual mark paid) also posts a balanced double-entry
 * LedgerEvent in the same transaction via postLedgerEvent().
 */
import { prisma } from "@/lib/prisma";
import { withTenant } from "@/lib/tenant";
import { logActivity } from "@/lib/activity";
import { sendPaymentReceipt } from "@/lib/send-payment-receipt";
import { postLedgerEvent } from "@/lib/ledger";
import { toNumber } from "@/lib/money";
import type { Invoice, Prisma } from "@prisma/client";

export interface MarkPaidOptions {
  provider?: "stripe" | "razorpay" | "manual";
  ip?: string | null;
  stripePaymentIntentId?: string | null;
  stripeCheckoutSessionId?: string | null;
  razorpayPaymentId?: string | null;
  razorpayOrderId?: string | null;
  razorpaySignature?: string | null;
  /**
   * User id that performed the action. For admin-initiated Mark Paid this
   * is the logged-in merchant. For webhooks / verify endpoints we fall
   * back to the invoice's owner so the activity timeline remains correct.
   */
  actorUserId?: string;
  /**
   * Optional existing Prisma transaction client. When supplied,
   * markInvoicePaid reuses it (SET LOCAL RLS within that tx) instead of
   * opening a new nested transaction — Prisma disallows interactive-
   * transaction nesting.
   */
  tx?: Prisma.TransactionClient;
}

function formatAmountForMessage(amount: unknown, currency = "INR"): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      minimumFractionDigits: 2,
    }).format(toNumber(amount as Prisma.Decimal));
  } catch {
    return String(amount);
  }
}

/**
 * Mark an invoice PAID — idempotent and concurrency-safe. If the invoice is
 * currently DRAFT, posts an INVOICE_ISSUED first (so AR is recognized)
 * followed by INVOICE_PAID (Dr CASH / Cr ACCOUNTS_RECEIVABLE) inside the
 * same atomic transaction.
 *
 * Returns the updated Invoice on the winning transition; null if already
 * PAID, VOID, or missing.
 */
export async function markInvoicePaid(
  invoiceId: string,
  opts: MarkPaidOptions = {}
): Promise<Invoice | null> {
  // Load items in case we need to post INVOICE_ISSUED (DRAFT→PAID).
  const pre = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { items: true },
  });
  if (!pre) return null;
  const ownerId = opts.actorUserId ?? pre.userId;
  const wasDraft = pre.status === "DRAFT";

  type RunResult = {
    invoice: Invoice;
    postCommit: {
      userId: string;
      invoiceNumber: string;
      totalAmount: Prisma.Decimal;
    };
  };

  const run = async (tx: Prisma.TransactionClient): Promise<RunResult | null> => {
    const paidAt = new Date();

    const data: Prisma.InvoiceUpdateInput & { status: "PAID"; paidAt: Date } = {
      status: "PAID",
      paidAt,
    };

    if (opts.stripePaymentIntentId) data.stripePaymentIntentId = opts.stripePaymentIntentId;
    if (opts.stripeCheckoutSessionId) data.stripeCheckoutSessionId = opts.stripeCheckoutSessionId;
    if (opts.razorpayPaymentId) data.razorpayPaymentId = opts.razorpayPaymentId;
    if (opts.razorpayOrderId) data.razorpayOrderId = opts.razorpayOrderId;
    if (opts.razorpaySignature) data.razorpaySignature = opts.razorpaySignature;

    const result = await tx.invoice.updateMany({
      where: {
        id: invoiceId,
        status: { notIn: ["PAID", "VOID"] },
      },
      data,
    });

    if (result.count === 0) {
      const existing = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: { id: true, status: true },
      });
      if (existing?.status === "VOID") {
        console.warn(
          "[invoice-helpers] markInvoicePaid called on voided invoice — ignoring",
          { invoiceId, provider: opts.provider ?? null }
        );
      }
      return null;
    }

    const updated = await tx.invoice.findUnique({
      where: { id: invoiceId },
    });
    if (!updated) return null;

    // If the invoice was DRAFT we need to recognize AR first (INVOICE_ISSUED)
    // before posting INVOICE_PAID so the books stay balanced.
    if (wasDraft) {
      await postLedgerEvent(
        {
          type: "INVOICE_ISSUED",
          invoice: {
            id: updated.id,
            userId: updated.userId,
            items: pre.items.map((it) => ({
              description: it.description,
              quantity: it.quantity,
              price: Number(it.price),
            })),
            taxRate: Number(pre.taxRate),
            discountType: pre.discountType,
            discountValue: pre.discountValue != null ? Number(pre.discountValue) : null,
          },
        },
        tx
      );
    }

    // Ledger entry: Dr CASH / Cr ACCOUNTS_RECEIVABLE.
    await postLedgerEvent(
      {
        type: "INVOICE_PAID",
        invoice: { id: updated.id, userId: updated.userId, totalAmount: updated.totalAmount },
        amountPaid: updated.totalAmount,
      },
      tx
    );

    return {
      invoice: updated,
      postCommit: {
        userId: opts.actorUserId ?? updated.userId,
        invoiceNumber: updated.invoiceNumber,
        totalAmount: updated.totalAmount,
      },
    };
  };

  let outcome: RunResult | null;
  if (opts.tx) {
    outcome = await withTenant(ownerId, run, { tx: opts.tx });
  } else {
    outcome = await withTenant(ownerId, run);
  }

  if (!outcome) return null;

  const { invoice: updated, postCommit } = outcome;
  const amountText = formatAmountForMessage(postCommit.totalAmount);
  const providerMsg =
    opts.provider === "stripe"
      ? `Payment received via Stripe — ${amountText}`
      : opts.provider === "razorpay"
      ? `Payment received via Razorpay — ${amountText}`
      : opts.provider === "manual"
      ? `Marked as paid — ${amountText}`
      : `Payment received — ${amountText}`;

  logActivity({
    invoiceId,
    userId: postCommit.userId,
    type: opts.provider === "manual" ? "MARKED_PAID" : "PAID",
    message: providerMsg,
    ip: opts.ip ?? null,
    meta: {
      provider: opts.provider ?? null,
      paymentId: opts.stripePaymentIntentId ?? opts.razorpayPaymentId ?? null,
      amount: toNumber(postCommit.totalAmount),
      invoiceNumber: postCommit.invoiceNumber,
    },
  });

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
    transactionId: opts.stripePaymentIntentId ?? opts.razorpayPaymentId ?? null,
  }).catch((err) => {
    console.error("[invoice-helpers] Receipt send failed:", err);
  });

  return updated;
}

/**
 * Void an invoice. Idempotent (no-op if already VOID) and concurrency-safe.
 * For PENDING/PAID invoices, posts INVOICE_VOIDED ledger entries that reverse
 * the original issuance (and reverse any payment ledger entry if PAID).
 * DRAFT invoices have never been economically issued, so we just flip
 * status → VOID with no ledger postings.
 */
export async function voidInvoice(
  invoiceId: string,
  opts: { actorUserId?: string; ip?: string | null; tx?: Prisma.TransactionClient } = {}
): Promise<Invoice | null> {
  const pre = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { items: true },
  });
  if (!pre) return null;
  if (pre.status === "VOID") {
    return prisma.invoice.findUnique({ where: { id: invoiceId }, include: { client: true, items: true } });
  }
  const ownerId = opts.actorUserId ?? pre.userId;
  const wasPaid = pre.status === "PAID";
  const wasDraft = pre.status === "DRAFT";

  const run = async (tx: Prisma.TransactionClient): Promise<Invoice> => {
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: "VOID", paidAt: null, stripeCheckoutSessionId: null },
      include: { client: true, items: true },
    });

    // Only post reversing ledger entries if the invoice had been issued
    // (PENDING/PAID). DRAFTs were never on the ledger.
    if (!wasDraft) {
      await postLedgerEvent(
        {
          type: "INVOICE_VOIDED",
          invoice: {
            id: updated.id,
            userId: updated.userId,
            items: pre.items.map((it) => ({
              description: it.description,
              quantity: it.quantity,
              price: Number(it.price),
            })),
            taxRate: Number(pre.taxRate),
            discountType: pre.discountType,
            discountValue: pre.discountValue != null ? Number(pre.discountValue) : null,
            paidAmount: wasPaid ? pre.totalAmount : null,
          },
        },
        tx
      );
    }

    return updated;
  };

  let updated: Invoice;
  if (opts.tx) {
    updated = await withTenant(ownerId, run, { tx: opts.tx });
  } else {
    updated = await withTenant(ownerId, run);
  }

  logActivity({
    invoiceId,
    userId: ownerId,
    type: "VOIDED",
    message: wasDraft
      ? "Draft invoice voided (deleted)"
      : "Invoice voided (cancelled without payment)" + (wasPaid ? " — payment reversed in ledger" : ""),
    ip: opts.ip ?? null,
  });

  return updated;
}

/** Record a payment-failed activity (fire-and-forget, RLS-scoped). */
export function logPaymentFailed(
  invoiceId: string,
  provider: "stripe" | "razorpay",
  reason?: string,
  paymentId?: string,
  extra: { userId?: string; ip?: string | null } = {}
): void {
  (async () => {
    let userId = extra.userId;
    if (!userId) {
      const inv = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { userId: true },
      });
      if (!inv) return;
      userId = inv.userId;
    }
    logActivity({
      invoiceId,
      userId,
      type: "PAYMENT_FAILED",
      message: `${provider === "stripe" ? "Stripe" : "Razorpay"} payment failed${
        reason ? `: ${String(reason).slice(0, 200)}` : ""
      }`,
      ip: extra.ip ?? null,
      meta: { provider, paymentId: paymentId ?? null },
    });
  })().catch((err) => {
    console.error("[invoice-helpers] logPaymentFailed error:", err);
  });
}
