import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getStripe, getSiteUrl } from "@/lib/stripe";
import { rateLimit, requestKey } from "@/lib/rate-limit";
import type { Stripe } from "stripe";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/invoices/:id/pay
 *
 * Public (CUID-protected): creates a Stripe Checkout Session for a PENDING
 * invoice. The client (public /view page or admin detail) redirects the
 * browser to session.url. We mark the invoice PAID in the webhook handler,
 * not here — this endpoint only creates a session.
 *
 * Rate-limited to prevent trivial abuse of Stripe API quotas.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    // 10 checkout creates per minute per IP is plenty for legitimate users.
    const rl = rateLimit(requestKey(request), {
      namespace: "stripe:checkout",
      limit: 10,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many payment attempts — please try again later." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
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

    // Only allow payment for PENDING invoices. Paid invoices return 409, drafts 400.
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

    const total = Number(invoice.totalAmount);
    const currency = (invoice.user.settings?.currency || "INR").toLowerCase();

    // Stripe expects amounts in the smallest currency unit (paise for INR,
    // cents for USD/EUR, etc.). We convert the server-computed decimal total
    // to integer subunit to avoid rounding surprises.
    const subunits = toSmallestUnit(total, currency);

    const siteUrl = getSiteUrl();
    const successUrl = `${siteUrl}/view/${invoice.id}?paid=1&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${siteUrl}/view/${invoice.id}?cancelled=1`;

    // Look for an existing open session for this invoice to avoid creating
    // duplicates on double-click. If one exists, return it.
    const existing = await prisma.invoice.findFirst({
      where: { id },
      select: { stripeCheckoutSessionId: true },
    });
    if (existing?.stripeCheckoutSessionId) {
      try {
        const existingSession = await stripe.checkout.sessions.retrieve(
          existing.stripeCheckoutSessionId
        );
        if (
          existingSession &&
          existingSession.status !== "expired" &&
          existingSession.payment_status !== "paid"
        ) {
          return NextResponse.json(
            { url: existingSession.url },
            { status: 200 }
          );
        }
      } catch {
        // session may have been deleted or expired; fall through to create new.
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: invoice.client.email,
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: `Invoice ${invoice.invoiceNumber}`,
              description: `Payment for invoice ${invoice.invoiceNumber} from ${invoice.user.settings?.companyName ?? "SmartBill"}`,
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

    if (session.url) {
      await prisma.invoice.update({
        where: { id },
        data: { stripeCheckoutSessionId: session.id },
      });
    }

    return NextResponse.json(
      { url: session.url, sessionId: session.id },
      { status: 200 }
    );
  } catch (error) {
    console.error("[POST /api/invoices/:id/pay] Failed:", error);
    return NextResponse.json({ error: "Failed to create checkout session" }, { status: 500 });
  }
}

/**
 * GET /api/invoices/:id/pay
 *
 * Returns simple payment status for the public view (paid/unpaid) so
 * the client can show/hide the Pay button after redirect back.
 */
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, status: true, paidAt: true, totalAmount: true },
    });
    if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({
      status: invoice.status,
      paid: invoice.status === "PAID",
      paidAt: invoice.paidAt,
      amount: Number(invoice.totalAmount),
    });
  } catch (error) {
    console.error("[GET /api/invoices/:id/pay] Failed:", error);
    return NextResponse.json({ error: "Failed to load payment status" }, { status: 500 });
  }
}

// Convert a decimal amount (e.g. 100.50 in INR → 10050 paise) to Stripe's
// integer smallest-unit representation. Supports zero-decimal currencies.
function toSmallestUnit(amount: number, currency: string): number {
  const zeroDecimal = new Set([
    "bif","clp","djf","gnf","jpy","kmf","krw","mga","pyg","rwf",
    "ugx","vnd","vuv","xaf","xof","xpf",
  ]);
  const threeDecimal = new Set(["bhd","iqd","jod","kwd","lyd","omr","tnd"]);
  if (zeroDecimal.has(currency)) return Math.round(amount);
  if (threeDecimal.has(currency)) return Math.round(amount * 1000);
  return Math.round((amount + Number.EPSILON) * 100);
}
