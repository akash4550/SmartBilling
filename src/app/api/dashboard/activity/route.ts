/**
 * GET /api/dashboard/activity?limit=N
 *
 * Returns the most recent invoice activity entries for the current user,
 * joined with the invoice (for invoice number) and client (for client name).
 * Used by the dashboard "Recent Activity" feed.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit, requestKey } from "@/lib/rate-limit";

export const runtime = "nodejs";

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  CREATED: "created",
  EDITED: "edited",
  SENT: "sent to client",
  REMINDED: "reminder sent for",
  VIEWED: "viewed by client",
  PAID: "payment received for",
  PAYMENT_FAILED: "payment failed for",
  MARKED_PAID: "marked as paid",
  PDF_DOWNLOADED: "PDF downloaded for",
  DELETED: "deleted",
  RECURRING_GENERATED: "auto-generated from recurring",
};

function formatRelative(iso: Date | string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
  }).format(d);
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const rl = rateLimit(requestKey(request, `dash-act:${userId}`), {
    namespace: "dash-activity",
    limit: 60,
    windowSec: 60,
  });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || "10")));

  try {
    const activities = await prisma.invoiceActivity.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        invoice: {
          select: { id: true, invoiceNumber: true, status: true, clientId: true },
        },
      },
    });

    // Collect clientIds we need to look up
    const clientIds = Array.from(
      new Set(activities.map((a) => a.invoice?.clientId).filter(Boolean) as string[]),
    );
    const clients = clientIds.length
      ? await prisma.client.findMany({
          where: { id: { in: clientIds }, userId },
          select: { id: true, name: true },
        })
      : [];
    const clientMap = new Map(clients.map((c) => [c.id, c.name]));

    const items = activities.map((a) => {
      const inv = a.invoice;
      const clientName = inv?.clientId ? clientMap.get(inv.clientId) ?? null : null;
      return {
        id: a.id,
        type: a.type,
        label: ACTIVITY_TYPE_LABELS[a.type] ?? a.type.toLowerCase().replace(/_/g, " "),
        message: a.message ?? null,
        invoiceId: inv?.id ?? null,
        invoiceNumber: inv?.invoiceNumber ?? null,
        clientName,
        createdAt: a.createdAt.toISOString(),
        relative: formatRelative(a.createdAt),
        meta: a.meta ?? null,
      };
    });

    return NextResponse.json({ items });
  } catch (err) {
    console.error("[GET /api/dashboard/activity]", err);
    return NextResponse.json({ error: "Failed to load activity" }, { status: 500 });
  }
}
