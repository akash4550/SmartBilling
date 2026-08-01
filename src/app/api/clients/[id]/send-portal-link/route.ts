import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
import { checkRateLimit, requestKey } from "@/lib/rate-limiter";
import { z } from "zod";
import { sendPortalInviteEmail } from "@/lib/send-portal-invite";
import { clientIp } from "@/lib/activity";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Build absolute portal URL on the server (mirrors PortalLinkButton helper but
// avoids depending on `window` or NEXT_PUBLIC_* env vars in an API route).
function buildPortalUrl(token: string): string {
  const host =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL;
  const base = host
    ? host.startsWith("http")
      ? host
      : `https://${host}`
    : "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/portal/${token}`;
}

const schema = z.object({
  message: z.string().max(500, "Message too long").optional().nullable(),
});

/**
 * POST /api/clients/:id/send-portal-link
 *
 * Sends an invitation email to the client containing their current portal
 * link. Does NOT rotate the token; admins can rotate separately via
 * /portal-token.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    // Rate limit: 10 emails per minute per user — protects against accidental
    // double-sends without being overly restrictive.
    const rl = await checkRateLimit(requestKey(request, "send-portal"), {
      namespace: "send-portal-link",
      limit: 10,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return rl.toResponse('Too many requests — please try again a moment before sending again.');
    }

    const client = await prisma.client.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        name: true,
        email: true,
        portalToken: true,
      },
    });
    if (!client) return jsonError("Client not found", 404);
    if (!client.email) return jsonError("Client has no email address on file", 400);

    let message: string | null = null;
    try {
      const body = await request.json().catch(() => ({}));
      message = schema.parse(body ?? {}).message ?? null;
    } catch {
      message = null;
    }

    const portalLink = buildPortalUrl(client.portalToken);
    const result = await sendPortalInviteEmail({
      clientId: client.id,
      portalLink,
      message,
    });
    if (!result.success) {
      return jsonError(result.error ?? "Failed to send portal invite email", 500);
    }

    // Note: client-level invite sends aren't tied to a single invoice, so we
    // don't write to the per-invoice activity log. Success is returned to the
    // UI where a toast confirms the send.

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[POST /api/clients/:id/send-portal-link] Failed:", error);
    return jsonError("Failed to send portal invite", 500);
  }
}
