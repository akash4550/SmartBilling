import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripeConfigured } from "@/lib/stripe";
import { razorpayConfigured, getRazorpayKeyId } from "@/lib/razorpay";
import { DEFAULT_BRAND_COLOR } from "@/lib/branding";

/**
 * GET /api/public/settings?invoiceId=<id>
 *
 * Public (unauthenticated) endpoint used by the client-facing invoice
 * portal (/view/:id) to render company branding (name, email, phone,
 * address, currency, logo, accent color) plus which payment gateways are
 * available.
 *
 * The settings are scoped to the owner of the given invoice, so every
 * tenant's public invoices show their own branding. An invoice ID is
 * required to prevent leaking cross-tenant data; if missing or invalid
 * we return neutral defaults.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const invoiceId = searchParams.get("invoiceId");

  // Site-wide payment gateway configuration (env based; same across tenants
  // since the deployment owns the gateway keys).
  const payments = {
    stripe: stripeConfigured(),
    razorpay: razorpayConfigured(),
    razorpayKeyId: getRazorpayKeyId(),
  };

  const fallback = {
    companyName: "Your Business Name",
    companyEmail: "billing@example.com",
    companyPhone: null as string | null,
    companyAddress: null as string | null,
    currency: "INR",
    logoUrl: null as string | null,
    brandColor: DEFAULT_BRAND_COLOR,
    payments,
  };

  try {
    if (!invoiceId) {
      return NextResponse.json(fallback, { status: 200 });
    }

    // Find the invoice, then load the owner's settings (via userId on invoice).
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { userId: true },
    });
    if (!invoice) {
      return NextResponse.json(fallback, { status: 200 });
    }

    const settings = await prisma.settings.upsert({
      where: { userId: invoice.userId },
      update: {},
      create: { userId: invoice.userId },
      select: {
        companyName: true,
        companyEmail: true,
        companyPhone: true,
        companyAddress: true,
        currency: true,
        logoData: true,
        logoContentType: true,
        brandColor: true,
        updatedAt: true,
      },
    });

    const logoUrl = settings.logoData && settings.logoContentType
      ? `/api/public/logo?invoiceId=${encodeURIComponent(invoiceId)}&v=${settings.updatedAt.getTime()}`
      : null;

    return NextResponse.json(
      {
        companyName: settings.companyName,
        companyEmail: settings.companyEmail,
        companyPhone: settings.companyPhone,
        companyAddress: settings.companyAddress,
        currency: settings.currency,
        logoUrl,
        brandColor: settings.brandColor || DEFAULT_BRAND_COLOR,
        payments,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[GET /api/public/settings]", error);
    return NextResponse.json(fallback, { status: 200 });
  }
}
