/**
 * GET /api/dashboard/aging
 *
 * Accounts Receivable Aging report — buckets outstanding PENDING invoices
 * by days-overdue (or days-until-due for future-dated):
 *   - current: not yet due (dueDate >= today)
 *   - 1-30:    1 to 30 days overdue
 *   - 31-60:  31 to 60 days overdue
 *   - 61-90:  61 to 90 days overdue
 *   - 90+:    over 90 days overdue
 *
 * Returns per-bucket totals plus a list of overdue invoices with client
 * info for display in a dashboard widget or standalone report.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // All pending (outstanding) invoices, with client
    const pending = await prisma.invoice.findMany({
      where: { userId: user.id, status: "PENDING" },
      orderBy: { dueDate: "asc" },
      include: { client: { select: { id: true, name: true, email: true } } },
    });

    const buckets = {
      current: { count: 0, amount: 0 },
      "1-30": { count: 0, amount: 0 },
      "31-60": { count: 0, amount: 0 },
      "61-90": { count: 0, amount: 0 },
      "90+": { count: 0, amount: 0 },
    } as Record<string, { count: number; amount: number }>;

    const overdueItems: Array<{
      id: string;
      invoiceNumber: string;
      clientName: string;
      clientId: string;
      dueDate: string;
      daysOverdue: number;
      amount: number;
      bucket: string;
    }> = [];

    for (const inv of pending) {
      const due = new Date(inv.dueDate);
      due.setHours(0, 0, 0, 0);
      const diffDays = Math.floor((startOfToday.getTime() - due.getTime()) / 86_400_000);
      const amount = Number(inv.totalAmount);
      let bucket: string;
      if (diffDays <= 0) bucket = "current";
      else if (diffDays <= 30) bucket = "1-30";
      else if (diffDays <= 60) bucket = "31-60";
      else if (diffDays <= 90) bucket = "61-90";
      else bucket = "90+";

      buckets[bucket].count += 1;
      buckets[bucket].amount += amount;

      if (bucket !== "current") {
        overdueItems.push({
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          clientName: inv.client.name,
          clientId: inv.client.id,
          dueDate: inv.dueDate.toISOString(),
          daysOverdue: diffDays,
          amount,
          bucket,
        });
      }
    }

    // Round amounts
    for (const k of Object.keys(buckets)) {
      buckets[k].amount = Math.round(buckets[k].amount * 100) / 100;
    }

    const totalOutstanding = Object.values(buckets).reduce((s, b) => s + b.amount, 0);
    const totalOverdue =
      buckets["1-30"].amount + buckets["31-60"].amount + buckets["61-90"].amount + buckets["90+"].amount;

    return NextResponse.json({
      buckets: Object.entries(buckets).map(([label, b]) => ({ label, ...b })),
      totalOutstanding: Math.round(totalOutstanding * 100) / 100,
      totalOverdue: Math.round(totalOverdue * 100) / 100,
      overdueItems: overdueItems.slice(0, 10),
    });
  } catch (err) {
    console.error("[GET /api/dashboard/aging]", err);
    return jsonError("Failed to load aging report", 500);
  }
}
