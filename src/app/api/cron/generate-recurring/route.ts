/**
 * GET /api/cron/generate-recurring
 *
 * Cron endpoint that scans RecurringProfiles where `nextRunAt <= now()` and
 * generates a fresh invoice for each, advancing `nextRunAt` by the configured
 * interval. If `autoSend` is true, the new invoice is emailed immediately.
 *
 * Auth: requires Authorization: Bearer <CRON_SECRET> if CRON_SECRET is set.
 *
 * Invoke from Vercel Cron, GitHub Actions, a host cron, or any scheduler:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://yourapp/api/cron/generate-recurring
 *
 * It's safe to call this as frequently as every hour — profiles only run
 * when their nextRunAt is due, and we guard against double-processing.
 */
import { NextResponse } from "next/server";
import { processDueRecurringProfiles } from "@/lib/recurring";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = request.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (token !== secret) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const url = new URL(request.url);
    const max = parseInt(url.searchParams.get("limit") ?? "100", 10);

    const startedAt = Date.now();
    const results = await processDueRecurringProfiles({
      maxProfiles: Number.isFinite(max) && max > 0 ? Math.min(max, 500) : 100,
    });

    return NextResponse.json({
      success: true,
      processed: results.length,
      generated: results.filter((r) => r.invoiceId).length,
      sent: results.filter((r) => r.sent).length,
      failed: results.filter((r) => r.error).length,
      results,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    console.error("[cron/generate-recurring] Failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to run recurring invoices" },
      { status: 500 }
    );
  }
}
