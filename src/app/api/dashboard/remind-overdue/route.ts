import { NextResponse } from "next/server";
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import {
  requireUser,
  unauthorized,
  jsonError,
} from "@/lib/api-helpers";
import { renderInvoiceEmail } from "@/lib/email";
import { checkRateLimit, requestKey } from "@/lib/rate-limiter";

/**
 * POST /api/dashboard/remind-overdue
 *
 * Bulk-send payment reminders for all overdue PENDING invoices belonging
 * to the signed-in user that haven't been reminded in the last 24h.
 *
 * Returns a summary { sent, skipped, failed, results: [...] }.
 *
 * Rate-limited per-user and per-IP to prevent runaway sends if someone
 * accidentally double-clicks.
 */

const REMIND_COOLDOWN_HOURS = 24;
const MAX_BATCH = 100; // hard cap per call

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    if (!process.env.RESEND_API_KEY) {
      return jsonError(
        "Resend API key is not configured. Set RESEND_API_KEY.",
        503
      );
    }

    // Stricter rate limit on bulk endpoint — one batch per minute.
    const userRl = await checkRateLimit(`bulk-remind:${user.id}`, {
      namespace: "bulk-remind",
      limit: 3,
      windowSec: 60,
    });
    if (!userRl.allowed) {
      return userRl.toResponse('Please wait a moment before sending another bulk reminder batch.');
    }
    const ipRl = await checkRateLimit(requestKey(request), {
      namespace: "bulk-remind:ip",
      limit: 10,
      windowSec: 60 * 10,
    });
    if (!ipRl.allowed) {
      return ipRl.toResponse('Too many requests — please try again later.');
    }

    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      process.env.APP_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
      "http://localhost:3000";

    const settings = await prisma.settings.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
    });

    const fromEmail =
      process.env.FROM_EMAIL || `${settings.companyName} <billing@smartbill.app>`;
    const currency = settings.currency || "INR";

    const cooldownAgo = new Date(Date.now() - REMIND_COOLDOWN_HOURS * 60 * 60 * 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Overdue = PENDING + dueDate < today (midnight local).
    // Also skip invoices reminded within cooldown OR already paid/draft.
    const overdueInvoices = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        status: "PENDING",
        dueDate: { lt: today },
        OR: [
          { lastRemindedAt: null },
          { lastRemindedAt: { lt: cooldownAgo } },
        ],
      },
      include: { client: true, items: true },
      orderBy: { dueDate: "asc" },
      take: MAX_BATCH,
    });

    if (overdueInvoices.length === 0) {
      return NextResponse.json(
        {
          success: true,
          sent: 0,
          skipped: 0,
          failed: 0,
          results: [],
          message: "No overdue invoices need reminders.",
        },
        { status: 200 }
      );
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    const results: Array<{
      invoiceId: string;
      invoiceNumber: string;
      clientEmail: string;
      daysOverdue: number;
      ok: boolean;
      error?: string;
    }> = [];
    let sent = 0;
    let failed = 0;

    // Send sequentially to be kind to Resend rate limits. This is a small
    // batch per user (capped at 100) so latency is acceptable. For larger
    // volumes this should move to a background job queue.
    const now = new Date();
    for (const invoice of overdueInvoices) {
      const dueDate = new Date(invoice.dueDate);
      const daysOverdue = Math.max(
        0,
        Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
      );
      const viewLink = `${siteUrl}/view/${invoice.id}`;
      const pdfLink = `${siteUrl}/api/public/invoices/${invoice.id}/pdf`;
      const subtotal = Number(invoice.subtotal);
      const taxRate = Number(invoice.taxRate);
      const taxAmount = (subtotal * taxRate) / 100;
      const total = Number(invoice.totalAmount);

      const { subject, html, text } = renderInvoiceEmail({
        variant: "reminder",
        companyName: settings.companyName,
        companyEmail: settings.companyEmail,
        companyAddress: settings.companyAddress,
        companyPhone: settings.companyPhone,
        clientName: invoice.client.name,
        invoiceNumber: invoice.invoiceNumber,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        subtotal,
        taxRate,
        taxAmount,
        total,
        currency,
        items: invoice.items.map((i) => ({
          description: i.description,
          quantity: i.quantity,
          price: Number(i.price),
          total: Number(i.total),
        })),
        viewLink,
        pdfLink,
        daysOverdue,
      });

      try {
        const { data, error } = await resend.emails.send({
          from: fromEmail,
          to: [invoice.client.email],
          subject,
          html,
          text,
        });
        if (error) {
          failed++;
          results.push({
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            clientEmail: invoice.client.email,
            daysOverdue,
            ok: false,
            error: error.message,
          });
          continue;
        }
        // Stamp lastRemindedAt individually so partial failures don't get retried.
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: { lastRemindedAt: now },
        });
        sent++;
        results.push({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clientEmail: invoice.client.email,
          daysOverdue,
          ok: true,
        });
        // Unused var guard
        void data;
      } catch (err) {
        failed++;
        results.push({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clientEmail: invoice.client.email,
          daysOverdue,
          ok: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    return NextResponse.json(
      {
        success: failed === 0,
        sent,
        skipped: 0,
        failed,
        total: overdueInvoices.length,
        results,
      },
      { status: failed > 0 && sent === 0 ? 502 : 200 }
    );
  } catch (error) {
    console.error("[POST /api/dashboard/remind-overdue] Failed:", error);
    return jsonError("Failed to send reminders", 500);
  }
}
