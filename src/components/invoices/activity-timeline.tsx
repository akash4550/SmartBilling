"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Mail,
  Bell,
  Eye,
  CreditCard,
  CheckCircle2,
  FilePlus,
  Pencil,
  Download,
  RefreshCw,
  AlertTriangle,
  Trash2,
  History,
  Loader2,
  Ban,
  CheckCheck,
  XCircle,
  MailOpen,
  AlertOctagon,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { InvoiceActivity, InvoiceActivityType } from "@/types";

interface ActivityTimelineProps {
  invoiceId: string;
}

const TYPE_META: Record<InvoiceActivityType, { icon: typeof History; label: string; color: string; dotColor: string }> = {
  CREATED: {
    icon: FilePlus,
    label: "Created",
    color: "text-blue-600 dark:text-blue-400",
    dotColor: "bg-blue-500",
  },
  EDITED: {
    icon: Pencil,
    label: "Edited",
    color: "text-slate-600 dark:text-slate-400",
    dotColor: "bg-slate-400",
  },
  SENT: {
    icon: Mail,
    label: "Sent",
    color: "text-indigo-600 dark:text-indigo-400",
    dotColor: "bg-indigo-500",
  },
  REMINDED: {
    icon: Bell,
    label: "Reminder sent",
    color: "text-amber-600 dark:text-amber-400",
    dotColor: "bg-amber-500",
  },
  VIEWED: {
    icon: Eye,
    label: "Viewed",
    color: "text-slate-600 dark:text-slate-400",
    dotColor: "bg-slate-400",
  },
  PAID: {
    icon: CreditCard,
    label: "Payment received",
    color: "text-emerald-600 dark:text-emerald-400",
    dotColor: "bg-emerald-500",
  },
  PAYMENT_FAILED: {
    icon: AlertTriangle,
    label: "Payment failed",
    color: "text-red-600 dark:text-red-400",
    dotColor: "bg-red-500",
  },
  MARKED_PAID: {
    icon: CheckCircle2,
    label: "Marked paid",
    color: "text-emerald-600 dark:text-emerald-400",
    dotColor: "bg-emerald-500",
  },
  PDF_DOWNLOADED: {
    icon: Download,
    label: "PDF downloaded",
    color: "text-slate-600 dark:text-slate-400",
    dotColor: "bg-slate-400",
  },
  DELETED: {
    icon: Trash2,
    label: "Deleted",
    color: "text-red-600 dark:text-red-400",
    dotColor: "bg-red-500",
  },
  RECURRING_GENERATED: {
    icon: RefreshCw,
    label: "Auto-generated (recurring)",
    color: "text-violet-600 dark:text-violet-400",
    dotColor: "bg-violet-500",
  },
  VOIDED: {
    icon: Ban,
    label: "Voided",
    color: "text-slate-600 dark:text-slate-400",
    dotColor: "bg-slate-500",
  },
  EMAIL_DELIVERED: {
    icon: CheckCheck,
    label: "Email delivered",
    color: "text-emerald-600 dark:text-emerald-400",
    dotColor: "bg-emerald-500",
  },
  EMAIL_BOUNCED: {
    icon: XCircle,
    label: "Email bounced",
    color: "text-red-600 dark:text-red-400",
    dotColor: "bg-red-500",
  },
  EMAIL_COMPLAINED: {
    icon: AlertOctagon,
    label: "Email marked as spam",
    color: "text-orange-600 dark:text-orange-400",
    dotColor: "bg-orange-500",
  },
  EMAIL_OPENED: {
    icon: MailOpen,
    label: "Email opened",
    color: "text-blue-600 dark:text-blue-400",
    dotColor: "bg-blue-500",
  },
};

function timeAgo(date: Date | string): string {
  const d = new Date(date);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(d);
}

export function ActivityTimeline({ invoiceId }: ActivityTimelineProps) {
  const [activities, setActivities] = useState<InvoiceActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/invoices/${invoiceId}/activity`, { cache: "no-store" });
        if (!res.ok) throw new Error("Failed to load activity");
        const data: InvoiceActivity[] = await res.json();
        if (alive) setActivities(data);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Something went wrong");
      }
    })();
    return () => { alive = false; };
  }, [invoiceId]);

  return (
    <Card className="border-slate-200/60 dark:border-slate-800/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <History className="h-4 w-4 text-slate-500" />
          Activity Timeline
        </CardTitle>
      </CardHeader>
      <CardContent>
        {activities === null && !error && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
          </div>
        )}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400 text-center py-4">{error}</p>
        )}
        {activities && activities.length === 0 && (
          <p className="text-sm text-slate-400 text-center py-4">No activity yet.</p>
        )}
        {activities && activities.length > 0 && (
          <ol className="relative">
            {activities.map((a, idx) => {
              const meta = TYPE_META[a.type] ?? TYPE_META.EDITED;
              const Icon = meta.icon;
              return (
                <li key={a.id} className="flex gap-3 pb-4 last:pb-0">
                  <div className="flex flex-col items-center shrink-0">
                    <div className={`h-8 w-8 rounded-full flex items-center justify-center ring-4 ring-white dark:ring-slate-900 ${meta.dotColor} text-white shadow-sm`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    {idx < activities.length - 1 && (
                      <div className="w-px flex-1 bg-slate-200 dark:bg-slate-800 mt-1" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0 pt-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-slate-900 dark:text-white">
                        {meta.label}
                      </p>
                      {isPaymentMeta(a.meta) && a.meta?.provider && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 capitalize">
                          {String(a.meta.provider)}
                        </Badge>
                      )}
                    </div>
                    {a.message && (
                      <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5 break-words">
                        {a.message}
                      </p>
                    )}
                    <p className="text-xs text-slate-400 dark:text-slate-500 mt-1" title={new Date(a.createdAt).toLocaleString("en-IN")}>
                      {timeAgo(a.createdAt)} · {formatDate(a.createdAt)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function isPaymentMeta(m: unknown): m is { provider?: string } {
  return typeof m === "object" && m !== null;
}
