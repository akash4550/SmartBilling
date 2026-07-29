import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  requireUser,
  unauthorized,
  jsonError,
  getPrismaErrorCode,
} from "@/lib/api-helpers";
import { getSiteUrl } from "@/lib/stripe";
import { getBrandingForUser } from "@/lib/branding";
import { rateLimit, requestKey } from "@/lib/rate-limit";
import { logActivity, clientIp } from "@/lib/activity";
import { sendInvoiceEmail } from "@/lib/send-invoice-email";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Minimum cooldown between reminders for the same invoice (hours).
 * Prevents accidentally spamming the client if the button is double-clicked
 * or a bulk job runs too often.
 */
const REMIND_COOLDOWN_HOURS = 24;

/**
 * POST /api/invoices/:id/remind
 *
 * Sends a payment-reminder email for a pending invoice. Eligibility rules:
 *   - Caller must own the invoice.
 *   - Invoice must be PENDING (don't remind for PAID or DRAFT).
 *   - Not reminded within the last REMIND_COOLDOWN_HOURS.
 *
 * Updates `lastRemindedAt` on success.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const { id } = await params;

    // Per-user rate limit to discourage bulk-abuse of the Resend API via
    // repeated individual calls.
    const rl = rateLimit(`remind:${user.id}`, {
      namespace: "send-reminder",
      limit: 30,
      windowSec: 60 * 60, // 30 reminders / hour / user
    });
    if (!rl.allowed) {
      return NextResponse.json(
        {
          error: "Too many reminders sent. Please try again later.",
        },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
        }
      );
    }
    // Also IP-rate-limit to harden against stolen sessions.
    const ipRl = rateLimit(requestKey(request), {
      namespace: "send-reminder:ip",
      limit: 60,
      windowSec: 60 * 10,
    });
    if (!ipRl.allowed) {
      return NextResponse.json(
        { error: "Too many requests — please try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(ipRl.retryAfterMs / 1000)) },
        }
      );
    }

    if (!process.env.RESEND_API_KEY) {
      return jsonError(
        "Resend API key is not configured. Set RESEND_API_KEY.",
        503
      );
    }

    let personalMessage: string | undefined;
    try {
      const body = await request.json().catch(() => ({}));
      if (body && typeof body.message === "string") {
        personalMessage = body.message.trim().slice(0, 1000) || undefined;
      }
    } catch {
      /* no message */
    }

    const [invoice, settings] = await Promise.all([
      prisma.invoice.findFirst({
        where: { id, userId: user.id },
        include: { client: true, items: true },
      }),
      prisma.settings.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
      }),
    ]);

    if (!invoice) return jsonError("Invoice not found", 404);

    if (invoice.status === "PAID") {
      return jsonError("This invoice is already marked as paid.", 400);
    }
    if (invoice.status === "DRAFT") {
      return jsonError(
        "Draft invoices haven't been sent yet. Send the invoice first.",
        400
      );
    }

    // Cooldown check
    const now = new Date();
    if (invoice.lastRemindedAt) {
      const sinceLast = now.getTime() - invoice.lastRemindedAt.getTime();
      const cooldownMs = REMIND_COOLDOWN_HOURS * 60 * 60 * 1000;
      if (sinceLast < cooldownMs) {
        const hoursLeft = Math.ceil((cooldownMs - sinceLast) / (60 * 60 * 1000));
        return jsonError(
          `A reminder was already sent for this invoice within the last ${REMIND_COOLDOWN_HOURS} hours. Please wait ${hoursLeft} more hour${hoursLeft === 1 ? "" : "s"}.`,
          429
        );
      }
    }

    const siteUrl = getSiteUrl();
    const fromEmail = process.env.FROM_EMAIL || `${settings.companyName} <billing@smartbill.app>`;
    const viewLink = `${siteUrl}/view/${invoice.id}`;
    const pdfLink = `${siteUrl}/api/public/invoices/${invoice.id}/pdf`;
    const currency = settings.currency || "INR";

    const dueDate = new Date(invoice.dueDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysOverdue = Math.max(
      0,
      Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
    );

    const branding = await getBrandingForUser(user.id);
    const logoAbsUrl = branding.logoUrl
      ? (branding.logoUrl.startsWith("http") ? branding.logoUrl : `${siteUrl}${branding.logoUrl}`)
      : null;
    const portalLink = invoice.client.portalToken
      ? `${siteUrl}/portal/${invoice.client.portalToken}`
      : null;

    const result = await sendInvoiceEmail({
      invoice,
      settings: {
        companyName: settings.companyName,
        companyEmail: settings.companyEmail,
        companyAddress: settings.companyAddress,
        companyPhone: settings.companyPhone,
        currency,
        logoUrl: logoAbsUrl,
        logoBase64: branding.logoData,
        logoContentType: branding.logoContentType,
        brandColor: branding.brandColor,
      },
      to: invoice.client.email,
      from: fromEmail,
      variant: "reminder",
      viewLink,
      pdfLink,
      portalLink,
      personalMessage,
      daysOverdue,
    });

    if (result.error) {
      console.error("[remind-invoice] Resend error:", result.error);
      return jsonError(`Failed to send reminder: ${result.error}`, 502);
    }

    await prisma.invoice.update({
      where: { id },
      data: { lastRemindedAt: now },
    });

    logActivity({
      invoiceId: id,
      userId: user.id,
      type: "REMINDED",
      message: `Payment reminder sent to ${invoice.client.email}${daysOverdue > 0 ? ` (${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue)` : ""}${result.pdfAttached ? " — PDF attached" : ""}`,
      ip: clientIp(request),
      meta: { to: invoice.client.email, daysOverdue, pdfAttached: result.pdfAttached },
    });

    return NextResponse.json(
      {
        success: true,
        messageId: result.messageId,
        sentTo: invoice.client.email,
        daysOverdue,
        pdfAttached: result.pdfAttached,
      },
      { status: 200 }
    );
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2025" || getPrismaErrorCode(error) === "P2016") {
      return jsonError("Invoice not found", 404);
    }
    console.error("[POST /api/invoices/:id/remind] Failed:", error);
    return jsonError("Failed to send reminder", 500);
  }
}
