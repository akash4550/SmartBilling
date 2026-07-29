/**
 * Razorpay webhook endpoint.
 *
 * Listens for `payment.captured` and `order.paid` to mark invoices PAID, and
 * records `payment.failed` as a PAYMENT_FAILED activity entry.
 * Signature-verified via HMAC-SHA256 using RAZORPAY_WEBHOOK_SECRET.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { verifyWebhookSignature } from "@/lib/razorpay";
import { markInvoicePaid, logPaymentFailed } from "@/lib/invoice-helpers";

export const runtime = "nodejs";

const seenEvents = new Set<string>();

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

export async function POST(request: Request) {
  try {
    const signature = request.headers.get("x-razorpay-signature");
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const rawBody = await request.text();

    if (webhookSecret) {
      if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 400 });
      let valid = await verifyWebhookSignature(rawBody, signature, webhookSecret);
      if (!valid) {
        const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
        try {
          valid = expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
        } catch {
          /* length mismatch = invalid */
        }
      }
      if (!valid) {
        console.warn("[razorpay-webhook] Invalid signature");
        return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
      }
    }

    let event: RazorpayEvent;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    if (event.id) {
      if (seenEvents.has(event.id)) return NextResponse.json({ received: true, duplicate: true });
      seenEvents.add(event.id);
      if (seenEvents.size > 5000) seenEvents.delete(seenEvents.values().next().value!);
    }

    switch (event.event) {
      case "payment.captured":
      case "payment.authorized": {
        const payment = event.payload?.payment?.entity;
        if (payment && (payment.status === "captured" || payment.captured)) {
          await handlePaid(payment);
        }
        break;
      }
      case "order.paid": {
        const order = event.payload?.order?.entity;
        if (order) {
          // Find invoice by order id and mark PAID (no payment id in this event).
          await markInvoicePaidByOrder(order.id);
        }
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

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("[razorpay-webhook] Error:", error);
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }
}

async function handlePaid(payment: RazorpayPaymentEntity) {
  if (payment.notes?.invoiceId) {
    await markInvoicePaid(payment.notes.invoiceId, {
      provider: "razorpay",
      razorpayPaymentId: payment.id,
      razorpayOrderId: payment.order_id,
    });
    return;
  }
  await markInvoicePaidByOrder(payment.order_id, payment.id);
}

async function markInvoicePaidByOrder(orderId: string, paymentId?: string) {
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
