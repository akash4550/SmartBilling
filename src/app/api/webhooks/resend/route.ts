/**
 * POST /api/webhooks/resend (thin async ingester).
 *
 * Same async-queue model as Stripe/Razorpay:
 *   1. Verify Svix signature (or Bearer token) fail-closed when secret set.
 *   2. Insert raw body to WebhookIngestion.
 *   3. Return 202 immediately; worker writes activity timeline entries.
 *
 * Query-string secrets are rejected (URLs are logged).
 */
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { ingestWebhook } from "@/lib/webhook-ingestion";
import { checkRateLimit, requestKey } from "@/lib/rate-limiter";

export const dynamic = "force-dynamic";

const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

interface ResendEvent {
  type: string;
  id?: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function verifySvixSignature(
  rawBody: string,
  signatureHeader: string,
  idHeader: string | null,
  timestampHeader: string | null,
  secret: string
): boolean {
  try {
    if (!idHeader || !timestampHeader || !signatureHeader) return false;

    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) return false;
    const tsMs = timestamp * 1000;
    if (Math.abs(Date.now() - tsMs) > WEBHOOK_TOLERANCE_MS) return false;

    const cleaned = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    const secretBytes = Buffer.from(cleaned, "base64");
    const signedContent = `${idHeader}.${timestampHeader}.${rawBody}`;
    const expected = createHmac("sha256", secretBytes)
      .update(signedContent, "utf8")
      .digest("hex");

    const pairs = signatureHeader.split(" ");
    for (const pair of pairs) {
      const comma = pair.indexOf(",");
      if (comma === -1) continue;
      const version = pair.slice(0, comma);
      const sigHex = pair.slice(comma + 1);
      if (version !== "v1") continue;
      if (sigHex.length !== expected.length) continue;
      try {
        const a = Buffer.from(sigHex, "hex");
        const b = Buffer.from(expected, "hex");
        if (a.length === b.length && timingSafeEqual(a, b)) return true;
      } catch {
        // ignore malformed hex
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    const rl = await checkRateLimit(requestKey(request), {
      namespace: "webhook:resend",
      limit: 120,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return rl.toResponse('Too many requests.');
    }

    const secret = process.env.RESEND_WEBHOOK_SECRET;
    const rawBody = await request.text();

    if (secret) {
      const auth = request.headers.get("authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const svixId = request.headers.get("svix-id");
      const svixTs = request.headers.get("svix-timestamp");
      const svixSig = request.headers.get("svix-signature") ?? "";
      const ok =
        (bearer && constantTimeEqual(bearer, secret)) ||
        verifySvixSignature(rawBody, svixSig, svixId, svixTs, secret);
      if (!ok) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    let payload: ResendEvent;
    try {
      payload = JSON.parse(rawBody) as ResendEvent;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    try {
      await ingestWebhook({
        provider: "resend",
        providerEventId: payload.id,
        eventType: payload.type,
        rawBody,
        signature: null,
      });
    } catch (err) {
      console.error("[resend-webhook] Failed to enqueue event:", err);
      return NextResponse.json(
        { error: "Failed to enqueue event" },
        { status: 500 }
      );
    }

    return NextResponse.json({ received: true, queued: true }, { status: 202 });
  } catch (error) {
    console.error("[webhooks/resend] Failed:", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
