/**
 * GET /api/public/track/open/:id  (Email open tracking pixel)
 *
 * Returns a 1x1 transparent GIF and records a VIEWED activity for the
 * invoice, but ONLY the first time per invoice per short window. This lets
 * merchants see that a client opened their invoice email without recording
 * a view every time their email client auto-loads images.
 *
 * Open to the public (no auth); invoice id is an unguessable CUID so no
 * tenant isolation issue — even if someone knows an invoice ID, they can
 * only register an extra "viewed" event which is harmless.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit, requestKey } from "@/lib/rate-limit";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";

// Tiny transparent GIF (43 bytes)
const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

// In-memory dedup: track which (invoiceId, client-ip-hash) pairs we've seen
// in the last hour to avoid logging a dozen views per email open (many email
// clients re-request images multiple times).
const recentViews = new Map<string, number>();
const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function cleanupOld() {
  const now = Date.now();
  for (const [k, t] of recentViews) {
    if (now - t > DEDUP_WINDOW_MS) recentViews.delete(k);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ type: string; id: string }> },
) {
  const { type, id } = await params;

  if (type !== "open") {
    return new NextResponse(null, { status: 404 });
  }

  // Tracking pixels should always return the image quickly.
  const rl = rateLimit(requestKey(request, `track-${id}`), {
    namespace: "track-open",
    limit: 30,
    windowSec: 60,
  });
  if (!rl.allowed) {
    return new NextResponse(TRANSPARENT_GIF, {
      status: 200,
      headers: {
        "Content-Type": "image/gif",
        "Content-Length": String(TRANSPARENT_GIF.length),
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        Pragma: "no-cache",
      },
    });
  }

  // Look up invoice
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, userId: true, invoiceNumber: true, status: true },
    });

    if (invoice) {
      // Dedupe by IP to avoid double-counting
      cleanupOld();
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
                 request.headers.get("x-real-ip") || "unknown";
      const key = `${id}:${ip}`;
      const now = Date.now();
      const last = recentViews.get(key);
      if (!last || now - last > DEDUP_WINDOW_MS) {
        recentViews.set(key, now);
        // Record VIEWED activity only if invoice is PENDING (not draft/paid to reduce noise)
        if (invoice.status === "PENDING") {
          // Fire-and-forget activity log — never let tracking errors break
          // the pixel response (we wrap in try/catch in the outer block).
          logActivity({
            invoiceId: invoice.id,
            userId: invoice.userId,
            type: "VIEWED",
            message: `Invoice opened via email pixel (${ip})`,
            ip,
            meta: { source: "email-open-pixel" },
          });
        }
      }
    }
  } catch {
    // Swallow errors — the pixel must always return.
  }

  return new NextResponse(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(TRANSPARENT_GIF.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, private",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}
