import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError, validationErrorResponse } from "@/lib/api-helpers";
import { recurringProfileSchema } from "@/lib/validations";
import { generateInvoiceFromProfile, computeNextRun } from "@/lib/recurring";

interface RouteParams {
  params: Promise<{ id: string }>;
}

async function getOwnedProfile(userId: string, id: string) {
  return prisma.recurringProfile.findFirst({
    where: { id, userId },
    include: { items: true, client: true, user: { include: { settings: true } } },
  });
}

/** GET /api/recurring/:id — fetch one profile (with items). */
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    const profile = await prisma.recurringProfile.findFirst({
      where: { id, userId: user.id },
      include: {
        client: { select: { id: true, name: true, email: true } },
        items: true,
        invoices: {
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { id: true, invoiceNumber: true, status: true, totalAmount: true, dueDate: true, createdAt: true },
        },
        _count: { select: { invoices: true } },
      },
    });
    if (!profile) return jsonError("Recurring profile not found", 404);
    return NextResponse.json(profile);
  } catch (error) {
    console.error("[GET /api/recurring/:id] Failed:", error);
    return jsonError("Failed to load recurring profile", 500);
  }
}

/** PATCH /api/recurring/:id — update a profile (supports full update + toggle). */
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    const existing = await getOwnedProfile(user.id, id);
    if (!existing) return jsonError("Recurring profile not found", 404);

    const body = await request.json().catch(() => ({}));

    // Lightweight toggle: { active: bool }
    if (typeof body.active === "boolean" && Object.keys(body).length === 1) {
      const updated = await prisma.recurringProfile.update({
        where: { id },
        data: {
          active: body.active,
          // If re-activating and nextRunAt is in the past, reset it to now so
          // the next cron run fires immediately rather than missing cycles.
          ...(body.active && existing.nextRunAt.getTime() < Date.now()
            ? { nextRunAt: new Date() }
            : {}),
        },
        include: { client: true, items: true },
      });
      return NextResponse.json(updated);
    }

    // Full update.
    const validated = recurringProfileSchema.parse(body);

    // Verify client.
    const client = await prisma.client.findFirst({
      where: { id: validated.clientId, userId: user.id },
      select: { id: true },
    });
    if (!client) return jsonError("Client not found", 404);

    const updated = await prisma.$transaction(async (tx) => {
      // Delete existing items
      await tx.recurringItem.deleteMany({ where: { profileId: id } });
      return tx.recurringProfile.update({
        where: { id },
        data: {
          clientId: validated.clientId,
          frequency: validated.frequency,
          intervalDays: validated.frequency === "CUSTOM_DAYS" ? validated.intervalDays ?? null : null,
          dueInDays: validated.dueInDays,
          taxRate: validated.taxRate,
          notes: validated.notes ?? null,
          autoSend: validated.autoSend,
          active: validated.active,
          endDate: validated.endDate ? new Date(validated.endDate) : null,
          items: {
            create: validated.items.map((i) => ({
              userId: user.id,
              description: i.description,
              quantity: i.quantity,
              price: i.price,
            })),
          },
        },
        include: { client: true, items: true },
      });
    });

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    console.error("[PATCH /api/recurring/:id] Failed:", error);
    return jsonError("Failed to update recurring profile", 500);
  }
}

/** DELETE /api/recurring/:id — deactivate and delete a recurring profile.
 *  Past invoices generated from it are preserved (onDelete: SetNull). */
export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    const existing = await getOwnedProfile(user.id, id);
    if (!existing) return jsonError("Recurring profile not found", 404);

    await prisma.recurringProfile.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[DELETE /api/recurring/:id] Failed:", error);
    return jsonError("Failed to delete recurring profile", 500);
  }
}
