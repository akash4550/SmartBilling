"use server";

/**
 * Server Actions (COMMANDS) for the Admin Ledger Audit Console.
 *
 * -------------------------------------------------------------------
 * BOUNDARY NOTE: this file carries the module-level `"use server"`
 * directive. Every exported async function is exposed as a Server
 * Action — a serializable reference that can be passed across the
 * RSC/Client boundary and invoked from `useFormStatus`/button handlers
 * in `_components/ledger-admin.tsx` without an HTTP round-trip.
 *
 * Clean separation from `./actions.ts`:
 *   mutations.ts  → COMMANDS. State-mutating operations (reconcile,
 *                   release-quarantine, quarantine, backfill) plus the
 *                   one client-invoked read action (loadMoreLedger
 *                   EntriesAction) which must be a Server Action to
 *                   be callable from the "use client" pagination UI.
 *   actions.ts    → QUERIES. Pure read-only data loaders (getTenant
 *                   AuditOverview, getLedgerChainEntries, listRecon
 *                   ciliationAudits) used by the RSC page and by these
 *                   mutations for post-mutation hydration. They are
 *                   plain server functions — NOT Server Actions — so
 *                   they are not bundled into the client action
 *                   manifest and cannot be invoked directly from the
 *                   browser.
 *
 * Shared invariants enforced by every action:
 *   1. `requireUser()` + `redirect("/login")` on session miss.
 *   2. Strict tenant isolation: tenantId must match
 *      /^[A-Za-z0-9_-]{1,128}$/ AND equal session.user.id (no IDOR).
 *   3. DR-mode guard (`assertReadWriteMode`) fires BEFORE rate-limit
 *      and before any DB write so maintenance windows fail-fast.
 *   4. Distributed per-user rate limit: 10 actions / 60-second sliding
 *      window (see src/lib/rate-limiter.ts).
 *   5. Engine calls go straight to reconcileTenant / releaseQuarantine
 *      / quarantineTenant / operatorBackfill (no fetch() to our own
 *      API).
 *   6. Every mutation returns a UNIFIED refresh payload
 *      `{ ok, error?, audit?, overview, recentAudits }` so the client
 *      hydrates the banner, chain, and audit history in one RTT.
 *      Action-specific fields (`released`, `forced`, `invoicesBack
 *      filled`, `expensesBackfilled`) sit alongside the base.
 *
 * Money is never passed as floats; paise are stringified BigInts all
 * the way through to the client.
 * -------------------------------------------------------------------
 */
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
import { assertMutationRateLimit } from "@/lib/rate-limiter";
import { assertReadWriteMode } from "@/lib/dr-mode";
import {
  reconcileTenant,
  releaseQuarantine,
  quarantineTenant as engineQuarantineTenant,
  operatorBackfill,
  type ReconcileResult,
} from "@/lib/reconciler";
import {
  getTenantAuditOverview,
  getLedgerChainEntries,
  listReconciliationAudits,
  type AuditRunSummary,
  type TenantAuditOverview,
  type LedgerChainPage,
} from "./actions";

// ============================================================
// TYPES
// ============================================================

/**
 * Unified action result. Every action returns at least these fields.
 * Action-specific extras (released, forced, invoicesBackfilled, etc.)
 * are appended on the individual action return types.
 */
interface BaseActionResult {
  ok: boolean;
  error?: string;
  audit: AuditRunSummary | null;
  overview: TenantAuditOverview | null;
  recentAudits: AuditRunSummary[];
}

export interface ReconcileActionResult extends BaseActionResult {}

export interface ReleaseActionResult extends BaseActionResult {
  released: boolean;
  forced: boolean;
}

export interface QuarantineActionResult extends BaseActionResult {}

export interface BackfillActionResult extends BaseActionResult {
  invoicesBackfilled: number;
  expensesBackfilled: number;
}

/** Result of a "load more ledger entries" keyset-cursor page fetch. */
export interface LoadMoreEntriesResult {
  ok: boolean;
  error?: string;
  page: LedgerChainPage | null;
}

// ============================================================
// VALIDATION / RATE LIMIT / HYDRATION
// ============================================================

const SAFE_USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const AUDIT_NOTE_MAX = 500;
const RECENT_AUDITS_FETCH = 25;

function sanitizeNote(note: unknown): string {
  if (typeof note !== "string") return "";
  return note.trim().slice(0, AUDIT_NOTE_MAX);
}

/**
 * Enforce auth + tenant identity. On failure we redirect() (mutations
 * without a session should bounce to /login). When the input is
 * malformed (tenantId regex / session mismatch), same redirect — we
 * never reveal "that tenant exists but isn't yours".
 */
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

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyHydration(): {
  overview: null;
  recentAudits: AuditRunSummary[];
} {
  return { overview: null, recentAudits: [] };
}

async function hydrate(tenantId: string): Promise<{
  overview: TenantAuditOverview;
  recentAudits: AuditRunSummary[];
}> {
  const [overview, recentAudits] = await Promise.all([
    getTenantAuditOverview(tenantId),
    listReconciliationAudits(tenantId, RECENT_AUDITS_FETCH),
  ]);
  return { overview, recentAudits };
}

/**
 * Build the AuditRunSummary for a reconcile run by looking up the
 * actual audit row by its id (authoritative startedAt / finishedAt /
 * durationMs — we don't approximate startedAt from Date.now()-duration).
 */
async function serializeResult(
  r: ReconcileResult
): Promise<AuditRunSummary | null> {
  const row = await prisma.reconciliationAudit.findUnique({
    where: { id: r.auditId },
  });
  if (!row) return null;
  type Disc = AuditRunSummary["discrepancies"][number];
  let discrepancies: Disc[] = [];
  if (Array.isArray(row.discrepancies)) {
    discrepancies = (row.discrepancies as unknown as Disc[]).map((d) => ({
      kind: typeof d?.kind === "string" ? d.kind : "UNKNOWN",
      severity:
        d &&
        typeof d === "object" &&
        "severity" in d &&
        (d.severity === "CRITICAL" ||
          d.severity === "HIGH" ||
          d.severity === "MEDIUM" ||
          d.severity === "INFO")
          ? d.severity
          : "INFO",
      account:
        d && typeof d === "object" && "account" in d && typeof d.account === "string"
          ? d.account
          : undefined,
      expectedPaise:
        d && typeof d === "object" && "expectedPaise" in d && typeof d.expectedPaise === "string"
          ? d.expectedPaise
          : undefined,
      actualPaise:
        d && typeof d === "object" && "actualPaise" in d && typeof d.actualPaise === "string"
          ? d.actualPaise
          : undefined,
      diffPaise:
        d && typeof d === "object" && "diffPaise" in d && typeof d.diffPaise === "string"
          ? d.diffPaise
          : undefined,
      detail:
        d && typeof d === "object" && "detail" in d && typeof d.detail === "string"
          ? d.detail
          : undefined,
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
  };
}

// ============================================================
// PUBLIC ACTIONS
// ============================================================

/** Trigger an on-demand reconcile (force=true skips min-interval gate). */
export async function triggerTenantReconcileAction(
  tenantId: string
): Promise<ReconcileActionResult> {
  const session = await requireUser();
  if (!session) redirect("/login");
  const uid = ensureTenant(session.id, tenantId);
  try {
    assertReadWriteMode("admin/ledger:reconcile");
    await assertMutationRateLimit(uid);
  } catch (e) {
    return { ok: false, error: toError(e), audit: null, ...emptyHydration() };
  }
  try {
    const result = await reconcileTenant(uid, { force: true });
    const audit = await serializeResult(result);
    const h = await hydrate(uid);
    return { ok: true, audit, ...h };
  } catch (err) {
    console.error("[admin/ledger] triggerReconcile failed:", err);
    return { ok: false, error: toError(err), audit: null, ...emptyHydration() };
  }
}

/**
 * Release quarantine. If force=false the engine refuses to clear the
 * flag unless a fresh reconcile returns PASSED. If force=true the flag
 * is cleared unconditionally and a confirm-run in auditOnly mode logs
 * residual drift without re-quarantining. An audit note is always
 * required (captured as an INFO audit row).
 */
export async function releaseTenantQuarantineAction(
  tenantId: string,
  auditNoteReason: string,
  opts: { force?: boolean } = {}
): Promise<ReleaseActionResult> {
  const session = await requireUser();
  if (!session) redirect("/login");
  const uid = ensureTenant(session.id, tenantId);
  const forced = !!opts.force;
  const note = sanitizeNote(auditNoteReason);
  if (note.length === 0) {
    return {
      ok: false,
      error: "An audit note is required before releasing quarantine.",
      released: false,
      forced,
      audit: null,
      ...emptyHydration(),
    };
  }
  try {
    assertReadWriteMode("admin/ledger:release-quarantine");
    await assertMutationRateLimit(uid);
  } catch (e) {
    return {
      ok: false,
      error: toError(e),
      released: false,
      forced,
      audit: null,
      ...emptyHydration(),
    };
  }
  try {
    const res = await releaseQuarantine(uid, note, { force: forced });
    const audit = res.result ? await serializeResult(res.result) : null;
    const h = await hydrate(uid);
    return {
      ok: res.ok,
      error: res.error,
      released: res.ok,
      forced,
      audit,
      ...h,
    };
  } catch (err) {
    console.error("[admin/ledger] releaseQuarantine failed:", err);
    return {
      ok: false,
      error: toError(err),
      released: false,
      forced,
      audit: null,
      ...emptyHydration(),
    };
  }
}

/** Manually flip the quarantine flag (operator-only action). */
export async function quarantineTenantAction(
  tenantId: string,
  auditNoteReason: string
): Promise<QuarantineActionResult> {
  const session = await requireUser();
  if (!session) redirect("/login");
  const uid = ensureTenant(session.id, tenantId);
  const note = sanitizeNote(auditNoteReason);
  if (note.length === 0) {
    return {
      ok: false,
      error: "An audit note is required to quarantine.",
      audit: null,
      ...emptyHydration(),
    };
  }
  try {
    assertReadWriteMode("admin/ledger:quarantine");
    await assertMutationRateLimit(uid);
  } catch (e) {
    return { ok: false, error: toError(e), audit: null, ...emptyHydration() };
  }
  try {
    await engineQuarantineTenant(uid, note, `user:${session.id}`);
    const h = await hydrate(uid);
    return { ok: true, audit: null, ...h };
  } catch (err) {
    console.error("[admin/ledger] quarantine failed:", err);
    return {
      ok: false,
      error: toError(err),
      audit: null,
      ...emptyHydration(),
    };
  }
}

/**
 * Load a page of hash-chain entries using keyset-cursor pagination.
 *
 * This is a read-only action but we run it through the same auth /
 * tenant-isolation / rate-limit pipeline as mutations so a compromised
 * browser session cannot be used to scrape another tenant's chain.
 * Returns a bare LedgerChainPage (no overview/audit re-hydration) to
 * keep the RTT small for pagination.
 *
 * Pass `cursor: null` (or the sentinel "__reset__") to fetch the first
 * page from the chain tail; this is used by refreshChain() after a
 * mutation so newly appended entries appear at the top.
 */
export async function loadMoreLedgerEntriesAction(
  tenantId: string,
  cursor: string | null,
  limit: number = 50
): Promise<LoadMoreEntriesResult> {
  const session = await requireUser();
  if (!session) redirect("/login");
  const uid = ensureTenant(session.id, tenantId);
  const reset = cursor === null || cursor === "__reset__";
  if (!reset) {
    // Cursors are CUIDs generated by Prisma; enforce a simple shape check
    // before passing them to the getter to avoid weird injection surfaces
    // through findFirst().
    if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(cursor)) {
      return { ok: false, error: "Invalid cursor", page: null };
    }
  }
  try {
    await assertMutationRateLimit(uid);
  } catch (e) {
    return { ok: false, error: toError(e), page: null };
  }
  try {
    const page = await getLedgerChainEntries(uid, {
      cursor: reset ? null : cursor,
      limit,
    });
    return { ok: true, page };
  } catch (err) {
    console.error("[admin/ledger] loadMore failed:", err);
    return { ok: false, error: toError(err), page: null };
  }
}

/**
 * Run the idempotent backfill (catches un-ledgered invoices/expenses)
 * then a reconcile with skipAutoBackfill (avoids a second backfill
 * pass inside the engine) and return backfilled counts along with the
 * hydrated payload.
 */
export async function backfillTenantAction(
  tenantId: string
): Promise<BackfillActionResult> {
  const session = await requireUser();
  if (!session) redirect("/login");
  const uid = ensureTenant(session.id, tenantId);
  try {
    assertReadWriteMode("admin/ledger:backfill");
    await assertMutationRateLimit(uid);
  } catch (e) {
    return {
      ok: false,
      error: toError(e),
      invoicesBackfilled: 0,
      expensesBackfilled: 0,
      audit: null,
      ...emptyHydration(),
    };
  }
  try {
    const res = await operatorBackfill(uid);
    const audit = await serializeResult(res.result);
    const h = await hydrate(uid);
    return {
      ok: true,
      invoicesBackfilled: res.invoices,
      expensesBackfilled: res.expenses,
      audit,
      ...h,
    };
  } catch (err) {
    console.error("[admin/ledger] backfill failed:", err);
    return {
      ok: false,
      error: toError(err),
      invoicesBackfilled: 0,
      expensesBackfilled: 0,
      audit: null,
      ...emptyHydration(),
    };
  }
}
