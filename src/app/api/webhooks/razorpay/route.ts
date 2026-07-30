/**
 * Razorpay webhook endpoint (thin async ingester).
 *
 * Same model as Stripe: verify HMAC signature (fail-closed in prod),
 * enqueue raw payload to WebhookIngestion, return 202 Accepted.
 * The worker (`/api/cron/process-webhooks`) performs invoice PAID
 * updates out-of-band.
 */
import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/razorpay";
import { ingestWebhook } from "@/lib/webhook-ingestion";

export const runtime = "nodejs";

let _webhookConfigWarned = false;
function warnIfMisconfiguredInProduction(hasSecret: boolean) {
  if (_webhookConfigWarned) return;
  if (
    process.env.NODE_ENV === "production" &&
    process.env.RAZORPAY_KEY_SECRET &&
    !hasSecret
  ) {
    console.error(
      "[razorpay-webhook] CRITICAL: RAZORPAY_KEY_SECRET is set but RAZORPAY_WEBHOOK_SECRET is not. " +
        "Refusing unsigned webhook events until RAZORPAY_WEBHOOK_SECRET is configured."
    );
  }
  _webhookConfigWarned = true;
}

interface RazorpayEvent {
  event: string;
  id?: string;
}

export async function POST(request: Request) {
  try {
    const signature = request.headers.get("x-razorpay-signature");
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? null;
    const rawBody = await request.text();

    warnIfMisconfiguredInProduction(Boolean(webhookSecret));

    // ---------------- SIGNATURE VERIFICATION ----------------
    if (webhookSecret) {
      if (!signature) {
        return NextResponse.json(
          { error: "Missing signature" },
          { status: 400 }
        );
      }
      const valid = await verifyWebhookSignature(rawBody, signature, webhookSecret);
      if (!valid) {
        console.warn("[razorpay-webhook] Invalid signature");
        return NextResponse.json(
          { error: "Invalid signature" },
          { status: 400 }
        );
      }
    } else {
      if (
        process.env.NODE_ENV === "production" &&
        process.env.RAZORPAY_KEY_SECRET
      ) {
        return NextResponse.json(
          { error: "Webhook signature verification misconfigured" },
          { status: 503 }
        );
      }
    }

    let event: RazorpayEvent;
    try {
      event = JSON.parse(rawBody) as RazorpayEvent;
    } catch {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    // ---------------- QUEUE FOR ASYNC PROCESSING ----------------
    try {
      await ingestWebhook({
        provider: "razorpay",
        providerEventId: event.id,
        eventType: event.event,
        rawBody,
        signature,
      });
    } catch (err) {
      console.error("[razorpay-webhook] Failed to enqueue event:", err);
      return NextResponse.json(
        { error: "Failed to enqueue event" },
        { status: 500 }
      );
    }

    return NextResponse.json({ received: true, queued: true }, { status: 202 });
  } catch (error) {
    console.error("[razorpay-webhook] Error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
}
