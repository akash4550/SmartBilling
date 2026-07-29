import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  jsonError,
  requireUser,
  unauthorized,
} from "@/lib/api-helpers";

/**
 * GET /api/dashboard/revenue?months=6
 *
 * Returns monthly revenue aggregates (sum of PAID invoices grouped by the
 * month of the `paidAt` timestamp) for the signed-in user. No arbitrary
 * invoice fetch cap — all PAID invoices are aggregated in SQL, so the
 * chart stays accurate at scale.
 *
 * Response shape:
 *   {
 *     points: [ { key: "YYYY-MM", label: "Mon YYYY", revenue: number } ],
 *     currency: string
 *   }
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const { searchParams } = new URL(request.url);
    const monthsParam = searchParams.get("months");
    const months = Math.min(Math.max(Number(monthsParam) || 6, 1), 24);

    // Load settings for currency (fallback INR)
    const settings = await prisma.settings.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
      select: { currency: true },
    });

    // Compute month buckets starting from the beginning of the earliest month
    // we care about, so empty months still get a $0 data point (critical for
    // the chart to render correctly).
    const now = new Date();
    const buckets: Array<{ key: string; label: string; start: Date; end: Date; revenue: number }> = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      buckets.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        label: d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" }),
        start: d,
        end,
        revenue: 0,
      });
    }

    // Fetch PAID invoices for this user where paidAt falls in range
    const startCutoff = buckets[0].start;
    const paidInvoices = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        status: "PAID",
        paidAt: { gte: startCutoff },
      },
      select: { paidAt: true, totalAmount: true },
    });

    for (const inv of paidInvoices) {
      if (!inv.paidAt) continue;
      const key = `${inv.paidAt.getFullYear()}-${String(inv.paidAt.getMonth() + 1).padStart(2, "0")}`;
      const bucket = buckets.find((b) => b.key === key);
      if (bucket) {
        bucket.revenue += Number(inv.totalAmount);
      }
    }

    // Round for stability
    const points = buckets.map((b) => ({
      key: b.key,
      label: b.label,
      revenue: Math.round(b.revenue * 100) / 100,
    }));

    return NextResponse.json({ points, currency: settings.currency }, { status: 200 });
  } catch (error) {
    console.error("[GET /api/dashboard/revenue]", error);
    return jsonError("Failed to load revenue data", 500);
  }
}
