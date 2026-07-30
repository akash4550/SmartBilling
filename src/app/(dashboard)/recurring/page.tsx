"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RecurringProfileDialog } from "@/components/recurring/recurring-profile-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { PageTransition } from "@/components/page-transition";
import {
  RefreshCw,
  Plus,
  Calendar,
  Mail,
  PlayCircle,
  PauseCircle,
  Trash2,
  Zap,
  Loader2,
  Clock,
  FileText,
  Repeat,
} from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { RecurringProfileWithRelations, RecurrenceFrequency } from "@/types";

const FREQ_LABEL: Record<RecurrenceFrequency, string> = {
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  YEARLY: "Yearly",
  CUSTOM_DAYS: "Every N days",
};

function nextRunLabel(d: string | Date): { label: string; tone: "due" | "soon" | "ok" } {
  const next = new Date(d);
  const now = new Date();
  const ms = next.getTime() - now.getTime();
  const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
  if (days < 0) return { label: `Overdue by ${Math.abs(days)} day${Math.abs(days) !== 1 ? "s" : ""}`, tone: "due" };
  if (days === 0) return { label: "Today", tone: "due" };
  if (days === 1) return { label: "Tomorrow", tone: "soon" };
  if (days <= 3) return { label: `in ${days} days`, tone: "soon" };
  return { label: `in ${days} days (${formatDate(next)})`, tone: "ok" };
}

export default function RecurringInvoicesPage() {
  const [profiles, setProfiles] = useState<RecurringProfileWithRelations[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/recurring", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load recurring profiles");
      const data: RecurringProfileWithRelations[] = await res.json();
      setProfiles(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  const activeCount = profiles?.filter((p) => p.active).length ?? 0;
  const dueCount = profiles?.filter((p) => p.active && new Date(p.nextRunAt).getTime() <= Date.now()).length ?? 0;

  async function toggleActive(id: string, next: boolean) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/recurring/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: next }),
      });
      if (!res.ok) throw new Error("Failed to update");
      toast.success(next ? "Profile activated" : "Profile paused");
      fetchProfiles();
    } catch {
      toast.error("Failed to update profile");
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/recurring/${id}/run`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to generate invoice");
      toast.success("Invoice generated", {
        description: `Invoice ${data.invoiceNumber ?? ""} was created${data.sent ? " and sent" : ""}.`,
      });
      fetchProfiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate invoice");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteProfile(id: string) {
    if (!confirm("Delete this recurring profile? Previously generated invoices will be kept.")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/recurring/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      toast.success("Recurring profile deleted");
      fetchProfiles();
    } catch {
      toast.error("Failed to delete profile");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageTransition className="space-y-6 max-w-5xl mx-auto">
      <PageHeader
        title="Recurring Invoices"
        description="Automatically generate and send invoices on a schedule — perfect for retainers, subscriptions, and monthly billing."
        icon={<RefreshCw className="h-5 w-5" strokeWidth={2.2} />}
        iconGradient="from-violet-500 to-purple-600"
        badge={
          profiles && profiles.length > 0 ? (
            <Badge variant={dueCount > 0 ? "danger" : "success"} className="ml-1">
              {dueCount > 0 ? `${dueCount} due now` : `${activeCount} active`}
            </Badge>
          ) : null
        }
      >
        <RecurringProfileDialog
          trigger={
            <Button className="bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 shadow-lg shadow-violet-500/25">
              <Plus className="h-4 w-4 mr-2" />
              New Profile
            </Button>
          }
          onSuccess={fetchProfiles}
        />
      </PageHeader>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      ) : error ? (
        <Card className="surface border-red-200 dark:border-red-900 bg-red-50/60 dark:bg-red-950/20">
          <CardContent className="py-12 text-center">
            <p className="text-red-600 dark:text-red-400 font-medium">{error}</p>
            <Button variant="outline" className="mt-4" onClick={fetchProfiles}>Retry</Button>
          </CardContent>
        </Card>
      ) : !profiles || profiles.length === 0 ? (
        <EmptyState
          icon={<Repeat className="h-7 w-7" strokeWidth={1.8} />}
          title="No recurring invoices yet"
          description="Set up your first recurring profile to automatically bill clients weekly, monthly, or on a custom cadence. Auto-send invoices so you never chase payments."
          action={
            <RecurringProfileDialog
              trigger={
                <Button className="bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 shadow-lg shadow-violet-500/25">
                  <Plus className="h-4 w-4 mr-2" />
                  Create your first profile
                </Button>
              }
              onSuccess={fetchProfiles}
            />
          }
        />
      ) : (
        <div className="grid gap-4">
          {profiles.map((p) => {
            const run = nextRunLabel(p.nextRunAt);
            const isDue = run.tone === "due" && p.active;
            const isSoon = run.tone === "soon" && p.active;
            const amount =
              p.items.reduce(
                (sum, i) => sum + (Number(i.quantity) || 0) * (Number(i.price) || 0),
                0
              ) * (1 + Number(p.taxRate) / 100);

            return (
              <Card
                key={p.id}
                className={[
                  "surface overflow-hidden transition-all hover:shadow-lg",
                  !p.active ? "opacity-75" : "",
                  isDue ? "ring-1 ring-amber-300 dark:ring-amber-800/60" : "",
                ].join(" ")}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex items-center gap-3">
                      <div className="h-10 w-10 shrink-0 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white flex items-center justify-center shadow-md">
                        <span className="font-semibold text-sm">
                          {p.client.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <CardTitle className="text-base flex items-center gap-2 flex-wrap text-slate-900 dark:text-white">
                          <Link href={`/clients/${p.clientId}`} className="hover:underline truncate">
                            {p.client.name}
                          </Link>
                          {p.active ? (
                            <Badge variant="success" className="text-xs">Active</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">Paused</Badge>
                          )}
                          {p.autoSend && (
                            <Badge variant="outline" className="text-xs gap-1">
                              <Mail className="h-3 w-3" /> Auto-send
                            </Badge>
                          )}
                          {isDue && (
                            <Badge variant="danger" className="text-xs gap-1">
                              <Clock className="h-3 w-3" /> Due now
                            </Badge>
                          )}
                          {isSoon && !isDue && (
                            <Badge variant="warning" className="text-xs gap-1">
                              <Clock className="h-3 w-3" /> {run.label}
                            </Badge>
                          )}
                        </CardTitle>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                          <span className="font-medium text-slate-700 dark:text-slate-300">
                            {FREQ_LABEL[p.frequency]}
                          </span>
                          {p.frequency === "CUSTOM_DAYS" && p.intervalDays && ` (every ${p.intervalDays} days)`}
                          <span className="mx-1.5">·</span>
                          Net {Number(p.dueInDays)} days
                          <span className="mx-1.5">·</span>
                          {Number(p.taxRate)}% tax
                          <span className="mx-1.5">·</span>
                          <span className="text-violet-600 dark:text-violet-400 font-medium">{p._count.invoices}</span> sent
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => runNow(p.id)}
                        disabled={busyId === p.id}
                        className="bg-white/70 dark:bg-slate-900/60"
                      >
                        {busyId === p.id ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <Zap className="h-4 w-4 mr-1 text-amber-500" />
                        )}
                        Run now
                      </Button>
                      <RecurringProfileDialog
                        profile={p}
                        trigger={
                          <Button variant="outline" size="sm" className="bg-white/70 dark:bg-slate-900/60">
                            <FileText className="h-4 w-4 mr-1" /> Edit
                          </Button>
                        }
                        onSuccess={fetchProfiles}
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => toggleActive(p.id, !p.active)}
                        disabled={busyId === p.id}
                        title={p.active ? "Pause" : "Activate"}
                      >
                        {p.active ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => deleteProfile(p.id)}
                        disabled={busyId === p.id}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm pt-1">
                    <div className="flex items-start gap-2">
                      <Calendar className={`h-4 w-4 mt-0.5 shrink-0 ${isDue ? "text-amber-500" : "text-slate-400"}`} />
                      <div>
                        <p className="text-[11px] uppercase text-slate-400 tracking-wide font-semibold">Next invoice</p>
                        <p className={`font-medium ${isDue ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-white"}`}>
                          {!isSoon ? run.label : formatDate(p.nextRunAt)}
                        </p>
                      </div>
                    </div>
                    {p.lastRunAt && (
                      <div className="flex items-start gap-2">
                        <Clock className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-[11px] uppercase text-slate-400 tracking-wide font-semibold">Last generated</p>
                          <p className="font-medium text-slate-900 dark:text-white">{formatDate(p.lastRunAt)}</p>
                        </div>
                      </div>
                    )}
                    <div className="flex items-start gap-2">
                      <div className="h-4 w-4 flex items-center justify-center text-slate-400 mt-0.5 shrink-0 font-bold">₹</div>
                      <div>
                        <p className="text-[11px] uppercase text-slate-400 tracking-wide font-semibold">Per invoice</p>
                        <p className="font-bold text-lg tabular-nums text-slate-900 dark:text-white">
                          {formatCurrency(amount)}
                        </p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </PageTransition>
  );
}
