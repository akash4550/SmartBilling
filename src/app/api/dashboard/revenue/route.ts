/**
 * GET /api/dashboard/revenue?months=6
 *
 * Monthly revenue aggregates — PAID invoices grouped by the calendar
 * month of `paidAt`. Aggregations run in SQL via date_trunc, which is
 * far more efficient than pulling every row into Node (fixes
 * the in-memory reduce bottleneck for N ≥ 10k invoices).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jsonError, requireUser, unauthorized } from "@/lib/api-helpers";
import { toNumber } from "@/lib/money";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const { searchParams } = new URL(request.url);
    const monthsParam = searchParams.get("months");
    const months = Math.min(Math.max(Number(monthsParam) || 6, 1), 24);

    const settings = await prisma.settings.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
      select: { currency: true },
    });

    // Build month buckets — empty months return $0 so the chart renders
    // correctly without sparse data.
    const now = new Date();
    const buckets: Array<{
      key: string;
      label: string;
      start: Date;
      end: Date;
      revenue: number;
    }> = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      buckets.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        label: d.toLocaleDateString("en-IN", {
          month: "short",
          year: "2-digit",
        }),
        start: d,
        end,
        revenue: 0,
      });
    }

    // SQL-side GROUP BY month — single index scan over (userId, paidAt).
    const startCutoff = buckets[0]!.start;
    const rows = await prisma.$queryRaw<
      Array<{ month: Date; revenue: unknown }>
    >`
      SELECT date_trunc('month', "paidAt") AS month,
             SUM("totalAmount")            AS revenue
      FROM   "invoices"
      WHERE  "userId"    = ${user.id}
        AND  status      = 'PAID'
        AND  "paidAt"   >= ${startCutoff}
      GROUP  BY 1
      ORDER  BY 1 ASC
    `;

    for (const r of rows) {
      if (!r.month) continue;
      const m = new Date(r.month);
      const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
      const bucket = buckets.find((b) => b.key === key);
      if (bucket) {
        bucket.revenue = Math.round(toNumber(r.revenue as any) * 100) / 100;
      }
    }

    const points = buckets.map((b) => ({
      key: b.key,
      label: b.label,
      revenue: b.revenue,
    }));

    return NextResponse.json(
      { points, currency: settings.currency },
      { status: 200 }
    );
  } catch (error) {
    console.error("[GET /api/dashboard/revenue]", error);
    return jsonError("Failed to load revenue data", 500);
  }
}
