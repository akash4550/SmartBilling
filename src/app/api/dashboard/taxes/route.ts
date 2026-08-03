/**
 * GET /api/dashboard/taxes?months=N
 *
 * Returns tax collected per month (paid invoices only) for the dashboard
 * tax summary chart. Also returns total tax collected YTD and for the
 * current month (useful for GST/VAT filing).
 */
import { NextResponse } from "next/server";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const url = new URL(request.url);
    const months = Math.max(1, Math.min(24, Number(url.searchParams.get("months") || "6")));

    const now = new Date();
    const startRange = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

    const paidInvoices = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        status: "PAID",
        paidAt: { gte: startRange },
      },
      select: {
        paidAt: true,
        totalAmount: true,
        subtotal: true,
        discountAmount: true,
        taxRate: true,
      },
      orderBy: { paidAt: "asc" },
    });

    // Build buckets per month
    const points: Array<{ key: string; label: string; tax: number; revenue: number }> = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
      points.push({ key, label, tax: 0, revenue: 0 });
    }
    const byKey = new Map(points.map((p) => [p.key, p]));

    let totalTax = 0;
    let totalRevenue = 0;
    let currentMonthTax = 0;
    const cmKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    for (const inv of paidInvoices) {
      if (!inv.paidAt) continue;
      const pd = new Date(inv.paidAt);
      const key = `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, "0")}`;
      const bucket = byKey.get(key);
      const total = Number(inv.totalAmount);
      const subtotal = Number(inv.subtotal);
      const disc = Number(inv.discountAmount ?? 0);
      const net = Math.max(0, subtotal - disc);
      const taxRate = Number(inv.taxRate) || 0;
      const tax = Math.round(net * taxRate) / 100;
      totalTax += tax;
      totalRevenue += total;
      if (key === cmKey) currentMonthTax += tax;
      if (bucket) {
        bucket.tax = Math.round((bucket.tax + tax) * 100) / 100;
        bucket.revenue = Math.round((bucket.revenue + total) * 100) / 100;
      }
    }

    // Round
    totalTax = Math.round(totalTax * 100) / 100;
    totalRevenue = Math.round(totalRevenue * 100) / 100;
    currentMonthTax = Math.round(currentMonthTax * 100) / 100;

    // YTD
    const ytdStart = new Date(now.getFullYear(), 0, 1);    // Rough YTD tax estimate using average tax rate would be imprecise;
    // we approximate by pulling all paid invoices' tax.
    const ytdInvoices = await prisma.invoice.findMany({
      where: { userId: user.id, status: "PAID", paidAt: { gte: ytdStart } },
      select: { subtotal: true, discountAmount: true, taxRate: true },
    });
    let ytdTax = 0;
    for (const inv of ytdInvoices) {
      const net = Math.max(0, Number(inv.subtotal) - Number(inv.discountAmount ?? 0));
      ytdTax += Math.round(net * (Number(inv.taxRate) || 0)) / 100;
    }
    ytdTax = Math.round(ytdTax * 100) / 100;

    return NextResponse.json({
      points,
      totals: {
        totalTax,
        totalRevenue,
        currentMonthTax,
        ytdTax,
        effectiveRate: totalRevenue > 0 ? Math.round((totalTax / totalRevenue) * 10000) / 100 : 0,
      },
    });
  } catch (err) {
    console.error("[GET /api/dashboard/taxes]", err);
    return jsonError("Failed to load tax data", 500);
  }
}
