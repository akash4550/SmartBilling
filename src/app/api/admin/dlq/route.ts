/**
 * GET /api/admin/dlq — list DLQ + POISON rows for operator UI.
 * Auth: CRON_SECRET (same as other cron/admin endpoints).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "@/lib/api-helpers";
import { listDlq, registerDlqAlertHook } from "@/lib/webhook-ingestion";
import { withService } from "@/lib/service-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let hookRegistered = false;
function ensureHooks() {
  if (hookRegistered) return;
  hookRegistered = true;
  registerDlqAlertHook(async (row) => {
    console.error(
      `[dlq-alert] status=${row.status} provider=${row.provider} event=${row.eventType} attempts=${row.attempts} redrives=${row.redriveCount} error=${row.lastError ?? "n/a"} reason=${row.poisonReason ?? "n/a"} id=${row.id}`
    );
  });
}

function assertCronSecret(request: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
    }
    return null;
  }
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const url = new URL(request.url);
  const qs = url.searchParams.get("secret") ?? "";
  if (timingSafeEqual(token, secret) || timingSafeEqual(qs, secret)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const err = assertCronSecret(request);
  if (err) return err;
  ensureHooks();

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const includeResolved = url.searchParams.get("resolved") === "1";

  const rows = await withService("admin:dlq", (tx) =>
    listDlq({
      status: statusParam === "DLQ" || statusParam === "POISON" ? statusParam : undefined,
      limit: Number.isFinite(limit) ? limit : 50,
      includeResolved,
      client: tx,
    })
  );
  return NextResponse.json({ ok: true, rows });
}
