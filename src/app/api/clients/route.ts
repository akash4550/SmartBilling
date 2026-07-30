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

/**
 * GET /api/clients
 * Fetch the current user's clients ordered by creation date (newest first).
 * Protected — only returns clients belonging to the signed-in user.
 */
export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const clients = await prisma.client.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { invoices: true } },
      },
    });
    return NextResponse.json(clients, { status: 200 });
  } catch (error) {
    console.error("[GET /api/clients] Failed to fetch clients:", error);
    return jsonError("Failed to fetch clients", 500);
  }
}

/**
 * POST /api/clients
 * Create a new client owned by the signed-in user.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const body = await request.json();
    const validated = clientSchema.parse(body);

    const client = await prisma.client.create({
      data: {
        userId: user.id,
        name: validated.name,
        email: validated.email,
        address: validated.address ?? null,
        phone: validated.phone ?? null,
        notes: validated.notes ?? null,
        dueDays: validated.dueDays ?? null,
      },
    });

    return NextResponse.json(client, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationErrorResponse(error);
    }

    if (error instanceof SyntaxError) {
      return jsonError("Invalid JSON payload", 400);
    }

    // Per-user unique email violation (P2002 on composite userId+email)
    if (getPrismaErrorCode(error) === "P2002") {
      return jsonError("A client with this email already exists", 409);
    }

    // FK violation — session references a deleted/reset user.
    if (getPrismaErrorCode(error) === "P2003") {
      return unauthorized();
    }

    console.error("[POST /api/clients] Failed to create client:", error);
    return jsonError("Failed to create client", 500);
  }
}
