/**
 * GET  /api/admin/ledger/:tenantId/quarantine[?action=status]
 *      Returns current quarantine state (ledgerQuarantinedAt,
 *      ledgerQuarantineReason, lastReconciledAt) and the latest
 *      reconciliation audit row.
 *
 * POST /api/admin/ledger/:tenantId/quarantine?action=<quarantine|release|backfill|reconcile>
 *      Body (JSON):
 *        - { reason: string, force?: boolean } for quarantine/release
 *        - {} for backfill / reconcile
 *
 *      Actions:
 *        quarantine  → set quarantine flag (requires non-empty reason).
 *        release     → clear quarantine flag. If force=false, refuses to
 *                      clear unless a fresh reconcileTenant() returns
 *                      PASSED. If force=true, clears flag unconditionally
 *                      and records an auditOnly confirm run that does
 *                      not re-quarantine. Always requires a reason
 *                      (operator audit note).
 *        backfill    → run operatorBackfill (idempotent repair), return
 *                      { invoicesBackfilled, expensesBackfilled }.
 *        reconcile   → run reconcileTenant(..., { force: true }).
 *
 * Authentication (two paths, both supported):
 *   1. CRON_SECRET bearer (or ?secret=) → service/automation caller; may
 *      target any tenantId (cross-tenant cron/admin scripts).
 *   2. Signed-in user session (requireUser) → strict tenant equality:
 *      session.user.id MUST === tenantId (prevents IDOR). Cookie-authed
 *      POSTs additionally require same-origin Origin/Referer (CSRF).
 *
 * tenantId is validated against /^[A-Za-z0-9_-]{1,128}$/ before any
 * query hits the database.
 */
import { NextResponse } from "next/server";
import {
  safeCompareSecrets,
  requireUser,
  unauthorized,
  jsonError,
} from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
import {
  quarantineTenant,
  releaseQuarantine,
  operatorBackfill,
  reconcileTenant,
} from "@/lib/reconciler";
import { isSameOrigin } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_TENANT_RE = /^[A-Za-z0-9_-]{1,128}$/;
const VALID_ACTIONS = [
  "quarantine",
  "release",
  "backfill",
  "reconcile",
] as const;
type Action = (typeof VALID_ACTIONS)[number];

type OperatorAuth = {
  ok: boolean;
  response?: Response;
  actor: string;
  isService: boolean;
};

function isValidAction(a: unknown): a is Action {
  return typeof a === "string" && (VALID_ACTIONS as readonly string[]).includes(a);
}

/**
 * Authenticate the operator. Allows either:
 *   - Bearer/?secret= CRON_SECRET  → service, cross-tenant permitted.
 *   - Signed-in session            → only the caller's own tenantId.
 */
async function assertOperator(
  request: Request,
  tenantId: string
): Promise<OperatorAuth> {
  if (typeof tenantId !== "string" || !SAFE_TENANT_RE.test(tenantId)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid tenantId" }, { status: 400 }),
      actor: "",
      isService: false,
    };
  }

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (safeCompareSecrets(bearer, secret)) {
      return { ok: true, actor: "cron-secret", isService: true };
    }
    const url = new URL(request.url);
    const qs = url.searchParams.get("secret") ?? "";
    if (safeCompareSecrets(qs, secret)) {
      return { ok: true, actor: "cron-secret", isService: true };
    }
  }

  const user = await requireUser();
  if (!user) {
    return { ok: false, response: unauthorized(), actor: "", isService: false };
  }
  // Strict tenant equality for session callers (no cross-tenant IDOR).
  if (user.id !== tenantId) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      actor: "",
      isService: false,
    };
  }
  return { ok: true, actor: user.id, isService: false };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const authed = await assertOperator(request, tenantId);
  if (!authed.ok) return authed.response as Response;

  const user = await prisma.user.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      email: true,
      ledgerQuarantinedAt: true,
      ledgerQuarantineReason: true,
      lastReconciledAt: true,
      lastLedgerEntryHash: true,
    },
  });
  if (!user) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  const lastAudit = await prisma.reconciliationAudit.findFirst({
    where: { tenantId },
    orderBy: { startedAt: "desc" },
    take: 1,
  });

  return NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      ledgerQuarantinedAt: user.ledgerQuarantinedAt,
      ledgerQuarantineReason: user.ledgerQuarantineReason,
      lastReconciledAt: user.lastReconciledAt,
      lastLedgerEntryHash: user.lastLedgerEntryHash,
    },
    latestAudit: lastAudit,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const authed = await assertOperator(request, tenantId);
  if (!authed.ok) return authed.response as Response;

  // CSRF defense: cookie-authed (browser) POSTs must be same-origin.
  // Service/secret callers are exempt (they authenticate via bearer).
  if (!authed.isService && !isSameOrigin(request)) {
    return NextResponse.json(
      { error: "Cross-origin request blocked" },
      { status: 403 }
    );
  }

  const url = new URL(request.url);
  const qpAction = url.searchParams.get("action");
  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
    reason?: unknown;
    force?: boolean;
  };
  const action: unknown = qpAction ?? body.action;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : "";
  const force = !!body.force;

  if (!isValidAction(action)) {
    return NextResponse.json(
      {
        error:
          "Invalid action. Expected ?action=quarantine|release|backfill|reconcile",
      },
      { status: 400 }
    );
  }

  if (
    (action === "quarantine" || action === "release") &&
    reason.trim().length === 0
  ) {
    return NextResponse.json(
      { error: "reason required (operator audit note)" },
      { status: 400 }
    );
  }

  try {
    switch (action) {
      case "quarantine": {
        await quarantineTenant(tenantId, reason, authed.actor);
        return NextResponse.json({
          ok: true,
          action,
          quarantined: true,
        });
      }
      case "release": {
        const res = await releaseQuarantine(tenantId, reason, { force });
        if (!res.ok) {
          return NextResponse.json(
            {
              ok: false,
              action,
              released: false,
              error: res.error,
              result: res.result
                ? {
                    status: res.result.status,
                    entriesScanned: res.result.entriesScanned,
                    criticalCount: res.result.criticalCount,
                    highCount: res.result.highCount,
                    quarantined: res.result.quarantined,
                  }
                : undefined,
            },
            { status: 409 }
          );
        }
        return NextResponse.json({
          ok: true,
          action,
          released: true,
          result: res.result
            ? {
                status: res.result.status,
                entriesScanned: res.result.entriesScanned,
                criticalCount: res.result.criticalCount,
                highCount: res.result.highCount,
                quarantined: res.result.quarantined,
                autoRemediated: res.result.autoRemediated,
              }
            : undefined,
        });
      }
      case "backfill": {
        const res = await operatorBackfill(tenantId);
        return NextResponse.json({
          ok: true,
          action,
          invoicesBackfilled: res.invoices,
          expensesBackfilled: res.expenses,
          result: {
            status: res.result.status,
            entriesScanned: res.result.entriesScanned,
            criticalCount: res.result.criticalCount,
            highCount: res.result.highCount,
            quarantined: res.result.quarantined,
            autoRemediated: res.result.autoRemediated,
          },
        });
      }
      case "reconcile": {
        const res = await reconcileTenant(tenantId, { force: true });
        return NextResponse.json({
          ok: true,
          action,
          result: res,
        });
      }
    }
  } catch (err) {
    console.error(
      `[admin/quarantine:${action}] failed for ${tenantId}:`,
      err
    );
    return jsonError(
      err instanceof Error ? err.message : String(err),
      500
    );
  }
}
