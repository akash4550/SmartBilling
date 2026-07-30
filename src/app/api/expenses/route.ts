import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { prisma } from "@/lib/prisma";
import { expenseSchema } from "@/lib/validations";
import {
  validationErrorResponse,
  jsonError,
  requireUser,
  unauthorized,
} from "@/lib/api-helpers";
import { postLedgerEvent } from "@/lib/ledger";
import { withTenant } from "@/lib/tenant";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const querySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  category: z.string().trim().max(40).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** GET /api/expenses — list expenses scoped to the current user, with filters. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const { searchParams } = new URL(request.url);
    const parsed = querySchema.safeParse({
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      category: searchParams.get("category") ?? undefined,
      q: searchParams.get("q") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid query", details: parsed.error.issues },
        { status: 400 }
      );
    }
    const { from, to, category, q, limit } = parsed.data;

    const where: Record<string, unknown> = { userId: user.id };
    if (from || to) {
      where.date = {};
      if (from) (where.date as Record<string, unknown>).gte = new Date(from);
      if (to) (where.date as Record<string, unknown>).lte = new Date(to);
    }
    if (category) where.category = category;
    if (q) {
      where.OR = [
        { description: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
      ];
    }

    const expenses = await prisma.expense.findMany({
      where,
      orderBy: { date: "desc" },
      take: limit,
    });
    return NextResponse.json(expenses, { status: 200 });
  } catch (error) {
    console.error("[GET /api/expenses] Failed:", error);
    return jsonError("Failed to load expenses", 500);
  }
}

/** POST /api/expenses — create a new expense. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const body = await request.json();
    const validated = expenseSchema.parse(body);

    const expense = await withTenant(user.id, async (tx) => {
      const created = await tx.expense.create({
        data: {
          userId: user.id,
          date: new Date(validated.date),
          category: validated.category,
          description: validated.description,
          amount: validated.amount,
          notes: validated.notes ?? null,
        },
      });

      // Post the EXPENSE_RECORDED ledger entry inside the same RLS tx.
      // Because postLedgerEvent opens its own withTenant tx when no tx is
      // supplied, we pass `tx` so the ledger rows land in the same
      // atomic unit as the expense record.
      await postLedgerEvent(
        {
          type: "EXPENSE_RECORDED",
          expense: {
            id: created.id,
            userId: created.userId,
            amount: created.amount,
            category: created.category,
          },
        },
        tx
      );

      return created;
    });

    return NextResponse.json(expense, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    if (error instanceof SyntaxError) return jsonError("Invalid JSON payload", 400);
    console.error("[POST /api/expenses] Failed:", error);
    return jsonError("Failed to create expense", 500);
  }
}
