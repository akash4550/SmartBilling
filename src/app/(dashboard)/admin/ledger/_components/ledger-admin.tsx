"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import {
  ShieldAlert,
  ShieldCheck,
  Activity,
  RefreshCw,
  LockKeyhole,
  Unlock,
  Copy,
  ChevronRight,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Database,
  FileText,
  Landmark,
  Wallet,
  TrendingUp,
  Receipt,
  X,
  Eye,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
  useFocusTrap,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import {
  type TenantAuditOverview,
  type AuditRunSummary,
  type LedgerChainEntry,
} from "../actions";
import {
  triggerTenantReconcileAction,
  releaseTenantQuarantineAction,
  backfillTenantAction,
  quarantineTenantAction,
  loadMoreLedgerEntriesAction,
  type ReconcileActionResult,
  type ReleaseActionResult,
  type BackfillActionResult,
  type QuarantineActionResult,
} from "../mutations";
import {
  formatPaise,
  shortHash,
  formatTime,
  formatDuration,
  ACCOUNT_LABELS,
  EVENT_LABELS,
  DRIFT_LABELS,
} from "./format";

// Note: the WCAG 2.1 AA focus-trap hook `useFocusTrap` is imported from
// @/components/ui/dialog and shared with the global <DialogContent>
// primitive. Both the bespoke admin ledger panels (Release / Quarantine
// / Paise Inspector) and every other modal in the app use the same
// implementation, eliminating duplication and guaranteeing consistent
// Tab-wrap / Escape / return-focus behavior across the product.

// ============================================================
// STATUS / HEALTH
// ============================================================

type HealthStatus = "healthy" | "warning" | "quarantined" | "unknown";

type OptimisticOp =
  | "RECONCILING"
  | "QUARANTINING"
  | "RELEASING"
  | "BACKFILLING"
  | null;

function deriveHealth(ov: TenantAuditOverview): HealthStatus {
  if (ov.ledgerQuarantinedAt) return "quarantined";
  const lat = ov.latestAudit;
  if (!lat) return "unknown";
  if (lat.status === "HASH_BROKEN") return "quarantined";
  if (lat.status === "DRIFT_DETECTED") {
    if (lat.criticalCount > 0) return "quarantined";
    if (lat.highCount > 0 || lat.mediumCount > 0) return "warning";
  }
  if (lat.status === "PASSED") return "healthy";
  return "unknown";
}

const OPTIMISTIC_META: Record<
  NonNullable<OptimisticOp>,
  { label: string; tone: "info" | "warning"; describe: string }
> = {
  RECONCILING: {
    label: "Reconciling…",
    tone: "info",
    describe: "Sweeping hash chain, verifying balances, and writing audit.",
  },
  BACKFILLING: {
    label: "Backfilling…",
    tone: "info",
    describe: "Re-posting any missing ledger entries and re-verifying.",
  },
  QUARANTINING: {
    label: "Quarantining…",
    tone: "warning",
    describe: "Flipping quarantine flag; writes will pause.",
  },
  RELEASING: {
    label: "Releasing…",
    tone: "warning",
    describe: "Running verification and clearing quarantine flag.",
  },
};

function StatusBadge({ status }: { status: AuditRunSummary["status"] }) {
  switch (status) {
    case "PASSED":
      return (
        <Badge variant="success" className="gap-1">
          <CheckCircle2 className="h-3 w-3" /> Passed
        </Badge>
      );
    case "DRIFT_DETECTED":
      return (
        <Badge variant="warning" className="gap-1">
          <AlertTriangle className="h-3 w-3" /> Drift
        </Badge>
      );
    case "HASH_BROKEN":
      return (
        <Badge variant="danger" className="gap-1">
          <ShieldAlert className="h-3 w-3" /> Hash Broken
        </Badge>
      );
    case "TRANSIENT_FAILURE":
      return (
        <Badge variant="secondary" className="gap-1">
          <Activity className="h-3 w-3" /> Transient
        </Badge>
      );
  }
}

/**
 * Optimistic in-flight badge. Shown during a mutation before the server
 * round-trip completes so the operator gets immediate visual feedback
 * that their click was accepted. The spinner + animate-pulse + ring-2
 * pulse together make it unambiguously "working" without shifting layout.
 */
function OptimisticBadge({ op }: { op: NonNullable<OptimisticOp> }) {
  const meta = OPTIMISTIC_META[op];
  const cls =
    meta.tone === "warning"
      ? "bg-amber-50 text-amber-700 ring-amber-600/30 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/30 animate-pulse"
      : "bg-blue-50 text-blue-700 ring-blue-600/30 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-400/30 animate-pulse";
  return (
    <Badge variant="secondary" className={cn("gap-1 ring-1 ring-inset", cls)}>
      <Loader2 className="h-3 w-3 animate-spin" />
      {meta.label}
    </Badge>
  );
}

function SeverityPill({
  count,
  tone,
  label,
}: {
  count: number;
  tone: "critical" | "high" | "medium" | "info";
  label: string;
}) {
  if (count === 0) return null;
  const cls = {
    critical:
      "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950/40 dark:text-red-400 dark:ring-red-400/20",
    high: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-400 dark:ring-amber-400/20",
    medium:
      "bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-950/40 dark:text-blue-400 dark:ring-blue-400/20",
    info: "bg-slate-100 text-slate-600 ring-slate-400/20 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-500/20",
  }[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        cls
      )}
    >
      {count} {label}
    </span>
  );
}

// ============================================================
// SMALL HELPERS
// ============================================================

function CopyHash({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  const resetTimerRef = React.useRef<number | null>(null);

  // Guarantee unmount safety: if the component unmounts while the
  // "copied" acknowledgement timer is pending, clear it so we never
  // call setCopied on an unmounted component (React 19 strict-mode
  // safe; prevents the "setState on unmounted component" warning and
  // the associated retained-closure leak).
  React.useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, []);

  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();

      // Clear any prior reset timer so rapid repeated clicks don't
      // race each other (the last success wins the ack window).
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }

      // Silently swallow clipboard rejections (non-secure contexts,
      // iframe sandboxes, blurred tabs, Permissions-Policy: clipboard).
      // We prefer an explicit `.catch(() => {})` over relying on
      // `void`-discarded rejections to keep unhandledrejection events
      // out of operator consoles.
      const writeP =
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
          ? navigator.clipboard.writeText(value)
          : Promise.reject(new Error("clipboard unavailable"));

      Promise.resolve(writeP)
        .then(() => {
          setCopied(true);
          resetTimerRef.current = window.setTimeout(() => {
            resetTimerRef.current = null;
            setCopied(false);
          }, 1200);
        })
        .catch(() => {
          // No user-facing error: copy affordance is a convenience,
          // not a critical path. Silently fail closed.
        });
    },
    [value]
  );

  return (
    <button
      type="button"
      onClick={handleClick}
      className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition"
      title="Copy hash"
      aria-label="Copy hash"
    >
      <Copy className={cn("h-3 w-3", copied && "text-emerald-500")} />
    </button>
  );
}

function SideChip({ side }: { side: "DEBIT" | "CREDIT" | string }) {
  if (side === "DEBIT") {
    return (
      <Badge variant="info" className="font-mono text-[10px] px-1.5 py-0">
        Dr
      </Badge>
    );
  }
  return (
    <Badge variant="warning" className="font-mono text-[10px] px-1.5 py-0">
      Cr
    </Badge>
  );
}

// ============================================================
// RELEASE / QUARANTINE MODALS (WCAG 2.1 AA accessible)
// ============================================================
//
// Both dialogs wrap their content in the hand-rolled accessible
// panel described above, with role="dialog", aria-modal="true",
// aria-labelledby pointing to the title, aria-describedby pointing
// to the description, focus-trap Tab wrapping, Escape dismissal,
// backdrop click-to-close (with .stopPropagation inside the card),
// and guaranteed return-focus to the triggering button.
//
// We keep using <Dialog> (provider) + <DialogTrigger> for state +
// scroll-lock; <DialogContent> is intentionally NOT used because
// the hand-rolled primitive below gives us a proper labelled-by
// association and focus trap without modifying the shared UI kit.
// The Dialog primitive still applies body scroll-lock (overflow:hidden)
// while open, which we want.

const NOTE_MAX = 500;

/**
 * Shared classes for the dark/light modal panel (mirrors the original
 * `DialogContent` look-and-feel so no visual regressions occur).
 */
const DIALOG_PANEL_CLASS =
  "relative z-10 w-full max-w-md rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xl border border-slate-200 dark:border-slate-700 max-h-[90vh] overflow-y-auto";
const DIALOG_BACKDROP_CLASS =
  "absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in";
const DIALOG_CLOSE_BUTTON_CLASS =
  "absolute right-4 top-4 rounded-sm opacity-70 text-slate-500 dark:text-slate-400 ring-offset-white dark:ring-offset-slate-900 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-slate-950 dark:focus:ring-slate-300 focus:ring-offset-2";

function ReleaseDialog({
  overview,
  onReleased,
  onStart,
  onSettle,
  disabled,
}: {
  overview: TenantAuditOverview;
  onReleased: (r: ReleaseActionResult) => void;
  onStart?: () => void;
  onSettle?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [force, setForce] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const titleId = React.useId();
  const descId = React.useId();
  const noteRef = React.useRef<HTMLTextAreaElement | null>(null);
  const trapRef = useFocusTrap({
    active: open,
    onClose: () => setOpen(false),
    initialFocusRef: noteRef,
  });

  const trimmed = note.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= NOTE_MAX && !submitting;

  function resetForm() {
    setNote("");
    setForce(false);
    setError(null);
  }

  async function onSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    // Optimistic UI: tell the parent we've started so HealthBanner
    // can flip to "RELEASING…" before the server round-trip completes.
    onStart?.();
    try {
      const res = await releaseTenantQuarantineAction(overview.tenantId, trimmed, {
        force,
      });
      if (!res.ok) {
        setError(res.error ?? "Release failed.");
        // The dialog stays open so the operator can read the error and
        // retry — clear the optimistic override so the banner returns
        // to the authoritative server state.
        onSettle?.();
        return;
      }
      setOpen(false);
      resetForm();
      onReleased(res);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
      <DialogTrigger asChild>
        <Button
          variant="default"
          size="sm"
          className="gap-1.5"
          disabled={disabled}
        >
          <Unlock className="h-4 w-4" /> Release Quarantine…
        </Button>
      </DialogTrigger>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          // Portal-like container; Dialog already locks body scroll.
        >
          {/* Backdrop (click outside → close) */}
          <div
            className={DIALOG_BACKDROP_CLASS}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          {/* Accessible panel */}
          <div
            ref={trapRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            tabIndex={-1}
            className={DIALOG_PANEL_CLASS}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={DIALOG_CLOSE_BUTTON_CLASS}
              aria-label="Close dialog"
              disabled={submitting}
            >
              <X className="h-4 w-4" />
            </button>

            <DialogHeader>
              <DialogTitle id={titleId} className="flex items-center gap-2">
                <Unlock className="h-5 w-5 text-amber-600" />
                Release Ledger Quarantine
              </DialogTitle>
              <DialogDescription id={descId}>
                Before clearing the quarantine flag, a fresh reconciliation
                will run. The flag is only cleared if the sweep passes. Force
                release skips re-verification (emergency use only) and is
                permanently recorded in the audit trail.
              </DialogDescription>
            </DialogHeader>

            <div className="px-6 pb-2 space-y-4">
              <div className="rounded-lg border border-amber-200/70 dark:border-amber-900/40 bg-amber-50/60 dark:bg-amber-950/20 p-3 text-sm text-amber-900 dark:text-amber-300">
                <div className="font-medium">Quarantine reason</div>
                <div className="mt-0.5 font-mono text-xs text-amber-800 dark:text-amber-400/90 break-all">
                  {overview.ledgerQuarantineReason ?? "n/a"}
                </div>
                <div className="mt-1 text-xs text-amber-800/80 dark:text-amber-400/70">
                  Since {formatTime(overview.ledgerQuarantinedAt)}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="release-note">
                  Audit note <span className="text-red-500">*</span>
                </Label>
                <Textarea
                  id="release-note"
                  ref={noteRef}
                  value={note}
                  onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
                  placeholder="Describe the remediation and who authorized release…"
                  className="min-h-[90px]"
                />
                <p className="text-xs text-slate-500">
                  Required ({trimmed.length}/{NOTE_MAX}). Stored permanently
                  in{" "}
                  <code className="font-mono">reconciliation_audits</code>.
                </p>
              </div>

              <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
                />
                <span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    Force release (emergency override)
                  </span>{" "}
                  <span className="text-slate-500 dark:text-slate-400">
                    — skip the mandatory PASS check. A confirm run will log
                    residual drift without re-quarantining.
                  </span>
                </span>
              </label>

              {error && (
                <div
                  className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                  role="alert"
                >
                  {error}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOpen(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                variant={force ? "destructive" : "default"}
                size="sm"
                disabled={!canSubmit}
                onClick={onSubmit}
                type="button"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                {force ? "Force Release" : "Verify & Release"}
              </Button>
            </DialogFooter>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function QuarantineDialog({
  overview,
  onQuarantined,
  onStart,
  onSettle,
  disabled,
}: {
  overview: TenantAuditOverview;
  onQuarantined: (r: QuarantineActionResult) => void;
  onStart?: () => void;
  onSettle?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const titleId = React.useId();
  const descId = React.useId();
  const noteRef = React.useRef<HTMLTextAreaElement | null>(null);
  const trapRef = useFocusTrap({
    active: open,
    onClose: () => setOpen(false),
    initialFocusRef: noteRef,
  });

  const trimmed = note.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= NOTE_MAX && !submitting;

  function resetForm() {
    setNote("");
    setError(null);
  }

  async function onSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    onStart?.();
    try {
      const res = await quarantineTenantAction(overview.tenantId, trimmed);
      if (!res.ok) {
        setError(res.error ?? "Quarantine failed.");
        onSettle?.();
        return;
      }
      setOpen(false);
      resetForm();
      onQuarantined(res);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-red-600 dark:text-red-400 border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-950/30"
          disabled={disabled}
        >
          <LockKeyhole className="h-4 w-4" /> Quarantine…
        </Button>
      </DialogTrigger>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className={DIALOG_BACKDROP_CLASS}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={trapRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            tabIndex={-1}
            className={DIALOG_PANEL_CLASS}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={DIALOG_CLOSE_BUTTON_CLASS}
              aria-label="Close dialog"
              disabled={submitting}
            >
              <X className="h-4 w-4" />
            </button>

            <DialogHeader>
              <DialogTitle
                id={titleId}
                className="flex items-center gap-2 text-red-600 dark:text-red-400"
              >
                <LockKeyhole className="h-5 w-5" /> Manually Quarantine Ledger
              </DialogTitle>
              <DialogDescription id={descId}>
                Immediately blocks all financial writes for this tenant.
                Customer webhook payments are held (status PENDING, attempts
                NOT incremented) and resume after release. A reason is
                required for the audit trail.
              </DialogDescription>
            </DialogHeader>

            <div className="px-6 pb-2 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="quarantine-note">
                  Reason <span className="text-red-500">*</span>
                </Label>
                <Textarea
                  id="quarantine-note"
                  ref={noteRef}
                  value={note}
                  onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
                  placeholder="Describe the suspicious activity or incident…"
                  className="min-h-[90px]"
                />
                <p className="text-xs text-slate-500">
                  Required ({trimmed.length}/{NOTE_MAX}).
                </p>
              </div>
              {error && (
                <div
                  className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                  role="alert"
                >
                  {error}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOpen(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={!canSubmit}
                onClick={onSubmit}
                type="button"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                Quarantine Now
              </Button>
            </DialogFooter>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ============================================================
// SECTION A — HEALTH BANNER
// ============================================================

function HealthBanner({
  overview,
  optimisticOp,
  latestError,
  onReconcile,
  onBackfill,
  onRelease,
  onReleaseStart,
  onQuarantineStart,
  onSettle,
}: {
  overview: TenantAuditOverview;
  optimisticOp: OptimisticOp;
  latestError: string | null;
  onReconcile: () => void;
  onBackfill: () => void;
  onRelease: (r: ReleaseActionResult | QuarantineActionResult) => void;
  onReleaseStart: () => void;
  onQuarantineStart: () => void;
  /** Called by the Release/Quarantine dialogs when they close in error
   *  (rejected by server) so the parent can clear its optimistic flag. */
  onSettle: () => void;
}) {
  const status = deriveHealth(overview);
  const quarantined = !!overview.ledgerQuarantinedAt;
  // Single source of truth for busy state: derived purely from the
  // optimistic op. While any mutation is in flight, ALL conflicting
  // banner action buttons are disabled to prevent double-submits and
  // concurrent-write races, and each button reflects its own
  // aria-busy state only when it is the active action.
  const isBusy = optimisticOp !== null;

  const palette = {
    healthy: {
      bar: "bg-gradient-to-r from-emerald-500/90 to-emerald-600/90",
      ring: "ring-emerald-500/20",
      title: "Ledger Healthy",
      desc: "All integrity checks passed on the most recent run.",
      icon: <ShieldCheck className="h-6 w-6" />,
    },
    warning: {
      bar: "bg-gradient-to-r from-amber-500/90 to-orange-500/90",
      ring: "ring-amber-500/20",
      title: "Drift Detected",
      desc: "Non-critical mismatches found. Review audit history and consider a backfill & re-verify.",
      icon: <AlertTriangle className="h-6 w-6" />,
    },
    quarantined: {
      bar: "bg-gradient-to-r from-red-500/90 to-rose-600/90",
      ring: "ring-red-500/20",
      title: "Ledger Quarantined",
      desc: "Financial writes are blocked. Customer webhook payments are queued (not dropped) and resume after release.",
      icon: <LockKeyhole className="h-6 w-6" />,
    },
    unknown: {
      bar: "bg-gradient-to-r from-slate-500/90 to-slate-700/90",
      ring: "ring-slate-500/20",
      title: "Never Reconciled",
      desc: "Run the reconciler to establish a baseline for this tenant.",
      icon: <Activity className="h-6 w-6" />,
    },
  }[status];

  // When an optimistic operation is active, we override the banner title's
  // description and replace the static status badge with a pulsing
  // "working" badge. The server state remains visible in the metrics
  // cards and palette accent bar, so the operator always sees both the
  // current truth and the in-flight intent.
  const title = optimisticOp ? OPTIMISTIC_META[optimisticOp].label.replace("…", "") : palette.title;
  const desc = optimisticOp ? OPTIMISTIC_META[optimisticOp].describe : palette.desc;

  // Δ = ledger (ground truth) − expected (read model). 0 → reconciled (green),
  // non-zero → drift (red). All arithmetic is BigInt over string paise.
  const arDelta =
    BigInt(overview.ledgerArPaise) - BigInt(overview.openReceivablePaise);
  const cashDelta =
    BigInt(overview.ledgerCashPaise) - BigInt(overview.expectedCashPaise);
  const currency = overview.currency;

  return (
    <Card className="overflow-hidden">
      <div className={cn("h-1.5", palette.bar)} />
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white ring-4",
              palette.bar,
              palette.ring
            )}
          >
            {palette.icon}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-xl">{title}</CardTitle>
              {optimisticOp ? (
                <OptimisticBadge op={optimisticOp} />
              ) : quarantined ? (
                <Badge variant="danger" className="gap-1 animate-pulse">
                  <LockKeyhole className="h-3 w-3" /> WRITES BLOCKED
                </Badge>
              ) : overview.latestAudit ? (
                <StatusBadge status={overview.latestAudit.status} />
              ) : null}
            </div>
            <CardDescription className="mt-1 max-w-2xl">
              {desc}
            </CardDescription>
            {quarantined && overview.ledgerQuarantineReason && (
              <div className="mt-2 flex items-center gap-2 text-xs font-mono text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/40 rounded px-2 py-1">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  Reason: <strong>{overview.ledgerQuarantineReason}</strong>
                </span>
              </div>
            )}
            {latestError && (
              <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                {latestError}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onReconcile}
            disabled={isBusy}
            className="gap-1.5"
            aria-busy={isBusy && optimisticOp === "RECONCILING"}
          >
            {isBusy && optimisticOp === "RECONCILING" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {isBusy && optimisticOp === "RECONCILING"
              ? "Reconciling…"
              : "Run Reconciler Now"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onBackfill}
            disabled={isBusy}
            className="gap-1.5"
            aria-busy={isBusy && optimisticOp === "BACKFILLING"}
          >
            {isBusy && optimisticOp === "BACKFILLING" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Database className="h-4 w-4" />
            )}
            {isBusy && optimisticOp === "BACKFILLING"
              ? "Backfilling…"
              : "Backfill &amp; Re-verify"}
          </Button>
          {quarantined ? (
            <ReleaseDialog
              overview={overview}
              onReleased={onRelease}
              onStart={onReleaseStart}
              onSettle={onSettle}
              disabled={isBusy}
            />
          ) : (
            <QuarantineDialog
              overview={overview}
              onQuarantined={onRelease}
              onStart={onQuarantineStart}
              onSettle={onSettle}
              disabled={isBusy}
            />
          )}
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            icon={<Landmark className="h-4 w-4" />}
            label="Open Receivables"
            value={formatPaise(overview.openReceivablePaise, currency)}
            delta={arDelta}
            currency={currency}
          />
          <Metric
            icon={<Wallet className="h-4 w-4" />}
            label="Cash (ledger)"
            value={formatPaise(overview.ledgerCashPaise, currency)}
            delta={cashDelta}
            currency={currency}
          />
          <Metric
            icon={<Receipt className="h-4 w-4" />}
            label="Paid Invoices (Σ)"
            value={formatPaise(overview.paidTotalPaise, currency)}
          />
          <Metric
            icon={<TrendingUp className="h-4 w-4" />}
            label="Expenses (Σ)"
            value={formatPaise(overview.expenseTotalPaise, currency)}
            hideDelta
          />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-4 text-xs">
          <Stat label="Last reconciled" value={formatTime(overview.lastReconciledAt)} />
          <Stat
            label="30d runs"
            value={String(
              overview.runCounts.passed +
                overview.runCounts.driftDetected +
                overview.runCounts.hashBroken +
                overview.runCounts.transientFailure
            )}
          />
          <Stat
            label="30d drift"
            value={String(
              overview.runCounts.driftDetected + overview.runCounts.hashBroken
            )}
          />
          <Stat
            label="Tail hash"
            mono
            value={
              overview.lastLedgerEntryHash
                ? shortHash(overview.lastLedgerEntryHash, 8)
                : "—"
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({
  icon,
  label,
  value,
  delta,
  currency,
  hideDelta,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  delta?: bigint;
  currency?: string;
  hideDelta?: boolean;
}) {
  const d = delta ?? BigInt(0);
  const reconciled = d === BigInt(0);
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 p-3">
      <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {value}
      </div>
      {!hideDelta && (
        <div
          className={cn(
            "mt-0.5 text-xs tabular-nums",
            reconciled
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
          )}
        >
          {reconciled
            ? "reconciled"
            : `Δ ${formatPaise(d.toString(), currency ?? "INR", {
                showSign: true,
              })}`}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md px-2 py-1.5">
      <div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 text-sm font-medium text-slate-700 dark:text-slate-200 break-all",
          mono && "font-mono text-xs"
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ============================================================
// SECTION B — HASH-CHAIN EXPLORER
// ============================================================

function ChainExplorer({
  entries,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  entries: LedgerChainEntry[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  function toggle(id: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-slate-400" /> Hash-Chain Explorer
          </CardTitle>
          <CardDescription>
            Newest entries first. Click a row to inspect the full SHA-256 chain link.
          </CardDescription>
        </div>
        <Badge variant="secondary" className="font-mono shrink-0">
          {entries.length} rows
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-slate-200 dark:border-slate-800 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                <th className="px-4 py-2 font-medium w-16">#</th>
                <th className="px-3 py-2 font-medium">Event</th>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium w-16">Side</th>
                <th className="px-3 py-2 font-medium text-right w-32">Amount</th>
                <th className="px-3 py-2 font-medium">Entry Hash</th>
                <th className="w-8 pr-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {entries.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-10 text-center text-slate-500"
                  >
                    No ledger entries yet. Create an invoice to seed the chain.
                  </td>
                </tr>
              )}
              {entries.map((e) => {
                const open = expanded.has(e.id);
                return (
                  <React.Fragment key={e.id}>
                    <tr
                      className={cn(
                        "hover:bg-slate-50 dark:hover:bg-slate-900/40 transition cursor-pointer",
                        open && "bg-slate-50 dark:bg-slate-900/40"
                      )}
                      onClick={() => toggle(e.id)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          toggle(e.id);
                        }
                      }}
                      tabIndex={0}
                      aria-expanded={open}
                    >
                      <td className="px-4 py-2 font-mono text-xs text-slate-500">
                        {e.entryIndex}
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-800 dark:text-slate-200">
                          {EVENT_LABELS[e.eventType] ?? e.eventType}
                        </div>
                        <div className="text-xs text-slate-500 font-mono truncate max-w-[200px]">
                          {e.eventId}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                        {ACCOUNT_LABELS[e.account] ?? e.account}
                      </td>
                      <td className="px-3 py-2">
                        <SideChip side={e.side} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-900 dark:text-slate-100">
                        {formatPaise(e.amountPaise, e.currency)}
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center font-mono text-xs text-slate-700 dark:text-slate-300">
                          <span className="text-emerald-600 dark:text-emerald-400">
                            {shortHash(e.entryHash, 8)}
                          </span>
                          <CopyHash value={e.entryHash} />
                        </span>
                      </td>
                      <td className="pr-3">
                        <ChevronRight
                          className={cn(
                            "h-4 w-4 text-slate-400 transition",
                            open && "rotate-90"
                          )}
                        />
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-50 dark:bg-slate-900/40">
                        <td colSpan={7} className="px-6 py-3">
                          <div className="grid gap-3 md:grid-cols-2 text-xs">
                            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3">
                              <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1.5">
                                Hash Chain Link
                              </div>
                              <div className="space-y-1 font-mono text-[11px]">
                                <div className="flex items-start gap-2">
                                  <span className="shrink-0 text-slate-500 w-12">
                                    prev
                                  </span>
                                  <span className="break-all text-slate-600 dark:text-slate-400">
                                    {e.prevEntryHash}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 text-slate-400 pl-12">
                                  ↓
                                </div>
                                <div className="flex items-start gap-2">
                                  <span className="shrink-0 text-slate-500 w-12">
                                    entry
                                  </span>
                                  <span className="break-all text-emerald-700 dark:text-emerald-400 font-semibold">
                                    {e.entryHash}
                                  </span>
                                  <CopyHash value={e.entryHash} />
                                </div>
                              </div>
                            </div>
                            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3">
                              <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1.5">
                                Metadata
                              </div>
                              <dl className="grid grid-cols-[90px,1fr] gap-y-1 text-[11px]">
                                <dt className="text-slate-500">entryId</dt>
                                <dd className="font-mono text-slate-700 dark:text-slate-300 break-all">
                                  {e.id}
                                </dd>
                                <dt className="text-slate-500">eventId</dt>
                                <dd className="font-mono text-slate-700 dark:text-slate-300 break-all">
                                  {e.eventId}
                                </dd>
                                <dt className="text-slate-500">invoice</dt>
                                <dd className="font-mono text-slate-700 dark:text-slate-300">
                                  {e.invoiceId ?? "—"}
                                </dd>
                                <dt className="text-slate-500">expense</dt>
                                <dd className="font-mono text-slate-700 dark:text-slate-300">
                                  {e.expenseId ?? "—"}
                                </dd>
                                <dt className="text-slate-500">currency</dt>
                                <dd className="font-mono text-slate-700 dark:text-slate-300">
                                  {e.currency}
                                </dd>
                                <dt className="text-slate-500">created</dt>
                                <dd className="text-slate-700 dark:text-slate-300">
                                  {formatTime(e.createdAt)}
                                </dd>
                                {e.note && (
                                  <>
                                    <dt className="text-slate-500">note</dt>
                                    <dd className="text-slate-700 dark:text-slate-300 col-span-2">
                                      {e.note}
                                    </dd>
                                  </>
                                )}
                              </dl>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {hasMore && (
          <div className="border-t border-slate-100 dark:border-slate-800/70 px-4 py-3 flex items-center justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={onLoadMore}
              disabled={loadingMore}
              className="gap-1.5"
            >
              {loadingMore ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ChevronRight className="h-4 w-4 rotate-90" />
              )}
              {loadingMore ? "Loading…" : "Load 50 More Entries"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// AUDIT DRIFT INSPECTOR MODAL ("Paise Inspector")
// ============================================================
//
// Accessible detail modal for Section C audit history. Operators can
// open it from the summary row; it renders a zero-float paise
// Expected / Actual / Δ comparison table for each drift that carries
// integer amounts, plus a discrepancy taxonomy list with severity
// pills and standardized engineering explanations pulled from
// DRIFT_LABELS.

interface PaiseDiffRow {
  label: string;
  account?: string;
  expectedPaise: string;
  actualPaise: string;
  diffPaise: string;
}

function PaiseDelta({
  diffPaise,
  currency = "INR",
  zero = "reconciled",
}: {
  diffPaise: string;
  currency?: string;
  zero?: string;
}) {
  let d = BigInt(0);
  try {
    d = BigInt(diffPaise);
  } catch {
    d = BigInt(0);
  }
  if (d === BigInt(0)) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium tabular-nums">
        <CheckCircle2 className="h-3.5 w-3.5" /> {zero}
      </span>
    );
  }
  const tone =
    d < BigInt(0)
      ? "text-red-600 dark:text-red-400"
      : "text-red-600 dark:text-red-400";
  return (
    <span className={cn("tabular-nums font-medium", tone)}>
      {formatPaise(diffPaise, currency, { showSign: true })}
    </span>
  );
}

function SeverityBar({
  criticalCount,
  highCount,
  mediumCount,
  infoCount,
}: {
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  infoCount: number;
}) {
  const total = criticalCount + highCount + mediumCount + infoCount;
  if (total === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-4 w-4" />
        Zero discrepancies — all accounts reconciled.
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {criticalCount > 0 && (
        <Badge variant="danger" className="gap-1">
          {criticalCount} critical
        </Badge>
      )}
      {highCount > 0 && (
        <Badge variant="warning" className="gap-1">
          {highCount} high
        </Badge>
      )}
      {mediumCount > 0 && (
        <Badge variant="info" className="gap-1">
          {mediumCount} medium
        </Badge>
      )}
      {infoCount > 0 && (
        <Badge variant="secondary" className="gap-1">
          {infoCount} info
        </Badge>
      )}
    </div>
  );
}

function AuditInspectorModal({
  audit,
  currency,
  open,
  onOpenChange,
}: {
  audit: AuditRunSummary | null;
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const titleId = React.useId();
  const descId = React.useId();
  const trapRef = useFocusTrap({
    active: open,
    onClose: () => onOpenChange(false),
    // Route initial focus to the Close button so keyboard users land
    // somewhere immediately dismissable when the Paise Inspector opens
    // via row click (preserves prior UX).
    initialFocusRef: closeRef,
  });

  // Derive paise diff rows ONLY from those discrepancies that carry
  // integer-paise expected/actual fields (AR/CASH/EXPENSE mismatches).
  // Hash-chain/gap/transient discrepancies are text-only in the list.
  const paiseRows = React.useMemo<PaiseDiffRow[]>(() => {
    if (!audit) return [];
    const rows: PaiseDiffRow[] = [];
    for (const d of audit.discrepancies) {
      if (d.expectedPaise != null || d.actualPaise != null || d.diffPaise != null) {
        const label = DRIFT_LABELS[d.kind]?.label ?? d.kind;
        rows.push({
          label,
          account: d.account,
          expectedPaise: d.expectedPaise ?? "0",
          actualPaise: d.actualPaise ?? "0",
          diffPaise:
            d.diffPaise ??
            (() => {
              try {
                return (
                  BigInt(d.actualPaise ?? "0") - BigInt(d.expectedPaise ?? "0")
                ).toString();
              } catch {
                return "0";
              }
            })(),
        });
      }
    }
    return rows;
  }, [audit]);

  if (!audit || !open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
    >
      <div
        className={DIALOG_BACKDROP_CLASS}
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />
      <div
        ref={trapRef}
        tabIndex={-1}
        className={cn(DIALOG_PANEL_CLASS, "max-w-2xl")}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          ref={closeRef}
          onClick={() => onOpenChange(false)}
          className={DIALOG_CLOSE_BUTTON_CLASS}
          aria-label="Close dialog"
        >
          <X className="h-4 w-4" />
        </button>

        <DialogHeader>
          <DialogTitle id={titleId} className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-slate-500" />
            Paise Inspector — Audit Run
            <StatusBadge status={audit.status} />
          </DialogTitle>
          <DialogDescription id={descId}>
            Zero-float paise comparison for this reconciliation run. All
            amounts are integer subunits (paise) rendered through{" "}
            <code className="font-mono">formatPaise</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-4 space-y-4">
          {/* Metadata strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <Meta label="Started" value={formatTime(audit.startedAt)} />
            <Meta
              label="Duration"
              value={formatDuration(audit.durationMs ?? undefined)}
            />
            <Meta label="Entries scanned" value={String(audit.entriesScanned)} />
            <Meta
              label="First broken index"
              value={
                audit.firstBrokenIndex != null
                  ? String(audit.firstBrokenIndex)
                  : "—"
              }
            />
          </div>

          <div>
            <SeverityBar
              criticalCount={audit.criticalCount}
              highCount={audit.highCount}
              mediumCount={audit.mediumCount}
              infoCount={audit.infoCount}
            />
          </div>

          {audit.autoRemediated && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300 flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                Auto-backfill was applied during this run — drift was
                self-remediated inside a single REPEATABLE READ tx and the
                confirm sweep returned clean.
              </span>
            </div>
          )}

          {/* Paise comparison table */}
          {paiseRows.length > 0 && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
              <div className="bg-slate-50 dark:bg-slate-900/60 px-3 py-2 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-2">
                <Database className="h-3.5 w-3.5" /> Expected vs. Ledger Actual
                (paise)
              </div>
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="border-y border-slate-200 dark:border-slate-800 text-left text-[11px] uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2 font-medium">Account</th>
                    <th className="px-3 py-2 font-medium text-right">Expected</th>
                    <th className="px-3 py-2 font-medium text-right">Actual</th>
                    <th className="px-3 py-2 font-medium text-right">Δ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                  {paiseRows.map((row, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-800 dark:text-slate-200">
                          {row.label}
                        </div>
                        {row.account && (
                          <div className="text-[11px] text-slate-500 font-mono">
                            {ACCOUNT_LABELS[row.account] ?? row.account}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-700 dark:text-slate-300">
                        {formatPaise(row.expectedPaise, currency)}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-700 dark:text-slate-300">
                        {formatPaise(row.actualPaise, currency)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <PaiseDelta diffPaise={row.diffPaise} currency={currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Discrepancy taxonomy list — every discrepancy appears here */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5 flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5" /> Drift Taxonomy
            </div>
            {audit.discrepancies.length === 0 ? (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-950/20 p-3 text-sm text-emerald-800 dark:text-emerald-300">
                No discrepancies reported by Sweep A or Sweep B.
              </div>
            ) : (
              <ul className="space-y-2">
                {audit.discrepancies.map((d, i) => {
                  const meta =
                    DRIFT_LABELS[d.kind] ?? { label: d.kind, hint: "" };
                  const sevTone =
                    ({
                      CRITICAL: "danger",
                      HIGH: "warning",
                      MEDIUM: "info",
                      INFO: "secondary",
                    } as const)[d.severity] ?? "secondary";
                  return (
                    <li
                      key={i}
                      className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={sevTone} className="text-[10px]">
                          {d.severity}
                        </Badge>
                        <span className="font-medium text-sm text-slate-800 dark:text-slate-200">
                          {meta.label}
                        </span>
                        {d.account && (
                          <span className="text-xs text-slate-500">
                            ({ACCOUNT_LABELS[d.account] ?? d.account})
                          </span>
                        )}
                        <span className="ml-auto font-mono text-[10px] text-slate-400">
                          {d.kind}
                        </span>
                      </div>
                      {d.detail && (
                        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 font-mono break-all">
                          {d.detail}
                        </p>
                      )}
                      {meta.hint && (
                        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-500">
                          {meta.hint}
                        </p>
                      )}
                      {/* Render inline Expected/Actual/Δ for rows that carry
                          amounts AND are not already in the table above. */}
                      {(d.expectedPaise || d.actualPaise || d.diffPaise) && (
                        <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] font-mono">
                          <div>
                            <div className="text-slate-500">expected</div>
                            <div>
                              {formatPaise(d.expectedPaise ?? "0", currency)}
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-500">actual</div>
                            <div>
                              {formatPaise(d.actualPaise ?? "0", currency)}
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-500">Δ</div>
                            <PaiseDelta
                              diffPaise={
                                d.diffPaise ??
                                (() => {
                                  try {
                                    return (
                                      BigInt(d.actualPaise ?? "0") -
                                      BigInt(d.expectedPaise ?? "0")
                                    ).toString();
                                  } catch {
                                    return "0";
                                  }
                                })()
                              }
                              currency={currency}
                            />
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Footer metadata (worker/version/id) for cross-reference */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 font-mono pt-1 border-t border-slate-100 dark:border-slate-800/70">
            <span>worker: {audit.workerId ?? "n/a"}</span>
            <span>v{audit.version}</span>
            <span>id: {audit.id}</span>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="default"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-medium text-slate-800 dark:text-slate-200 font-mono truncate">
        {value}
      </div>
    </div>
  );
}

// ============================================================
// SECTION C — AUDIT HISTORY
// ============================================================

const sevBadgeVariant = {
  CRITICAL: "danger",
  HIGH: "warning",
  MEDIUM: "info",
  INFO: "secondary",
} as const;

function AuditHistory({
  audits,
  currency,
  onInspect,
}: {
  audits: AuditRunSummary[];
  currency: string;
  onInspect: (audit: AuditRunSummary) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-slate-400" /> Reconciliation Audit
          History
        </CardTitle>
        <CardDescription>
          Append-only record of every reconciler run for this tenant. Click
          the eye icon or a row to open the Paise Inspector.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-slate-100 dark:divide-slate-800/70 max-h-[640px] overflow-y-auto">
          {audits.length === 0 && (
            <div className="p-10 text-center text-slate-500 text-sm">
              No reconciliation runs yet. Click &quot;Run Reconciler Now&quot;
              to create the first audit.
            </div>
          )}
          {audits.map((a) => (
            <details key={a.id} className="group">
              <summary className="flex cursor-pointer list-none items-center gap-3 px-6 py-3 hover:bg-slate-50 dark:hover:bg-slate-900/40">
                <ChevronRight className="h-4 w-4 text-slate-400 transition group-open:rotate-90 shrink-0" />
                <button
                  type="button"
                  className="flex-1 min-w-0 text-left"
                  onClick={(e) => {
                    // The <summary> element handles open/close on click
                    // already; this button only intercepts to open the
                    // Paise Inspector. Using preventDefault stops the
                    // <summary> toggle from firing when the user clicked
                    // explicitly on the button.
                    e.preventDefault();
                    e.stopPropagation();
                    onInspect(a);
                  }}
                  aria-label={`Inspect audit run ${a.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={a.status} />
                    <span className="text-xs text-slate-500 tabular-nums">
                      {formatTime(a.startedAt)}
                    </span>
                    <span className="text-xs text-slate-400">·</span>
                    <span className="text-xs text-slate-500">
                      {a.entriesScanned} rows · {formatDuration(a.durationMs ?? undefined)}
                    </span>
                    {a.autoRemediated && (
                      <Badge variant="info" className="text-[10px]">
                        auto-backfilled
                      </Badge>
                    )}
                  </div>
                </button>
                <div className="flex items-center gap-1.5 shrink-0">
                  <SeverityPill count={a.criticalCount} tone="critical" label="crit" />
                  <SeverityPill count={a.highCount} tone="high" label="high" />
                  <SeverityPill count={a.mediumCount} tone="medium" label="med" />
                  <SeverityPill count={a.infoCount} tone="info" label="info" />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="ml-1 h-7 px-2 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onInspect(a);
                    }}
                    title="Open Paise Inspector"
                    aria-label={`Inspect audit run ${a.id}`}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    <span className="ml-1 text-xs">Inspect</span>
                  </Button>
                </div>
              </summary>
              <div className="px-6 pb-4 pl-[46px]">
                {a.discrepancies.length === 0 ? (
                  <div className="text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4" /> No discrepancies.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {a.discrepancies.map((d, i) => {
                      const meta =
                        DRIFT_LABELS[d.kind] ?? { label: d.kind, hint: "" };
                      const tone =
                        (sevBadgeVariant[
                          d.severity as keyof typeof sevBadgeVariant
                        ] as "danger" | "warning" | "info" | "secondary") ??
                        "secondary";
                      return (
                        <li
                          key={i}
                          className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30 p-3"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={tone} className="text-[10px]">
                              {d.severity}
                            </Badge>
                            <span className="font-medium text-sm text-slate-800 dark:text-slate-200">
                              {meta.label}
                            </span>
                            {d.account && (
                              <span className="text-xs text-slate-500">
                                ({ACCOUNT_LABELS[d.account] ?? d.account})
                              </span>
                            )}
                          </div>
                          {d.detail && (
                            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                              {d.detail}
                            </p>
                          )}
                          {meta.hint && (
                            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-500">
                              {meta.hint}
                            </p>
                          )}
                          {(d.expectedPaise || d.actualPaise) && (
                            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] font-mono">
                              <div>
                                <div className="text-slate-500">expected</div>
                                <div>
                                  {formatPaise(d.expectedPaise ?? "0")}
                                </div>
                              </div>
                              <div>
                                <div className="text-slate-500">actual</div>
                                <div>{formatPaise(d.actualPaise ?? "0")}</div>
                              </div>
                              <div>
                                <div className="text-slate-500">Δ</div>
                                <div
                                  className={
                                    BigInt(d.diffPaise ?? "0") === BigInt(0)
                                      ? "text-emerald-600"
                                      : "text-red-600"
                                  }
                                >
                                  {formatPaise(d.diffPaise ?? "0", undefined, {
                                    showSign: true,
                                  })}
                                </div>
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 font-mono">
                  <span>worker: {a.workerId ?? "n/a"}</span>
                  <span>v{a.version}</span>
                  <span>broken index: {a.firstBrokenIndex ?? "—"}</span>
                  <span>id: {a.id}</span>
                </div>
              </div>
            </details>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// ROOT CLIENT COMPONENT
// ============================================================

const CHAIN_PAGE_SIZE = 50;
const CHAIN_FETCH_MAX = 200;

/**
 * Merge an incoming page of older entries into the existing list.
 *
 * - Entries are keyed by `id` so an entry already in the list (appended
 *   by a concurrent mutation / refresh) is never duplicated. React
 *   key collisions produce duplicate-key console warnings and can
 *   mis-pair state in the expand-rows `Set`, so we deduplicate
 *   defensively on every append.
 * - Existing entries win on id collision: they are the newer /
 *   authoritative rows already visible to the user; an older page
 *   must never reorder, duplicate, or replace them.
 */
function mergeEntries(
  existing: LedgerChainEntry[],
  incoming: LedgerChainEntry[]
): LedgerChainEntry[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return incoming.slice();
  const seen = new Set<string>(existing.map((e) => e.id));
  const out: LedgerChainEntry[] = existing.slice();
  for (const e of incoming) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

export default function LedgerAdmin(props: {
  initialOverview: TenantAuditOverview;
  initialEntries: LedgerChainEntry[];
  initialNextCursor: string | null;
  initialAudits: AuditRunSummary[];
}) {
  const router = useRouter();
  const [overview, setOverview] = React.useState<TenantAuditOverview>(
    props.initialOverview
  );
  const [entries, setEntries] = React.useState<LedgerChainEntry[]>(
    props.initialEntries
  );
  const [audits, setAudits] = React.useState<AuditRunSummary[]>(
    props.initialAudits
  );
  const [error, setError] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  /**
   * Single source of truth for in-flight banner mutations. Set
   * synchronously when the operator clicks a banner button (or confirms
   * a dialog submit); cleared on settle (success or failure) once
   * router.refresh() + refreshChain() have pulled the authoritative
   * server state. Drives:
   *   1. The pulsing HealthBanner status badge (OptimisticBadge).
   *   2. The banner title + description override.
   *   3. A unified `isBusy` flag that disables ALL conflicting banner
   *      action buttons (Reconcile / Backfill / Release / Quarantine)
   *      to prevent double-submits and concurrent-write races.
   *   4. The `aria-busy` attribute on each banner button, so screen
   *      readers announce the exact in-flight action.
   *
   * Deriving busy state from this single value eliminates any drift
   * window where a boolean `running` flag and the optimistic op enum
   * could disagree and leave a button enabled while a request is still
   * in flight (or vice versa).
   */
  const [optimisticOp, setOptimisticOp] = React.useState<OptimisticOp>(null);

  function clearOptimistic() {
    setOptimisticOp(null);
  }
  /**
   * Keyset cursor: id of the oldest entry currently rendered. Null means
   * we've loaded all the way back to genesis (or the server returned a
   * full page with no sentinel on first paint — won't happen with our
   * LIMIT+1 logic, but handled safely).
   */
  const [nextCursor, setNextCursor] = React.useState<string | null>(
    props.initialNextCursor
  );

  /**
   * Request epoch to defeat pagination/reset races. Every time the
   * chain is reset (initial load, post-mutation refreshChain) we bump
   * this counter. Any in-flight `loadMore()` whose epoch no longer
   * matches the current one is discarded when it resolves, so:
   *   - A slow `loadMore` cannot clobber a just-completed reset.
   *   - Two rapid clicks of "Load More" cannot double-append (the
   *     loadingMore guard also suppresses the second click, but the
   *     epoch gives us a hard guarantee even if state updates interleave).
   *   - A mutation firing mid-`loadMore` cannot result in a mixed
   *     view of pre- and post-mutation cursors.
   * Starts at 1 so a value of 0 is never "live" (initial page is set
   * synchronously and no async fetch is yet in flight).
   */
  const chainEpochRef = React.useRef(1);

  // Track the newest audit id we've toasted for so we don't double-toast on
  // first paint.
  const lastAuditIdRef = React.useRef<string | null>(
    props.initialOverview.latestAudit?.id ?? null
  );

  // Hold a stable ref to the current tenantId so async callbacks that
  // fire after an unmount or a rapid re-render don't read a stale
  // closure. (overview.tenantId is invariant for the page lifetime,
  // but using a ref removes a class of stale-closure bugs.)
  const tenantIdRef = React.useRef(props.initialOverview.tenantId);
  React.useEffect(() => {
    tenantIdRef.current = overview.tenantId;
  }, [overview.tenantId]);

  async function refreshChain() {
    // On post-mutation refresh we reset pagination: re-fetch the first
    // page from the tail (newest entries) so newly appended rows appear
    // at the top immediately. Fetch enough entries to cover what the
    // user has already loaded (capped at the server's hard max of 200)
    // so the list doesn't visibly shrink.
    const myEpoch = ++chainEpochRef.current;
    setLoadingMore(false);
    const currentCount = entries.length;
    const want = Math.min(
      Math.max(currentCount, CHAIN_PAGE_SIZE),
      CHAIN_FETCH_MAX
    );
    try {
      const res = await loadMoreLedgerEntriesAction(
        tenantIdRef.current,
        null, // null cursor = first page
        want
      );
      // Stale response (a newer reset or load started after us)? Drop it
      // entirely to avoid overwriting fresher state.
      if (myEpoch !== chainEpochRef.current) return;
      if (res.ok && res.page) {
        setEntries(res.page.entries);
        setNextCursor(res.page.nextCursor);
      }
    } catch (e) {
      if (myEpoch === chainEpochRef.current) {
        console.error("[admin/ledger] refreshChain failed:", e);
      }
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const myEpoch = chainEpochRef.current;
    setLoadingMore(true);
    try {
      const res = await loadMoreLedgerEntriesAction(
        tenantIdRef.current,
        nextCursor,
        CHAIN_PAGE_SIZE
      );
      // If a reset happened while we were in flight, discard. If another
      // loadMore beat us home (the loadingMore guard should prevent
      // this, but defensive against React 18 state batching), discard.
      if (myEpoch !== chainEpochRef.current) return;
      if (!res.ok || !res.page) {
        setError(res.error ?? "Failed to load more entries.");
        toast.error("Load more failed", {
          description: res.error ?? undefined,
        });
        return;
      }
      // Deduplicate against existing entries by id before merging so a
      // concurrent write (webhook append between our request send and
      // response receive) never produces duplicate React keys.
      setEntries((prev) => mergeEntries(prev, res.page!.entries));
      setNextCursor(res.page.nextCursor);
    } finally {
      if (myEpoch === chainEpochRef.current) {
        setLoadingMore(false);
      }
    }
  }

  async function afterMutation(
    label: string,
    latest: AuditRunSummary | null | undefined
  ) {
    // RSC refresh keeps server-rendered chrome consistent; client-side
    // refetch picks up new entries immediately without window.location.
    router.refresh();
    await refreshChain();
    if (latest && lastAuditIdRef.current !== latest.id) {
      toast.success(label, {
        description: `Status: ${latest.status} · scanned ${latest.entriesScanned} rows`,
      });
      lastAuditIdRef.current = latest.id;
    }
  }

  function applyReconcile(r: ReconcileActionResult | BackfillActionResult) {
    let label = "Reconciliation complete";
    if (r.audit?.autoRemediated) label = "Auto-backfill completed";
    if (r.overview) setOverview(r.overview);
    if (r.recentAudits?.length) setAudits(r.recentAudits);
    const latest = r.audit ?? r.overview?.latestAudit ?? null;
    // Wait for refresh + chain reload so the optimistic override clears
    // against the authoritative server state rather than a stale view.
    void afterMutation(label, latest).finally(clearOptimistic);
  }

  async function runReconcile() {
    // Single source of truth: setting optimisticOp synchronously is
    // what disables all banner buttons and flips aria-busy. No
    // companion boolean is needed.
    setOptimisticOp("RECONCILING");
    setError(null);
    try {
      const r = await triggerTenantReconcileAction(tenantIdRef.current);
      if (!r.ok) {
        setError(r.error ?? "Reconcile failed.");
        toast.error("Reconcile failed", {
          description: r.error ?? undefined,
        });
        clearOptimistic();
      } else {
        applyReconcile(r);
      }
    } catch (e) {
      clearOptimistic();
      console.error("[admin/ledger] runReconcile threw:", e);
      setError(e instanceof Error ? e.message : "Reconcile failed.");
    }
  }

  async function runBackfill() {
    setOptimisticOp("BACKFILLING");
    setError(null);
    try {
      const r = await backfillTenantAction(tenantIdRef.current);
      if (!r.ok) {
        setError(r.error ?? "Backfill failed.");
        toast.error("Backfill failed", { description: r.error ?? undefined });
        clearOptimistic();
      } else {
        applyReconcile(r);
      }
    } catch (e) {
      clearOptimistic();
      console.error("[admin/ledger] runBackfill threw:", e);
      setError(e instanceof Error ? e.message : "Backfill failed.");
    }
  }

  function onReleaseStart() {
    setOptimisticOp("RELEASING");
  }
  function onQuarantineStart() {
    setOptimisticOp("QUARANTINING");
  }

  function onRelease(r: ReleaseActionResult | QuarantineActionResult) {
    if (r.overview) setOverview(r.overview);
    if (r.recentAudits?.length) setAudits(r.recentAudits);
    const isRelease = "released" in r;
    const label = isRelease
      ? r.forced
        ? "Quarantine force-released"
        : "Quarantine released"
      : "Ledger quarantined";
    const latest = r.audit ?? r.overview?.latestAudit ?? null;
    // Wait for refresh + chain reload, then clear the optimistic flag so
    // the server authoritative status (HEALTHY / QUARANTINED / DRIFT) renders.
    void (async () => {
      router.refresh();
      await refreshChain();
      clearOptimistic();
      // Quarantine is an operator action that deserves an error-styled
      // toast (writes are now blocked); releases are success.
      if (!isRelease) {
        toast.error(label, {
          description: "Financial writes are now blocked.",
        });
      } else {
        toast.success(label, {
          description: latest
            ? `Reconcile status: ${latest.status}`
            : undefined,
        });
      }
      if (latest) lastAuditIdRef.current = latest.id;
    })();
  }

  // Paise Inspector (Section C) — controlled modal state. The inspected
  // audit is a stable reference so open/close doesn't cause flicker as
  // Section C re-renders under optimistic updates.
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  const [inspectedAudit, setInspectedAudit] =
    React.useState<AuditRunSummary | null>(null);
  const inspectedAuditRef = React.useRef<AuditRunSummary | null>(null);
  function openInspector(audit: AuditRunSummary) {
    inspectedAuditRef.current = audit;
    setInspectedAudit(audit);
    setInspectorOpen(true);
  }
  function closeInspector() {
    setInspectorOpen(false);
  }
  const hasMore = nextCursor !== null;

  return (
    <div className="space-y-6">
      <HealthBanner
        overview={overview}
        optimisticOp={optimisticOp}
        latestError={error}
        onReconcile={runReconcile}
        onBackfill={runBackfill}
        onRelease={onRelease}
        onReleaseStart={onReleaseStart}
        onQuarantineStart={onQuarantineStart}
        onSettle={clearOptimistic}
      />

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <ChainExplorer
            entries={entries}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
          />
        </div>
        <div className="lg:col-span-2">
          <AuditHistory
            audits={audits}
            currency={overview.currency}
            onInspect={openInspector}
          />
        </div>
      </div>

      <AuditInspectorModal
        audit={inspectedAudit}
        currency={overview.currency}
        open={inspectorOpen}
        onOpenChange={(o) => {
          if (!o) closeInspector();
          else setInspectorOpen(o);
        }}
      />
    </div>
  );
}
