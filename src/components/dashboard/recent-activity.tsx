"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Activity,
  Plus,
  Edit3,
  Send,
  BellRing,
  Eye,
  CheckCircle2,
  AlertCircle,
  FileText,
  Download,
  Trash2,
  RefreshCw,
  XCircle,
  Loader2,
} from "lucide-react";

interface ActivityItem {
  id: string;
  type: string;
  label: string;
  message: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  clientName: string | null;
  createdAt: string;
  relative: string;
}

const TYPE_ICON: Record<string, typeof Plus> = {
  CREATED: Plus,
  EDITED: Edit3,
  SENT: Send,
  REMINDED: BellRing,
  VIEWED: Eye,
  PAID: CheckCircle2,
  PAYMENT_FAILED: XCircle,
  MARKED_PAID: CheckCircle2,
  PDF_DOWNLOADED: Download,
  DELETED: Trash2,
  RECURRING_GENERATED: RefreshCw,
};

const TYPE_COLOR: Record<string, string> = {
  CREATED: "text-slate-600 bg-slate-100 dark:bg-slate-800 dark:text-slate-300",
  EDITED: "text-slate-600 bg-slate-100 dark:bg-slate-800 dark:text-slate-300",
  SENT: "text-blue-600 bg-blue-100 dark:bg-blue-950/50 dark:text-blue-400",
  REMINDED: "text-amber-600 bg-amber-100 dark:bg-amber-950/40 dark:text-amber-400",
  VIEWED: "text-indigo-600 bg-indigo-100 dark:bg-indigo-950/40 dark:text-indigo-400",
  PAID: "text-emerald-600 bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-400",
  PAYMENT_FAILED: "text-red-600 bg-red-100 dark:bg-red-950/40 dark:text-red-400",
  MARKED_PAID: "text-emerald-600 bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-400",
  PDF_DOWNLOADED: "text-purple-600 bg-purple-100 dark:bg-purple-950/40 dark:text-purple-400",
  DELETED: "text-red-600 bg-red-100 dark:bg-red-950/40 dark:text-red-400",
  RECURRING_GENERATED: "text-cyan-600 bg-cyan-100 dark:bg-cyan-950/40 dark:text-cyan-400",
};

export function RecentActivity({ limit = 8 }: { limit?: number }) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/dashboard/activity?limit=${limit}`, { cache: "no-store" });
        if (res.ok) {
          const json = await res.json();
          if (active) setItems(json.items || []);
        }
      } catch {
        /* ignore */
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [limit]);

  return (
    <Card className="border-slate-200/60 dark:border-slate-800">
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-indigo-500" /> Recent Activity
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="py-10 flex items-center justify-center text-slate-400 text-sm">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading activity…
          </div>
        ) : items.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-500">
            <FileText className="h-8 w-8 mx-auto text-slate-300 mb-2" />
            No activity yet. Start by creating your first invoice.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 -mx-1">
            {items.map((a) => {
              const Icon = TYPE_ICON[a.type] ?? Activity;
              const color = TYPE_COLOR[a.type] ?? "text-slate-600 bg-slate-100";
              return (
                <li key={a.id} className="py-3 px-1 flex items-start gap-3">
                  <div className={`h-8 w-8 shrink-0 rounded-full flex items-center justify-center ${color}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-700 dark:text-slate-300 leading-snug">
                      <span className="capitalize">{a.label}</span>{" "}
                      {a.invoiceId ? (
                        <Link
                          href={`/invoices/${a.invoiceId}`}
                          className="font-mono font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                        >
                          {a.invoiceNumber}
                        </Link>
                      ) : (
                        <span className="font-mono font-semibold text-slate-600 dark:text-slate-400">
                          {a.invoiceNumber ?? "invoice"}
                        </span>
                      )}
                      {a.clientName && (
                        <>
                          {" · "}
                          <span className="text-slate-500 dark:text-slate-400">{a.clientName}</span>
                        </>
                      )}
                    </p>
                    {a.message && (
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">{a.message}</p>
                    )}
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{a.relative}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
