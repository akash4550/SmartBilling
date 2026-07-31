/**
 * GET /api/admin/ledger/:tenantId/audit?limit=N
 *
 * Return recent reconciliation audit rows for a tenant (newest first).
 * Authenticated via CRON_SECRET or signed-in user (same as quarantine).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual, requireUser, unauthorized, jsonError } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_TENANT_RE = /^[A-Za-z0-9_-]{1,128}$/;

async function assertOperator(
  request: Request,
  tenantId: string
): Promise<boolean> {
  if (typeof tenantId !== "string" || !SAFE_TENANT_RE.test(tenantId)) return false;
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (timingSafeEqual(token, secret)) return true;
    const url = new URL(request.url);
    if (timingSafeEqual(url.searchParams.get("secret") ?? "", secret)) return true;
  }
  const user = await requireUser();
  if (!user) return false;
  // Tenant isolation: signed-in users may only read their own audits.
  return user.id === tenantId;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const ok = await assertOperator(request, tenantId);
  if (!ok) return unauthorized();

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
    500
  );

  try {
    const audits = await prisma.reconciliationAudit.findMany({
      where: { tenantId },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
    return NextResponse.json({ tenantId, count: audits.length, audits });
  } catch (err) {
    console.error("[admin/audit] failed:", err);
    return jsonError(
      err instanceof Error ? err.message : String(err),
      500
    );
  }
}
