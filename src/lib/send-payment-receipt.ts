/**
 * Send a "payment received" receipt email. Best-effort — errors are logged
 * but don't fail the caller (we don't want a misconfigured email provider
 * to prevent an invoice from being marked paid).
 */
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/stripe";
import { getBrandingForUser } from "@/lib/branding";
import { renderPaymentReceipt } from "@/lib/email-receipt";
import {
  renderInvoicePdfToBuffer,
  buildPdfFilename,
  type PdfSettings,
} from "@/lib/pdf";

export interface SendReceiptOptions {
  invoiceId: string;
  /** Friendly payment method label ("Stripe", "Razorpay", "Manual", "UPI", etc.) */
  paymentMethod?: string | null;
  transactionId?: string | null;
}

export async function sendPaymentReceipt(opts: SendReceiptOptions): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) return false;
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: opts.invoiceId },
      include: { client: true, items: true, user: { include: { settings: true } } },
    });
    if (!invoice || !invoice.paidAt) return false;

    const settings = invoice.user.settings;
    const company = {
      name: settings?.companyName ?? invoice.user.name ?? "SmartBill",
      email: settings?.companyEmail ?? invoice.user.email,
      address: settings?.companyAddress ?? null,
      phone: settings?.companyPhone ?? null,
      currency: settings?.currency || "INR",
    };

    const siteUrl = getSiteUrl();
    const viewLink = `${siteUrl}/view/${invoice.id}`;
    const pdfLink = `${siteUrl}/api/public/invoices/${invoice.id}/pdf`;

    // Branding (logo + color). Use absolute URL for the email's <img src>.
    const branding = await getBrandingForUser(invoice.userId);
    const logoAbsUrl = branding.logoUrl
      ? (branding.logoUrl.startsWith("http") ? branding.logoUrl : `${siteUrl}${branding.logoUrl}`)
      : null;

    const { subject, html, text } = renderPaymentReceipt({
      companyName: company.name,
      companyEmail: company.email,
      companyAddress: company.address,
      companyPhone: company.phone,
      clientName: invoice.client.name,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      paidAt: invoice.paidAt,
      total: Number(invoice.totalAmount),
      currency: company.currency,
      viewLink,
      pdfLink,
      paymentMethod: opts.paymentMethod ?? null,
      transactionId: opts.transactionId ?? null,
      logoUrl: logoAbsUrl,
      brandColor: branding.brandColor,
    });

    // Attach the paid/stamped PDF (best-effort)
    let pdfBuffer: Buffer | null = null;
    try {
      const pdfSettings: PdfSettings = {
        companyName: company.name,
        companyEmail: company.email,
        companyAddress: company.address,
        companyPhone: company.phone,
        currency: company.currency,
        logoBase64: branding.logoData,
        logoContentType: branding.logoContentType,
        brandColor: branding.brandColor,
      };
      pdfBuffer = await renderInvoicePdfToBuffer({
        invoice,
        settings: pdfSettings,
        filename: buildPdfFilename(invoice.invoiceNumber),
      });
    } catch (err) {
      console.warn("[send-payment-receipt] PDF render failed:", err);
    }

    const fromEmail = process.env.FROM_EMAIL || `${company.name} <billing@smartbill.app>`;
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: [invoice.client.email],
      subject,
      html,
      text,
      tags: [
        { name: "invoiceId", value: invoice.id },
        { name: "invoiceNumber", value: invoice.invoiceNumber },
        { name: "userId", value: invoice.userId },
        { name: "variant", value: "receipt" },
      ],
      ...(pdfBuffer
        ? {
            attachments: [
              {
                filename: buildPdfFilename(invoice.invoiceNumber),
                content: pdfBuffer,
                contentType: "application/pdf",
              },
            ],
          }
        : {}),
    });

    if (error) {
      console.error("[send-payment-receipt] Resend error:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[send-payment-receipt] Failed:", err);
    return false;
  }
}
