/**
 * GET/POST /api/cron/process-webhooks
 *
 * Decoupled async webhook worker. Called periodically (Vercel Cron or an
 * external scheduler) to:
 *   1. Reap stale PROCESSING claims (workers that died mid-handle).
 *   2. Claim up to BATCH_SIZE due PENDING rows via SKIP LOCKED.
 *   3. Dispatch each to the appropriate provider processor.
 *   4. markDone on success; markRetry (with exponential backoff) on
 *      failure → DLQ after 5 attempts.
 *
 * Auth: required CRON_SECRET (timingSafeEqual comparison, same as
 * other cron routes).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "@/lib/api-helpers";
import {
  claimDue,
  markDone,
  markRetry,
  reapStaleClaims,
  MAX_ATTEMPTS,
  registerDlqAlertHook,
} from "@/lib/webhook-ingestion";
import {
  processStripeEvent,
  processRazorpayEvent,
  processResendEvent,
} from "@/lib/webhook-processors";
import { withService } from "@/lib/service-context";

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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BATCH_SIZE = 20;

export async function GET(request: Request) {
  return handleRequest(request);
}
export async function POST(request: Request) {
  return handleRequest(request);
}

async function handleRequest(request: Request) {
  // Auth: CRON_SECRET required (timing-safe compare).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!timingSafeEqual(token, secret)) {
      // Also allow ?secret= for backwards compatibility with some cron
      // providers, but prefer Authorization header.
      const url = new URL(request.url);
      const qs = url.searchParams.get("secret") ?? "";
      if (!timingSafeEqual(qs, secret)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }
  } else if (process.env.NODE_ENV === "production") {
    // In production without CRON_SECRET, refuse to run — this endpoint
    // can write financial state, so open access is a risk.
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 503 }
    );
  }

  ensureHooks();

  try {
    // Run the worker under service_role (least-privilege, no superuser).
    // All webhook_ingestions writes are performed on `tx` so RLS (which
    // requires app.service_name to be set) applies.
    const result = await withService("cron:process-webhooks", async (tx) => {
      const reaped = await reapStaleClaims(undefined, tx);

      const rows = await claimDue({ limit: BATCH_SIZE, client: tx });

      let succeeded = 0;
      let failed = 0;
      let dlq = 0;

      for (const row of rows) {
        try {
          switch (row.provider) {
            case "stripe":
              await processStripeEvent(row.rawBody);
              break;
            case "razorpay":
              await processRazorpayEvent(row.rawBody);
              break;
            case "resend":
              await processResendEvent(row.rawBody);
              break;
            default:
              throw new Error(`Unknown provider: ${row.provider}`);
          }
          await markDone(row.id, tx);
          succeeded++;
        } catch (err) {
          const beforeAttempts = row.attempts;
          await markRetry(row.id, beforeAttempts, err, tx);
          failed++;
          if (beforeAttempts + 1 >= MAX_ATTEMPTS) dlq++;
        }
      }

      return { reaped, claimed: rows.length, succeeded, failed, dlq };
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/process-webhooks] Worker error:", err);
    return NextResponse.json(
      { error: "Worker failure", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
