/**
 * Stripe webhook endpoint (thin async ingester).
 *
 * Security + latency model:
 *   1. Fail-closed HMAC signature verification (same as before).
 *   2. INSERT raw payload into WebhookIngestion staging table (deduped by
 *      Stripe event id via unique constraint).
 *   3. Return 202 Accepted — no business-logic DB writes, no external API
 *      calls on the request path. End-to-end latency target <50ms.
 *
 * The `/api/cron/process-webhooks` worker picks up PENDING rows and
 * runs the original invoice-payment processing out-of-band. This
 * decouples Stripe delivery from our DB write budget and prevents
 * webhook-burst connection exhaustion.
 */
import { NextResponse } from "next/server";
import { getStripe, getStripeWebhookSecret } from "@/lib/stripe";
import { ingestWebhook } from "@/lib/webhook-ingestion";
import type { Stripe } from "stripe";

export const runtime = "nodejs";

let _webhookConfigWarned = false;
function warnIfMisconfiguredInProduction(hasSecret: boolean) {
  if (_webhookConfigWarned) return;
  if (
    process.env.NODE_ENV === "production" &&
    process.env.STRIPE_SECRET_KEY &&
    !hasSecret
  ) {
    console.error(
      "[stripe-webhook] CRITICAL: STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not. " +
        "Refusing unsigned webhook events until STRIPE_WEBHOOK_SECRET is configured."
    );
  }
  _webhookConfigWarned = true;
}

export async function POST(request: Request) {
  try {
    const stripe = await getStripe();
    if (!stripe) {
      return NextResponse.json(
        { error: "Stripe not configured" },
        { status: 503 }
      );
    }
    const webhookSecret = getStripeWebhookSecret();
    warnIfMisconfiguredInProduction(Boolean(webhookSecret));

    const signature = request.headers.get("stripe-signature");
    const rawBody = await request.text();

    // ---------------- SIGNATURE VERIFICATION ----------------
    let event: Stripe.Event;

    if (webhookSecret) {
      if (!signature) {
        return NextResponse.json(
          { error: "Missing stripe-signature header" },
          { status: 400 }
        );
      }
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Invalid signature";
        console.warn("[stripe-webhook] Signature verification failed:", msg);
        return NextResponse.json(
          { error: "Invalid signature" },
          { status: 400 }
        );
      }
    } else {
      if (process.env.NODE_ENV === "production" && process.env.STRIPE_SECRET_KEY) {
        return NextResponse.json(
          { error: "Webhook signature verification misconfigured" },
          { status: 503 }
        );
      }
      try {
        event = JSON.parse(rawBody) as Stripe.Event;
      } catch {
        return NextResponse.json({ error: "Invalid body" }, { status: 400 });
      }
    }

    // ---------------- QUEUE FOR ASYNC PROCESSING ----------------
    try {
      await ingestWebhook({
        provider: "stripe",
        providerEventId: event.id,
        eventType: event.type,
        rawBody,
        signature,
      });
    } catch (err) {
      // If we fail to enqueue (e.g. DB down), return 500 so Stripe retries.
      console.error("[stripe-webhook] Failed to enqueue event:", err);
      return NextResponse.json(
        { error: "Failed to enqueue event" },
        { status: 500 }
      );
    }

    return NextResponse.json({ received: true, queued: true }, { status: 202 });
  } catch (error) {
    console.error("[stripe-webhook] Error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
}
