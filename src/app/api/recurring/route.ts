import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError, validationErrorResponse } from "@/lib/api-helpers";
import { recurringProfileSchema } from "@/lib/validations";
import { computeNextRun } from "@/lib/recurring";

/**
 * GET /api/recurring
 *
 * List all recurring profiles belonging to the current user.
 */
export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const profiles = await prisma.recurringProfile.findMany({
      where: { userId: user.id },
      include: { client: { select: { id: true, name: true, email: true } }, items: true, _count: { select: { invoices: true } } },
      orderBy: [{ active: "desc" }, { nextRunAt: "asc" }],
    });

    return NextResponse.json(profiles);
  } catch (error) {
    console.error("[GET /api/recurring] Failed:", error);
    return jsonError("Failed to list recurring profiles", 500);
  }
}

/**
 * POST /api/recurring
 *
 * Create a new recurring profile. If the body includes `startDate`, that is
 * used as the first issue date; otherwise the first run is scheduled for now
 * (so if the user wants the first invoice immediately they can call
 * POST /api/recurring/:id/run separately — creation only sets up the template).
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const body = await request.json().catch(() => ({}));
    const validated = recurringProfileSchema.parse(body);

    // Verify client belongs to this user
    const client = await prisma.client.findFirst({
      where: { id: validated.clientId, userId: user.id },
      select: { id: true },
    });
    if (!client) return jsonError("Client not found", 404);

    // Start date: default to today (so next run is today).
    const startDate = validated.startDate ? new Date(validated.startDate) : new Date();
    // Normalise time to midnight IST for deterministic scheduling.
    startDate.setHours(0, 0, 0, 0);
    // If start date is in the future, schedule for that date; otherwise schedule now.
    const firstRun = startDate.getTime() > Date.now() ? startDate : new Date();
    const nextRun = firstRun;

    const profile = await prisma.recurringProfile.create({
      data: {
        userId: user.id,
        clientId: validated.clientId,
        frequency: validated.frequency,
        intervalDays: validated.frequency === "CUSTOM_DAYS" ? validated.intervalDays ?? null : null,
        dueInDays: validated.dueInDays,
        taxRate: validated.taxRate,
        notes: validated.notes ?? null,
        autoSend: validated.autoSend,
        active: validated.active,
        nextRunAt: nextRun,
        endDate: validated.endDate ? new Date(validated.endDate) : null,
        items: {
          create: validated.items.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            price: item.price,
          })),
        },
      },
      include: { client: true, items: true },
    });

    return NextResponse.json(profile, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    console.error("[POST /api/recurring] Failed:", error);
    return jsonError("Failed to create recurring profile", 500);
  }
}
