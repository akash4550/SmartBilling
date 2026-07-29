import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { prisma } from "@/lib/prisma";
import { expenseSchema } from "@/lib/validations";
import {
  validationErrorResponse,
  jsonError,
  requireUser,
  unauthorized,
  getPrismaErrorCode,
} from "@/lib/api-helpers";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    const existing = await prisma.expense.findFirst({ where: { id, userId: user.id } });
    if (!existing) return jsonError("Expense not found", 404);

    const body = await request.json();
    // Allow partial updates; we still validate via the full schema by merging
    // with current values so omitted fields remain valid.
    const merged = {
      date: existing.date.toISOString().slice(0, 10),
      category: existing.category,
      description: existing.description,
      amount: Number(existing.amount),
      notes: existing.notes ?? undefined,
      ...body,
    };
    const validated = expenseSchema.parse(merged);

    const updated = await prisma.expense.update({
      where: { id },
      data: {
        date: new Date(validated.date),
        category: validated.category,
        description: validated.description,
        amount: validated.amount,
        notes: validated.notes ?? null,
      },
    });
    return NextResponse.json(updated, { status: 200 });
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    if (error instanceof SyntaxError) return jsonError("Invalid JSON payload", 400);
    if (getPrismaErrorCode(error) === "P2025") return jsonError("Expense not found", 404);
    console.error("[PATCH /api/expenses/:id] Failed:", error);
    return jsonError("Failed to update expense", 500);
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();
    const { id } = await params;

    const existing = await prisma.expense.findFirst({ where: { id, userId: user.id } });
    if (!existing) return jsonError("Expense not found", 404);

    await prisma.expense.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2025") return jsonError("Expense not found", 404);
    console.error("[DELETE /api/expenses/:id] Failed:", error);
    return jsonError("Failed to delete expense", 500);
  }
}
