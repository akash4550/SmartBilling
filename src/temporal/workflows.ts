/**
 * Temporal Workflows for the SmartBill payment-webhook pipeline.
 *
 *   processPaymentWebhook  — runs for every Stripe/Razorpay payment event.
 *
 * Saga pattern (all steps are idempotent so Temporal retries are safe):
 *
 *    ┌─ checkTenantQuarantine     (fail → retry w/ backoff; DO NOT apply)
 *    │
 *    ├─ resolveInvoiceForWebhook
 *    │      • non-retryable "no matching invoice" → workflow ends no-op
 *    │
 *    ├─ postLedgerEvent           (mark invoice PAID + double-entry)
 *    │      • transient failure → Temporal retries (idempotent)
 *    │      • THE LEDGER IS SACRED — once this succeeds we NEVER reverse
 *    │        it for downstream (email/cache) failures.
 *    │
 *    ├─ refreshTenantReadModel    (CQRS projection refresh; best-effort)
 *    │      • moved here IMMEDIATELY after the ledger write so the
 *    │        dashboard sees the new balance before we move on to email
 *    │        (no stale-read window between payment commit and cache update)
 *    │
 *    ├─ sendReceiptEmail          (best-effort; retried, never compensates)
 *    │      • on exhausting retries → log to audit + complete successfully
 *    │        (the ledger has already committed; a missed receipt is
 *    │         triaged by operators, never auto-refunded)
 *    │
 *    └─ recordWebhookOutcome      (final audit; never fails workflow)
 *
 * Deduplication: the Temporal `workflowId` is set to
 * `wh:${provider}:${providerEventId}` by the API route, and the workflow
 * uses `workflowIdReusePolicy: REJECT_DUPLICATE` — so a retried Stripe
 * delivery of the same event never spawns a second workflow execution.
 *
 * Retry policy: activities get per-activity retry policies via
 * `defaultRetryPolicy`, with non-retryable ApplicationFailure types
 * surfaced from the activity layer (bad payload, voided invoice, etc.).
 */
import {
  proxyActivities,
  defineSignal,
  isCancellation,
  uuid4,
  log,
} from "@temporalio/workflow";
import type * as activities from "./activities";

// ---------------------------------------------------------------------------
// Activity proxy + retry policy
// ---------------------------------------------------------------------------

const NON_RETRYABLE = [
  "UnsupportedProvider",
  "NoMatchingInvoice",
  "InvoiceNotFound",
  "PaymentNotApplicable",
  "InvalidSignature",
  "MalformedPayload",
];

/**
 * Default retry policy for transient failures (DB blips, SMTP timeouts,
 * SMTP 4xx, network partitions, DR-mode backoff). Initial interval 1s,
 * backoff up to 30s, up to 20 attempts (~ 5–7 minutes of retrying) before
 * surfacing failure to the workflow.
 *
 * Email-related failures do NOT trigger compensation; they are caught
 * locally and logged.
 */
const defaultRetryPolicy = {
  initialInterval: "1s",
  backoffCoefficient: 2,
  maximumInterval: "30s",
  maximumAttempts: 20,
  nonRetryableErrorTypes: NON_RETRYABLE,
} as const;

const {
  checkTenantQuarantine,
  resolveInvoiceForWebhook,
  postLedgerEvent,
  sendReceiptEmail,
  recordWebhookOutcome,
  refreshTenantReadModel,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "30s",
  retry: defaultRetryPolicy,
});

// Email gets a slightly longer per-attempt timeout (Resend can be slow
// with attachment rendering). Failures are caught locally, not
// compensated.
const { sendReceiptEmail: sendReceiptEmailLong } = proxyActivities<typeof activities>({
  startToCloseTimeout: "60s",
  retry: {
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
    maximumAttempts: 8,
    nonRetryableErrorTypes: NON_RETRYABLE,
  },
});

// Audit logging gets fire-and-forget timeouts — never blocks the workflow.
const { recordWebhookOutcome: recordOutcomeFireAndForget } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: "5s",
    retry: {
      initialInterval: "1s",
      backoffCoefficient: 2,
      maximumInterval: "15s",
      maximumAttempts: 3,
      nonRetryableErrorTypes: NON_RETRYABLE,
    },
  });

// Read-model refresh gets its own fire-and-forget proxy: retries are
// short (3 attempts) and failures are swallowed — the read side
// recomputes from Postgres on cache miss, so cache writes are best-effort
// latency optimizations, not a correctness dependency.
const { refreshTenantReadModel: refreshReadModelFireAndForget } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: "15s",
    retry: {
      initialInterval: "500ms",
      backoffCoefficient: 2,
      maximumInterval: "5s",
      maximumAttempts: 3,
      nonRetryableErrorTypes: NON_RETRYABLE,
    },
  });

// ---------------------------------------------------------------------------
// Signals (future: allow an operator to "release" a quarantined workflow)
// ---------------------------------------------------------------------------
export const releaseSignal = defineSignal("release");

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------
export interface ProcessPaymentWebhookInput {
  provider: "stripe" | "razorpay";
  providerEventId: string;
  rawBody: string;
  receivedAt: string;
}

export type ProcessPaymentStatus = "applied" | "noop" | "applied_email_failed" | "failed";

export interface ProcessPaymentWebhookResult {
  status: ProcessPaymentStatus;
  invoiceId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------
export async function processPaymentWebhook(
  input: ProcessPaymentWebhookInput
): Promise<ProcessPaymentWebhookResult> {
  const ctx = {
    provider: input.provider,
    providerEventId: input.providerEventId,
    idempotencyKey: `${input.provider}:${input.providerEventId}`,
    rawBody: input.rawBody,
    receivedAt: input.receivedAt,
  };

  let resolved: Awaited<ReturnType<typeof resolveInvoiceForWebhook>> | null = null;

  try {
    // Step 1: bail if DR/quarantine (retries until healthy).
    await checkTenantQuarantine(ctx);

    // Step 2: resolve target invoice. Non-retryable failures (no invoice
    // found / malformed payload) throw ApplicationFailure with
    // nonRetryable=true and we exit no-op.
    try {
      resolved = await resolveInvoiceForWebhook(ctx);
    } catch (err) {
      if (isNonRetryable(err)) {
        await recordOutcomeFireAndForget({
          ctx,
          resolved: null,
          status: "noop",
          error: errorMessage(err),
        }).catch(() => {});
        return { status: "noop", error: errorMessage(err) };
      }
      throw err;
    }

    // Step 3: apply payment + ledger double-entry. THIS IS THE SACRED
    // STEP — once it returns with applied=true the ledger has committed
    // and we NEVER reverse it, regardless of downstream failures.
    const applyResult = await postLedgerEvent({ ctx, resolved });

    // Step 4: CQRS read-model invalidation — run IMMEDIATELY after the
    // ledger write (before email) to eliminate the stale-read window
    // between payment commit and dashboard refresh. Fire-and-forget:
    // cache is a latency optimization; read-through recompute preserves
    // correctness if this fails.
    if (applyResult.applied) {
      await refreshReadModelFireAndForget(resolved.userId).catch((err) => {
        log.warn("read-model refresh failed; read side will recompute on miss", {
          tenantId: resolved!.userId,
          err: errorMessage(err),
        });
      });
    }

    // Step 5: send receipt email. BEST-EFFORT — do NOT compensate the
    // ledger if this fails. The receipt is a customer nicety; the
    // payment is final. Retries handled by Temporal via the longer
    // activity timeout above; if retries exhaust, log and return
    // applied_email_failed so operators can re-send manually from
    // the admin console without risking a double-refund.
    let emailFailed = false;
    let emailError: string | undefined;
    try {
      if (applyResult.applied) {
        await sendReceiptEmailLong({ ctx, resolved });
      }
    } catch (err) {
      if (isCancellation(err)) throw err;
      emailFailed = true;
      emailError = `receipt email failed after retries: ${errorMessage(err)}`;
      log.warn("receipt email delivery failed; ledger commit retained", {
        invoiceId: resolved.invoiceId,
        err: emailError,
      });
    }

    // Step 6: audit record. We record the audit as "applied" even when
    // email failed (the payment did commit); the error field carries the
    // email-failure reason for operator triage.
    const terminalStatus: ProcessPaymentStatus = !applyResult.applied
      ? "noop"
      : emailFailed
      ? "applied_email_failed"
      : "applied";
    await recordOutcomeFireAndForget({
      ctx,
      resolved,
      status: applyResult.applied ? "applied" : "noop",
      error: emailError,
    }).catch(() => {});

    return {
      status: terminalStatus,
      invoiceId: resolved.invoiceId,
      error: emailError,
    };
  } catch (err) {
    if (isCancellation(err)) throw err;
    const terminalError = errorMessage(err);
    log.error("processPaymentWebhook failed", {
      providerEventId: ctx.providerEventId,
      invoiceId: resolved?.invoiceId,
      err: terminalError,
    });
    // NOTE: We do NOT reverse the ledger write here. If postLedgerEvent
    // threw, nothing was committed (the activity only returns on
    // successful commit); if it returned and a LATER step (cache/email)
    // failed, the ledger is already correct and compensation would
    // create a drift. We just record the failure for operator triage.
    await recordOutcomeFireAndForget({
      ctx,
      resolved,
      status: "failed",
      error: terminalError,
    }).catch(() => {});
    return {
      status: "failed",
      invoiceId: resolved?.invoiceId,
      error: terminalError,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers (pure, deterministic → safe in workflow code)
// ---------------------------------------------------------------------------
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}

function isNonRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; type?: string; nonRetryable?: boolean };
  if (e.nonRetryable === true) return true;
  const name = e.name ?? e.type ?? "";
  return [
    "UnsupportedProvider",
    "NoMatchingInvoice",
    "InvoiceNotFound",
    "PaymentNotApplicable",
    "InvalidSignature",
    "MalformedPayload",
  ].includes(name as string);
}

// Re-export uuid4 as a no-op convenience for future workflows that need
// deterministic workflow-side ids.
export { uuid4 };
