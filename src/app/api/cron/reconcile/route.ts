/**
 * GET/POST /api/cron/reconcile
 *
 * Primary cron entry point for the Automated Ledger Drift & Integrity
 * Reconciler. Supports three modes:
 *
 *   ?mode=incremental&limit=N   (default: limit=20, max 200)
 *       Reconcile tenants where lastReconciledAt is null, older than
 *       15 minutes, OR the tenant is currently quarantined (so operator
 *       dashboards see fresh audit history during incident response).
 *
 *   ?mode=full&limit=N
 *       Reconcile every tenant (nightly sweep at 03:00 IST).
 *
 *   ?mode=single&tenantId=<id>&force=1
 *       Reconcile one tenant (admin/operator trigger). tenantId must
 *       match /^[A-Za-z0-9_-]{1,128}$/.
 *
 * Auth: Bearer CRON_SECRET (timingSafeEqual) or ?secret= fallback.
 * Refuses to run in production without CRON_SECRET configured.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     mode,
 *     count,
 *     summary: {
 *       PASSED, DRIFT_DETECTED, HASH_BROKEN, TRANSIENT_FAILURE,
 *       totalEntriesScanned, newlyQuarantined, autoRemediated
 *     }
 *   }
 */
import { NextResponse } from "next/server";
import { safeCompareSecrets } from "@/lib/api-helpers";
import {
  reconcileAllTenants,
  reconcileTenant,
  type ReconcileResult,
} from "@/lib/reconciler";
import { ensureDefaultDriftAlertHook } from "@/lib/reconciler-alerts";
import type { ReconciliationStatus } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_TENANT_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const FULL_MODE_LIMIT_CAP = 1000;

type Summary = {
  PASSED: number;
  DRIFT_DETECTED: number;
  HASH_BROKEN: number;
  TRANSIENT_FAILURE: number;
  totalEntriesScanned: number;
  newlyQuarantined: number;
  autoRemediated: number;
};

function emptySummary(): Summary {
  return {
    PASSED: 0,
    DRIFT_DETECTED: 0,
    HASH_BROKEN: 0,
    TRANSIENT_FAILURE: 0,
    totalEntriesScanned: 0,
    newlyQuarantined: 0,
    autoRemediated: 0,
  };
}

function summarize(results: readonly ReconcileResult[]): Summary {
  const s = emptySummary();
  for (const r of results) {
    const key = r.status as ReconciliationStatus;
    if (key === "PASSED" || key === "DRIFT_DETECTED" || key === "HASH_BROKEN" || key === "TRANSIENT_FAILURE") {
      s[key]++;
    }
    s.totalEntriesScanned += r.entriesScanned;
    if (r.quarantined) s.newlyQuarantined++;
    if (r.autoRemediated) s.autoRemediated++;
  }
  return s;
}

async function authenticate(request: Request): Promise<{ ok: boolean; error?: Response }> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (safeCompareSecrets(token, secret)) return { ok: true };
    const url = new URL(request.url);
    const qs = url.searchParams.get("secret") ?? "";
    if (safeCompareSecrets(qs, secret)) return { ok: true };
    return { ok: false, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (process.env.NODE_ENV === "production") {
    return {
      ok: false,
      error: NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 }),
    };
  }
  return { ok: true };
}

export async function GET(request: Request) {
  return handleRequest(request);
}
export async function POST(request: Request) {
  return handleRequest(request);
}

async function handleRequest(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.error as Response;

  ensureDefaultDriftAlertHook();

  const url = new URL(request.url);
  const modeRaw = url.searchParams.get("mode") ?? "incremental";
  const mode =
    modeRaw === "full" || modeRaw === "single" ? modeRaw : "incremental";

  const parsedLimit = parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(
    Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_LIMIT),
    MAX_LIMIT
  );
  const tenantId = url.searchParams.get("tenantId");
  const force = url.searchParams.get("force") === "1";

  try {
    if (mode === "single") {
      if (!tenantId || !SAFE_TENANT_RE.test(tenantId)) {
        return NextResponse.json(
          {
            error:
              "tenantId required for mode=single (must match /^[A-Za-z0-9_-]{1,128}$/)",
          },
          { status: 400 }
        );
      }
      const r = await reconcileTenant(tenantId, { force });
      return NextResponse.json({
        ok: true,
        mode,
        count: 1,
        summary: summarize([r]),
      });
    }

    const results = await reconcileAllTenants({
      mode: mode === "full" ? "full" : "incremental",
      limit: mode === "full" ? FULL_MODE_LIMIT_CAP : limit,
      force,
    });
    return NextResponse.json({
      ok: true,
      mode,
      count: results.length,
      summary: summarize(results),
    });
  } catch (err) {
    console.error("[cron/reconcile] Worker error:", err);
    return NextResponse.json(
      {
        error: "Reconcile worker failure",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
