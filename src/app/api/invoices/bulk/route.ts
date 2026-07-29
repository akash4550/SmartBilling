/**
 * POST /api/invoices/bulk
 *
 * Bulk actions on invoices (scoped to current user). Supported actions:
 *   - mark_paid: mark pending/draft invoices as paid (current timestamp)
 *   - remind:     send payment reminder email to each invoice's client
 *   - delete:     delete DRAFT invoices only (sent/paid invoices skipped
 *                 to prevent accidental data loss)
 *
 * Body: { ids: string[], action: "mark_paid"|"remind"|"delete" }
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
import { markInvoicePaid } from "@/lib/invoice-helpers";
import { sendInvoiceEmail } from "@/lib/send-invoice-email";
import { logActivity, clientIp } from "@/lib/activity";
import { getSiteUrl } from "@/lib/stripe";
import { getBrandingForUser } from "@/lib/branding";
import { rateLimit, requestKey } from "@/lib/rate-limit";

export const runtime = "nodejs";

const MAX_BULK = 50;

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    // Per-user rate limit (bulk actions send emails / write many rows).
    const rl = rateLimit(requestKey(request, `bulk:${user.id}`), {
      namespace: "invoices:bulk",
      limit: 10,
      windowSec: 60,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many bulk actions — please try again later." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { ids, action } = body as { ids?: string[]; action?: string };
    if (!Array.isArray(ids) || ids.length === 0) {
      return jsonError("No invoices selected", 400);
    }
    if (ids.length > MAX_BULK) {
      return jsonError(`Too many invoices selected (max ${MAX_BULK})`, 400);
    }
    if (!["mark_paid", "remind", "delete"].includes(action || "")) {
      return jsonError("Invalid action", 400);
    }

    // Load invoices scoped to user (ownership check).
    const invoices = await prisma.invoice.findMany({
      where: { id: { in: ids }, userId: user.id },
      include: {
        client: true,
        items: true,
      },
    });
    if (invoices.length === 0) {
      return jsonError("No matching invoices found", 404);
    }

    const ip = clientIp(request);
    const siteUrl = getSiteUrl();
    const [settings, branding] = await Promise.all([
      prisma.settings.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id } }),
      getBrandingForUser(user.id),
    ]);
    const logoAbsUrl = branding.logoUrl ? (branding.logoUrl.startsWith("http") ? branding.logoUrl : `${siteUrl}${branding.logoUrl}`) : null;
    const fromEmail = process.env.FROM_EMAIL || `${settings.companyName} <billing@smartbill.app>`;

    let succeeded = 0;
    let skipped = 0;
    const errors: Array<{ id: string; error: string }> = [];

    for (const inv of invoices) {
      try {
        if (action === "mark_paid") {
          if (inv.status === "PAID") { skipped++; continue; }
          await markInvoicePaid(inv.id, { actorUserId: user.id, ip: ip ?? undefined });
          succeeded++;
        } else if (action === "remind") {
          if (inv.status === "DRAFT") { skipped++; continue; }
          if (inv.status === "PAID") { skipped++; continue; }
          const viewLink = `${siteUrl}/view/${inv.id}`;
          const pdfLink = `${siteUrl}/api/public/invoices/${inv.id}/pdf`;
          const portalLink = inv.client.portalToken ? `${siteUrl}/portal/${inv.client.portalToken}` : null;
          const due = new Date(inv.dueDate); const today = new Date(); today.setHours(0,0,0,0);
          const daysOverdue = Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86400000));
          const result = await sendInvoiceEmail({
            invoice: inv,
            settings: {
              companyName: settings.companyName,
              companyEmail: settings.companyEmail,
              companyAddress: settings.companyAddress,
              companyPhone: settings.companyPhone,
              currency: settings.currency || "INR",
              logoUrl: logoAbsUrl,
              logoBase64: branding.logoData,
              logoContentType: branding.logoContentType,
              brandColor: branding.brandColor,
            },
            to: inv.client.email,
            from: fromEmail,
            variant: "reminder",
            viewLink,
            pdfLink,
            portalLink,
            daysOverdue,
          });
          if (result.error) throw new Error(result.error);
          await prisma.invoice.update({
            where: { id: inv.id },
            data: { lastRemindedAt: new Date() },
          });
          await logActivity({
            invoiceId: inv.id, userId: user.id, type: "REMINDED",
            message: `Payment reminder sent to ${inv.client.email} (bulk)${result.pdfAttached ? " (PDF)" : ""}`,
            ip: ip ?? undefined,
          });
          succeeded++;
        } else if (action === "delete") {
          if (inv.status !== "DRAFT") { skipped++; continue; }
          await prisma.invoice.delete({ where: { id: inv.id } });
          await logActivity({
            invoiceId: inv.id, userId: user.id, type: "DELETED",
            message: `Invoice ${inv.invoiceNumber} deleted (bulk)`,
            ip: ip ?? undefined,
          });
          succeeded++;
        }
      } catch (e) {
        errors.push({ id: inv.id, error: (e as Error).message });
      }
    }

    return NextResponse.json({
      ok: true, action, succeeded, skipped, failed: errors.length,
      total: invoices.length, errors,
    });
  } catch (err) {
    console.error("[POST /api/invoices/bulk]", err);
    return jsonError("Bulk action failed", 500);
  }
}
