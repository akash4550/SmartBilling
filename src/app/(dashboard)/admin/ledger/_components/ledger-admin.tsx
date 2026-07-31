"use client";

import * as React from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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

// ============================================================
// STATUS MAPPING
// ============================================================

type HealthStatus = "healthy" | "warning" | "quarantined" | "unknown";

function deriveHealth(ov: TenantAuditOverview): HealthStatus {
  if (ov.ledgerQuarantinedAt) return "quarantined";
  const lat = ov.latestAudit;
  if (!lat) return "unknown";
  if (lat.status === "HASH_BROKEN") return "quarantined";
  if (lat.status === "DRIFT_DETECTED") {
    if (lat.criticalCount > 0) return "quarantined";
    if (lat.highCount > 0) return "warning";
    if (lat.mediumCount > 0) return "warning";
  }
  if (lat.status === "PASSED") return "healthy";
  return "unknown";
}

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
    critical: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950/40 dark:text-red-400 dark:ring-red-400/20",
    high: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-400 dark:ring-amber-400/20",
    medium: "bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-950/40 dark:text-blue-400 dark:ring-blue-400/20",
    info: "bg-slate-100 text-slate-600 ring-slate-400/20 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-500/20",
  }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", cls)}>
      {count} {label}
    </span>
  );
}

// ============================================================
// COPY HASH BUTTON
// ============================================================

function CopyHash({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition"
      title="Copy hash"
    >
      <Copy className={cn("h-3 w-3", copied && "text-emerald-500")} />
    </button>
  );
}

// ============================================================
// QUARANTINE RELEASE MODAL
// ============================================================

function ReleaseDialog({
  overview,
  onReleased,
}: {
  overview: TenantAuditOverview;
  onReleased: (r: ReleaseActionResult) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [force, setForce] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const canSubmit = note.trim().length > 0 && !submitting;

  async function onSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const res = await releaseTenantQuarantineAction(overview.tenantId, note, { force });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error ?? "Release failed.");
      return;
    }
    setOpen(false);
    setNote("");
    setForce(false);
    onReleased(res);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" size="sm" className="gap-1.5">
          <Unlock className="h-4 w-4" /> Release Quarantine…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Unlock className="h-5 w-5 text-amber-600" />
            Release Ledger Quarantine
          </DialogTitle>
          <DialogDescription>
            Before clearing the quarantine flag, a fresh reconciliation will
            run. The flag will only clear if the sweep passes. Use Force only
            in an emergency; force-releases are permanently recorded in the
            audit trail.
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
            <Label htmlFor="release-note">Audit note <span className="text-red-500">*</span></Label>
            <Textarea
              id="release-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Describe the remediation and who authorized release…"
              className="min-h-[90px]"
            />
            <p className="text-xs text-slate-500">Required. Stored permanently in reconciliation_audits.</p>
          </div>
          <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
            />
            <span>
              <span className="font-medium text-red-600 dark:text-red-400">Force release</span>{" "}
              <span className="text-slate-500 dark:text-slate-400">— skip re-verification (emergency only).</span>
            </span>
          </label>
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300" role="alert">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant={force ? "destructive" : "default"}
            size="sm"
            disabled={!canSubmit}
            onClick={onSubmit}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            {force ? "Force Release" : "Verify & Release"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QuarantineDialog({
  overview,
  onQuarantined,
}: {
  overview: TenantAuditOverview;
  onQuarantined: (r: QuarantineActionResult) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const canSubmit = note.trim().length > 0 && !submitting;

  async function onSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const res = await quarantineTenantAction(overview.tenantId, note);
    setSubmitting(false);
    if (!res.ok) { setError(res.error ?? "Quarantine failed."); return; }
    setOpen(false);
    setNote("");
    onQuarantined(res);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 text-red-600 dark:text-red-400 border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-950/30">
          <LockKeyhole className="h-4 w-4" /> Quarantine…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <LockKeyhole className="h-5 w-5" /> Manually Quarantine Ledger
          </DialogTitle>
          <DialogDescription>
            This will immediately block all financial writes for the tenant.
            Customer webhook payments are held in the queue and will resume
            after release. A reason is required for the audit trail.
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-2 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="quarantine-note">Reason <span className="text-red-500">*</span></Label>
            <Textarea
              id="quarantine-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Describe the suspicious activity or incident…"
              className="min-h-[90px]"
            />
          </div>
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300" role="alert">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" disabled={!canSubmit} onClick={onSubmit}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Quarantine Now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// HEALTH BANNER (Section A)
// ============================================================

function HealthBanner({
  overview,
  running,
  latestError,
  onReconcile,
  onBackfill,
  onRelease,
}: {
  overview: TenantAuditOverview;
  running: boolean;
  latestError: string | null;
  onReconcile: () => void;
  onBackfill: () => void;
  onRelease: (r: ReleaseActionResult | QuarantineActionResult) => void;
}) {
  const status = deriveHealth(overview);
  const quarantined = !!overview.ledgerQuarantinedAt;

  const palette = {
    healthy: {
      bar: "bg-gradient-to-r from-emerald-500/90 to-emerald-600/90",
      ring: "ring-emerald-500/20",
      title: "Ledger Healthy",
      desc: "All integrity checks passed on the last run.",
      icon: <ShieldCheck className="h-6 w-6" />,
    },
    warning: {
      bar: "bg-gradient-to-r from-amber-500/90 to-orange-500/90",
      ring: "ring-amber-500/20",
      title: "Drift Detected",
      desc: "Non-critical mismatches found. Review audit history and consider running backfill.",
      icon: <AlertTriangle className="h-6 w-6" />,
    },
    quarantined: {
      bar: "bg-gradient-to-r from-red-500/90 to-rose-600/90",
      ring: "ring-red-500/20",
      title: "Ledger Quarantined",
      desc: "Financial writes are blocked. No customer payments are lost — webhooks remain queued.",
      icon: <LockKeyhole className="h-6 w-6" />,
    },
    unknown: {
      bar: "bg-gradient-to-r from-slate-500/90 to-slate-700/90",
      ring: "ring-slate-500/20",
      title: "Never Reconciled",
      desc: "Run the reconciler to establish a baseline.",
      icon: <Activity className="h-6 w-6" />,
    },
  }[status];

  return (
    <Card className="overflow-hidden">
      <div className={cn("h-1.5", palette.bar)} />
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="flex items-start gap-3">
          <div className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white ring-4", palette.bar, palette.ring)}>
            {palette.icon}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <CardTitle className="text-xl">{palette.title}</CardTitle>
              {quarantined ? (
                <Badge variant="danger" className="gap-1 animate-pulse">
                  <LockKeyhole className="h-3 w-3" /> WRITES BLOCKED
                </Badge>
              ) : overview.latestAudit ? (
                <StatusBadge status={overview.latestAudit.status} />
              ) : null}
            </div>
            <CardDescription className="mt-1 max-w-2xl">{palette.desc}</CardDescription>
            {quarantined && overview.ledgerQuarantineReason && (
              <div className="mt-2 flex items-center gap-2 text-xs font-mono text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/40 rounded px-2 py-1">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>Reason: <strong>{overview.ledgerQuarantineReason}</strong></span>
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
          <Button size="sm" variant="outline" onClick={onReconcile} disabled={running} className="gap-1.5">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {running ? "Running…" : "Run Reconciler Now"}
          </Button>
          <Button size="sm" variant="outline" onClick={onBackfill} disabled={running} className="gap-1.5">
            <Database className="h-4 w-4" /> Backfill & Re-verify
          </Button>
          {quarantined ? (
            <ReleaseDialog overview={overview} onReleased={onRelease} />
          ) : (
            <QuarantineDialog
              overview={overview}
              onQuarantined={(r) => onRelease(r)}
            />
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            icon={<Landmark className="h-4 w-4" />}
            label="Open Receivables"
            value={formatPaise(overview.openReceivablePaise, overview.currency)}
            delta={BigInt(overview.ledgerArPaise) - BigInt(overview.openReceivablePaise)}
            currency={overview.currency}
          />
          <Metric
            icon={<Wallet className="h-4 w-4" />}
            label="Cash (ledger)"
            value={formatPaise(overview.ledgerCashPaise, overview.currency)}
            delta={BigInt(overview.ledgerCashPaise) - (BigInt(overview.paidTotalPaise) - BigInt(overview.expenseTotalPaise))}
            currency={overview.currency}
          />
          <Metric
            icon={<Receipt className="h-4 w-4" />}
            label="Paid Invoices (Σ)"
            value={formatPaise(overview.paidTotalPaise, overview.currency)}
          />
          <Metric
            icon={<TrendingUp className="h-4 w-4" />}
            label="Expenses (Σ)"
            value={formatPaise(overview.expenseTotalPaise, overview.currency)}
            delta={BigInt(overview.expenseTotalPaise) - BigInt(overview.expenseTotalPaise) === BigInt(0) ? BigInt(0) : BigInt(0)}
            currency={overview.currency}
            hideDelta
          />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-4 text-xs">
          <Stat label="Last reconciled" value={formatTime(overview.lastReconciledAt)} />
          <Stat label="Last 30d passed" value={String(overview.runCounts.passed)} />
          <Stat label="Last 30d drift" value={String(overview.runCounts.driftDetected + overview.runCounts.hashBroken)} />
          <Stat label="Tail hash" mono value={overview.lastLedgerEntryHash ? shortHash(overview.lastLedgerEntryHash, 14) : "—"} />
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
  const ok = d === BigInt(0);
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 p-3">
      <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value}</div>
      {!hideDelta && (
        <div className={cn("mt-0.5 text-xs tabular-nums", ok ? "text-emerald-600 dark:text-emerald-400" : d < 0 ? "text-red-600 dark:text-red-400" : "text-red-600 dark:text-red-400")}>
          {ok ? "reconciled" : `Δ ${formatPaise(d.toString(), currency ?? "INR", { showSign: true })}`}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md px-2 py-1.5">
      <div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
      <div className={cn("mt-0.5 text-sm font-medium text-slate-700 dark:text-slate-200 break-all", mono && "font-mono text-xs")}>{value}</div>
    </div>
  );
}

// ============================================================
// CHAIN EXPLORER (Section B)
// ============================================================

function SideChip({ side }: { side: "DEBIT" | "CREDIT" | string }) {
  if (side === "DEBIT") {
    return <Badge variant="info" className="font-mono text-[10px] px-1.5 py-0">Dr</Badge>;
  }
  return <Badge variant="warning" className="font-mono text-[10px] px-1.5 py-0">Cr</Badge>;
}

function ChainExplorer({ entries }: { entries: LedgerChainEntry[] }) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  function toggle(id: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-slate-400" /> Hash-Chain Explorer
          </CardTitle>
          <CardDescription>
            Newest entries first. Click a row to inspect the SHA-256 chain link.
          </CardDescription>
        </div>
        <Badge variant="secondary" className="font-mono">{entries.length} rows</Badge>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-slate-200 dark:border-slate-800 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                <th className="px-4 py-2 font-medium w-10">#</th>
                <th className="px-3 py-2 font-medium">Event</th>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium w-16">Side</th>
                <th className="px-3 py-2 font-medium text-right w-32">Amount</th>
                <th className="px-3 py-2 font-medium">Entry Hash</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {entries.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
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
                    >
                      <td className="px-4 py-2 font-mono text-xs text-slate-500">{e.entryIndex}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-800 dark:text-slate-200">
                          {EVENT_LABELS[e.eventType] ?? e.eventType}
                        </div>
                        <div className="text-xs text-slate-500 font-mono truncate max-w-[180px]">{e.eventId}</div>
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{ACCOUNT_LABELS[e.account] ?? e.account}</td>
                      <td className="px-3 py-2"><SideChip side={e.side} /></td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-900 dark:text-slate-100">
                        {formatPaise(e.amountPaise, e.currency)}
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center font-mono text-xs text-slate-700 dark:text-slate-300">
                          <span className="text-emerald-600 dark:text-emerald-400">{shortHash(e.entryHash, 10)}</span>
                          <CopyHash value={e.entryHash} />
                        </span>
                      </td>
                      <td className="pr-3">
                        <ChevronRight className={cn("h-4 w-4 text-slate-400 transition", open && "rotate-90")} />
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-50 dark:bg-slate-900/40">
                        <td colSpan={7} className="px-6 py-3">
                          <div className="grid gap-3 md:grid-cols-2 text-xs">
                            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3">
                              <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1.5">Hash Chain Link</div>
                              <div className="space-y-1 font-mono text-[11px]">
                                <div className="flex items-start gap-2">
                                  <span className="shrink-0 text-slate-500 w-10">prev</span>
                                  <span className="break-all text-slate-600 dark:text-slate-400">{e.prevEntryHash}</span>
                                </div>
                                <div className="flex items-center gap-2 text-slate-400 pl-10">↓</div>
                                <div className="flex items-start gap-2">
                                  <span className="shrink-0 text-slate-500 w-10">entry</span>
                                  <span className="break-all text-emerald-700 dark:text-emerald-400 font-semibold">{e.entryHash}</span>
                                </div>
                              </div>
                            </div>
                            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3">
                              <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1.5">Metadata</div>
                              <dl className="grid grid-cols-[90px,1fr] gap-y-1 text-[11px]">
                                <dt className="text-slate-500">entryId</dt><dd className="font-mono text-slate-700 dark:text-slate-300 break-all">{e.id}</dd>
                                <dt className="text-slate-500">eventId</dt><dd className="font-mono text-slate-700 dark:text-slate-300 break-all">{e.eventId}</dd>
                                <dt className="text-slate-500">invoice</dt><dd className="font-mono text-slate-700 dark:text-slate-300">{e.invoiceId ?? "—"}</dd>
                                <dt className="text-slate-500">expense</dt><dd className="font-mono text-slate-700 dark:text-slate-300">{e.expenseId ?? "—"}</dd>
                                <dt className="text-slate-500">currency</dt><dd className="font-mono text-slate-700 dark:text-slate-300">{e.currency}</dd>
                                <dt className="text-slate-500">created</dt><dd className="text-slate-700 dark:text-slate-300">{formatTime(e.createdAt)}</dd>
                                {e.note && (<><dt className="text-slate-500">note</dt><dd className="text-slate-700 dark:text-slate-300 col-span-2">{e.note}</dd></>)}
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
      </CardContent>
    </Card>
  );
}

// ============================================================
// AUDIT HISTORY (Section C)
// ============================================================

function AuditHistory({ audits }: { audits: AuditRunSummary[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-slate-400" /> Reconciliation Audit History
        </CardTitle>
        <CardDescription>
          Append-only record of every reconciler run for this tenant.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
          {audits.length === 0 && (
            <div className="p-10 text-center text-slate-500 text-sm">
              No reconciliation runs yet. Click &quot;Run Reconciler Now&quot; to create the first audit.
            </div>
          )}
          {audits.map((a) => (
            <details key={a.id} className="group">
              <summary className="flex cursor-pointer list-none items-center gap-3 px-6 py-3 hover:bg-slate-50 dark:hover:bg-slate-900/40">
                <ChevronRight className="h-4 w-4 text-slate-400 transition group-open:rotate-90" />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={a.status} />
                    <span className="text-xs text-slate-500 tabular-nums">{formatTime(a.startedAt)}</span>
                    <span className="text-xs text-slate-400">·</span>
                    <span className="text-xs text-slate-500">
                      scanned {a.entriesScanned} rows · {formatDuration(a.durationMs ?? undefined)}
                    </span>
                    {a.autoRemediated && <Badge variant="info" className="text-[10px]">auto-backfilled</Badge>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <SeverityPill count={a.criticalCount} tone="critical" label="crit" />
                  <SeverityPill count={a.highCount} tone="high" label="high" />
                  <SeverityPill count={a.mediumCount} tone="medium" label="med" />
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
                      const meta = DRIFT_LABELS[d.kind] ?? { label: d.kind, hint: "" };
                      const sevTone = { CRITICAL: "danger", HIGH: "warning", MEDIUM: "info", INFO: "secondary" }[d.severity] as "danger" | "warning" | "info" | "secondary";
                      return (
                        <li key={i} className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30 p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={sevTone} className="text-[10px]">{d.severity}</Badge>
                            <span className="font-medium text-sm text-slate-800 dark:text-slate-200">{meta.label}</span>
                            {d.account && <span className="text-xs text-slate-500">({ACCOUNT_LABELS[d.account] ?? d.account})</span>}
                          </div>
                          {d.detail && <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{d.detail}</p>}
                          {meta.hint && <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-500">{meta.hint}</p>}
                          {(d.expectedPaise || d.actualPaise) && (
                            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] font-mono">
                              <div><div className="text-slate-500">expected</div><div>{formatPaise(d.expectedPaise ?? "0")}</div></div>
                              <div><div className="text-slate-500">actual</div><div>{formatPaise(d.actualPaise ?? "0")}</div></div>
                              <div><div className="text-slate-500">Δ</div>
                                <div className={BigInt(d.diffPaise ?? "0") === BigInt(0) ? "text-emerald-600" : "text-red-600"}>
                                  {formatPaise(d.diffPaise ?? "0", undefined, { showSign: true })}
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
// MAIN CLIENT COMPONENT
// ============================================================

export default function LedgerAdmin(props: {
  initialOverview: TenantAuditOverview;
  initialEntries: LedgerChainEntry[];
  initialAudits: AuditRunSummary[];
}) {
  const [overview, setOverview] = React.useState<TenantAuditOverview>(props.initialOverview);
  const [entries, setEntries] = React.useState<LedgerChainEntry[]>(props.initialEntries);
  const [audits, setAudits] = React.useState<AuditRunSummary[]>(props.initialAudits);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const prevEntriesRef = React.useRef<number | null>(null);

  // SWR-free: all mutations return hydrated state via `overview` + `recentAudits`.
  function applyReconcile(r: ReconcileActionResult | BackfillActionResult) {
    if (r.overview) setOverview(r.overview);
    if (r.recentAudits?.length) setAudits(r.recentAudits);
  }

  async function runReconcile() {
    setRunning(true);
    setError(null);
    try {
      const r = await triggerTenantReconcileAction(overview.tenantId);
      if (!r.ok) {
        setError(r.error ?? "Reconcile failed.");
      } else {
        applyReconcile(r);
      }
    } finally {
      setRunning(false);
    }
  }

  async function runBackfill() {
    setRunning(true);
    setError(null);
    try {
      const r = await backfillTenantAction(overview.tenantId);
      if (!r.ok) {
        setError(r.error ?? "Backfill failed.");
      } else {
        applyReconcile(r);
      }
    } finally {
      setRunning(false);
    }
  }

  function onRelease(
    r: ReleaseActionResult | QuarantineActionResult
  ) {
    if (r.overview) setOverview(r.overview);
    if (r.recentAudits?.length) setAudits(r.recentAudits);
  }

  // After backfill or when a reconcile auto-remediated, new ledger entries
  // may exist — the server actions already return a refreshed
  // `overview` + `recentAudits`, but the chain explorer displays the
  // initially-fetched entry list. The simplest correct behaviour is to
  // do a soft router refresh so the RSC re-fetches fresh chain data.
  // We only trigger this when the user has performed a mutation (not on
  // initial mount) and when entriesScanned changed or autoRemediated.
  React.useEffect(() => {
    if (running) return;
    if (!overview.latestAudit) return;
    const prev = prevEntriesRef.current;
    if (prev && overview.latestAudit.entriesScanned > prev) {
      // Soft reload: Next.js router.refresh() would re-run RSC without
      // losing client state — but our RSC tree is a direct child of the
      // page, so window.location.reload is simplest and guaranteed to
      // reflect new ledger rows. Acceptable for an operator console.
      window.location.reload();
    }
    prevEntriesRef.current = overview.latestAudit.entriesScanned;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, overview.latestAudit?.id]);

  return (
    <div className="space-y-6">
      <HealthBanner
        overview={overview}
        running={running}
        latestError={error}
        onReconcile={runReconcile}
        onBackfill={runBackfill}
        onRelease={onRelease}
      />

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <ChainExplorer entries={entries} />
        </div>
        <div className="lg:col-span-2">
          <AuditHistory audits={audits} />
        </div>
      </div>
    </div>
  );
}
