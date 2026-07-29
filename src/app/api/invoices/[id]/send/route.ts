import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/stripe";
import { getBrandingForUser } from "@/lib/branding";
import { requireUser, unauthorized, jsonError, getPrismaErrorCode } from "@/lib/api-helpers";
import { logActivity, clientIp } from "@/lib/activity";
import { sendInvoiceEmail } from "@/lib/send-invoice-email";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/invoices/:id/send
 *
 * Sends the invoice email to the client via Resend. If the invoice is
 * currently DRAFT it is transitioned to PENDING (the send action implies
 * the invoice has been issued). Records `lastSentAt` for audit/reminder
 * cadence logic.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const user = await requireUser();
    if (!user) return unauthorized();

    const { id } = await params;

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

    const siteUrl = getSiteUrl();
    const fromEmail = process.env.FROM_EMAIL || `${settings.companyName} <billing@smartbill.app>`;
    const viewLink = `${siteUrl}/view/${invoice.id}`;
    const pdfLink = `${siteUrl}/api/public/invoices/${invoice.id}/pdf`;
    const currency = settings.currency || "INR";

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
      variant: "new",
      viewLink,
      pdfLink,
      portalLink,
      personalMessage,
    });

    if (result.error) {
      console.error("[send-invoice] Resend error:", result.error);
      return jsonError(`Failed to send email: ${result.error}`, 502);
    }

    // Mark as sent: DRAFT → PENDING and stamp lastSentAt.
    const updated = await prisma.invoice.updateMany({
      where: { id, userId: user.id },
      data: {
        status: invoice.status === "DRAFT" ? "PENDING" : invoice.status,
        lastSentAt: new Date(),
      },
    });

    if (updated.count > 0) {
      logActivity({
        invoiceId: id,
        userId: user.id,
        type: "SENT",
        message: `Invoice sent to ${invoice.client.email}${result.pdfAttached ? " (PDF attached)" : ""}${personalMessage ? " — with message" : ""}`,
        ip: clientIp(request),
        meta: { to: invoice.client.email, personalMessage: !!personalMessage, pdfAttached: result.pdfAttached },
      });
    }

    return NextResponse.json(
      {
        success: true,
        messageId: result.messageId,
        sentTo: invoice.client.email,
        pdfAttached: result.pdfAttached,
        status: invoice.status === "DRAFT" ? "PENDING" : invoice.status,
      },
      { status: 200 }
    );
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2025" || getPrismaErrorCode(error) === "P2016") {
      return jsonError("Invoice not found", 404);
    }
    console.error("[POST /api/invoices/:id/send] Failed:", error);
    return jsonError("Failed to send invoice", 500);
  }
}
