"use server";

/**
 * Server Actions for the Admin Ledger Audit Console.
 *
 * These are invoked directly from Client Components (no HTTP round-trip):
 *   1. requireUser() + sessionVersion check; redirect("/login") on miss.
 *   2. Tenant isolation via CUID-safe regex + strict equality against
 *      session.user.id — no cross-tenant surface.
 *   3. Per-user in-process rate limit (10 actions/minute) to prevent
 *      runaway reconcile/backfill loops.
 *   4. Engine calls run under withService("maint:reconcile") via
 *      reconcileTenant/releaseQuarantine/quarantineTenant/operatorBackfill.
 *   5. Every mutation returns the engine's ReconcileResult plus a fresh
 *      overview and recent-audit bundle (hydrated via the server getters)
 *      so the UI can re-render from one response.
 *
 * Money is never passed as floats; paise stay strings and are formatted
 * client-side with Intl.NumberFormat.
 */
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
import {
  reconcileTenant,
  releaseQuarantine,
  quarantineTenant as engineQuarantineTenant,
  operatorBackfill,
} from "@/lib/reconciler";
import type { ReconcileResult } from "@/lib/reconciler";
import {
  getTenantAuditOverview,
  listReconciliationAudits,
} from "./actions";
import type { AuditRunSummary } from "./actions";

// ============================================================
// TYPES
// ============================================================

export interface ReconcileActionResult {
  ok: boolean;
  error?: string;
  audit: AuditRunSummary | null;
  overview: Awaited<ReturnType<typeof getTenantAuditOverview>> | null;
  recentAudits: AuditRunSummary[];
}

export interface ReleaseActionResult {
  ok: boolean;
  error?: string;
  released: boolean;
  forced: boolean;
  audit: AuditRunSummary | null;
  overview: Awaited<ReturnType<typeof getTenantAuditOverview>> | null;
  recentAudits: AuditRunSummary[];
}

export interface QuarantineActionResult {
  ok: boolean;
  error?: string;
  overview: Awaited<ReturnType<typeof getTenantAuditOverview>> | null;
  recentAudits: AuditRunSummary[];
}

export interface BackfillActionResult {
  ok: boolean;
  error?: string;
  invoicesBackfilled: number;
  expensesBackfilled: number;
  audit: AuditRunSummary | null;
  overview: Awaited<ReturnType<typeof getTenantAuditOverview>> | null;
  recentAudits: AuditRunSummary[];
}

// ============================================================
// VALIDATION + RATE LIMIT
// ============================================================

const SAFE_USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const AUDIT_NOTE_MAX = 500;
const RECENT_AUDITS_FETCH = 25;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function enforceRateLimit(userId: string) {
  const now = Date.now();
  let b = rateBuckets.get(userId);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(userId, b);
  }
  b.count++;
  if (b.count > RATE_MAX) {
    throw new Error("Too many requests — please wait a minute and retry.");
  }
}

function sanitizeNote(note: unknown): string {
  if (typeof note !== "string") return "";
  return note.trim().slice(0, AUDIT_NOTE_MAX);
}

function ensureTenant(sessionUserId: string, tenantId: unknown): string {
  if (
    typeof tenantId !== "string" ||
    !SAFE_USER_ID_RE.test(tenantId) ||
    tenantId !== sessionUserId
  ) {
    redirect("/login");
  }
  return tenantId;
}

async function serializeResult(
  tenantId: string,
  r: ReconcileResult
): Promise<AuditRunSummary | null> {
  // Pull the real audit row so startedAt/finishedAt/durationMs are
  // authoritative (don't approximate startedAt from Date.now()-duration).
  const row = await prisma.reconciliationAudit.findUnique({
    where: { id: r.auditId },
  });
  if (!row) return null;
  type Disc = AuditRunSummary["discrepancies"][number];
  let discrepancies: Disc[] = [];
  if (Array.isArray(row.discrepancies)) {
    discrepancies = (row.discrepancies as unknown as Disc[]).map((d) => ({
      kind: String(d.kind ?? "UNKNOWN"),
      severity: (d.severity as Disc["severity"]) ?? "INFO",
      account: typeof d.account === "string" ? d.account : undefined,
      expectedPaise:
        typeof d.expectedPaise === "string" ? d.expectedPaise : undefined,
      actualPaise: typeof d.actualPaise === "string" ? d.actualPaise : undefined,
      diffPaise: typeof d.diffPaise === "string" ? d.diffPaise : undefined,
      detail: typeof d.detail === "string" ? d.detail : undefined,
    }));
  }
  return {
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    durationMs: row.durationMs,
    status: row.status,
    entriesScanned: row.entriesScanned,
    firstBrokenIndex: row.firstBrokenIndex,
    discrepancies,
    criticalCount: row.criticalCount,
    highCount: row.highCount,
    mediumCount: row.mediumCount,
    infoCount: row.infoCount,
    autoRemediated: row.autoRemediated,
    workerId: row.workerId,
    version: row.version,
  } as AuditRunSummary;
}

async function hydrate(tenantId: string) {
  const [overview, recentAudits] = await Promise.all([
    getTenantAuditOverview(tenantId),
    listReconciliationAudits(tenantId, RECENT_AUDITS_FETCH),
  ]);
  return { overview, recentAudits };
}

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================
// PUBLIC ACTIONS
// ============================================================

export async function triggerTenantReconcileAction(
  tenantId: string
): Promise<ReconcileActionResult> {
  const user = await requireUser();
  if (!user) redirect("/login");
  const uid = ensureTenant(user.id, tenantId);
  try {
    enforceRateLimit(uid);
  } catch (e) {
    return { ok: false, error: toError(e), audit: null, overview: null, recentAudits: [] };
  }
  try {
    const result = await reconcileTenant(uid, { force: true });
    const audit = await serializeResult(uid, result);
    const h = await hydrate(uid);
    return { ok: true, audit, overview: h.overview, recentAudits: h.recentAudits };
  } catch (err) {
    console.error("[admin/ledger] triggerReconcile failed:", err);
    return {
      ok: false, error: toError(err), audit: null, overview: null, recentAudits: [],
    };
  }
}

export async function releaseTenantQuarantineAction(
  tenantId: string,
  auditNoteReason: string,
  opts: { force?: boolean } = {}
): Promise<ReleaseActionResult> {
  const user = await requireUser();
  if (!user) redirect("/login");
  const uid = ensureTenant(user.id, tenantId);
  const forced = !!opts.force;
  const note = sanitizeNote(auditNoteReason);
  if (note.length === 0) {
    return {
      ok: false,
      error: "An audit note is required before releasing quarantine.",
      released: false, forced,
      audit: null, overview: null, recentAudits: [],
    };
  }
  try {
    enforceRateLimit(uid);
  } catch (e) {
    return { ok: false, error: toError(e), released: false, forced, audit: null, overview: null, recentAudits: [] };
  }
  try {
    const res = await releaseQuarantine(uid, note, { force: forced });
    const audit = res.result ? await serializeResult(uid, res.result) : null;
    const h = await hydrate(uid);
    return {
      ok: res.ok,
      error: res.error,
      released: res.ok,
      forced,
      audit,
      overview: h.overview,
      recentAudits: h.recentAudits,
    };
  } catch (err) {
    console.error("[admin/ledger] releaseQuarantine failed:", err);
    return {
      ok: false, error: toError(err), released: false, forced,
      audit: null, overview: null, recentAudits: [],
    };
  }
}

export async function quarantineTenantAction(
  tenantId: string,
  auditNoteReason: string
): Promise<QuarantineActionResult> {
  const user = await requireUser();
  if (!user) redirect("/login");
  const uid = ensureTenant(user.id, tenantId);
  const note = sanitizeNote(auditNoteReason);
  if (note.length === 0) {
    return { ok: false, error: "An audit note is required to quarantine.", overview: null, recentAudits: [] };
  }
  try {
    enforceRateLimit(uid);
  } catch (e) {
    return { ok: false, error: toError(e), overview: null, recentAudits: [] };
  }
  try {
    await engineQuarantineTenant(uid, note, `user:${user.id}`);
    const h = await hydrate(uid);
    return { ok: true, overview: h.overview, recentAudits: h.recentAudits };
  } catch (err) {
    console.error("[admin/ledger] quarantine failed:", err);
    return { ok: false, error: toError(err), overview: null, recentAudits: [] };
  }
}

export async function backfillTenantAction(
  tenantId: string
): Promise<BackfillActionResult> {
  const user = await requireUser();
  if (!user) redirect("/login");
  const uid = ensureTenant(user.id, tenantId);
  try {
    enforceRateLimit(uid);
  } catch (e) {
    return {
      ok: false, error: toError(e),
      invoicesBackfilled: 0, expensesBackfilled: 0, audit: null,
      overview: null, recentAudits: [],
    };
  }
  try {
    const res = await operatorBackfill(uid);
    const audit = await serializeResult(uid, res.result);
    const h = await hydrate(uid);
    return {
      ok: true,
      invoicesBackfilled: res.invoices,
      expensesBackfilled: res.expenses,
      audit,
      overview: h.overview,
      recentAudits: h.recentAudits,
    };
  } catch (err) {
    console.error("[admin/ledger] backfill failed:", err);
    return {
      ok: false, error: toError(err),
      invoicesBackfilled: 0, expensesBackfilled: 0, audit: null,
      overview: null, recentAudits: [],
    };
  }
}
