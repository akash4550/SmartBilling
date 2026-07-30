/**
 * GET /api/dashboard/pnl?months=6
 *
 * Profit & Loss series: per-month revenue (PAID invoices grouped by paidAt
 * month) vs expenses (grouped by date month). All aggregations run in SQL
 * via date_trunc — no in-memory scan over the full invoice/expense tables.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
import { toNumber } from "@/lib/money";
import { z } from "zod";

const querySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
});

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function labelFor(d: Date): string {
  return d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const { searchParams } = new URL(request.url);
    const parsed = querySchema.safeParse({
      months: searchParams.get("months") ?? undefined,
    });
    if (!parsed.success) return jsonError("Invalid query", 400);
    const { months } = parsed.data;

    const now = new Date();
    const seriesStart = addMonths(startOfMonth(now), -(months - 1));
    const seriesEnd = endOfMonth(now);

    const [settings, invoiceRows, expenseRows] = await Promise.all([
      prisma.settings.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
        select: { currency: true },
      }),
      prisma.$queryRaw<Array<{ month: Date; revenue: unknown }>>`
        SELECT date_trunc('month', "paidAt") AS month,
               SUM("totalAmount")            AS revenue
        FROM   "invoices"
        WHERE  "userId"    = ${user.id}
          AND  status      = 'PAID'
          AND  "paidAt"   >= ${seriesStart}
          AND  "paidAt"   <= ${seriesEnd}
        GROUP  BY 1
        ORDER  BY 1 ASC
      `,
      prisma.$queryRaw<
        Array<{ month: Date; expenses: unknown; category: string }>
      >`
        SELECT date_trunc('month', "date") AS month,
               category,
               SUM(amount)                AS expenses
        FROM   "expenses"
        WHERE  "userId"    = ${user.id}
          AND  "date"     >= ${seriesStart}
          AND  "date"     <= ${seriesEnd}
        GROUP  BY 1, category
        ORDER  BY 1 ASC
      `,
    ]);

    const points: Array<{
      key: string;
      label: string;
      revenue: number;
      expenses: number;
      profit: number;
    }> = [];
    const byCategory = new Map<string, number>();
    for (let i = 0; i < months; i++) {
      const mStart = addMonths(seriesStart, i);
      const key = `${mStart.getFullYear()}-${String(mStart.getMonth() + 1).padStart(2, "0")}`;

      // Match SQL-generated rows to this bucket by year+month.
      const revenue = invoiceRows
        .filter((r) => r.month && new Date(r.month).getTime() === mStart.getTime())
        .reduce((s, r) => s + toNumber(r.revenue as any), 0);
      const monthExpenseRows = expenseRows.filter(
        (r) => r.month && new Date(r.month).getTime() === mStart.getTime()
      );
      const exp = monthExpenseRows.reduce(
        (s, r) => s + toNumber(r.expenses as any),
        0
      );
      for (const r of monthExpenseRows) {
        const cat = r.category || "General";
        byCategory.set(
          cat,
          (byCategory.get(cat) ?? 0) + toNumber(r.expenses as any)
        );
      }

      points.push({
        key,
        label: labelFor(mStart),
        revenue: Math.round(revenue * 100) / 100,
        expenses: Math.round(exp * 100) / 100,
        profit: Math.round((revenue - exp) * 100) / 100,
      });
    }

    const categories = Array.from(byCategory.entries())
      .map(([name, amount]) => ({
        name,
        amount: Math.round(amount * 100) / 100,
      }))
      .sort((a, b) => b.amount - a.amount);

    const totalRevenue = points.reduce((s, p) => s + p.revenue, 0);
    const totalExpenses = points.reduce((s, p) => s + p.expenses, 0);
    const current = points[points.length - 1]!;

    return NextResponse.json({
      currency: settings.currency || "INR",
      points,
      categories,
      totals: {
        revenue: Math.round(totalRevenue * 100) / 100,
        expenses: Math.round(totalExpenses * 100) / 100,
        profit: Math.round((totalRevenue - totalExpenses) * 100) / 100,
        margin:
          totalRevenue > 0
            ? Math.round(
                ((totalRevenue - totalExpenses) / totalRevenue) * 1000
              ) / 10
            : 0,
      },
      currentMonth: current,
    });
  } catch (err) {
    console.error("[GET /api/dashboard/pnl] Failed:", err);
    return jsonError("Failed to load P&L", 500);
  }
}
