import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
import { generateInvoiceFromProfile } from "@/lib/recurring";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/recurring/:id/run
 *
 * Generate a single invoice from this recurring profile immediately, then
 * advance nextRunAt (so the cron doesn't generate another duplicate on its
 * next tick). Useful for "Generate now" admin buttons and for test-sending
 * the first invoice when a profile is created.
 */
export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    const profile = await prisma.recurringProfile.findFirst({
      where: { id, userId: user.id },
      include: { items: true, client: true, user: { include: { settings: true } } },
    });
    if (!profile) return jsonError("Recurring profile not found", 404);

    // Force-run ignores active/endDate/nextRunAt guards (user explicitly asked).
    // Temporarily mark active so the generator's internal transaction guard
    // doesn't block us; save original state to restore after.
    const wasActive = profile.active;
    if (!wasActive) {
      await prisma.recurringProfile.update({ where: { id }, data: { active: true, nextRunAt: new Date() } });
      profile.active = true;
      profile.nextRunAt = new Date();
    }

    try {
      const result = await generateInvoiceFromProfile(profile, new Date());
      return NextResponse.json({ success: true, ...result });
    } finally {
      if (!wasActive) {
        // Restore inactive state (but keep the advanced nextRunAt so
        // reactivating later doesn't immediately re-fire).
        await prisma.recurringProfile.update({ where: { id }, data: { active: false } });
      }
    }
  } catch (error) {
    console.error("[POST /api/recurring/:id/run] Failed:", error);
    return jsonError(
      error instanceof Error ? error.message : "Failed to run recurring profile",
      500
    );
  }
}
