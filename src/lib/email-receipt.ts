/**
 * Payment receipt email — sent automatically when an invoice transitions to PAID.
 * Reuses the same brand styling family as the new/reminder emails but uses a
 * green "thank you" banner so clients clearly recognise a confirmation.
 */
import { formatMoney } from "@/lib/format-money";
import { formatDate } from "@/lib/utils";

export interface ReceiptEmailParams {
  companyName: string;
  companyEmail: string;
  companyAddress?: string | null;
  companyPhone?: string | null;
  clientName: string;
  invoiceNumber: string;
  issueDate: Date | string;
  paidAt: Date | string;
  total: number;
  currency: string;
  viewLink: string;
  pdfLink?: string;
  paymentMethod?: string | null;
  transactionId?: string | null;
  /** Optional absolute URL to company logo. */
  logoUrl?: string | null;
  /** Hex brand color used for the thank-you banner. Defaults to emerald #10b981. */
  brandColor?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderPaymentReceipt(p: ReceiptEmailParams): RenderedEmail {
  const subject = `Payment receipt — ${p.invoiceNumber} (${formatMoney(p.total, p.currency)})`;
  const paidOn = formatDate(p.paidAt);
  const method = p.paymentMethod ? `<tr><td style="padding:4px 0;color:#64748b;font-size:13px;">Payment method</td><td style="padding:4px 0;text-align:right;font-weight:500;font-size:13px;">${escapeHtml(p.paymentMethod)}</td></tr>` : "";
  const tx = p.transactionId ? `<tr><td style="padding:4px 0;color:#64748b;font-size:13px;">Transaction ID</td><td style="padding:4px 0;text-align:right;font-family:ui-monospace,monospace;font-size:12px;">${escapeHtml(p.transactionId)}</td></tr>` : "";

  // Receipt uses a green success banner (classic "paid" affordance) but
  // respects the user's brand color as a subtle fallback accent in the
  // links / view button if provided.
  const brand = p.brandColor && /^#([0-9a-fA-F]{3}){1,2}$/.test(p.brandColor) ? p.brandColor : "#2563eb";
  const logoHtml = p.logoUrl
    ? `<img src="${escapeHtml(p.logoUrl)}" alt="${escapeHtml(p.companyName)}" width="120" height="auto" style="display:block;max-height:48px;width:auto;max-width:160px;object-fit:contain;margin-bottom:10px;filter:brightness(0) invert(1);">`
    : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background-color:#f1f5f9;font-family:system-ui,-apple-system,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 0;">
<tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.06);">
  <tr><td style="background:linear-gradient(135deg,#10b981,#059669);padding:28px 36px;color:#fff;">
    ${logoHtml}
    <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:0.9;margin-bottom:6px;">Payment received</div>
    <h1 style="margin:0;font-size:24px;">Thank you, ${escapeHtml(p.clientName)}!</h1>
  </td></tr>
  <tr><td style="padding:32px 36px;color:#0f172a;font-size:15px;line-height:1.6;">
    <p style="margin:0 0 20px;">We've received your payment for invoice <strong>${escapeHtml(p.invoiceNumber)}</strong>. This email is your receipt — please keep it for your records.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;padding:16px 20px;border:1px solid #e2e8f0;">
      <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Invoice #</td><td style="padding:6px 0;text-align:right;font-weight:600;font-size:13px;">${escapeHtml(p.invoiceNumber)}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b;font-size:13px;">Amount paid</td><td style="padding:4px 0;text-align:right;font-weight:700;font-size:18px;color:#059669;">${formatMoney(p.total, p.currency)}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b;font-size:13px;">Paid on</td><td style="padding:4px 0;text-align:right;font-weight:500;font-size:13px;">${paidOn}</td></tr>
      ${method}
      ${tx}
    </table>
    <p style="margin:24px 0 0;font-size:13px;color:#64748b;">
      <a href="${p.viewLink}" style="color:${brand};text-decoration:none;">View invoice online</a>
      ${p.pdfLink ? `&nbsp;·&nbsp; <a href="${p.pdfLink}" style="color:${brand};text-decoration:none;">Download PDF</a>` : ""}
    </p>
  </td></tr>
  <tr><td style="padding:20px 36px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.5;">
    <p style="margin:0 0 4px;font-weight:600;color:#0f172a;font-size:13px;">${escapeHtml(p.companyName)}</p>
    ${p.companyAddress ? `<p style="margin:0 0 2px;">${escapeHtml(p.companyAddress).replace(/\n/g, "<br>")}</p>` : ""}
    ${p.companyEmail ? `<p style="margin:0 0 2px;">${escapeHtml(p.companyEmail)}</p>` : ""}
    ${p.companyPhone ? `<p style="margin:0;">${escapeHtml(p.companyPhone)}</p>` : ""}
  </td></tr>
</table></td></tr></table></body></html>`;

  const lines = [
    `Payment receipt — ${p.invoiceNumber}`,
    ``,
    `Hi ${p.clientName},`,
    ``,
    `We've received your payment. Thank you!`,
    ``,
    `  Invoice:      ${p.invoiceNumber}`,
    `  Amount paid:  ${formatMoney(p.total, p.currency)}`,
    `  Paid on:      ${paidOn}`,
    p.paymentMethod ? `  Method:       ${p.paymentMethod}` : "",
    p.transactionId ? `  Transaction:  ${p.transactionId}` : "",
    ``,
    `View online: ${p.viewLink}`,
    p.pdfLink ? `Download PDF: ${p.pdfLink}` : "",
    ``,
    `— ${p.companyName}${p.companyEmail ? ` <${p.companyEmail}>` : ""}`,
  ].filter((l) => l !== null);
  const text = lines.join("\n");

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
