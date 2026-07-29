/**
 * GET /api/public/logo?u=<userId> — serve a user's company logo as a binary
 * image. Public because email clients (Gmail, Outlook, Apple Mail) fetch
 * images without cookies/auth. The userId is not a secret — it's a CUID
 * visible on every public invoice link anyway.
 *
 * Optional ?invoiceId=<id> variant (preferred for public contexts) — we
 * look up the invoice owner to resolve the userId, so we don't leak which
 * userIds exist.
 *
 * Cache: 1 day in browser + 7 days in shared caches. Logos are mutable but
 * change rarely; when a user updates their logo they'll re-upload and we
 * add ?v=<timestamp> in Settings responses to bust caches.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const invoiceId = searchParams.get("invoiceId");
    const qUserId = searchParams.get("u");
    const v = searchParams.get("v"); // cache-buster (updatedAt epoch ms)

    let userId: string | null = null;
    if (invoiceId) {
      const inv = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { userId: true },
      });
      if (inv) userId = inv.userId;
    } else if (qUserId) {
      userId = qUserId;
    }

    if (!userId) {
      return new Response(null, { status: 404 });
    }

    const settings = await prisma.settings.findUnique({
      where: { userId },
      select: { logoData: true, logoContentType: true, updatedAt: true },
    });

    if (!settings?.logoData || !settings.logoContentType) {
      return new Response(null, { status: 404 });
    }

    const buf = Buffer.from(settings.logoData, "base64");
    const etag = `"logo-${settings.updatedAt.getTime().toString(36)}-${buf.length.toString(36)}"`;

    const headers = new Headers({
      "Content-Type": settings.logoContentType,
      "Content-Length": String(buf.length),
      "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    });

    // If the browser sends If-None-Match that matches our etag, 304.
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === `W/${etag}`)) {
      return new Response(null, { status: 304, headers });
    }

    if (v) headers.set("X-Cache-Buster", v);
    return new Response(buf, { status: 200, headers });
  } catch (error) {
    console.error("[GET /api/public/logo]", error);
    return new Response(null, { status: 500 });
  }
}
