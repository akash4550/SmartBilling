/**
 * Async webhook ingestion (Batch 6 production hardening).
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
 *
 * Failure handling (Batch 6):
 *   - Deterministic errors (malformed JSON, unknown provider, invalid
 *     signature) are classified as poison-pill → status POISON, never
 *     auto-retried or redriven. They require operator intervention.
 *   - Transient errors move to DLQ after MAX_ATTEMPTS, with redriveAfter
 *     set to now + REDRIVE_BACKOFF (15m) so they don't spin forever.
 *   - The `/api/cron/redrive-dlq` worker flips eligible DLQ rows back to
 *     PENDING up to MAX_REDRIVES (3) per row. After MAX_REDRIVES they
 *     are promoted to POISON (quarantine) with an operator alert.
 *   - Stuck PROCESSING rows are reaped (crash recovery).
 *
 * Alerting: a pluggable `registerDlqAlertHook()` allows callers to push
 * alerts (stderr → log aggregator, Resend, Slack) when rows hit DLQ or
 * POISON.
 *
 * All helpers accept an optional `client` parameter (Prisma client or tx)
 * so callers can bind them to a withService/withTenant transaction rather
 * than touching the global superuser prisma. Defaults to the global prisma
 * for back-compat.
 */
import { Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";

export type WebhookProvider = "stripe" | "razorpay" | "resend";

export const MAX_ATTEMPTS = 5;
export const MAX_REDRIVES = 3;
const BASE_BACKOFF_MS = 5_000;
const REDRIVE_BACKOFF_MS = 15 * 60 * 1000;
const DEFAULT_REDRIVE_BATCH = 10;

type PrismaClient = typeof defaultPrisma;
type PrismaTx = Prisma.TransactionClient;
type AnyPrisma = PrismaClient | PrismaTx;

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

export type AlertHook = (row: {
  id: string;
  provider: string;
  eventType: string;
  status: "DLQ" | "POISON";
  attempts: number;
  redriveCount: number;
  lastError: string | null;
  poisonReason: string | null;
}) => void | Promise<void>;

const alertHooks: AlertHook[] = [];

export function registerDlqAlertHook(hook: AlertHook): void {
  alertHooks.push(hook);
}

async function fireAlerts(row: {
  id: string;
  provider: string;
  eventType: string;
  status: "DLQ" | "POISON";
  attempts: number;
  redriveCount: number;
  lastError: string | null;
  poisonReason: string | null;
}) {
  for (const hook of alertHooks) {
    try {
      await hook(row);
    } catch (err) {
      console.error("[webhook-ingestion] alert hook failed:", err);
    }
  }
}

/**
 * Classify an error as deterministic (poison pill) vs transient.
 */
export function classifyError(
  err: unknown
): { poison: boolean; reason?: string } {
  const msg = err instanceof Error ? err.message : String(err ?? "unknown");
  if (/Unknown provider/i.test(msg)) return { poison: true, reason: "unknown_provider" };
  if (/invalid.*json|malformed.*json|json.*parse|syntaxerror|unexpected token/i.test(msg))
    return { poison: true, reason: "malformed_json" };
  if (/signature.*(invalid|verification|mismatch)|no signature|hmac/i.test(msg))
    return { poison: true, reason: "invalid_signature" };
  if (/no such (invoice|customer|payment|charge|intent)|resource_missing/i.test(msg))
    return { poison: true, reason: "missing_resource" };
  return { poison: false };
}

/** Insert a webhook into the staging table. (Edge path — short INSERT.) */
export async function ingestWebhook(
  input: IngestInput,
  client: AnyPrisma = defaultPrisma
): Promise<IngestResult> {
  const { provider, providerEventId, eventType, rawBody, signature } = input;
  try {
    const row = await client.webhookIngestion.create({
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

export function nextBackoff(attempts: number, now = Date.now()): Date {
  const jitter = Math.floor(Math.random() * 1000);
  return new Date(now + BASE_BACKOFF_MS * Math.pow(2, attempts) + jitter);
}

export interface ClaimOptions {
  limit?: number;
  provider?: WebhookProvider;
}

/**
 * Claim up to `limit` due rows via SELECT FOR UPDATE SKIP LOCKED.
 */
export async function claimDue(
  opts: ClaimOptions & { client?: AnyPrisma } = {}
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
  const { limit = 10, provider, client = defaultPrisma } = opts;
  const now = new Date();
  const workerId = getWorkerId();

  const providerClause = provider
    ? Prisma.sql`AND provider = ${provider}`
    : Prisma.empty;

  const rows = await client.$queryRaw<
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
  await client.webhookIngestion.updateMany({
    where: { id: { in: ids } },
    data: { status: "PROCESSING", lockedBy: workerId, lockedAt: new Date() },
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

/**
 * Place a row back into PENDING with lastError='tenant_quarantined' and
 * a 15-minute backoff. Used by the webhook worker when the owning tenant
 * is under ledger quarantine — we do NOT mark it failed/DLQ; we hold it
 * so customer payments are not lost. Attempts counter is NOT incremented.
 */
export async function markQuarantineHold(
  id: string,
  client: AnyPrisma = defaultPrisma
) {
  await client.webhookIngestion.update({
    where: { id },
    data: {
      status: "PENDING",
      lastError: "tenant_quarantined",
      nextAttemptAt: new Date(Date.now() + 15 * 60 * 1000),
      lockedBy: null,
      lockedAt: null,
    },
  });
}

export async function markDone(id: string, client: AnyPrisma = defaultPrisma) {
  await client.webhookIngestion.update({
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
 * Record a failed attempt. Classifies error as poison vs transient.
 */
export async function markRetry(
  id: string,
  attempts: number,
  error: unknown,
  client: AnyPrisma = defaultPrisma
) {
  const nextAttempts = attempts + 1;
  const safeError =
    (error instanceof Error ? error.message : String(error ?? "unknown")).slice(0, 2048);
  const classification = classifyError(error);

  if (classification.poison) {
    await client.webhookIngestion.update({
      where: { id },
      data: {
        status: "POISON",
        attempts: nextAttempts,
        lastError: safeError,
        poisonPill: true,
        poisonReason: classification.reason ?? "deterministic_failure",
        lockedBy: null,
        lockedAt: null,
        processedAt: new Date(),
        lastAlertedAt: new Date(),
      },
    });
    console.error(
      `[webhook-worker] ${id} flagged POISON (${classification.reason}) after ${nextAttempts} attempts: ${safeError}`
    );
    const fresh = await client.webhookIngestion.findUnique({
      where: { id },
      select: { provider: true, eventType: true },
    });
    await fireAlerts({
      id,
      provider: fresh?.provider ?? "unknown",
      eventType: fresh?.eventType ?? "unknown",
      status: "POISON",
      attempts: nextAttempts,
      redriveCount: 0,
      lastError: safeError,
      poisonReason: classification.reason ?? null,
    });
    return;
  }

  if (nextAttempts >= MAX_ATTEMPTS) {
    const updated = await client.webhookIngestion.update({
      where: { id },
      data: {
        status: "DLQ",
        attempts: nextAttempts,
        lastError: safeError,
        lockedBy: null,
        lockedAt: null,
        processedAt: new Date(),
        redriveAfter: new Date(Date.now() + REDRIVE_BACKOFF_MS),
        lastAlertedAt: new Date(),
      },
    });
    console.error(
      `[webhook-worker] ${id} moved to DLQ after ${nextAttempts} attempts: ${safeError}`
    );
    await fireAlerts({
      id,
      provider: updated.provider,
      eventType: updated.eventType,
      status: "DLQ",
      attempts: nextAttempts,
      redriveCount: updated.redriveCount,
      lastError: safeError,
      poisonReason: null,
    });
    return;
  }
  await client.webhookIngestion.update({
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

export async function reapStaleClaims(
  staleMs = 5 * 60 * 1000,
  client: AnyPrisma = defaultPrisma
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const r = await client.webhookIngestion.updateMany({
    where: { status: "PROCESSING", lockedAt: { lt: cutoff } },
    data: { status: "PENDING", lockedBy: null, lockedAt: null, nextAttemptAt: new Date() },
  });
  return r.count;
}

export async function redriveOne(
  id: string,
  opts: { operator?: boolean; client?: AnyPrisma; note?: string } = {}
): Promise<{ ok: boolean; reason?: string }> {
  const { operator = false, client = defaultPrisma } = opts;
  const row = await client.webhookIngestion.findUnique({ where: { id } });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status === "DONE") return { ok: false, reason: "already_done" };
  if (row.status === "POISON" && !operator) return { ok: false, reason: "poison_pill" };
  if (row.status === "PENDING" || row.status === "PROCESSING") return { ok: false, reason: "already_queued" };
  if (row.redriveCount >= MAX_REDRIVES && !operator) {
    await client.webhookIngestion.update({
      where: { id },
      data: {
        status: "POISON",
        poisonPill: true,
        poisonReason: "redrive_quota_exceeded",
        lastAlertedAt: new Date(),
      },
    });
    console.error(
      `[webhook-redrive] ${id} promoted to POISON after ${row.redriveCount} redrives (quota exceeded)`
    );
    await fireAlerts({
      id, provider: row.provider, eventType: row.eventType, status: "POISON",
      attempts: row.attempts, redriveCount: row.redriveCount,
      lastError: row.lastError, poisonReason: "redrive_quota_exceeded",
    });
    return { ok: false, reason: "quota_exceeded_poisoned" };
  }
  const nextRedrive = row.redriveCount + 1;
  await client.webhookIngestion.update({
    where: { id },
    data: {
      status: "PENDING",
      redriveCount: nextRedrive,
      nextAttemptAt: new Date(),
      lockedBy: null, lockedAt: null, processedAt: null,
    },
  });
  return { ok: true };
}

export async function redriveEligible(
  limit: number = DEFAULT_REDRIVE_BATCH,
  client: AnyPrisma = defaultPrisma
): Promise<{ redriven: number; poisoned: number; skipped: number }> {
  const now = new Date();
  const eligible = await client.webhookIngestion.findMany({
    where: { status: "DLQ", poisonPill: false, redriveAfter: { lte: now }, resolvedAt: null },
    orderBy: { redriveAfter: "asc" },
    take: Math.min(limit, 50),
    select: { id: true },
  });
  let redriven = 0, poisoned = 0;
  for (const r of eligible) {
    const res = await redriveOne(r.id, { client });
    if (res.ok) redriven++;
    else if (res.reason === "quota_exceeded_poisoned") poisoned++;
  }
  return { redriven, poisoned, skipped: eligible.length - redriven - poisoned };
}

export async function resolveDlq(
  id: string, note: string, client: AnyPrisma = defaultPrisma
): Promise<{ ok: boolean; reason?: string }> {
  const row = await client.webhookIngestion.findUnique({ where: { id } });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status === "DONE") return { ok: false, reason: "already_done" };
  await client.webhookIngestion.update({
    where: { id },
    data: { resolvedAt: new Date(), resolveNote: note.slice(0, 2048) },
  });
  return { ok: true };
}

export async function listDlq(
  opts: { status?: "DLQ" | "POISON"; limit?: number; includeResolved?: boolean; client?: AnyPrisma } = {}
) {
  const { status, limit = 50, includeResolved = false, client = defaultPrisma } = opts;
  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  else where.status = { in: ["DLQ", "POISON"] };
  if (!includeResolved) where.resolvedAt = null;
  return client.webhookIngestion.findMany({
    where, orderBy: { createdAt: "desc" }, take: Math.min(limit, 200),
    select: {
      id: true, provider: true, providerEventId: true, eventType: true,
      attempts: true, lastError: true, poisonPill: true, poisonReason: true,
      redriveCount: true, redriveAfter: true, createdAt: true, lockedBy: true,
      resolvedAt: true, resolveNote: true,
    },
  });
}
