/**
 * GET /api/public/portal?token=<portalToken>
 *
 * Public (unauthenticated) endpoint for the client-facing portal page.
 * Given a portalToken (a non-guessable CUID stored on the Client), returns
 * the client's info + all of their invoices (with items), totals, and the
 * merchant's branding/payment config.
 *
 * Rate limited per IP to prevent token enumeration.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripeConfigured } from "@/lib/stripe";
import { razorpayConfigured, getRazorpayKeyId } from "@/lib/razorpay";
import { DEFAULT_BRAND_COLOR } from "@/lib/branding";
import { checkRateLimit, requestKey } from "@/lib/rate-limiter";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");

  // Rate limit: 60/min/IP — prevents brute-force token guessing while letting
  // legitimate clients refresh freely.
  const rl = await checkRateLimit(requestKey(request, "portal"), {
    namespace: "public-portal",
    limit: 60,
    windowSec: 60,
  });
  if (!rl.allowed) {
      return rl.toResponse('Too many requests.');
    }

  if (!token || typeof token !== "string" || token.length < 6) {
    return NextResponse.json({ error: "Invalid portal link" }, { status: 400 });
  }

  try {
    const client = await prisma.client.findUnique({
      where: { portalToken: token },
      include: {
        user: {
          include: {
            settings: true,
          },
        },
        invoices: {
          where: { status: { in: ["PENDING", "PAID"] } },
          orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
          include: { items: { orderBy: { id: "asc" } } },
        },
      },
    });

    if (!client) {
      return NextResponse.json({ error: "Portal not found" }, { status: 404 });
    }

    const s = client.user.settings;
    const currency = s?.currency || "INR";
    const brandColor = s?.brandColor && /^#([0-9a-fA-F]{3}){1,2}$/.test(s.brandColor)
      ? s.brandColor
      : DEFAULT_BRAND_COLOR;

    // Totals
    const totalBilled = client.invoices.reduce((sum, inv) => sum + Number(inv.totalAmount), 0);
    const totalPaid = client.invoices
      .filter((i) => i.status === "PAID")
      .reduce((sum, inv) => sum + Number(inv.totalAmount), 0);
    const overdue = client.invoices.filter((i) => {
      if (i.status !== "PENDING") return false;
      const due = new Date(i.dueDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return due < today;
    });
    const overdueAmount = overdue.reduce((sum, inv) => sum + Number(inv.totalAmount), 0);
    const openAmount = client.invoices
      .filter((i) => i.status === "PENDING")
      .reduce((sum, inv) => sum + Number(inv.totalAmount), 0);

    const logoUrl = s?.logoData && s?.logoContentType
      ? `/api/public/logo?u=${encodeURIComponent(client.userId)}&v=${s.updatedAt.getTime()}`
      : null;

    return NextResponse.json({
      client: {
        id: client.id,
        name: client.name,
        email: client.email,
        phone: client.phone,
        address: client.address,
      },
      company: {
        name: s?.companyName || client.user.name || "Your Business Name",
        email: s?.companyEmail || client.user.email,
        phone: s?.companyPhone ?? null,
        address: s?.companyAddress ?? null,
        currency,
        brandColor,
        logoUrl,
      },
      invoices: client.invoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        subtotal: Number(inv.subtotal),
        discountAmount: Number(inv.discountAmount ?? 0),
        taxRate: Number(inv.taxRate),
        taxLabel: (inv as { taxLabel?: string }).taxLabel ?? "GST",
        totalAmount: Number(inv.totalAmount),
        paidAt: inv.paidAt,
      })),
      payments: {
        stripe: stripeConfigured(),
        razorpay: razorpayConfigured(),
        razorpayKeyId: getRazorpayKeyId(),
      },
      summary: {
        totalBilled,
        totalPaid,
        openAmount,
        overdueAmount,
        overdueCount: overdue.length,
        invoiceCount: client.invoices.length,
      },
    });
  } catch (err) {
    console.error("[GET /api/public/portal]", err);
    return NextResponse.json({ error: "Failed to load portal" }, { status: 500 });
  }
}
