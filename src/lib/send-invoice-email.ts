/**
 * Shared helper: render invoice email + attach PDF and send via Resend.
 *
 * Used by the send route, remind route, and recurring cron. Centralises the
 * PDF-attachment logic so all three code paths attach the branded PDF
 * consistently and gracefully degrade if rendering fails.
 */
import { Resend } from "resend";
import type { InvoiceEmailParams } from "@/lib/email";
import { renderInvoiceEmail } from "@/lib/email";
import { renderInvoicePdfToBuffer, buildPdfFilename, type PdfSettings } from "@/lib/pdf";
import type { InvoiceWithRelations } from "@/types";

export interface SendInvoiceEmailInput {
  /** Invoice (with items + client) and company settings used to render both the email and PDF. */
  invoice: InvoiceWithRelations;
  settings: {
    companyName: string;
    companyEmail: string;
    companyAddress?: string | null;
    companyPhone?: string | null;
    currency: string;
    logoUrl?: string | null; // absolute public URL to the logo (for emails)
    logoBase64?: string | null;
    logoContentType?: string | null;
    brandColor?: string | null;
  };
  /** Recipient email(s). */
  to: string | string[];
  from: string;
  /** Email params minus the company/client/amount fields we derive from invoice+settings. */
  variant: "new" | "reminder";
  viewLink: string;
  pdfLink: string;
  /** Optional absolute URL to the client portal (listing all their invoices). */
  portalLink?: string | null;
  personalMessage?: string;
  daysOverdue?: number;
  reminderNumber?: number;
}

export interface SendResult {
  messageId?: string;
  error?: string;
  pdfAttached: boolean;
}

export async function sendInvoiceEmail(input: SendInvoiceEmailInput): Promise<SendResult> {
  if (!process.env.RESEND_API_KEY) {
    return { error: "Resend API key not configured", pdfAttached: false };
  }

  const { invoice, settings } = input;
  const subtotal = Number(invoice.subtotal);
  const taxRate = Number(invoice.taxRate);
  const discInv = invoice as unknown as { discountAmount?: number | null; taxLabel?: string | null };
  const discountAmount = discInv.discountAmount != null ? Number(discInv.discountAmount) : 0;
  const taxLabel = (discInv.taxLabel && discInv.taxLabel.trim() ? discInv.taxLabel : "GST").toUpperCase();
  const net = Math.max(0, subtotal - (Number.isFinite(discountAmount) ? discountAmount : 0));
  const taxAmount = (net * taxRate) / 100;
  const total = Number(invoice.totalAmount);

  const params: InvoiceEmailParams = {
    variant: input.variant,
    companyName: settings.companyName,
    companyEmail: settings.companyEmail,
    companyAddress: settings.companyAddress ?? null,
    companyPhone: settings.companyPhone ?? null,
    clientName: invoice.client.name,
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    subtotal,
    taxRate,
    taxLabel,
    taxAmount,
    discountAmount,
    total,
    currency: settings.currency,
    items: invoice.items.map((i) => ({
      description: i.description,
      quantity: i.quantity,
      price: Number(i.price),
      total: Number(i.total),
    })),
    viewLink: input.viewLink,
    pdfLink: input.pdfLink,
    portalLink: input.portalLink ?? null,
    personalMessage: input.personalMessage,
    daysOverdue: input.daysOverdue,
    reminderNumber: input.reminderNumber,
    logoUrl: settings.logoUrl ?? null,
    brandColor: settings.brandColor ?? undefined,
  };

  const { subject, html, text } = renderInvoiceEmail(params);

  // Render PDF attachment (best-effort).
  let pdfBuffer: Buffer | null = null;
  try {
    const pdfSettings: PdfSettings = {
      companyName: settings.companyName,
      companyEmail: settings.companyEmail,
      companyAddress: settings.companyAddress ?? null,
      companyPhone: settings.companyPhone ?? null,
      currency: settings.currency,
      logoBase64: settings.logoBase64 ?? null,
      logoContentType: settings.logoContentType ?? null,
      brandColor: settings.brandColor ?? undefined,
    };
    pdfBuffer = await renderInvoicePdfToBuffer({
      invoice,
      settings: pdfSettings,
      filename: buildPdfFilename(invoice.invoiceNumber),
    });
  } catch (err) {
    console.warn("[send-invoice-email] PDF render failed, sending without attachment:", err);
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: input.from,
    to: Array.isArray(input.to) ? input.to : [input.to],
    subject,
    html,
    text,
    tags: [
      { name: "invoiceId", value: invoice.id },
      { name: "invoiceNumber", value: invoice.invoiceNumber },
      { name: "userId", value: invoice.userId },
      { name: "variant", value: input.variant },
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
    return { error: error.message, pdfAttached: !!pdfBuffer };
  }
  return { messageId: data?.id, pdfAttached: !!pdfBuffer };
}
