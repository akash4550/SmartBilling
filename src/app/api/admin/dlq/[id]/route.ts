/**
 * POST /api/admin/dlq/:id?action=redrive — operator-initiated replay of one DLQ row.
 * POST /api/admin/dlq/:id?action=resolve — mark a row resolved with operator note.
 *
 * Auth: CRON_SECRET. Redrive is idempotent; rows already PENDING/PROCESSING/DONE
 * return { ok: false, reason: ... }. Rows that hit MAX_REDRIVES auto-promote
 * to POISON. Operators can override (force-redrive a POISON row) by passing
 * ?action=redrive&force=1.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "@/lib/api-helpers";
import {
  redriveOne,
  resolveDlq,
  registerDlqAlertHook,
} from "@/lib/webhook-ingestion";
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const err = assertCronSecret(request);
  if (err) return err;
  ensureHooks();

  const { id } = await params;
  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "redrive";
  const force = url.searchParams.get("force") === "1";

  if (action === "resolve") {
    let note = "resolved by operator";
    try {
      const body = await request.json().catch(() => null);
      if (body && typeof body === "object" && "note" in body && typeof (body as { note: unknown }).note === "string") {
        note = (body as { note: string }).note;
      }
    } catch {
      /* ignore */
    }
    const result = await withService("admin:dlq", (tx) => resolveDlq(id, note, tx));
    return NextResponse.json(result);
  }

  // default: redrive
  const result = await withService("admin:dlq", (tx) =>
    // When force=1, operators can redrive POISON rows (bypasses the
    // poison check). Auto-redrive via cron will never force.
    redriveOne(id, { operator: force, client: tx })
  );
  return NextResponse.json(result);
}
