/**
 * Render a "Your client portal" invitation email with a secure link.
 */
import { DEFAULT_BRAND_COLOR } from "@/lib/branding";

export interface PortalInviteParams {
  companyName: string;
  companyEmail: string;
  clientName: string;
  portalLink: string;
  logoUrl?: string | null;
  brandColor?: string;
  /** Optional custom message added at the top of the email body. */
  message?: string | null;
}

export interface RenderedInvite {
  subject: string;
  html: string;
  text: string;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderPortalInviteEmail(p: PortalInviteParams): RenderedInvite {
  const brand =
    p.brandColor && /^#([0-9a-fA-F]{3}){1,2}$/.test(p.brandColor)
      ? p.brandColor
      : DEFAULT_BRAND_COLOR;

  const subject = `Your client portal for ${p.companyName}`;

  const logoHtml = p.logoUrl
    ? `<img src="${esc(p.logoUrl)}" alt="${esc(p.companyName)}" width="140" height="auto" style="display:block;max-height:56px;width:auto;max-width:180px;object-fit:contain;margin-bottom:8px;">`
    : `<div style="display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;background:${brand};color:#fff;font-weight:700;font-size:18px;margin-bottom:8px;">${esc(p.companyName.charAt(0).toUpperCase())}</div>`;

  const messageBlock = p.message
    ? `<p style="margin:14px 0 0;font-size:14px;line-height:1.55;">${esc(p.message)}</p>`
    : "";

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Inter,system-ui,sans-serif;color:#0f172a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);">
<tr><td style="background:${brand};padding:24px 32px;color:#fff;">
  ${logoHtml}
  <h1 style="margin:0;font-size:22px;font-weight:700;">Your Client Portal</h1>
  <p style="margin:6px 0 0;font-size:14px;opacity:.9;">${esc(p.companyName)}</p>
</td></tr>
<tr><td style="padding:28px 32px;">
  <p style="margin:0;font-size:15px;">Hi ${esc(p.clientName)},</p>
  <p style="margin:14px 0 0;font-size:14px;line-height:1.55;">We've set up a secure client portal where you can view all your invoices, download PDFs, and pay online at any time.</p>
  ${messageBlock}
</td></tr>
<tr><td style="padding:8px 32px 28px;text-align:center;">
  <a href="${esc(p.portalLink)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:15px;">Open Your Portal →</a>
  <p style="margin:12px 0 0;font-size:12px;color:#94a3b8;word-break:break-all;">Or copy this link into your browser:<br><a href="${esc(p.portalLink)}" style="color:${brand};text-decoration:underline;">${esc(p.portalLink)}</a></p>
  <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">This link is unique to you — please don't forward it. If you didn't expect this email, you can safely ignore it.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#f8fafc;text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;">
  <p style="margin:0;">Sent via SmartBill — © ${new Date().getFullYear()} ${esc(p.companyName)}</p>
  <p style="margin:4px 0 0;">${esc(p.companyEmail)}</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = `Hi ${p.clientName},

We've set up a secure client portal for you to view all your invoices, download PDFs, and pay online.
${p.message ? `\n${p.message}\n` : ""}
Open your portal: ${p.portalLink}

This link is unique to you — please don't forward it.

Thank you for your business!
— ${p.companyName}
${p.companyEmail}`;

  return { subject, html, text };
}
