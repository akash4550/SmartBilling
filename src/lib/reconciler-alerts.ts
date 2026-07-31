/**
 * Reconciler drift alert hook registry.
 *
 * Mirrors the registerDlqAlertHook pattern from Batch 6: callers can
 * register zero or more hooks; the reconciler fires them after the
 * audit row commits. The default hook emits structured stderr lines so
 * drift is observable even with no external alerting wired up.
 *
 * Alert cooldowns (anti-spam):
 *   CRITICAL  → at most once per tenant per 60 minutes.
 *   HIGH      → at most once per tenant per 6 hours.
 *   MEDIUM    → at most once per tenant per 24 hours (daily rollup).
 *   INFO      → log only; never pages.
 *
 * Cooldown state is read from the reconciliation_audits table: "was an
 * alert of >= this severity fired for this tenant in the cooldown
 * window?" No Redis required.
 */
import { prisma } from "@/lib/prisma";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
export type DriftKind =
  | "HASH_CHAIN_BROKEN"
  | "TAIL_POINTER_DESYNC"
  | "UNBALANCED_EVENT"
  | "AR_MISMATCH"
  | "CASH_MISMATCH"
  | "EXPENSE_MISMATCH"
  | "ENTRY_INDEX_GAP"
  | "REVENUE_TAX_MISMATCH"
  | "TRANSIENT_ERROR";

export interface Discrepancy {
  kind: DriftKind;
  severity: Severity;
  account?: string;
  expectedPaise?: string;
  actualPaise?: string;
  diffPaise?: string;
  detail?: string;
}

export interface DriftAlertPayload {
  tenantId: string;
  tenantEmail?: string;
  severity: Severity;
  worstKind: DriftKind;
  auditId: string;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  infoCount: number;
  discrepancies: Discrepancy[];
  quarantined: boolean;
  autoRemediated: boolean;
}

export type DriftAlertHook = (payload: DriftAlertPayload) => void | Promise<void>;

const hooks: DriftAlertHook[] = [];

export function registerDriftAlertHook(hook: DriftAlertHook): void {
  hooks.push(hook);
}

const COOLDOWN_MINUTES: Record<Severity, number> = {
  CRITICAL: 60,
  HIGH: 6 * 60,
  MEDIUM: 24 * 60,
  INFO: 0,
};

function severityRank(s: Severity): number {
  return ({ CRITICAL: 4, HIGH: 3, MEDIUM: 2, INFO: 1 } as const)[s];
}

function worstSeverity(ds: readonly Discrepancy[]): Severity {
  let w: Severity = "INFO";
  for (const d of ds) {
    if (severityRank(d.severity) > severityRank(w)) w = d.severity;
  }
  return w;
}

function worstKind(ds: readonly Discrepancy[]): DriftKind {
  let w: DriftKind = "TRANSIENT_ERROR";
  let rank = 0;
  for (const d of ds) {
    const r = severityRank(d.severity);
    if (r > rank) { rank = r; w = d.kind; }
  }
  return w;
}

/**
 * Returns true if an alert at or above `sev` has fired for `tenantId`
 * within the configured cooldown window.
 *
 * Accepts any Prisma-like client (global prisma or a tx); uses a loose
 * structural type so it can be called from within withService tx.
 */
interface AuditFindCapable {
  reconciliationAudit: {
    findFirst: (
      args: {
        where?: unknown;
        select?: Record<string, unknown>;
      }
    ) => Promise<{ id: string } | null>;
  };
}

export async function alertInCooldown(
  tenantId: string,
  sev: Severity,
  client: AuditFindCapable = prisma as unknown as AuditFindCapable
): Promise<boolean> {
  const mins = COOLDOWN_MINUTES[sev];
  if (mins <= 0) return false;
  const since = new Date(Date.now() - mins * 60_000);
  type Where = Record<string, unknown>;
  const where: Where = {
    tenantId,
    triggeredAlert: true,
    startedAt: { gte: since },
  };
  if (sev === "CRITICAL") {
    where.criticalCount = { gt: 0 };
  } else if (sev === "HIGH") {
    where.OR = [
      { criticalCount: { gt: 0 } },
      { highCount: { gt: 0 } },
    ];
  } else if (sev === "MEDIUM") {
    where.OR = [
      { criticalCount: { gt: 0 } },
      { highCount: { gt: 0 } },
      { mediumCount: { gt: 0 } },
    ];
  }
  const found = await client.reconciliationAudit.findFirst({
    where,
    select: { id: true },
  });
  return found !== null;
}

/**
 * Fire drift alert hooks if cooldown permits. Returns true when hooks
 * were invoked (caller should set triggeredAlert=true on the audit row).
 */
export async function fireDriftAlerts(
  payload: Omit<DriftAlertPayload, "severity" | "worstKind" | "auditId"> & {
    discrepancies: Discrepancy[];
    auditId?: string;
  },
  client: AuditFindCapable = prisma as unknown as AuditFindCapable
): Promise<boolean> {
  if (payload.discrepancies.length === 0) return false;
  const severity = worstSeverity(payload.discrepancies);
  const wk = worstKind(payload.discrepancies);
  const full: DriftAlertPayload = {
    tenantId: payload.tenantId,
    tenantEmail: payload.tenantEmail,
    severity,
    worstKind: wk,
    auditId: payload.auditId ?? "(pending)",
    criticalCount: payload.criticalCount,
    highCount: payload.highCount,
    mediumCount: payload.mediumCount,
    infoCount: payload.infoCount,
    discrepancies: payload.discrepancies,
    quarantined: payload.quarantined,
    autoRemediated: payload.autoRemediated,
  };
  if (severity === "INFO") {
    for (const h of hooks) {
      try { await h(full); } catch { /* swallow hook errors */ }
    }
    return false;
  }
  if (await alertInCooldown(payload.tenantId, severity, client)) return false;
  for (const h of hooks) {
    try { await h(full); } catch { /* swallow hook errors */ }
  }
  return true;
}

/**
 * Install the default stderr logger. Idempotent — safe to call from
 * multiple entry points.
 */
let defaultHookInstalled = false;
export function ensureDefaultDriftAlertHook(): void {
  if (defaultHookInstalled) return;
  defaultHookInstalled = true;
  registerDriftAlertHook((p) => {
    const dis = p.discrepancies
      .slice(0, 5)
      .map((d) => `${d.kind}${d.account ? "[" + d.account + "]" : ""}${d.detail ? " " + d.detail : ""}`)
      .join("; ");
    console.error(
      `[ledger-drift-alert] severity=${p.severity} worst=${p.worstKind} tenant=${p.tenantId}${p.tenantEmail ? " email=" + p.tenantEmail : ""} audit=${p.auditId} critical=${p.criticalCount} high=${p.highCount} medium=${p.mediumCount} quarantined=${p.quarantined} autorem=${p.autoRemediated} discrepancies=${dis}`
    );
  });
}
