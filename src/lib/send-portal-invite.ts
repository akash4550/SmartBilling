/**
 * Send a portal invite email (no attachments, lightweight) via Resend.
 */
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/stripe";
import { DEFAULT_BRAND_COLOR } from "@/lib/branding";
import { renderPortalInviteEmail } from "@/lib/email-portal-invite";

interface SendPortalInviteOptions {
  clientId: string;
  /** Absolute portal URL (the caller is expected to pass the already-built
   *  URL, which includes the current portalToken). */
  portalLink: string;
  /** Optional custom message from the admin. */
  message?: string | null;
}

interface SendResult {
  success: boolean;
  error?: string;
}

export async function sendPortalInviteEmail(
  opts: SendPortalInviteOptions
): Promise<SendResult> {
  if (!process.env.RESEND_API_KEY) {
    return { success: false, error: "Resend API key not configured" };
  }

  const client = await prisma.client.findUnique({
    where: { id: opts.clientId },
    include: { user: { include: { settings: true } } },
  });
  if (!client) return { success: false, error: "Client not found" };
  if (!client.email) return { success: false, error: "Client has no email address" };

  const s = client.user.settings;
  const companyName = s?.companyName || client.user.name || "Your Business Name";
  const companyEmail = s?.companyEmail || client.user.email || "billing@example.com";
  const brandColor =
    s?.brandColor && /^#([0-9a-fA-F]{3}){1,2}$/.test(s.brandColor)
      ? s.brandColor
      : DEFAULT_BRAND_COLOR;
  const siteUrl = getSiteUrl();
  const logoUrl = s?.logoData && s?.logoContentType
    ? `${siteUrl.replace(/\/$/, "")}/api/public/logo?u=${encodeURIComponent(client.userId)}&v=${s.updatedAt.getTime()}`
    : null;

  const fromEmail = process.env.FROM_EMAIL || `${companyName} <billing@smartbill.app>`;

  const { subject, html, text } = renderPortalInviteEmail({
    companyName,
    companyEmail,
    clientName: client.name,
    portalLink: opts.portalLink,
    logoUrl,
    brandColor,
    message: opts.message,
  });

  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: fromEmail,
    to: client.email,
    subject,
    html,
    text,
    tags: [
      { name: "type", value: "portal-invite" },
      { name: "clientId", value: client.id },
    ],
  });

  if (error) {
    console.error("[send-portal-invite] Resend error:", error);
    return {
      success: false,
      error: typeof error.message === "string" ? error.message : "Failed to send invite email",
    };
  }
  return { success: true };
}
