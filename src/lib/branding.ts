/**
 * Branding helpers — company logo + brand color resolution with safe
 * defaults. Centralised so the PDF renderer, email templates, public
 * portal, and admin UI all stay consistent.
 */
import { prisma } from "@/lib/prisma";

export const DEFAULT_BRAND_COLOR = "#2563eb";
export const MAX_LOGO_PDF_HEIGHT = 56; // points (1 point ≈ 1.33 px)
export const MAX_LOGO_PDF_WIDTH = 170;

export interface Branding {
  logoData: string | null; // base64 (without data: prefix)
  logoContentType: string | null; // e.g. "image/png"
  logoDataUri: string | null; // full data: URI for <img src> usage
  logoUrl: string | null; // public route URL (for <img src> / emails)
  brandColor: string; // hex like "#2563eb"
}

/**
 * Resolve branding for a user — logo (data URI for PDFs, public URL for
 * emails/HTML) and accent color. Falls back to no-logo + default blue if
 * the user has no settings row yet.
 */
export async function getBrandingForUser(userId: string): Promise<Branding> {
  const s = await prisma.settings.findUnique({
    where: { userId },
    select: { logoData: true, logoContentType: true, brandColor: true, updatedAt: true },
  });

  const hasLogo = !!(s?.logoData && s.logoContentType);
  return {
    logoData: s?.logoData ?? null,
    logoContentType: s?.logoContentType ?? null,
    logoDataUri: hasLogo ? `data:${s!.logoContentType};base64,${s!.logoData}` : null,
    logoUrl: hasLogo ? `/api/public/logo?u=${encodeURIComponent(userId)}&v=${s!.updatedAt.getTime()}` : null,
    brandColor: s?.brandColor || DEFAULT_BRAND_COLOR,
  };
}

/**
 * Resolve branding for a public invoice (by invoiceId). Returns the logoUrl
 * (public route) and brandColor; does NOT return the base64 to avoid
 * bloating public responses.
 */
export async function getPublicBrandingForInvoice(
  userId: string
): Promise<{ logoUrl: string | null; brandColor: string }> {
  const b = await getBrandingForUser(userId);
  return { logoUrl: b.logoUrl, brandColor: b.brandColor };
}

/** Darken a hex color by a factor (0..1) — used for PDF accent gradient. */
export function darken(hex: string, factor = 0.18): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = Math.max(0, Math.min(255, Math.round(parseInt(full.slice(0, 2), 16) * (1 - factor))));
  const g = Math.max(0, Math.min(255, Math.round(parseInt(full.slice(2, 4), 16) * (1 - factor))));
  const b = Math.max(0, Math.min(255, Math.round(parseInt(full.slice(4, 6), 16) * (1 - factor))));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Lighten a hex color. */
export function lighten(hex: string, factor = 0.85): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = Math.round(255 - (255 - parseInt(full.slice(0, 2), 16)) * (1 - factor));
  const g = Math.round(255 - (255 - parseInt(full.slice(2, 4), 16)) * (1 - factor));
  const b = Math.round(255 - (255 - parseInt(full.slice(4, 6), 16)) * (1 - factor));
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
