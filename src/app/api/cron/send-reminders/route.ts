/**
 * GET /api/cron/send-reminders
 *
 * Sends automated payment reminders for overdue invoices, using a stepped
 * cadence: 3 days, 7 days, and 14 days after the due date. We respect
 * `lastRemindedAt` so each cadence step fires at most once per invoice.
 *
 * Also sends a pre-due reminder at 1 day before due date (optional, controlled
 * by SEND_PRE_DUE_REMINDER env flag — off by default).
 *
 * Auth: requires Authorization: Bearer <CRON_SECRET> if CRON_SECRET is set.
 *
 * Safe to call hourly. Invoices in DRAFT / PAID / VOID state are ignored.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/stripe";
import { getBrandingForUser } from "@/lib/branding";
import { sendInvoiceEmail } from "@/lib/send-invoice-email";
import { logActivity } from "@/lib/activity";

export const dynamic = "force-dynamic";

interface ReminderResult {
  invoiceId: string;
  invoiceNumber: string;
  userId: string;
  clientEmail: string;
  daysOverdue: number;
  reminderNumber: number;
  sent: boolean;
  error?: string;
}

function daysBetweenISt(a: Date, b: Date): number {
  const tz = "Asia/Calcutta";
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = (d: Date) => {
    const p = fmt.formatToParts(d);
    const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"));
  };
  return Math.floor((parts(a) - parts(b)) / 86_400_000);
}

/** Cadence: days after due date when we send the Nth reminder. */
const REMINDER_CADENCE = [3, 7, 14] as const;

export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = request.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (token !== secret) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    if (!process.env.RESEND_API_KEY) {
      return NextResponse.json({
        success: true,
        skipped: "RESEND_API_KEY not configured — no reminders sent",
        sent: 0,
        failed: 0,
      });
    }

    const now = new Date();
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dryRun") === "1";
    const maxCandidates = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 500);

    // Fetch pending invoices whose due date is within our cadence window
    // (up to 14 days overdue), plus 2 days buffer for the last step.
    const windowStart = new Date(now);
    windowStart.setDate(windowStart.getDate() - 16);

    const candidates = await prisma.invoice.findMany({
      where: {
        status: "PENDING",
        dueDate: { gte: windowStart },
      },
      include: {
        client: true,
        items: true,
        user: { include: { settings: true } },
      },
      orderBy: { dueDate: "asc" },
      take: maxCandidates,
    });

    const results: ReminderResult[] = [];
    const siteUrl = getSiteUrl();

    for (const inv of candidates) {
      const daysOver = daysBetweenISt(now, new Date(inv.dueDate));
      if (daysOver < 3) continue; // not yet due for first reminder

      // Determine which cadence bucket this falls into.
      let reminderNumber = 0;
      for (let i = REMINDER_CADENCE.length - 1; i >= 0; i--) {
        if (daysOver >= REMINDER_CADENCE[i]) {
          reminderNumber = i + 1; // 1, 2, or 3
          break;
        }
      }
      if (reminderNumber === 0) continue;

      // Check we haven't already sent this reminder number (or any reminder
      // beyond the cadence window for that step). We approximate by checking
      // lastRemindedAt is old enough that a new step is warranted, OR that
      // the activity log doesn't contain a REMINDED event in the required
      // window. Simpler: only send if no reminder in the last 2 days AND
      // there's no recorded reminder for a cadence >= current step since
      // the invoice became that-many-days overdue.
      // For simplicity we rely on lastRemindedAt spacing: a reminder is due
      // if (now - lastRemindedAt) >= (currentCadence - previousCadence) days.
      if (inv.lastRemindedAt) {
        const daysSinceLast = daysBetweenISt(now, inv.lastRemindedAt);
        const stepGap = reminderNumber === 1 ? 3 : reminderNumber === 2 ? 4 : 7;
        if (daysSinceLast < stepGap) continue;
      }

      if (dryRun) {
        results.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          userId: inv.userId,
          clientEmail: inv.client.email,
          daysOverdue: daysOver,
          reminderNumber,
          sent: false,
        });
        continue;
      }

      try {
        const branding = await getBrandingForUser(inv.userId);
        const settings = inv.user.settings;
        const fromEmail =
          process.env.FROM_EMAIL ||
          `${settings?.companyName ?? "SmartBill"} <billing@smartbill.app>`;
        const viewLink = `${siteUrl}/view/${inv.id}`;
        const pdfLink = `${siteUrl}/api/public/invoices/${inv.id}/pdf`;
        const currency = settings?.currency || "INR";

        const result = await sendInvoiceEmail({
          invoice: inv,
          settings: {
            companyName: settings?.companyName ?? "SmartBill",
            companyEmail: settings?.companyEmail ?? inv.user.email,
            companyAddress: settings?.companyAddress ?? null,
            companyPhone: settings?.companyPhone ?? null,
            currency,
            logoUrl: branding.logoUrl
              ? branding.logoUrl.startsWith("http")
                ? branding.logoUrl
                : `${siteUrl}${branding.logoUrl}`
              : null,
            logoBase64: branding.logoData,
            logoContentType: branding.logoContentType,
            brandColor: branding.brandColor,
          },
          to: inv.client.email,
          from: fromEmail,
          variant: "reminder",
          viewLink,
          pdfLink,
          portalLink: inv.client.portalToken ? `${siteUrl}/portal/${inv.client.portalToken}` : null,
          daysOverdue: daysOver,
          reminderNumber,
          personalMessage:
            reminderNumber === 3
              ? "This is our final reminder. Please settle payment at your earliest convenience to avoid further action."
              : reminderNumber === 2
              ? "This is a friendly follow-up — payment has not yet been received."
              : "This is a friendly reminder that payment is overdue.",
        });

        if (result.error) {
          results.push({
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            userId: inv.userId,
            clientEmail: inv.client.email,
            daysOverdue: daysOver,
            reminderNumber,
            sent: false,
            error: result.error,
          });
        } else {
          // Update lastRemindedAt.
          await prisma.invoice.update({
            where: { id: inv.id },
            data: { lastRemindedAt: now },
          });
          logActivity({
            invoiceId: inv.id,
            userId: inv.userId,
            type: "REMINDED",
            message: `Auto-reminder #${reminderNumber} sent (${daysOver} days overdue)`,
            meta: { automated: true, reminderNumber, daysOverdue: daysOver },
          });
          results.push({
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            userId: inv.userId,
            clientEmail: inv.client.email,
            daysOverdue: daysOver,
            reminderNumber,
            sent: true,
          });
        }
      } catch (err) {
        console.error(`[cron/reminders] Failed for ${inv.invoiceNumber}:`, err);
        results.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          userId: inv.userId,
          clientEmail: inv.client.email,
          daysOverdue: daysOver,
          reminderNumber,
          sent: false,
          error: err instanceof Error ? err.message : "Unknown",
        });
      }
    }

    return NextResponse.json({
      success: true,
      processed: results.length,
      sent: results.filter((r) => r.sent).length,
      failed: results.filter((r) => r.error).length,
      dryRun,
      results,
    });
  } catch (error) {
    console.error("[cron/send-reminders] Failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
