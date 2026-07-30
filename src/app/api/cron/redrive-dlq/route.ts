/**
 * GET/POST /api/cron/redrive-dlq
 *
 * DLQ redrive worker. Runs periodically (recommended every 15 minutes) to:
 *   1. Reap stale PROCESSING claims (safety net, in case process-webhooks
 *      hasn't run recently).
 *   2. Find DLQ rows whose redriveAfter has elapsed (cooldown since
 *      last failure) and flip them back to PENDING for reprocessing.
 *   3. Auto-promote rows that have exhausted MAX_REDRIVES to POISON, and
 *      fire alert hooks (stderr → hosting log aggregator).
 *
 * Auth: CRON_SECRET (same as other cron routes).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "@/lib/api-helpers";
import {
  reapStaleClaims,
  redriveEligible,
  registerDlqAlertHook,
} from "@/lib/webhook-ingestion";
import { withService } from "@/lib/service-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DLQ_ALERT_WINDOW_MS = 30 * 60 * 1000;

// Register an alert hook once at module load. The hook emits a structured
// error line that hosting log aggregators (Vercel Log Drains, Datadog, etc.)
// can key off. This is intentionally minimal — integration with specific
// alerting channels (Slack, PagerDuty, Resend) is an app-level concern.
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

async function handleRequest(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!timingSafeEqual(token, secret)) {
      const url = new URL(request.url);
      const qs = url.searchParams.get("secret") ?? "";
      if (!timingSafeEqual(qs, secret)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 503 }
    );
  }

  ensureHooks();

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);

  try {
    // Run all DLQ work under service_role so we aren't connecting as superuser.
    const result = await withService("cron:redrive-dlq", async (tx) => {
      const reaped = await reapStaleClaims(undefined, tx);
      const { redriven, poisoned, skipped } = await redriveEligible(
        Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 10,
        tx
      );
      return { reaped, redriven, poisoned, skipped };
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/redrive-dlq] Failed:", err);
    return NextResponse.json(
      { error: "Worker failure", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  return handleRequest(request);
}
export async function POST(request: Request) {
  return handleRequest(request);
}

// Avoid unused-import warnings; DLQ_ALERT_WINDOW_MS reserved for future
// per-row alert rate-limiting inside the hook if needed.
void DLQ_ALERT_WINDOW_MS;
