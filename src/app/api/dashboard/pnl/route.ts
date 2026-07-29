/**
 * GET /api/dashboard/pnl?months=6
 *
 * Profit & Loss series: for each of the last N months (ending at the current
 * calendar month), compute revenue (sum of PAID invoices issued within the
 * month) and expenses (sum of expenses dated within the month). Returns
 * points for a chart plus a current-month summary.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
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
    const parsed = querySchema.safeParse({ months: searchParams.get("months") ?? undefined });
    if (!parsed.success) return jsonError("Invalid query", 400);
    const { months } = parsed.data;

    const now = new Date();
    // Anchor on the start of the current month so the series always ends at today's month.
    const seriesStart = addMonths(startOfMonth(now), -(months - 1));
    const seriesEnd = endOfMonth(now);

    const [settings, invoices, expenses] = await Promise.all([
      prisma.settings.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
        select: { currency: true },
      }),
      prisma.invoice.findMany({
        where: {
          userId: user.id,
          status: "PAID",
          paidAt: { gte: seriesStart, lte: seriesEnd },
        },
        select: { paidAt: true, totalAmount: true },
      }),
      prisma.expense.findMany({
        where: {
          userId: user.id,
          date: { gte: seriesStart, lte: seriesEnd },
        },
        select: { date: true, amount: true, category: true },
      }),
    ]);

    // Build N month buckets
    const points: Array<{
      key: string;
      label: string;
      revenue: number;
      expenses: number;
      profit: number;
    }> = [];
    for (let i = 0; i < months; i++) {
      const mStart = addMonths(seriesStart, i);
      const mEnd = endOfMonth(mStart);
      const key = `${mStart.getFullYear()}-${String(mStart.getMonth() + 1).padStart(2, "0")}`;

      const revenue = invoices
        .filter((inv) => {
          const d = inv.paidAt;
          return d && d >= mStart && d <= mEnd;
        })
        .reduce((s, inv) => s + Number(inv.totalAmount), 0);

      const exp = expenses
        .filter((e) => e.date >= mStart && e.date <= mEnd)
        .reduce((s, e) => s + Number(e.amount), 0);

      points.push({
        key,
        label: labelFor(mStart),
        revenue: Math.round(revenue * 100) / 100,
        expenses: Math.round(exp * 100) / 100,
        profit: Math.round((revenue - exp) * 100) / 100,
      });
    }

    // Category breakdown for expenses within the window
    const byCategory = new Map<string, number>();
    for (const e of expenses) {
      const cat = e.category || "General";
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + Number(e.amount));
    }
    const categories = Array.from(byCategory.entries())
      .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount);

    const totalRevenue = points.reduce((s, p) => s + p.revenue, 0);
    const totalExpenses = points.reduce((s, p) => s + p.expenses, 0);
    const current = points[points.length - 1];

    return NextResponse.json({
      currency: settings.currency || "INR",
      points,
      categories,
      totals: {
        revenue: Math.round(totalRevenue * 100) / 100,
        expenses: Math.round(totalExpenses * 100) / 100,
        profit: Math.round((totalRevenue - totalExpenses) * 100) / 100,
        margin: totalRevenue > 0 ? Math.round(((totalRevenue - totalExpenses) / totalRevenue) * 1000) / 10 : 0,
      },
      currentMonth: current,
    });
  } catch (err) {
    console.error("[GET /api/dashboard/pnl] Failed:", err);
    return jsonError("Failed to load P&L", 500);
  }
}
