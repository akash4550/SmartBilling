import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { prisma } from "@/lib/prisma";
import { clientSchema } from "@/lib/validations";
import {
  getPrismaErrorCode,
  validationErrorResponse,
  jsonError,
  requireUser,
  unauthorized,
} from "@/lib/api-helpers";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// All handlers scope by (id, userId) so you can never read/write another
// tenant's client even if you know the id. `findFirst` + `updateMany` style
// guards are used rather than `findUnique` by bare id, because the primary
// key is globally unique anyway but we need to enforce ownership.

async function ownedClient(userId: string, id: string) {
  return prisma.client.findFirst({ where: { id, userId } });
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    const client = await prisma.client.findFirst({
      where: { id, userId: user.id },
      include: {
        invoices: {
          orderBy: { createdAt: "desc" },
          include: { items: true },
        },
      },
    });
    if (!client) return jsonError("Client not found", 404);

    return NextResponse.json(client, { status: 200 });
  } catch (error) {
    console.error("[GET /api/clients/:id] Failed:", error);
    return jsonError("Failed to fetch client", 500);
  }
}

export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    const existing = await ownedClient(user.id, id);
    if (!existing) return jsonError("Client not found", 404);

    const body = await request.json();
    const validated = clientSchema.parse(body);

    const client = await prisma.client.update({
      where: { id },
      data: {
        name: validated.name,
        email: validated.email,
        address: validated.address ?? null,
        phone: validated.phone ?? null,
        notes: validated.notes ?? null,
        dueDays: validated.dueDays ?? null,
      },
    });

    return NextResponse.json(client, { status: 200 });
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    if (error instanceof SyntaxError) return jsonError("Invalid JSON payload", 400);
    if (getPrismaErrorCode(error) === "P2002") return jsonError("A client with this email already exists", 409);
    if (getPrismaErrorCode(error) === "P2025") return jsonError("Client not found", 404);
    console.error("[PUT /api/clients/:id] Failed:", error);
    return jsonError("Failed to update client", 500);
  }
}

const clientPatchSchema = clientSchema.partial();

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    const existing = await ownedClient(user.id, id);
    if (!existing) return jsonError("Client not found", 404);

    const body = await request.json();
    const validated = clientPatchSchema.parse(body);
    if (Object.keys(validated).length === 0) return jsonError("No valid fields provided", 400);

    const client = await prisma.client.update({
      where: { id },
      data: {
        ...(validated.name !== undefined && { name: validated.name }),
        ...(validated.email !== undefined && { email: validated.email }),
        ...(validated.address !== undefined && { address: validated.address ?? null }),
        ...(validated.phone !== undefined && { phone: validated.phone ?? null }),
        ...(validated.notes !== undefined && { notes: validated.notes ?? null }),
        ...(validated.dueDays !== undefined && { dueDays: validated.dueDays ?? null }),
      },
    });

    return NextResponse.json(client, { status: 200 });
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    if (error instanceof SyntaxError) return jsonError("Invalid JSON payload", 400);
    if (getPrismaErrorCode(error) === "P2002") return jsonError("A client with this email already exists", 409);
    if (getPrismaErrorCode(error) === "P2025") return jsonError("Client not found", 404);
    console.error("[PATCH /api/clients/:id] Failed:", error);
    return jsonError("Failed to update client", 500);
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    const existing = await ownedClient(user.id, id);
    if (!existing) return jsonError("Client not found", 404);

    await prisma.client.delete({ where: { id } });
    return NextResponse.json({ success: true, message: "Client deleted" }, { status: 200 });
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2025") return jsonError("Client not found", 404);
    console.error("[DELETE /api/clients/:id] Failed:", error);
    return jsonError("Failed to delete client", 500);
  }
}
