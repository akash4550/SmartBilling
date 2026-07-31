/**
 * Webhook event processors (run by the async worker).
 *
 * Each processor takes the parsed event and performs the original
 * business logic that used to run synchronously in the webhook route:
 * marking invoices PAID, logging payment failures, releasing expired
 * checkout sessions, writing email-activity events, etc.
 *
 * Contract / seam contract:
 *   - Signature verification (Stripe constructEvent / Razorpay
 *     x-razorpay-signature / Resend) is performed by the EDGE route
 *     BEFORE the event is ingested into webhook_ingestions. Processors
 *     do not re-verify.
 *   - Quarantine gating is the SOLE responsibility of the worker in
 *     src/app/api/cron/process-webhooks/route.ts, via
 *     isTenantQuarantined() from @/lib/webhook-ingestion. Processors
 *     assume a healthy tenant context and execute pure domain/ledger
 *     logic. The Postgres ledger_quarantine_guard trigger (SQLSTATE
 *     L0001) remains as defense-in-depth; any such error is caught by
 *     the worker loop and routed to markQuarantineHold().
 *   - DLQ backoff / poison-pill classification is owned by
 *     markRetry() in @/lib/webhook-ingestion. Processors simply throw
 *     on unexpected errors; they do not manage retries themselves.
 *   - JSON.parse failures on rawBody are treated as poison pills by
 *     classifyError() upstream and never reach a processor.
 */
import { prisma } from "@/lib/prisma";
import { markInvoicePaid, logPaymentFailed } from "@/lib/invoice-helpers";
import { logActivity } from "@/lib/activity";
import type Stripe from "stripe";

// ---------------------------- STRIPE ----------------------------

/**
 * Top-level Stripe dispatcher. Parses the raw body and routes by event.type.
 */
export async function processStripeEvent(rawBody: string) {
  const event = JSON.parse(rawBody) as Stripe.Event;

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      await handleStripeSuccessfulPayment(
        session.id,
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? null,
        session.metadata?.invoiceId
      );
      break;
    }
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      if (pi.metadata?.invoiceId) {
        await markInvoicePaid(pi.metadata.invoiceId, {
          provider: "stripe",
          stripePaymentIntentId: pi.id,
        });
      }
      break;
    }
    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      if (pi.metadata?.invoiceId) {
        const reason =
          typeof pi.last_payment_error?.message === "string"
            ? pi.last_payment_error.message
            : undefined;
        await logPaymentFailed(
          pi.metadata.invoiceId,
          "stripe",
          reason,
          pi.id
        );
      }
      break;
    }
    case "checkout.session.expired": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.invoiceId) {
        await prisma.invoice.updateMany({
          where: {
            id: session.metadata.invoiceId,
            stripeCheckoutSessionId: session.id,
            status: { not: "PAID" },
          },
          data: { stripeCheckoutSessionId: null },
        });
      }
      break;
    }
    default:
      // Unknown event type → treat as successfully processed (no-op).
      break;
  }
}

async function handleStripeSuccessfulPayment(
  sessionId: string,
  paymentIntentId: string | null,
  metadataInvoiceId: string | undefined
) {
  let invoiceId = metadataInvoiceId;
  if (!invoiceId) {
    const invoice = await prisma.invoice.findFirst({
      where: { stripeCheckoutSessionId: sessionId },
      select: { id: true },
    });
    invoiceId = invoice?.id;
  }
  if (!invoiceId) {
    try {
      const { getStripe } = await import("@/lib/stripe");
      const stripe = await getStripe();
      if (stripe) {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        invoiceId = session.metadata?.invoiceId;
      }
    } catch (err) {
      console.error("[webhook-worker] Stripe session lookup failed:", err);
      return;
    }
  }
  if (!invoiceId) return;

  await markInvoicePaid(invoiceId, {
    provider: "stripe",
    stripePaymentIntentId: paymentIntentId ?? undefined,
    stripeCheckoutSessionId: sessionId,
  });
}

// --------------------------- RAZORPAY ---------------------------

interface RazorpayPaymentEntity {
  id: string;
  order_id: string;
  status: string;
  captured: boolean;
  notes?: Record<string, string>;
  error_code?: string;
  error_description?: string;
}
interface RazorpayOrderEntity {
  id: string;
  notes?: Record<string, string>;
}
interface RazorpayEvent {
  event: string;
  id?: string;
  payload?: {
    payment?: { entity?: RazorpayPaymentEntity };
    order?: { entity?: RazorpayOrderEntity };
  };
}

export async function processRazorpayEvent(rawBody: string) {
  const event = JSON.parse(rawBody) as RazorpayEvent;

  switch (event.event) {
    case "payment.captured":
    case "payment.authorized": {
      const payment = event.payload?.payment?.entity;
      if (payment && (payment.status === "captured" || payment.captured)) {
        await handleRazorpayPaid(payment);
      }
      break;
    }
    case "order.paid": {
      const order = event.payload?.order?.entity;
      if (order) await markInvoicePaidByRazorpayOrder(order.id);
      break;
    }
    case "payment.failed": {
      const payment = event.payload?.payment?.entity;
      if (payment?.notes?.invoiceId) {
        await logPaymentFailed(
          payment.notes.invoiceId,
          "razorpay",
          payment.error_description,
          payment.id
        );
      }
      break;
    }
    default:
      break;
  }
}

async function handleRazorpayPaid(payment: RazorpayPaymentEntity) {
  if (payment.notes?.invoiceId) {
    await markInvoicePaid(payment.notes.invoiceId, {
      provider: "razorpay",
      razorpayPaymentId: payment.id,
      razorpayOrderId: payment.order_id,
    });
    return;
  }
  await markInvoicePaidByRazorpayOrder(payment.order_id, payment.id);
}

async function markInvoicePaidByRazorpayOrder(
  orderId: string,
  paymentId?: string
) {
  const invoice = await prisma.invoice.findFirst({
    where: { razorpayOrderId: orderId },
    select: { id: true, status: true },
  });
  if (!invoice) return;
  await markInvoicePaid(invoice.id, {
    provider: "razorpay",
    razorpayPaymentId: paymentId,
    razorpayOrderId: orderId,
  });
}

// ----------------------------- RESEND ----------------------------

interface ResendEvent {
  type: string;
  id?: string;
  data?: {
    id?: string;
    email_id?: string;
    to?: string[];
    subject?: string;
    tags?: Array<{ name: string; value: string }>;
    bounce_code?: number | string;
    bounce_description?: string;
  };
}

export async function processResendEvent(rawBody: string) {
  const payload = JSON.parse(rawBody) as ResendEvent;
  const type = payload.type ?? "";
  const data = payload.data ?? {};
  const tags = Array.isArray(data.tags) ? data.tags : [];

  const invoiceIdTag = tags.find((t) => t.name === "invoiceId");
  const invoiceId = invoiceIdTag?.value;
  if (!invoiceId) return;

  const userIdTag = tags.find((t) => t.name === "userId");
  const userId = userIdTag?.value;

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, userId: true, invoiceNumber: true },
  });
  if (!invoice) return;
  const effectiveUserId = userId || invoice.userId;

  switch (type) {
    case "email.delivered":
      logActivity({
        invoiceId: invoice.id,
        userId: effectiveUserId,
        type: "EMAIL_DELIVERED",
        message: `Email delivered to ${(data.to ?? []).join(", ") || "recipient"}`,
        meta: { emailId: data.id ?? data.email_id ?? null, type },
      });
      break;
    case "email.bounced":
      logActivity({
        invoiceId: invoice.id,
        userId: effectiveUserId,
        type: "EMAIL_BOUNCED",
        message: `Email bounced${data.bounce_description ? `: ${String(data.bounce_description).slice(0, 200)}` : ""}`,
        meta: {
          emailId: data.id ?? data.email_id ?? null,
          type,
          bounceCode: data.bounce_code ?? null,
          to: data.to ?? null,
        },
      });
      break;
    case "email.complained":
      logActivity({
        invoiceId: invoice.id,
        userId: effectiveUserId,
        type: "EMAIL_COMPLAINED",
        message: `Recipient marked email as spam/complaint`,
        meta: { emailId: data.id ?? data.email_id ?? null, type },
      });
      break;
    case "email.opened":
      logActivity({
        invoiceId: invoice.id,
        userId: effectiveUserId,
        type: "EMAIL_OPENED",
        message: `Email opened by client`,
        meta: { emailId: data.id ?? data.email_id ?? null, type },
      });
      break;
    default:
      break;
  }
}
