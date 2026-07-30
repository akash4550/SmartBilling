import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getRazorpay,
  razorpayConfigured,
  verifyRazorpaySignature,
} from "@/lib/razorpay";
import { markInvoicePaid } from "@/lib/invoice-helpers";
import { rateLimit, requestKey } from "@/lib/rate-limit";
import { toSubunit } from "@/lib/money";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/invoices/:id/pay-razorpay
 *
 * Step 1 — create a Razorpay Order. Idempotent (M2): uses a conditional
 * `updateMany where razorpayOrderId = null` with a "pending_" reservation
 * marker to serialize double-clicks. Losers reload the existing order.
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
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
          },
        }
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
    if (!invoice)
      return NextResponse.json(
        { error: "Invoice not found" },
        { status: 404 }
      );

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

    // --- Idempotent order acquisition (M2) ---
    const myReservation = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const claim = await prisma.invoice.updateMany({
      where: {
        id,
        status: "PENDING",
        razorpayOrderId: null,
      },
      data: { razorpayOrderId: myReservation },
    });

    if (claim.count === 0) {
      return await returnExistingRazorpayOrder(invoice.id);
    }

    const rp = await getRazorpay();
    if (!rp) {
      // Release claim
      await prisma.invoice
        .updateMany({
          where: { id, razorpayOrderId: myReservation },
          data: { razorpayOrderId: null },
        })
        .catch(() => {});
      return NextResponse.json(
        { error: "Payments not configured" },
        { status: 503 }
      );
    }

    const currency = (invoice.user.settings?.currency || "INR").toUpperCase();
    const amount = toSubunit(invoice.totalAmount, currency);

    const receipt = `inv_${invoice.invoiceNumber
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 28)}_${Date.now().toString(36)}`;

    let order: {
      id: string;
      amount: number;
      currency: string;
      status: string;
    };
    try {
      order = (await rp.orders.create({
        amount,
        currency,
        receipt,
        notes: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          userId: invoice.userId,
          clientEmail: invoice.client.email,
        },
        partial_payment: false,
      })) as { id: string; amount: number; currency: string; status: string };
    } catch (err) {
      await prisma.invoice
        .updateMany({
          where: { id, razorpayOrderId: myReservation },
          data: { razorpayOrderId: null },
        })
        .catch(() => {});
      throw err;
    }

    // Finalize the column with the real order id.
    await prisma.invoice.updateMany({
      where: { id, razorpayOrderId: myReservation },
      data: { razorpayOrderId: order.id },
    });

    return NextResponse.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId:
        process.env.RAZORPAY_KEY_ID ?? process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
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
    console.error(
      "[POST /api/invoices/:id/pay-razorpay] Failed:",
      error
    );
    return NextResponse.json(
      { error: "Failed to create payment order" },
      { status: 500 }
    );
  }
}

async function returnExistingRazorpayOrder(
  invoiceId: string
): Promise<Response> {
  const current = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { client: true, user: { include: { settings: true } } },
  });
  if (!current)
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (current.status === "PAID") {
    return NextResponse.json(
      { error: "This invoice has already been paid.", alreadyPaid: true },
      { status: 409 }
    );
  }

  const oid = current.razorpayOrderId;
  if (oid && !oid.startsWith("pending_")) {
    try {
      const rp = await getRazorpay();
      if (rp) {
        const existing = (await rp.orders.fetch(oid)) as {
          id: string;
          status: string;
          amount: number;
          currency: string;
        };
        if (existing && existing.status === "created") {
          return NextResponse.json({
            orderId: existing.id,
            amount: existing.amount,
            currency: existing.currency,
            keyId:
              process.env.RAZORPAY_KEY_ID ??
              process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
            name: current.user.settings?.companyName ?? "SmartBill",
            description: `Invoice ${current.invoiceNumber}`,
            prefill: {
              name: current.client.name,
              email: current.client.email,
              contact: current.client.phone ?? undefined,
            },
            invoiceNumber: current.invoiceNumber,
          });
        }
      }
    } catch {
      // order doesn't exist; fall through to reset
    }
  }

  // Abandoned reservation or expired order — reset column to null so the
  // next retry can claim it cleanly.
  await prisma.invoice
    .updateMany({
      where: { id: invoiceId, status: "PENDING" },
      data: { razorpayOrderId: null },
    })
    .catch(() => {});
  return NextResponse.json(
    { error: "Payment session expired, please try again.", retry: true },
    { status: 409 }
  );
}

/**
 * PATCH /api/invoices/:id/pay-razorpay (verify step)
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
      select: {
        id: true,
        status: true,
        razorpayOrderId: true,
        userId: true,
      },
    });
    if (!invoice)
      return NextResponse.json(
        { error: "Invoice not found" },
        { status: 404 }
      );
    if (invoice.status === "PAID") {
      return NextResponse.json({ paid: true }, { status: 200 });
    }
    if (invoice.razorpayOrderId && invoice.razorpayOrderId !== orderId) {
      // Allow mismatches if the stored value is a "pending_" reservation
      // (client could have posted back before our DB finalized). Otherwise
      // reject.
      if (!invoice.razorpayOrderId.startsWith("pending_")) {
        return NextResponse.json(
          { error: "Order ID mismatch" },
          { status: 400 }
        );
      }
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return NextResponse.json(
        { error: "Razorpay not configured" },
        { status: 503 }
      );
    }

    // Single canonical verification path via the Razorpay SDK (constant-time
    // HMAC-SHA256 internal). No duplicated manual fallback (N4).
    const valid = await verifyRazorpaySignature({
      orderId,
      paymentId,
      signature,
      secret: keySecret,
    });

    if (!valid) {
      return NextResponse.json(
        { error: "Invalid payment signature" },
        { status: 400 }
      );
    }

    // Finalize the order id column (covers the pending-reservation case).
    await prisma.invoice
      .updateMany({
        where: { id },
        data: { razorpayOrderId: orderId },
      })
      .catch(() => {});

    await markInvoicePaid(id, {
      provider: "razorpay",
      actorUserId: invoice.userId,
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: signature,
    });

    return NextResponse.json({ paid: true }, { status: 200 });
  } catch (error) {
    console.error(
      "[PATCH /api/invoices/:id/pay-razorpay] Failed:",
      error
    );
    return NextResponse.json(
      { error: "Payment verification failed" },
      { status: 500 }
    );
  }
}
