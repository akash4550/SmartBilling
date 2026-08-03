"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Calendar, ArrowRight, Plus } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { RecurringProfileDialog } from "@/components/recurring/recurring-profile-dialog";
import type { RecurringProfileWithRelations } from "@/types";

function nextRunLabel(d: string | Date): string {
  const next = new Date(d);
  const now = new Date();
  const ms = next.getTime() - now.getTime();
  const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
  if (days < 0) return `Due now`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `${formatDate(next)}`;
}

export function UpcomingRecurring() {
  const [profiles, setProfiles] = useState<RecurringProfileWithRelations[] | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), 0);
    (async () => {
      try {
        const res = await fetch("/api/recurring", { cache: "no-store" });
        if (!res.ok) return;
        const data: RecurringProfileWithRelations[] = await res.json();
        // Show upcoming (next 5 due) sorted by nextRunAt ascending, active only.
        const active = data
          .filter((p) => p.active)
          .sort((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime())
          .slice(0, 5);
        setProfiles(active);
      } catch {
        /* ignore */
      }
    })();
    return () => clearTimeout(timer);
  }, []);

  if (profiles === null) {
    return (
      <Card className="border-slate-200/60 dark:border-slate-800/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-violet-600" />
            Upcoming Recurring
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-400">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-slate-200/60 dark:border-slate-800/60">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-violet-600" />
          Upcoming Recurring
        </CardTitle>
        <Link href="/recurring" className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 flex items-center gap-1 hover:gap-2 transition-all">
          Manage <ArrowRight className="h-3 w-3" />
        </Link>
      </CardHeader>
      <CardContent className="space-y-3">
        {profiles.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">No active recurring invoices</p>
            <RecurringProfileDialog
              trigger={
                <button className="inline-flex items-center gap-1 text-xs text-violet-600 hover:text-violet-700 dark:text-violet-400 font-medium">
                  <Plus className="h-3 w-3" /> Set up auto-billing
                </button>
              }
            />
          </div>
        ) : (
          <>
            {profiles.map((p) => {
              const isDue = now > 0 && new Date(p.nextRunAt).getTime() <= now;
              const amount = p.items.reduce(
                (sum, i) => sum + (Number(i.quantity) || 0) * (Number(i.price) || 0),
                0
              ) * (1 + Number(p.taxRate) / 100);
              return (
                <div key={p.id} className="flex items-center justify-between gap-3 py-1">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{p.client.name}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {nextRunLabel(p.nextRunAt)}
                      {isDue && <Badge variant="warning" className="text-[10px] px-1.5 py-0 ml-1">Due</Badge>}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{formatCurrency(amount)}</span>
                </div>
              );
            })}
          </>
        )}
      </CardContent>
    </Card>
  );
}
