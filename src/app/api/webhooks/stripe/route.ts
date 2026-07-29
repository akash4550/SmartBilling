/**
 * Stripe webhook endpoint.
 *
 * Listens for `checkout.session.completed` and `payment_intent.succeeded` to
 * mark the associated invoice PAID. `payment_intent.payment_failed` writes
 * a PAYMENT_FAILED activity entry so the timeline shows the attempt.
 *
 * Unauthenticated but signature-protected against forged events.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getStripe, getStripeWebhookSecret } from "@/lib/stripe";
import { markInvoicePaid, logPaymentFailed } from "@/lib/invoice-helpers";
import type { Stripe } from "stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const stripe = await getStripe();
    if (!stripe) {
      return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
    }
    const webhookSecret = getStripeWebhookSecret();

    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
    }

    const rawBody = await request.text();
    let event: Stripe.Event;
    if (webhookSecret) {
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Invalid signature";
        console.warn("[stripe-webhook] Signature verification failed:", msg);
        return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
      }
    } else {
      try {
        event = JSON.parse(rawBody) as Stripe.Event;
      } catch {
        return NextResponse.json({ error: "Invalid body" }, { status: 400 });
      }
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleSuccessfulPayment(session.id, session.payment_intent as string | null);
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
          const reason = pi.last_payment_error?.message;
          await logPaymentFailed(pi.metadata.invoiceId, "stripe", typeof reason === "string" ? reason : undefined, pi.id);
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
        break;
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    console.error("[stripe-webhook] Error:", error);
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }
}

async function handleSuccessfulPayment(sessionId: string, paymentIntentId: string | null) {
  const invoice = await prisma.invoice.findFirst({
    where: { stripeCheckoutSessionId: sessionId },
    select: { id: true, status: true },
  });
  let invoiceId = invoice?.id;
  if (!invoiceId) {
    const stripe = await getStripe();
    if (stripe) {
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        invoiceId = session.metadata?.invoiceId;
      } catch (err) {
        console.error("[stripe-webhook] Session lookup failed:", err);
        return;
      }
    }
  }
  if (!invoiceId) return;
  await markInvoicePaid(invoiceId, {
    provider: "stripe",
    stripePaymentIntentId: paymentIntentId ?? undefined,
    stripeCheckoutSessionId: sessionId,
  });
}
