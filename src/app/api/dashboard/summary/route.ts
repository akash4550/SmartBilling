import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  jsonError,
  requireUser,
  unauthorized,
} from "@/lib/api-helpers";

/**
 * GET /api/dashboard/summary
 *
 * Protected aggregate KPI endpoint scoped to the signed-in user.
 */
export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const where = { userId: user.id };

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    const [
      totalRevenueAgg,
      pendingAmountAgg,
      draftCount,
      pendingCount,
      paidCount,
      totalInvoices,
      totalClients,
      recentInvoices,
      overdueCount,
      overdueAmountAgg,
      monthRevenueAgg,
      lastMonthRevenueAgg,
      monthPaidCountAgg,
    ] = await Promise.all([
      prisma.invoice.aggregate({
        _sum: { totalAmount: true },
        where: { ...where, status: "PAID" },
      }),
      prisma.invoice.aggregate({
        _sum: { totalAmount: true },
        where: { ...where, status: "PENDING" },
      }),
      prisma.invoice.count({ where: { ...where, status: "DRAFT" } }),
      prisma.invoice.count({ where: { ...where, status: "PENDING" } }),
      prisma.invoice.count({ where: { ...where, status: "PAID" } }),
      prisma.invoice.count({ where }),
      prisma.client.count({ where: { userId: user.id } }),
      prisma.invoice.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 6,
        include: { client: true, items: true },
      }),
      prisma.invoice.count({
        where: {
          ...where,
          status: "PENDING",
          dueDate: { lt: startOfToday },
        },
      }),
      prisma.invoice.aggregate({
        _sum: { totalAmount: true },
        where: {
          ...where,
          status: "PENDING",
          dueDate: { lt: startOfToday },
        },
      }),
      // Paid-this-month revenue (paidAt within current month).
      prisma.invoice.aggregate({
        _sum: { totalAmount: true },
        where: { ...where, status: "PAID", paidAt: { gte: startOfMonth } },
      }),
      // Paid-last-month revenue (for trend comparison).
      prisma.invoice.aggregate({
        _sum: { totalAmount: true },
        where: {
          ...where,
          status: "PAID",
          paidAt: { gte: startOfLastMonth, lte: endOfLastMonth },
        },
      }),
      prisma.invoice.count({
        where: { ...where, status: "PAID", paidAt: { gte: startOfMonth } },
      }),
    ]);

    const totalRevenue = Number(totalRevenueAgg._sum.totalAmount ?? 0);
    const pendingAmount = Number(pendingAmountAgg._sum.totalAmount ?? 0);
    const overdueAmount = Number(overdueAmountAgg._sum.totalAmount ?? 0);
    const monthRevenue = Number(monthRevenueAgg._sum.totalAmount ?? 0);
    const lastMonthRevenue = Number(lastMonthRevenueAgg._sum.totalAmount ?? 0);

    // Simple month-over-month percent change (guarded against div-by-zero).
    let monthTrend: number | null = null;
    if (lastMonthRevenue > 0) {
      monthTrend = Math.round(((monthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100);
    } else if (monthRevenue > 0) {
      monthTrend = 100;
    }

    return NextResponse.json(
      {
        totalRevenue,
        pendingAmount,
        overdueCount,
        overdueAmount,
        draftCount,
        pendingCount,
        paidCount,
        totalInvoices,
        totalClients,
        monthRevenue,
        monthPaidCount: monthPaidCountAgg,
        monthTrend,
        recentInvoices,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[GET /api/dashboard/summary]", error);
    return jsonError("Failed to load dashboard summary", 500);
  }
}
