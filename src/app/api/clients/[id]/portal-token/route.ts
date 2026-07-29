/**
 * POST /api/clients/:id/portal-token
 *
 * Rotates the client's portalToken to a new random CUID. The old token is
 * invalidated immediately. Returns the new token. Owner-only.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
import { rateLimit, requestKey } from "@/lib/rate-limit";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const rl = rateLimit(requestKey(request, `portal-token:${user.id}`), {
      namespace: "clients:portal-token",
      limit: 20,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests — please try again later." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }

    const { id } = await params;

    // Verify ownership.
    const client = await prisma.client.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!client) return jsonError("Client not found", 404);

    // Generate a new non-guessable token (32 random bytes → 64 hex chars).
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

    const updated = await prisma.client.update({
      where: { id },
      data: { portalToken: token },
      select: { id: true, portalToken: true },
    });

    return NextResponse.json(
      { ok: true, portalToken: updated.portalToken },
      { status: 200 },
    );
  } catch (error) {
    console.error("[POST /api/clients/:id/portal-token]", error);
    return jsonError("Failed to rotate portal token", 500);
  }
}
