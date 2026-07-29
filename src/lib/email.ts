/**
 * Shared email rendering helpers for invoice emails (initial send + reminders).
 *
 * Keeping HTML/text templates in one place ensures the Send and Remind
 * flows stay visually consistent and makes future template tweaks easy.
 */
import { formatMoney } from "@/lib/format-money";
import { formatDate } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ItemRow {
  description: string;
  quantity: number;
  price: number;
  total: number;
}

export interface InvoiceEmailParams {
  variant: "new" | "reminder";
  companyName: string;
  companyEmail: string;
  companyAddress?: string | null;
  companyPhone?: string | null;
  clientName: string;
  invoiceNumber: string;
  issueDate: Date | string;
  dueDate: Date | string;
  subtotal: number;
  taxRate: number;
  taxLabel?: string;
  taxAmount: number;
  discountAmount?: number;
  total: number;
  currency: string;
  items: ItemRow[];
  viewLink: string;
  pdfLink?: string;
  /** Optional URL to the client portal showing all their invoices. */
  portalLink?: string | null;
  personalMessage?: string;
  /** How many days overdue (only set for variant="reminder"). */
  daysOverdue?: number;
  /** 1-indexed reminder count (1st reminder, 2nd, ...). */
  reminderNumber?: number;
  /** Optional absolute URL to the company logo (publicly fetchable). */
  logoUrl?: string | null;
  /** Hex brand color used for CTA + top banner. Default #2563eb. */
  brandColor?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Public render function
// ---------------------------------------------------------------------------

export function renderInvoiceEmail(p: InvoiceEmailParams): RenderedEmail {
  const issue = typeof p.issueDate === "string" ? p.issueDate : formatDate(p.issueDate);
  const due = typeof p.dueDate === "string" ? p.dueDate : formatDate(p.dueDate);
  const totalStr = fmt(p.total, p.currency);
  const isReminder = p.variant === "reminder";

  const subject = isReminder
    ? p.daysOverdue && p.daysOverdue > 0
      ? `Reminder: Invoice ${p.invoiceNumber} (${totalStr}) is ${p.daysOverdue} day${p.daysOverdue === 1 ? "" : "s"} overdue`
      : `Reminder: Invoice ${p.invoiceNumber} (${totalStr}) due ${due}`
    : `Invoice ${p.invoiceNumber} from ${p.companyName} — ${totalStr} due ${due}`;

  return {
    subject,
    html: buildHtml({ ...p, issueDateStr: issue, dueDateStr: due, totalStr }),
    text: buildText({ ...p, issueDateStr: issue, dueDateStr: due, totalStr }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract invoice ID from a view link like "https://.../view/<cuid>" and
 * produce the absolute URL of the tracking pixel for that invoice.
 */
function trackPixelUrl(viewLink: string): string {
  try {
    const url = new URL(viewLink);
    const m = url.pathname.match(/\/view\/([^/]+)$/);
    if (!m) return "";
    return `${url.origin}/api/public/track/open/${m[1]}`;
  } catch {
    return "";
  }
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(v: number, c: string): string {
  return formatMoney(v, c);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

interface Internal extends Omit<InvoiceEmailParams, "issueDate" | "dueDate"> {
  issueDateStr: string;
  dueDateStr: string;
  totalStr: string;
}

function buildHtml(p: Internal): string {
  const isReminder = p.variant === "reminder";
  const defaultAccent = "#2563eb";
  const brand = p.brandColor && /^#([0-9a-fA-F]{3}){1,2}$/.test(p.brandColor) ? p.brandColor : defaultAccent;
  const accent = isReminder ? "#dc2626" : brand; // red for overdue reminders; otherwise brand color
  const title = isReminder ? "Payment Reminder" : "New Invoice";
  const ctaLabel = isReminder ? "Pay Now →" : "View & Pay Invoice →";
  const ctaBg = isReminder ? "#16a34a" : accent; // green pay-now on reminders, brand otherwise
  const logoHtml = p.logoUrl
    ? `<img src="${esc(p.logoUrl)}" alt="${esc(p.companyName)}" width="140" height="auto" style="display:block;max-height:56px;width:auto;max-width:180px;object-fit:contain;margin-bottom:8px;">`
    : `<div style="display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;background:${accent};color:#fff;font-weight:700;font-size:18px;margin-bottom:8px;">${esc(p.companyName.charAt(0).toUpperCase())}</div>`;

  const daysBadge =
    isReminder && p.daysOverdue && p.daysOverdue > 0
      ? `<tr><td style="padding:0 32px 8px;">
           <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;">
             <tr><td style="padding:12px 16px;font-size:14px;color:#991b1b;">
               <strong>This invoice is ${p.daysOverdue} day${p.daysOverdue === 1 ? "" : "s"} overdue.</strong> Please submit payment at your earliest convenience.
             </td></tr>
           </table>
         </td></tr>`
      : "";

  const greeting = isReminder
    ? `<p style="margin:0;font-size:15px;">Hi ${esc(p.clientName)},</p>
       <p style="margin:12px 0 0;font-size:14px;line-height:1.5;">This is a friendly reminder that payment for invoice <strong>${esc(p.invoiceNumber)}</strong> has not yet been received.</p>`
    : `<p style="margin:0;font-size:15px;">Hi ${esc(p.clientName)},</p>
       <p style="margin:14px 0 0;font-size:14px;line-height:1.5;">You have a new invoice with the following details:</p>`;

  const personalBlock = p.personalMessage
    ? `<p style="margin:12px 0 0;font-size:14px;line-height:1.5;">${esc(p.personalMessage)}</p>`
    : "";

  const rows = p.items
    .map(
      (i) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;">${esc(i.description)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:center;">${i.quantity}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;">${fmt(i.price, p.currency)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${fmt(i.total, p.currency)}</td>
    </tr>`
    )
    .join("");

  const companyAddressBlock = p.companyAddress
    ? `<p style="margin:4px 0 0;font-size:13px;color:#64748b;white-space:pre-line;">${esc(p.companyAddress)}</p>`
    : "";
  const companyPhoneBlock = p.companyPhone
    ? `<p style="margin:4px 0 0;font-size:13px;color:#64748b;">${esc(p.companyPhone)}</p>`
    : "";

  const pdfLinkBlock = p.pdfLink
    ? `&nbsp;·&nbsp; <a href="${esc(p.pdfLink)}" style="color:${accent};text-decoration:underline;">Download PDF</a>`
    : "";
  const portalLinkBlock = p.portalLink
    ? `<p style="margin:14px 0 0;font-size:12px;color:#64748b;text-align:center;">
         <a href="${esc(p.portalLink)}" style="color:${accent};text-decoration:underline;font-weight:500;">View all invoices & pay online →</a>
       </p>`
    : "";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Inter,system-ui,sans-serif;color:#0f172a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);">
<tr><td style="background:${accent};padding:24px 32px;color:#fff;">
  ${logoHtml}
  <h1 style="margin:0;font-size:22px;font-weight:700;">${title} — ${esc(p.invoiceNumber)}</h1>
  <p style="margin:6px 0 0;font-size:14px;opacity:.9;">From ${esc(p.companyName)}</p>
</td></tr>
<tr><td style="padding:28px 32px 0;">
  ${greeting}
  ${personalBlock}
</td></tr>
${daysBadge}
<tr><td style="padding:12px 32px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;">
    <tr>
      <td style="padding:14px 16px;"><p style="margin:0;font-size:12px;text-transform:uppercase;color:#64748b;letter-spacing:.05em;">From</p><p style="margin:4px 0 0;font-weight:600;">${esc(p.companyName)}</p><p style="margin:4px 0 0;font-size:13px;">${esc(p.companyEmail)}</p>${companyAddressBlock}${companyPhoneBlock}</td>
      <td style="padding:14px 16px;"><p style="margin:0;font-size:12px;text-transform:uppercase;color:#64748b;letter-spacing:.05em;">Invoice #</p><p style="margin:4px 0 0;font-weight:600;">${esc(p.invoiceNumber)}</p></td>
      <td style="padding:14px 16px;"><p style="margin:0;font-size:12px;text-transform:uppercase;color:#64748b;letter-spacing:.05em;">Issued</p><p style="margin:4px 0 0;">${p.issueDateStr}</p></td>
      <td style="padding:14px 16px;"><p style="margin:0;font-size:12px;text-transform:uppercase;color:#64748b;letter-spacing:.05em;">Due</p><p style="margin:4px 0 0;font-weight:600;color:#b45309;">${p.dueDateStr}</p></td>
    </tr>
  </table>
</td></tr>
<tr><td style="padding:12px 32px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;">
    <thead><tr style="background:#f1f5f9;">
      <th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#64748b;letter-spacing:.05em;">Description</th>
      <th style="padding:10px 12px;text-align:center;font-size:12px;text-transform:uppercase;color:#64748b;letter-spacing:.05em;">Qty</th>
      <th style="padding:10px 12px;text-align:right;font-size:12px;text-transform:uppercase;color:#64748b;letter-spacing:.05em;">Price</th>
      <th style="padding:10px 12px;text-align:right;font-size:12px;text-transform:uppercase;color:#64748b;letter-spacing:.05em;">Total</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr><td colspan="3" style="padding:10px 12px;text-align:right;border-top:2px solid #e2e8f0;color:#64748b;">Subtotal</td><td style="padding:10px 12px;text-align:right;border-top:2px solid #e2e8f0;">${fmt(p.subtotal, p.currency)}</td></tr>
      ${(p.discountAmount ?? 0) > 0
        ? `<tr><td colspan="3" style="padding:10px 12px;text-align:right;color:#059669;">Discount</td><td style="padding:10px 12px;text-align:right;color:#059669;">−${fmt(p.discountAmount ?? 0, p.currency)}</td></tr>`
        : ""}
      <tr><td colspan="3" style="padding:10px 12px;text-align:right;color:#64748b;">${(p.taxLabel || "GST").toUpperCase()} (${p.taxRate}%)</td><td style="padding:10px 12px;text-align:right;">${fmt(p.taxAmount, p.currency)}</td></tr>
      <tr style="background:#eff6ff;"><td colspan="3" style="padding:12px;text-align:right;font-weight:700;color:#1e40af;">Total Due</td><td style="padding:12px;text-align:right;font-weight:700;font-size:16px;color:#1e40af;">${p.totalStr}</td></tr>
    </tfoot>
  </table>
</td></tr>
<tr><td style="padding:16px 32px 24px;text-align:center;">
  <a href="${p.viewLink}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:${ctaBg};color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:15px;">${ctaLabel}</a>
  <p style="margin:10px 0 0;font-size:12px;color:#94a3b8;">Or view online: <a href="${esc(p.viewLink)}" style="color:${accent};text-decoration:underline;">${esc(p.viewLink)}</a>${pdfLinkBlock}</p>
  ${portalLinkBlock}
</td></tr>
<tr><td style="padding:20px 32px;background:#f8fafc;text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;">
  <p style="margin:0;">Thank you for your business!</p>
  <p style="margin:6px 0 0;">Sent via SmartBill — © ${new Date().getFullYear()} ${esc(p.companyName)}</p>
</td></tr>
</table>
</td></tr></table>
<img src="${trackPixelUrl(p.viewLink)}" alt="" width="1" height="1" style="display:none;width:1px;height:1px;border:0;" />
</body></html>`;
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

function buildText(p: Internal): string {
  const isReminder = p.variant === "reminder";
  const intro = isReminder
    ? `Hi ${p.clientName},\n\nThis is a friendly reminder that payment for invoice ${p.invoiceNumber} from ${p.companyName} has not yet been received.${
        p.daysOverdue && p.daysOverdue > 0
          ? `\n\nThis invoice is ${p.daysOverdue} day${p.daysOverdue === 1 ? "" : "s"} overdue.`
          : ""
      }`
    : `Hi ${p.clientName},\n\nYou have a new invoice (${p.invoiceNumber}) from ${p.companyName}.`;

  const discountLine =
    (p.discountAmount ?? 0) > 0
      ? `Discount:   −${fmt(p.discountAmount ?? 0, p.currency)}\n`
      : "";

  return `${intro}

Issue date: ${p.issueDateStr}
Due date:   ${p.dueDateStr}
Subtotal:   ${fmt(p.subtotal, p.currency)}
${discountLine}${(p.taxLabel || "GST").toUpperCase()}:        ${fmt(p.taxAmount, p.currency)}
Total due:  ${p.totalStr}
${p.personalMessage ? `\n${p.personalMessage}\n` : ""}
View online: ${p.viewLink}${p.pdfLink ? `\nDownload PDF: ${p.pdfLink}` : ""}${p.portalLink ? `\nAll invoices: ${p.portalLink}` : ""}

Thank you for your business!
— ${p.companyName}`;
}
