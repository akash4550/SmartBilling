/**
 * GET/POST /api/cron/reconcile
 *
 * Cron entry point for the ledger reconciler. Supports three modes:
 *   ?mode=incremental&limit=N   (default) — reconcile tenants with
 *       activity since last run or never-reconciled, plus any currently
 *       quarantined tenants (so operator dashboards stay current).
 *       Cap N (default 20).
 *   ?mode=full                 — reconcile every tenant (nightly sweep).
 *   ?mode=single&tenantId=...  — reconcile one tenant (admin/operator).
 *
 * Auth: Bearer CRON_SECRET (timing-safe compare) or ?secret= fallback.
 * Runs under service_role (via reconcileTenant / reconcileAllTenants)
 * with service name "maint:reconcile".
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "@/lib/api-helpers";
import { reconcileAllTenants, reconcileTenant } from "@/lib/reconciler";
import { ensureDefaultDriftAlertHook } from "@/lib/reconciler-alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleRequest(request);
}
export async function POST(request: Request) {
  return handleRequest(request);
}

async function handleRequest(request: Request) {
  // ---- Auth ----
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

  ensureDefaultDriftAlertHook();

  const url = new URL(request.url);
  const mode = (url.searchParams.get("mode") ?? "incremental") as
    | "incremental"
    | "full"
    | "single";
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20),
    200
  );
  const tenantId = url.searchParams.get("tenantId");
  const force = url.searchParams.get("force") === "1";

  const SAFE_TENANT_RE = /^[A-Za-z0-9_-]{1,128}$/;

  try {
    if (mode === "single") {
      if (!tenantId || !SAFE_TENANT_RE.test(tenantId)) {
        return NextResponse.json(
          { error: "tenantId required for mode=single (safe form: [A-Za-z0-9_-]{1,128})" },
          { status: 400 }
        );
      }
      const r = await reconcileTenant(tenantId, { force });
      return NextResponse.json({ ok: true, mode, results: [r] });
    }
    const results = await reconcileAllTenants({
      mode: mode === "full" ? "full" : "incremental",
      limit: mode === "full" ? 10000 : limit,
      force,
    });
    const summary = results.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        acc.scanned += r.entriesScanned;
        acc.quarantined += r.quarantined ? 1 : 0;
        acc.autoRemediated += r.autoRemediated ? 1 : 0;
        return acc;
      },
      { scanned: 0, quarantined: 0, autoRemediated: 0 } as Record<string, number>
    );
    return NextResponse.json({ ok: true, mode, count: results.length, summary });
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
