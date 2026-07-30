/**
 * Async webhook ingestion.
 *
 * Edge handlers (Stripe/Razorpay/Resend) do:
 *   1. Verify HMAC/signature (fail-closed in prod).
 *   2. Call `ingestWebhook()` which INSERTs the raw body into the
 *      append-only WebhookIngestion table, deduplicating by
 *      (provider, providerEventId).
 *   3. Return 202 Accepted — no DB writes to business tables happen
 *      on the request path, keeping response time <50ms.
 *
 * The `/api/cron/process-webhooks` worker claims rows via
 * `SELECT ... FOR UPDATE SKIP LOCKED`, dispatches to provider-specific
 * handlers, and manages retries with exponential backoff (5s * 2^n + jitter).
 * After 5 attempts, rows are routed to DLQ for manual review.
 *
 * Raw bodies are retained for 90 days for forensic audit.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type WebhookProvider = "stripe" | "razorpay" | "resend";

export const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5_000; // doubles each attempt → 5,10,20,40,80s

export interface IngestInput {
  provider: WebhookProvider;
  providerEventId?: string | null;
  eventType: string;
  rawBody: string;
  signature?: string | null;
}

export interface IngestResult {
  id: string;
  duplicate: boolean;
}

/**
 * Insert a webhook payload into the staging table. Returns the new row id
 * and `duplicate: true` if the (provider, providerEventId) was already
 * seen (provider retries are harmlessly absorbed).
 *
 * Runs as superuser (the webhook_ingestions table is not tenant-scoped).
 */
export async function ingestWebhook(input: IngestInput): Promise<IngestResult> {
  const { provider, providerEventId, eventType, rawBody, signature } = input;
  try {
    const row = await prisma.webhookIngestion.create({
      data: {
        provider,
        providerEventId: providerEventId ?? null,
        eventType,
        rawBody,
        signature: signature ?? null,
        status: "PENDING",
        nextAttemptAt: new Date(),
      },
      select: { id: true },
    });
    return { id: row.id, duplicate: false };
  } catch (err) {
    // P2002 unique violation → duplicate provider event id → ack 202.
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code: string }).code
        : null;
    if (code === "P2002" && providerEventId) {
      return { id: "duplicate", duplicate: true };
    }
    throw err;
  }
}

/**
 * Backoff calculator: BASE_BACKOFF_MS * 2^attempts + jitter(0..1000ms).
 * `attempts` is the *just-failed* attempt count (0 after first fail).
 */
export function nextBackoff(attempts: number, now = Date.now()): Date {
  const jitter = Math.floor(Math.random() * 1000);
  const delay = BASE_BACKOFF_MS * Math.pow(2, attempts) + jitter;
  return new Date(now + delay);
}

export interface ClaimOptions {
  limit?: number;
  provider?: WebhookProvider;
}

/**
 * Claim up to `limit` due rows via SELECT ... FOR UPDATE SKIP LOCKED
 * so concurrent workers don't fight over the same row. Marks them
 * PROCESSING and returns them for dispatch.
 */
export async function claimDue(
  opts: ClaimOptions = {}
): Promise<
  Array<{
    id: string;
    provider: string;
    providerEventId: string | null;
    eventType: string;
    rawBody: string;
    attempts: number;
  }>
> {
  const { limit = 10, provider } = opts;
  const now = new Date();
  const workerId = getWorkerId();

  const providerClause = provider
    ? Prisma.sql`AND provider = ${provider}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      provider: string;
      "providerEventId": string | null;
      "eventType": string;
      "rawBody": string;
      attempts: number;
    }>
  >`
    SELECT id, provider, "providerEventId", "eventType", "rawBody", attempts
    FROM webhook_ingestions
    WHERE status IN ('PENDING'::"WebhookIngestionStatus", 'PROCESSING'::"WebhookIngestionStatus")
      AND "nextAttemptAt" <= ${now}
      ${providerClause}
    ORDER BY "nextAttemptAt" ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `;

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  await prisma.webhookIngestion.updateMany({
    where: { id: { in: ids } },
    data: {
      status: "PROCESSING",
      lockedBy: workerId,
      lockedAt: new Date(),
    },
  });

  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    providerEventId: r["providerEventId"],
    eventType: r["eventType"],
    rawBody: r["rawBody"],
    attempts: Number(r.attempts),
  }));
}

let _workerId: string | null = null;
function getWorkerId(): string {
  if (_workerId) return _workerId;
  const host = (process.env.HOSTNAME ?? "local").slice(0, 32);
  _workerId = `pid-${process.pid}_host-${host}`;
  return _workerId;
}

export async function markDone(id: string) {
  await prisma.webhookIngestion.update({
    where: { id },
    data: {
      status: "DONE",
      processedAt: new Date(),
      lastError: null,
      lockedBy: null,
      lockedAt: null,
    },
  });
}

/**
 * Record a failed attempt. If attempts+1 >= MAX_ATTEMPTS → DLQ.
 * Otherwise schedule next retry with exponential backoff.
 */
export async function markRetry(id: string, attempts: number, error: unknown) {
  const nextAttempts = attempts + 1;
  const truncatedError =
    error instanceof Error ? error.message : String(error ?? "unknown");
  const safeError = truncatedError.slice(0, 2048);

  if (nextAttempts >= MAX_ATTEMPTS) {
    await prisma.webhookIngestion.update({
      where: { id },
      data: {
        status: "DLQ",
        attempts: nextAttempts,
        lastError: safeError,
        lockedBy: null,
        lockedAt: null,
        processedAt: new Date(),
      },
    });
    console.error(
      `[webhook-worker] ${id} moved to DLQ after ${nextAttempts} attempts: ${safeError}`
    );
    return;
  }
  await prisma.webhookIngestion.update({
    where: { id },
    data: {
      status: "PENDING",
      attempts: nextAttempts,
      lastError: safeError,
      nextAttemptAt: nextBackoff(attempts),
      lockedBy: null,
      lockedAt: null,
    },
  });
}

/** Re-claim stuck PROCESSING rows (lockedAt older than `staleMs`) back to PENDING. */
export async function reapStaleClaims(staleMs = 5 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const result = await prisma.webhookIngestion.updateMany({
    where: { status: "PROCESSING", lockedAt: { lt: cutoff } },
    data: {
      status: "PENDING",
      lockedBy: null,
      lockedAt: null,
      nextAttemptAt: new Date(),
    },
  });
  return result.count;
}
