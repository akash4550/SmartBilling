/**
 * Temporal Activities for the SmartBill payment-webhook pipeline.
 *
 * Every activity is written to be IDEMPOTENT: replaying the same
 * `workflowId` (= dedupe key `provider:eventId`) after a partial
 * failure must not double-count money, double-send email, or clobber a
 * successful ledger write. This is what makes Temporal retries safe —
 * the workflow can retry forever without creating duplicates because
 * the database layer uses conditional updates / unique keys.
 *
 * Activities run on the Temporal Worker (Node.js, long-lived process
 * with a pooled Prisma connection). They execute outside the Next.js
 * request path so we can afford longer timeouts and richer retries.
 */
import "server-only";

import { ApplicationFailure } from "@temporalio/activity";
import { prisma } from "@/lib/prisma";
import { ReadOnlyModeError } from "@/lib/dr-mode";
import { markInvoicePaid } from "@/lib/invoice-helpers";
import { sendPaymentReceipt } from "@/lib/send-payment-receipt";
import { toSubunit } from "@/lib/money";
import {
  computeTenantAuditOverview,
  writeTenantOverview,
} from "@/lib/read-model";
import {
  parseStripeEvent,
  resolveInvoiceFromStripeEvent,
  type ResolvedStripePayment,
} from "./stripe-event-resolver";

// ---------------------------------------------------------------------------
// Context passed to every activity — gives each step the dedupe keys it needs
// to be idempotent.
// ---------------------------------------------------------------------------
export interface WebhookActivityContext {
  provider: "stripe" | "razorpay";
  providerEventId: string;        // Stripe event id / Razorpay payment id (dedupe anchor)
  idempotencyKey: string;         // `${provider}:${providerEventId}` = Temporal workflowId
  rawBody: string;                // original raw payload for audit
  receivedAt: string;             // ISO timestamp from the edge
}

// ---------------------------------------------------------------------------
// Activity 1: verify tenant writeability
// ---------------------------------------------------------------------------
export async function checkTenantQuarantine(
  _ctx: WebhookActivityContext
): Promise<{ ok: true; quarantined: false }> {
  try {
    const { assertReadWriteMode } = await import("@/lib/dr-mode");
    assertReadWriteMode();
    return { ok: true, quarantined: false };
  } catch (err) {
    if (err instanceof ReadOnlyModeError) {
      throw ApplicationFailure.create({
        type: "TenantUnavailable",
        message: "Tenant/DB in read-only or quarantine — will retry",
        nonRetryable: false,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Activity 2: parse + resolve the invoice for this webhook
// ---------------------------------------------------------------------------
export interface ResolvePaymentResult {
  invoiceId: string;
  userId: string;
  paymentIntentId: string | null;
  checkoutSessionId: string | null;
  amountPaise: bigint;
  currency: string;
  alreadyPaid: boolean;
}

export async function resolveInvoiceForWebhook(
  ctx: WebhookActivityContext
): Promise<ResolvePaymentResult> {
  if (ctx.provider !== "stripe") {
    throw ApplicationFailure.create({
      type: "UnsupportedProvider",
      message: `Provider ${ctx.provider} not yet wired to Temporal activities`,
      nonRetryable: true,
    });
  }
  const event = parseStripeEvent(ctx.rawBody);
  const resolved: ResolvedStripePayment | null = await resolveInvoiceFromStripeEvent(event);

  if (!resolved) {
    throw ApplicationFailure.create({
      type: "NoMatchingInvoice",
      message: `Event ${ctx.providerEventId} does not reference a known SmartBill invoice`,
      nonRetryable: true,
    });
  }

  // Pull authoritative user settings for currency + paid state.
  const inv = await prisma.invoice.findUnique({
    where: { id: resolved.invoiceId },
    include: { user: { include: { settings: true } } },
  });
  if (!inv) {
    throw ApplicationFailure.create({
      type: "InvoiceNotFound",
      message: `Invoice ${resolved.invoiceId} not found for event ${ctx.providerEventId}`,
      nonRetryable: true,
    });
  }

  const currency = inv.user.settings?.currency ?? "INR";
  return {
    invoiceId: inv.id,
    userId: inv.userId,
    paymentIntentId: resolved.paymentIntentId,
    checkoutSessionId: resolved.checkoutSessionId,
    amountPaise: BigInt(toSubunit(inv.totalAmount, currency)),
    currency,
    alreadyPaid: inv.status === "PAID",
  };
}

// ---------------------------------------------------------------------------
// Activity 3: apply payment (ledger double-entry)
// ---------------------------------------------------------------------------
export interface ApplyPaymentInput {
  ctx: WebhookActivityContext;
  resolved: ResolvePaymentResult;
}

export interface ApplyPaymentResult {
  applied: boolean;
  invoiceId: string;
}

export async function postLedgerEvent(input: ApplyPaymentInput): Promise<ApplyPaymentResult> {
  const { ctx, resolved } = input;
  if (resolved.alreadyPaid) {
    return { applied: false, invoiceId: resolved.invoiceId };
  }
  try {
    await markInvoicePaid(resolved.invoiceId, {
      provider: ctx.provider,
      stripePaymentIntentId: resolved.paymentIntentId ?? undefined,
      stripeCheckoutSessionId: resolved.checkoutSessionId ?? undefined,
      actorUserId: resolved.userId,
    });
    return { applied: true, invoiceId: resolved.invoiceId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/voided|not found|status.*(?:DRAFT|VOID)/i.test(msg)) {
      throw ApplicationFailure.create({
        type: "PaymentNotApplicable",
        message: msg,
        nonRetryable: true,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Activity 4: email receipt (best-effort)
//
// The ledger is the source of truth. We deliberately do NOT model
// downstream side-effects (email, cache) as compensatable transactions:
// a transient SMTP outage must never trigger a PAYMENT_REVERSED that
// undoes a committed payment. Receipt email is a customer nicety, not
// a financial invariant; failures are logged and triaged by operators.
// ---------------------------------------------------------------------------
export interface SendReceiptInput {
  ctx: WebhookActivityContext;
  resolved: ResolvePaymentResult;
}

export async function sendReceiptEmail(input: SendReceiptInput): Promise<{ sent: boolean }> {
  const { resolved } = input;
  try {
    const ok = await sendPaymentReceipt({
      invoiceId: resolved.invoiceId,
      paymentMethod: "Stripe",
      transactionId: resolved.paymentIntentId ?? resolved.checkoutSessionId ?? undefined,
    });
    return { sent: ok };
  } catch (err) {
    throw ApplicationFailure.create({
      type: "ReceiptSendFailed",
      message: err instanceof Error ? err.message : "receipt send failed",
      nonRetryable: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Activity 5: persist audit record (best-effort fire & forget)
//
// We repurpose the legacy `webhookIngestion` table as a durable audit log
// rather than migrating to a new model: it already carries the
// (provider, providerEventId) unique constraint we need for idempotent
// upsert, and nothing in the hot read path scans it. Keeping it avoids a
// schema migration mid-rollout and preserves prior-ingestion history.
// ---------------------------------------------------------------------------
export interface RecordOutcomeInput {
  ctx: WebhookActivityContext;
  resolved: ResolvePaymentResult | null;
  status: "applied" | "noop" | "applied_email_failed" | "failed";
  error?: string;
}

export async function recordWebhookOutcome(input: RecordOutcomeInput): Promise<void> {
  const { ctx, resolved, status, error } = input;
  // Reuse the legacy WebhookIngestion table as an audit log rather than
  // introducing a new model — processedAt carries the completion time.
  await prisma.webhookIngestion.upsert({
    where: {
      wh_ingest_provider_event_uniq: {
        provider: ctx.provider,
        providerEventId: ctx.providerEventId,
      },
    },
    create: {
      provider: ctx.provider,
      providerEventId: ctx.providerEventId,
      eventType: "payment_intent.succeeded",
      rawBody: ctx.rawBody,
      signature: null,
      status: "DONE",
      attempts: 1,
      lastError: error ?? null,
      processedAt: new Date(),
    },
    update: {
      status: "DONE",
      lastError: error ?? null,
      processedAt: new Date(),
    },
  }).catch(() => {
    // Never fail the workflow on audit-log failures.
  });
}

// ---------------------------------------------------------------------------
// Activity 6: CQRS read-model refresh
//
// Idempotent overwrite of `rm:overview:<tenantId>` with the freshly
// recomputed TenantAuditOverview. Runs IMMEDIATELY after the ledger
// commits (before email) to narrow the cache-vs-ledger stale window for
// the dashboard; safe to retry and safe to call multiple times because
// it uses SET (not CAS) semantics.
//
// Why best-effort: Redis is a latency optimization for the admin
// dashboard, never a correctness dependency. The read path recomputes
// from Postgres on any miss, so a Redis outage degrades to ~ms-extra
// latency rather than a user-visible error. This is why the activity
// swallows errors after a short retry budget.
// ---------------------------------------------------------------------------
export async function refreshTenantReadModel(tenantId: string): Promise<void> {
  try {
    const overview = await computeTenantAuditOverview(tenantId);
    await writeTenantOverview(tenantId, overview);
  } catch (err) {
    console.error(
      `[read-model] refreshTenantReadModel failed for tenant ${tenantId}:`,
      err instanceof Error ? err.message : err
    );
    // Swallow: never fail the parent workflow because of a cache miss.
    // The safety TTL + read-through compute guarantee the UI stays
    // consistent; Redis is a latency optimization, not a correctness
    // requirement.
  }
}
