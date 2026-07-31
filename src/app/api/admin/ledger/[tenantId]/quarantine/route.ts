/**
 * GET  /api/admin/ledger/:tenantId/quarantine
 *      → current quarantine state + latest audit.
 *
 * POST /api/admin/ledger/:tenantId/quarantine
 *      Body: { action: "quarantine" | "release" | "backfill" | "reconcile",
 *              reason: string, force?: boolean }
 *
 * Operator endpoint for managing ledger quarantine state. Authenticated via
 * CRON_SECRET (constant-time Bearer or ?secret=) OR a signed-in user session
 * (so admins can operate from a UI).
 *
 * Release semantics:
 *   - Without `force: true`, runs a fresh reconcileTenant() PASS check;
 *     refuses to clear the flag if any discrepancy remains.
 *   - Requires a non-empty `reason` (operator audit note) so the release
 *     event is captured in reconciliation_audits.
 *   - After clearing, runs one more reconcile (skipAutoBackfill) to record
 *     a clean PASSED audit row post-release.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual, requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
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

type OperatorAuth = {
  ok: boolean;
  actor: string;
  tenantId: string | null;
  /** True when the caller authenticated via CRON_SECRET (service call), false when cookie-authed. */
  isService: boolean;
};

/**
 * Authenticate the operator. Two paths:
 *   1. Bearer/query CRON_SECRET → service/cron caller, may target any tenantId.
 *   2. Signed-in user session   → tenant-scoped: caller's userId MUST equal
 *                                 the :tenantId path parameter (self-service).
 */
async function assertOperator(
  request: Request,
  tenantId: string
): Promise<OperatorAuth> {
  // Validate tenantId shape up front (defense-in-depth against SQLi / bad input).
  if (typeof tenantId !== "string" || !SAFE_TENANT_RE.test(tenantId)) {
    return { ok: false, actor: "", tenantId: null, isService: false };
  }
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (timingSafeEqual(token, secret)) {
      return { ok: true, actor: "cron-secret", tenantId, isService: true };
    }
    const url = new URL(request.url);
    if (timingSafeEqual(url.searchParams.get("secret") ?? "", secret)) {
      return { ok: true, actor: "cron-secret", tenantId, isService: true };
    }
  }
  const user = await requireUser();
  if (!user) return { ok: false, actor: "", tenantId: null, isService: false };
  // Tenant isolation: signed-in users may only operate on their own ledger.
  if (user.id !== tenantId) {
    return { ok: false, actor: "", tenantId: null, isService: false };
  }
  return { ok: true, actor: user.id, tenantId, isService: false };
}

type Action = "quarantine" | "release" | "backfill" | "reconcile";

function isValidAction(a: unknown): a is Action {
  return a === "quarantine" || a === "release" || a === "backfill" || a === "reconcile";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const authed = await assertOperator(request, tenantId);
  if (!authed.ok) return unauthorized();

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
  return NextResponse.json({ user, lastAudit });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const authed = await assertOperator(request, tenantId);
  if (!authed.ok) return unauthorized();

  // CSRF: cookie-authed (browser UI) POSTs must carry a same-site Origin.
  // Cron/secret callers are exempt because they authenticate via bearer.
  if (!authed.isService && !isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
    reason?: unknown;
    force?: boolean;
  };
  const action: unknown = body.action;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : "";

  if (!isValidAction(action)) {
    return NextResponse.json(
      { error: "Invalid action (expected quarantine|release|backfill|reconcile)" },
      { status: 400 }
    );
  }
  if ((action === "quarantine" || action === "release") && reason.trim().length === 0) {
    return NextResponse.json(
      { error: "reason required (operator audit note)" },
      { status: 400 }
    );
  }

  try {
    switch (action) {
      case "quarantine": {
        await quarantineTenant(tenantId, reason, authed.actor);
        return NextResponse.json({ ok: true, action, quarantined: true });
      }
      case "release": {
        const res = await releaseQuarantine(tenantId, reason, { force: !!body.force });
        return NextResponse.json({
          action,
          released: res.ok,
          error: res.error,
          result: res.result
            ? {
                status: res.result.status,
                entriesScanned: res.result.entriesScanned,
                criticalCount: res.result.criticalCount,
                highCount: res.result.highCount,
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
          },
        });
      }
      case "reconcile": {
        const res = await reconcileTenant(tenantId, { force: true });
        return NextResponse.json({ ok: true, action, result: res });
      }
    }
  } catch (err) {
    console.error(`[admin/quarantine:${action}] failed for ${tenantId}:`, err);
    return jsonError(
      err instanceof Error ? err.message : String(err),
      500
    );
  }
}
