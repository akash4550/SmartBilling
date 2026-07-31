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
import { prisma } from "@/lib/prisma";
import {
  isReadOnlyMode,
  READ_ONLY_RETRY_AFTER_SECONDS,
} from "@/lib/dr-mode";
import {
  claimDue,
  markDone,
  markRetry,
  markQuarantineHold,
  isTenantQuarantined,
  TENANT_QUARANTINED_ERR,
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

/**
 * Best-effort extract the tenant userId from a webhook row so we can
 * check quarantine BEFORE touching business tables. We parse the
 * rawBody only enough to read provider metadata; on any failure we
 * return null (quarantine check is skipped; the processor will do a
 * real parse and fail normally).
 */
async function tenantForWebhook(row: {
  id: string;
  provider: string;
  rawBody: string;
}): Promise<string | null> {
  try {
    const parsed = JSON.parse(row.rawBody) as Record<string, unknown>;

    // Stripe: data.object.metadata.invoiceId or data.object.id (cs_...) → lookup
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const object = (data.object ?? {}) as Record<string, unknown>;
    const stripeMeta = (object.metadata ?? parsed.metadata ?? {}) as Record<string, string>;
    if (typeof stripeMeta.invoiceId === "string" && stripeMeta.invoiceId.length > 0) {
      const inv = await prisma.invoice.findUnique({
        where: { id: stripeMeta.invoiceId },
        select: { userId: true },
      });
      if (inv) return inv.userId;
    }
    if (typeof object.id === "string" && /^cs_/.test(object.id)) {
      const inv2 = await prisma.invoice.findFirst({
        where: { stripeCheckoutSessionId: object.id },
        select: { userId: true },
      });
      if (inv2) return inv2.userId;
    }

    // Razorpay: payload.payment.entity.notes.invoiceId or payload.order.entity.id
    const payload = (parsed.payload ?? {}) as Record<string, unknown>;
    const payment = (payload.payment ?? {}) as Record<string, unknown>;
    const pEntity = (payment.entity ?? {}) as Record<string, unknown>;
    const order = (payload.order ?? {}) as Record<string, unknown>;
    const oEntity = (order.entity ?? {}) as Record<string, unknown>;
    const rzNotes = (pEntity.notes ?? oEntity.notes ?? {}) as Record<string, string>;
    if (typeof rzNotes.invoiceId === "string" && rzNotes.invoiceId.length > 0) {
      const inv = await prisma.invoice.findUnique({
        where: { id: rzNotes.invoiceId },
        select: { userId: true },
      });
      if (inv) return inv.userId;
    }
    const rzOrderId = oEntity.id;
    if (typeof rzOrderId === "string" && rzOrderId.length > 0) {
      const inv = await prisma.invoice.findFirst({
        where: { razorpayOrderId: rzOrderId },
        select: { userId: true },
      });
      if (inv) return inv.userId;
    }

    // Resend: data.tags[].name === userId/invoiceId
    const d = (parsed.data ?? {}) as Record<string, unknown>;
    const tags = d.tags;
    if (Array.isArray(tags)) {
      for (const t of tags as Array<{ name?: unknown; value?: unknown }>) {
        if (t && t.name === "userId" && typeof t.value === "string" && t.value.length > 0) {
          return t.value;
        }
      }
      for (const t of tags as Array<{ name?: unknown; value?: unknown }>) {
        if (t && t.name === "invoiceId" && typeof t.value === "string" && t.value.length > 0) {
          const inv = await prisma.invoice.findUnique({
            where: { id: t.value },
            select: { userId: true },
          });
          if (inv) return inv.userId;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
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

  // Read-Only DR mode: fail fast with 503 + Retry-After without touching
  // any queues. Pending webhooks stay PENDING; attempts are NOT burned;
  // the cron scheduler (or provider) will redeliver when we exit DR.
  if (isReadOnlyMode()) {
    return NextResponse.json(
      {
        ok: false,
        error: "SmartBill is in Read-Only mode; webhook processing paused.",
        retryAfterSeconds: READ_ONLY_RETRY_AFTER_SECONDS,
      },
      {
        status: 503,
        headers: {
          "Retry-After": String(READ_ONLY_RETRY_AFTER_SECONDS),
        },
      }
    );
  }

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
      let quarantined = 0;

      for (const row of rows) {
        try {
          // ---- SINGLE GATEKEEPER: quarantine pre-flight ----
          // This is the ONLY quarantine check in the pipeline. If the
          // owning tenant is under ledger quarantine we hold the event
          // PENDING (attempts NOT burned) and continue. Processors
          // assume a healthy tenant context and run pure domain/ledger
          // logic. A defense-in-depth Postgres trigger
          // (ledger_quarantine_guard → SQLSTATE L0001) is the final
          // backstop for any race between this check and dispatch;
          // such throws are caught below and routed to
          // markQuarantineHold() as well.
          const uid = await tenantForWebhook(row);
          if (uid && (await isTenantQuarantined(uid, tx))) {
            await markQuarantineHold(row.id, tx);
            quarantined++;
            continue;
          }

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
          // Defense-in-depth: if the PG quarantine trigger fired
          // between our pre-flight and the dispatch (L0001), or any
          // downstream code surfaced the sentinel, hold the row
          // instead of counting it as a failure / DLQ.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === TENANT_QUARANTINED_ERR || /Ledger is quarantined|SQLSTATE.*L0001|L0001/i.test(msg)) {
            await markQuarantineHold(row.id, tx);
            quarantined++;
            continue;
          }
          const beforeAttempts = row.attempts;
          await markRetry(row.id, beforeAttempts, err, tx);
          failed++;
          if (beforeAttempts + 1 >= MAX_ATTEMPTS) dlq++;
        }
      }

      return { reaped, claimed: rows.length, succeeded, failed, dlq, quarantined };
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
