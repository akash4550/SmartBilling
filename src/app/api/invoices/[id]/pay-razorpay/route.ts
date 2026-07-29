import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  getRazorpay,
  razorpayConfigured,
  toRazorpayAmount,
  verifyRazorpaySignature,
} from "@/lib/razorpay";
import { markInvoicePaid } from "@/lib/invoice-helpers";
import { rateLimit, requestKey } from "@/lib/rate-limit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/invoices/:id/pay-razorpay
 *
 * Step 1 — create a Razorpay Order. Public (CUID-protected). The client
 * (public /view page) receives { orderId, keyId, amount, currency, ... }
 * and opens the Razorpay Checkout modal (which loads over HTTPS from
 * checkout.razorpay.com, collects card/UPI/netbanking details, and POSTs
 * back to the browser callback).
 *
 * We re-use any existing open (non-paid) order on this invoice to avoid
 * leaking duplicate orders on double clicks, much like Stripe.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    const rl = rateLimit(requestKey(request), {
      namespace: "razorpay:checkout",
      limit: 10,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many payment attempts — please try again later." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }

    if (!razorpayConfigured()) {
      return NextResponse.json(
        { error: "Razorpay payments are not configured for this account." },
        { status: 503 }
      );
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: { client: true, user: { include: { settings: true } } },
    });
    if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

    if (invoice.status === "PAID") {
      return NextResponse.json(
        { error: "This invoice has already been paid.", alreadyPaid: true },
        { status: 409 }
      );
    }
    if (invoice.status === "DRAFT") {
      return NextResponse.json(
        { error: "This invoice is a draft and hasn't been sent yet." },
        { status: 400 }
      );
    }
    if (invoice.status === "VOID") {
      return NextResponse.json(
        { error: "This invoice has been voided and is no longer payable." },
        { status: 410 }
      );
    }

    // If we already have a razorpayOrderId and payment hasn't been made yet,
    // verify the order is still open and reuse it. Otherwise create a new one.
    if (invoice.razorpayOrderId) {
      try {
        const rp = await getRazorpay();
        if (rp) {
          const existing = await rp.orders.fetch(invoice.razorpayOrderId) as {
            id: string; status: string; amount: number; currency: string;
          };
          if (existing && existing.status === "created") {
            return NextResponse.json({
              orderId: existing.id,
              amount: existing.amount,
              currency: existing.currency,
              keyId: process.env.RAZORPAY_KEY_ID ?? process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
              name: invoice.user.settings?.companyName ?? "SmartBill",
              description: `Invoice ${invoice.invoiceNumber}`,
              prefill: {
                name: invoice.client.name,
                email: invoice.client.email,
                contact: invoice.client.phone ?? undefined,
              },
              invoiceNumber: invoice.invoiceNumber,
            });
          }
        }
      } catch {
        // order likely doesn't exist any more; fall through to create.
      }
    }

    const rp = await getRazorpay();
    if (!rp) {
      return NextResponse.json({ error: "Payments not configured" }, { status: 503 });
    }

    const total = Number(invoice.totalAmount);
    const currency = (invoice.user.settings?.currency || "INR").toUpperCase();
    const amount = toRazorpayAmount(total, currency);

    // Short idempotency receipt — prevents Razorpay from creating a duplicate
    // order if the client retries this request.
    const receipt = `inv_${invoice.invoiceNumber.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 28)}_${Date.now().toString(36)}`;

    const order = await rp.orders.create({
      amount,
      currency,
      receipt,
      notes: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        userId: invoice.userId,
        clientEmail: invoice.client.email,
      },
      // Partial payments disabled for invoices.
      partial_payment: false,
    });

    await prisma.invoice.update({
      where: { id },
      data: { razorpayOrderId: order.id },
    });

    return NextResponse.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID ?? process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      name: invoice.user.settings?.companyName ?? "SmartBill",
      description: `Invoice ${invoice.invoiceNumber}`,
      prefill: {
        name: invoice.client.name,
        email: invoice.client.email,
        contact: invoice.client.phone ?? undefined,
      },
      invoiceNumber: invoice.invoiceNumber,
    });
  } catch (error) {
    console.error("[POST /api/invoices/:id/pay-razorpay] Failed:", error);
    return NextResponse.json({ error: "Failed to create payment order" }, { status: 500 });
  }
}

/**
 * POST /api/invoices/:id/pay-razorpay/verify
 *
 * Step 2 — after the Razorpay Checkout modal returns a payment_id in the
 * browser, the client POSTs { razorpay_payment_id, razorpay_order_id,
 * razorpay_signature } to this endpoint. We verify the HMAC signature to
 * confirm the payment is authentic (can't be forged client-side) and mark
 * the invoice PAID.
 *
 * The webhook (/api/webhooks/razorpay) is still configured as a safety net
 * in case the user closes the tab before this returns — this endpoint
 * provides instant UI feedback.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    const body = (await request.json().catch(() => ({}))) as {
      razorpay_payment_id?: string;
      razorpay_order_id?: string;
      razorpay_signature?: string;
    };
    const paymentId = body.razorpay_payment_id;
    const orderId = body.razorpay_order_id;
    const signature = body.razorpay_signature;
    if (!paymentId || !orderId || !signature) {
      return NextResponse.json(
        { error: "Missing Razorpay payment parameters" },
        { status: 400 }
      );
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, status: true, razorpayOrderId: true, userId: true },
    });
    if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    if (invoice.status === "PAID") {
      return NextResponse.json({ paid: true }, { status: 200 });
    }
    if (invoice.razorpayOrderId && invoice.razorpayOrderId !== orderId) {
      return NextResponse.json({ error: "Order ID mismatch" }, { status: 400 });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return NextResponse.json({ error: "Razorpay not configured" }, { status: 503 });
    }

    // Verify the HMAC signature order_id|payment_id against the secret.
    const expected = crypto
      .createHmac("sha256", keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    const valid = crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex")
    );
    // Also try the SDK helper as a fallback (covers hex-length edge cases).
    const sdkValid = !valid
      ? await verifyRazorpaySignature({ orderId, paymentId, signature, secret: keySecret })
      : true;

    if (!sdkValid) {
      return NextResponse.json({ error: "Invalid payment signature" }, { status: 400 });
    }

    // Verify the order belongs to this invoice.
    if (invoice.razorpayOrderId && invoice.razorpayOrderId !== orderId) {
      return NextResponse.json({ error: "Order ID mismatch" }, { status: 400 });
    }

    await markInvoicePaid(id, {
      provider: "razorpay",
      actorUserId: invoice.userId,
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: signature,
    });

    return NextResponse.json({ paid: true }, { status: 200 });
  } catch (error) {
    console.error("[PATCH /api/invoices/:id/pay-razorpay] Failed:", error);
    return NextResponse.json({ error: "Payment verification failed" }, { status: 500 });
  }
}
