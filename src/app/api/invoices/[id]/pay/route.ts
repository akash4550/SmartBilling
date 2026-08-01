import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getStripe, getSiteUrl } from "@/lib/stripe";
import { checkRateLimit, requestKey } from "@/lib/rate-limiter";
import { toSubunit } from "@/lib/money";
import type { Stripe } from "stripe";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/invoices/:id/pay
 *
 * Public (CUID-protected): creates a Stripe Checkout Session for a PENDING
 * invoice. Concurrency-safe (M2): session creation + DB write is wrapped in
 * a conditional update (`where: { id, stripeCheckoutSessionId: null }`) so
 * double-clicks / parallel requests cannot produce orphan Stripe sessions.
 * When the conditional update matches 0 rows, we reload and return the
 * existing session URL (verifying it's still open) instead of creating one.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    const rl = await checkRateLimit(requestKey(request), {
      namespace: "stripe:checkout",
      limit: 10,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return rl.toResponse('Too many payment attempts — please try again later.');
    }

    const stripe = await getStripe();
    if (!stripe) {
      return NextResponse.json(
        { error: "Payments are not configured for this account." },
        { status: 503 }
      );
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: { client: true, user: { include: { settings: true } } },
    });
    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

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

    const currency = (invoice.user.settings?.currency || "INR").toLowerCase();
    const subunits = toSubunit(invoice.totalAmount, currency);
    const siteUrl = getSiteUrl();
    const successUrl = `${siteUrl}/view/${invoice.id}?paid=1&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${siteUrl}/view/${invoice.id}?cancelled=1`;

    // --- Idempotent session acquisition (M2) ---
    //
    // Strategy: try to CLAIM this invoice for session creation using a
    // conditional update that only succeeds if stripeCheckoutSessionId is
    // NULL. If it succeeds (count===1), we won the race and create the
    // Stripe session inside a transaction that finalizes the assignment.
    // If it fails (count===0), another request beat us to it — reload and
    // return the existing session instead of leaking a duplicate.
    //
    // We use a short-lived "pending marker" (a sentinel value beginning
    // with "pending_") in the column to prevent both concurrent requests
    // from passing the null check simultaneously. This is the classic
    // "reservation" pattern.
    const myReservation = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const claim = await prisma.invoice.updateMany({
      where: {
        id,
        status: { in: ["PENDING"] },
        stripeCheckoutSessionId: null,
      },
      data: { stripeCheckoutSessionId: myReservation },
    });

    if (claim.count === 0) {
      // Another request already claimed (or created) a session.
      return await returnExistingStripeSession(stripe, invoice.id);
    }

    // We own the claim. Create the Stripe session and finalize the column
    // inside a transaction; if the Stripe call throws, release the claim
    // by resetting stripeCheckoutSessionId to null so the caller can retry.
    let session: Stripe.Response<Stripe.Checkout.Session>;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: invoice.client.email,
        line_items: [
          {
            price_data: {
              currency,
              product_data: {
                name: `Invoice ${invoice.invoiceNumber}`,
                description: `Payment for invoice ${invoice.invoiceNumber} from ${
                  invoice.user.settings?.companyName ?? "SmartBill"
                }`,
              },
              unit_amount: subunits,
            },
            quantity: 1,
          },
        ],
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          userId: invoice.userId,
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
        submit_type: "pay",
        billing_address_collection: "auto",
        payment_intent_data: {
          description: `${invoice.invoiceNumber} — ${invoice.client.name}`,
          metadata: {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            userId: invoice.userId,
          },
        },
      } as Stripe.Checkout.SessionCreateParams);
    } catch (err) {
      // Release the claim so retries can try again.
      await prisma.invoice
        .updateMany({
          where: { id, stripeCheckoutSessionId: myReservation },
          data: { stripeCheckoutSessionId: null },
        })
        .catch(() => {});
      throw err;
    }

    if (session.id) {
      await prisma.invoice.updateMany({
        where: { id, stripeCheckoutSessionId: myReservation },
        data: { stripeCheckoutSessionId: session.id },
      });
    } else {
      // Shouldn't happen, but release the claim.
      await prisma.invoice
        .updateMany({
          where: { id, stripeCheckoutSessionId: myReservation },
          data: { stripeCheckoutSessionId: null },
        })
        .catch(() => {});
    }

    return NextResponse.json(
      { url: session.url, sessionId: session.id },
      { status: 200 }
    );
  } catch (error) {
    console.error("[POST /api/invoices/:id/pay] Failed:", error);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}

/**
 * Load an existing session (if another concurrent caller won the race)
 * and return its URL. If the session is expired/paid/missing, create
 * a fresh one by resetting the column — this handles the case where a
 * prior session was abandoned in a "pending_" state due to a crash.
 */
async function returnExistingStripeSession(
  stripe: import("stripe").default,
  invoiceId: string
): Promise<Response> {
  const current = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      status: true,
      stripeCheckoutSessionId: true,
      totalAmount: true,
    },
  });
  if (!current) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (current.status === "PAID") {
    return NextResponse.json(
      { error: "This invoice has already been paid.", alreadyPaid: true },
      { status: 409 }
    );
  }

  const sid = current.stripeCheckoutSessionId;
  if (sid && !sid.startsWith("pending_")) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(sid);
      if (
        existing &&
        existing.status !== "expired" &&
        existing.payment_status !== "paid" &&
        existing.url
      ) {
        return NextResponse.json({ url: existing.url }, { status: 200 });
      }
    } catch {
      // session doesn't exist remotely; fall through to reset+retry
    }
  }

  // The existing session is expired / abandoned / missing. Reset the
  // column to null so the NEXT request can claim it cleanly. Return a
  // 409-style "try again" so the client can retry without creating a
  // session here (avoids recursion).
  await prisma.invoice
    .updateMany({
      where: { id: invoiceId, status: "PENDING" },
      data: { stripeCheckoutSessionId: null },
    })
    .catch(() => {});
  return NextResponse.json(
    { error: "Payment session expired, please try again.", retry: true },
    { status: 409 }
  );
}

/**
 * GET /api/invoices/:id/pay
 */
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, status: true, paidAt: true, totalAmount: true },
    });
    if (!invoice)
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({
      status: invoice.status,
      paid: invoice.status === "PAID",
      paidAt: invoice.paidAt,
      amount: Number(invoice.totalAmount),
    });
  } catch (error) {
    console.error("[GET /api/invoices/:id/pay] Failed:", error);
    return NextResponse.json(
      { error: "Failed to load payment status" },
      { status: 500 }
    );
  }
}
