"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { RecurringProfileDialog } from "@/components/recurring/recurring-profile-dialog";
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
  ArrowLeft,
  Clock,
  FileText,
} from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { RecurringProfileWithRelations, RecurrenceFrequency } from "@/types";

const FREQ_LABEL: Record<RecurrenceFrequency, string> = {
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  YEARLY: "Yearly",
  CUSTOM_DAYS: "Every N days",
};

function nextRunLabel(d: string | Date): string {
  const next = new Date(d);
  const now = new Date();
  const ms = next.getTime() - now.getTime();
  const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
  if (days < 0) return `Overdue by ${Math.abs(days)} day${Math.abs(days) !== 1 ? "s" : ""}`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `in ${days} days (${formatDate(next)})`;
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

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

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
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild className="text-slate-500 -ml-2">
              <Link href="/dashboard">
                <ArrowLeft className="h-4 w-4 mr-1" /> Dashboard
              </Link>
            </Button>
          </div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <RefreshCw className="h-6 w-6 text-violet-600" />
            Recurring Invoices
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Automatically generate and send invoices on a schedule — ideal for retainers, subscriptions, and monthly billing.
          </p>
        </div>
        <RecurringProfileDialog
          trigger={
            <Button>
              <Plus className="h-4 w-4 mr-2" /> New Recurring Profile
            </Button>
          }
          onSuccess={fetchProfiles}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-red-600">{error}</p>
            <Button variant="outline" className="mt-4" onClick={fetchProfiles}>Retry</Button>
          </CardContent>
        </Card>
      ) : !profiles || profiles.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center">
            <div className="mx-auto h-14 w-14 rounded-full bg-violet-100 dark:bg-violet-950/50 flex items-center justify-center mb-4">
              <RefreshCw className="h-6 w-6 text-violet-600 dark:text-violet-400" />
            </div>
            <h3 className="text-lg font-semibold">No recurring invoices yet</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto mt-2">
              Set up your first recurring profile to automatically bill clients on a weekly, monthly, or custom schedule.
            </p>
            <div className="mt-6">
              <RecurringProfileDialog
                trigger={
                  <Button>
                    <Plus className="h-4 w-4 mr-2" /> Create your first recurring invoice
                  </Button>
                }
                onSuccess={fetchProfiles}
              />
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {profiles.map((p) => {
            const isDue = new Date(p.nextRunAt).getTime() <= Date.now();
            return (
              <Card key={p.id} className={!p.active ? "opacity-70" : ""}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                        <span className="truncate">{p.client.name}</span>
                        <Badge variant={p.active ? "success" : "secondary"} className="text-xs">
                          {p.active ? "Active" : "Paused"}
                        </Badge>
                        {p.autoSend && (
                          <Badge variant="outline" className="text-xs gap-1">
                            <Mail className="h-3 w-3" /> Auto-send
                          </Badge>
                        )}
                        {isDue && p.active && (
                          <Badge variant="warning" className="text-xs gap-1">
                            <Clock className="h-3 w-3" /> Due
                          </Badge>
                        )}
                      </CardTitle>
                      <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        {FREQ_LABEL[p.frequency]}
                        {p.frequency === "CUSTOM_DAYS" && p.intervalDays && ` (every ${p.intervalDays} days)`}
                        {" · "}
                        Net {Number(p.dueInDays)} days · {Number(p.taxRate)}% tax · {p._count.invoices} invoice{p._count.invoices !== 1 ? "s" : ""} sent
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => runNow(p.id)}
                        disabled={busyId === p.id}
                      >
                        {busyId === p.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}
                        Run now
                      </Button>
                      <RecurringProfileDialog
                        profile={p}
                        trigger={
                          <Button variant="outline" size="sm">
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
                        className="text-red-600 hover:text-red-700"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                    <div className="flex items-start gap-2">
                      <Calendar className="h-4 w-4 text-slate-400 mt-0.5" />
                      <div>
                        <p className="text-xs uppercase text-slate-400 tracking-wide">Next invoice</p>
                        <p className={`font-medium ${isDue && p.active ? "text-amber-600" : ""}`}>
                          {nextRunLabel(p.nextRunAt)}
                        </p>
                      </div>
                    </div>
                    {p.lastRunAt && (
                      <div className="flex items-start gap-2">
                        <Clock className="h-4 w-4 text-slate-400 mt-0.5" />
                        <div>
                          <p className="text-xs uppercase text-slate-400 tracking-wide">Last generated</p>
                          <p className="font-medium">{formatDate(p.lastRunAt)}</p>
                        </div>
                      </div>
                    )}
                    <div className="flex items-start gap-2">
                      <div className="h-4 w-4 text-slate-400 mt-0.5 font-bold">₹</div>
                      <div>
                        <p className="text-xs uppercase text-slate-400 tracking-wide">Amount per invoice</p>
                        <p className="font-semibold text-base tabular-nums">
                          {formatCurrency(
                            p.items.reduce(
                              (sum, i) => sum + (Number(i.quantity) || 0) * (Number(i.price) || 0),
                              0
                            ) *
                              (1 + Number(p.taxRate) / 100)
                          )}
                        </p>
                      </div>
                    </div>
                  </div>

                  {p.notes && (
                    <>
                      <Separator className="my-3" />
                      <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">{p.notes}</p>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
