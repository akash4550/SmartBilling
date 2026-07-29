import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/invoices/:id/activity
 *
 * Returns the activity timeline for an invoice (owner only). Used by the
 * ActivityTimeline component on the invoice detail page. Public viewers do
 * not see this endpoint — activity is an admin-only audit log.
 */
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    // Verify ownership (tenant isolation).
    const inv = await prisma.invoice.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!inv) return jsonError("Invoice not found", 404);

    const activities = await prisma.invoiceActivity.findMany({
      where: { invoiceId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return NextResponse.json(activities);
  } catch (error) {
    console.error("[GET /api/invoices/:id/activity] Failed:", error);
    return jsonError("Failed to load activity", 500);
  }
}
