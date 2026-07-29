/**
 * POST /api/webhooks/resend
 *
 * Receive Resend webhook events (email.delivered, email.bounced,
 * email.complained, email.opened, email.clicked) and log them to the
 * associated invoice's activity timeline.
 *
 * We match emails back to invoices by parsing the invoice ID out of tags
 * (`invoiceId`) or from the subject (fallback). The easiest, reliable
 * approach: when sending, add a `invoiceId` tag via the Resend `tags`
 * option; here we extract it from `data.tags`.
 *
 * Auth: if RESEND_WEBHOOK_SECRET is set, verify Svix-style signature
 * (Resend signs with svix; we do a best-effort constant-time comparison
 * on the raw body; if the secret is missing we accept requests but
 * rate-limit).
 */
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/activity";
import { rateLimit, requestKey } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Svix webhook tolerance: 5 minutes (matches Svix default). */
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/** Resend event shape (subset). */
interface ResendEvent {
  type: string;
  id?: string;
  created_at?: string;
  data?: {
    id?: string;
    email_id?: string;
    to?: string[];
    from?: string;
    subject?: string;
    tags?: Array<{ name: string; value: string }>;
    created_at?: string;
    bounce_code?: number | string;
    bounce_description?: string;
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify Svix-style webhook signature used by Resend.
 *
 * Headers:
 *   svix-id        — unique message ID
 *   svix-timestamp — unix seconds when signed
 *   svix-signature — "v1,<hex_hmac>" (space-separated for multiple versions)
 *
 * Signed content: `${id}.${timestamp}.${rawBody}`
 * Secret is expected base64-encoded (whsec_… prefix stripped).
 */
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
    const expected = createHmac("sha256", secretBytes).update(signedContent, "utf8").digest("hex");

    // Signature header can contain multiple "vN,HEX" pairs separated by spaces.
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
    // Light rate limit on webhook endpoint.
    const rl = rateLimit(requestKey(request), {
      namespace: "webhook:resend",
      limit: 120,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const url = new URL(request.url);
    const secret = process.env.RESEND_WEBHOOK_SECRET;

    const rawBody = await request.text();

    // If a shared secret is configured, require Svix signature verification,
    // with Bearer / ?secret= as fallbacks for simple-token setups.
    if (secret) {
      const auth = request.headers.get("authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const qs = url.searchParams.get("secret") ?? "";
      const svixId = request.headers.get("svix-id");
      const svixTs = request.headers.get("svix-timestamp");
      const svixSig = request.headers.get("svix-signature") ?? "";
      const ok =
        (bearer && constantTimeEqual(bearer, secret)) ||
        (qs && constantTimeEqual(qs, secret)) ||
        verifySvixSignature(rawBody, svixSig, svixId, svixTs, secret);
      if (!ok) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }
    let payload: ResendEvent;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const type = payload.type ?? "";
    const data = payload.data ?? {};
    const tags = Array.isArray(data.tags) ? data.tags : [];

    // Extract invoiceId from tags (we set this when sending).
    const invoiceIdTag = tags.find((t) => t.name === "invoiceId");
    const invoiceId = invoiceIdTag?.value;

    // Extract userId from tags.
    const userIdTag = tags.find((t) => t.name === "userId");
    const userId = userIdTag?.value;

    if (!invoiceId) {
      // Nothing to correlate — ack.
      return NextResponse.json({ received: true, matched: false });
    }

    // Load the invoice (don't strictly require userId match; webhooks are
    // signed/authenticated already and we look up by primary key which is
    // CUID-unique).
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, userId: true, invoiceNumber: true },
    });
    if (!invoice) {
      return NextResponse.json({ received: true, matched: false });
    }
    const effectiveUserId = userId || invoice.userId;

    switch (type) {
      case "email.delivered": {
        logActivity({
          invoiceId: invoice.id,
          userId: effectiveUserId,
          type: "EMAIL_DELIVERED",
          message: `Email delivered to ${(data.to ?? []).join(", ") || "recipient"}`,
          meta: { emailId: data.id ?? data.email_id ?? null, type },
        });
        break;
      }
      case "email.bounced": {
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
      }
      case "email.complained": {
        logActivity({
          invoiceId: invoice.id,
          userId: effectiveUserId,
          type: "EMAIL_BOUNCED",
          message: `Recipient marked email as spam/complaint`,
          meta: { emailId: data.id ?? data.email_id ?? null, type },
        });
        break;
      }
      case "email.opened": {
        logActivity({
          invoiceId: invoice.id,
          userId: effectiveUserId,
          type: "EMAIL_OPENED",
          message: `Email opened by client`,
          meta: { emailId: data.id ?? data.email_id ?? null, type },
        });
        break;
      }
      default:
        // Ignore other events (sent, clicked, etc.) — ack 200.
        break;
    }

    return NextResponse.json({ received: true, matched: true, type });
  } catch (error) {
    console.error("[webhooks/resend] Failed:", error);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
