"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import {
  Plus, Save, Trash2, Pencil, X, Loader2, TrendingDown, Receipt,
  Filter, Search, Download, Wallet, PieChart as PieIcon,
} from "lucide-react";
import { DEFAULT_EXPENSE_CATEGORIES, type ExpenseInput } from "@/lib/validations";
import { formatMoney } from "@/lib/format-money";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { ImportExpensesButton } from "@/components/expenses/import-expenses-button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { PageTransition } from "@/components/page-transition";

function csvEscape(v: string | number): string {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportExpensesCsv(rows: Expense[], currency: string) {
  const header = ["Date", "Category", "Description", "Amount", "Notes"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      csvEscape(r.date.slice(0, 10)),
      csvEscape(r.category),
      csvEscape(r.description),
      csvEscape(Number(r.amount).toFixed(2)),
      csvEscape(r.notes ?? ""),
    ].join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `expenses-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success(`Exported ${rows.length} expense${rows.length === 1 ? "" : "s"} as CSV`, { description: currency });
}

interface Expense {
  id: string;
  date: string;
  category: string;
  description: string;
  amount: number | string;
  notes?: string | null;
}

function toLocalISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const CATEGORY_COLORS: Record<string, { pill: string; dot: string }> = {
  "Software & SaaS": { pill: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300", dot: "#3b82f6" },
  Marketing: { pill: "bg-pink-100 text-pink-700 dark:bg-pink-950/50 dark:text-pink-300", dot: "#ec4899" },
  Travel: { pill: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300", dot: "#f59e0b" },
  Materials: { pill: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300", dot: "#10b981" },
  Contractors: { pill: "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300", dot: "#8b5cf6" },
  Office: { pill: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300", dot: "#64748b" },
  "Legal & Accounting": { pill: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300", dot: "#6366f1" },
  Taxes: { pill: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300", dot: "#ef4444" },
  "Bank Fees": { pill: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300", dot: "#f97316" },
  General: { pill: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300", dot: "#64748b" },
};
function catStyle(name: string) {
  return CATEGORY_COLORS[name] ?? CATEGORY_COLORS.General;
}

// ---------------------------------------------------------------------------
// KPI mini-card
// ---------------------------------------------------------------------------
function KpiCard({
  icon: Icon,
  label,
  value,
  iconBg,
  iconColor,
  valueColor = "text-slate-900 dark:text-white",
  children,
}: {
  icon: typeof TrendingDown;
  label: string;
  value: React.ReactNode;
  iconBg: string;
  iconColor: string;
  valueColor?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className="surface overflow-hidden">
      <CardContent className="p-5 flex items-start gap-3">
        <div className={`p-2.5 rounded-xl ${iconBg} shrink-0`}>
          <Icon className={`h-5 w-5 ${iconColor}`} strokeWidth={2.2} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            {label}
          </p>
          <p className={`text-xl sm:text-2xl font-bold tabular-nums mt-0.5 leading-tight ${valueColor}`}>
            {value}
          </p>
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [currency, setCurrency] = useState("INR");
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ExpenseInput>({
    date: toLocalISODate(new Date()),
    category: "General",
    description: "",
    amount: 0,
    notes: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, settingsRes] = await Promise.all([
        fetch("/api/expenses?limit=500", { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
      ]);
      if (!res.ok) throw new Error("Failed to load expenses");
      const data = (await res.json()) as Expense[];
      setExpenses(data);
      if (settingsRes.ok) {
        const s = (await settingsRes.json()) as { currency?: string };
        setCurrency(s.currency || "INR");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load expenses");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const categories = useMemo(() => {
    if (!expenses) return DEFAULT_EXPENSE_CATEGORIES;
    const set = new Set<string>(DEFAULT_EXPENSE_CATEGORIES);
    for (const e of expenses) set.add(e.category);
    return Array.from(set);
  }, [expenses]);

  const filtered = useMemo(() => {
    if (!expenses) return [];
    const q = search.trim().toLowerCase();
    return expenses
      .filter((e) => categoryFilter === "ALL" || e.category === categoryFilter)
      .filter((e) =>
        !q ||
        e.description.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        (e.notes ?? "").toLowerCase().includes(q)
      )
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [expenses, categoryFilter, search]);

  const totals = useMemo(() => {
    const now = new Date();
    let monthTotal = 0;
    let allTotal = 0;
    const byCategory = new Map<string, number>();
    for (const e of filtered) {
      const amt = Number(e.amount);
      allTotal += amt;
      const d = new Date(e.date);
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
        monthTotal += amt;
      }
      byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + amt);
    }
    const sortedCats = Array.from(byCategory.entries())
      .map(([name, amount]) => ({ name, amount, ...catStyle(name) }))
      .sort((a, b) => b.amount - a.amount);
    const maxCat = sortedCats[0]?.amount ?? 0;
    return { monthTotal, allTotal, byCategory: sortedCats, maxCat };
  }, [filtered]);

  function openNew() {
    setEditingId(null);
    setForm({ date: toLocalISODate(new Date()), category: "General", description: "", amount: 0, notes: "" });
    setFormError(null);
    setShowForm(true);
  }
  function openEdit(e: Expense) {
    setEditingId(e.id);
    setForm({
      date: toLocalISODate(new Date(e.date)),
      category: e.category,
      description: e.description,
      amount: Number(e.amount),
      notes: e.notes ?? "",
    });
    setFormError(null);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const url = editingId ? `/api/expenses/${editingId}` : "/api/expenses";
      const method = editingId ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          notes: form.notes?.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || data.details?.[0]?.message || "Save failed");
        return;
      }
      toast.success(editingId ? "Expense updated" : "Expense added");
      setShowForm(false);
      load();
    } catch {
      setFormError("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this expense?")) return;
    const res = await fetch(`/api/expenses/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Expense deleted");
      load();
    } else {
      toast.error("Failed to delete expense");
    }
  }

  return (
    <PageTransition className="space-y-6 max-w-6xl mx-auto">
      <PageHeader
        title="Expenses"
        description="Track business costs and see your profit picture at a glance."
        icon={<Receipt className="h-5 w-5" strokeWidth={2.2} />}
        iconGradient="from-rose-500 to-orange-600"
      >
        <Button
          variant="outline"
          onClick={() => exportExpensesCsv(filtered, currency)}
          disabled={!filtered.length}
          className="bg-white/70 dark:bg-slate-900/60"
        >
          <Download className="h-4 w-4 mr-2" />
          Export
        </Button>
        <ImportExpensesButton onImported={load} />
        <Button onClick={openNew} className="bg-gradient-to-r from-rose-500 to-orange-600 hover:from-rose-600 hover:to-orange-700 shadow-lg shadow-rose-500/25">
          <Plus className="h-4 w-4 mr-2" />
          Add Expense
        </Button>
      </PageHeader>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={TrendingDown}
          label="This Month"
          value={loading ? "…" : formatMoney(totals.monthTotal, currency)}
          iconBg="bg-rose-100 dark:bg-rose-950/50"
          iconColor="text-rose-600 dark:text-rose-400"
          valueColor="text-rose-700 dark:text-rose-400"
        />
        <KpiCard
          icon={Wallet}
          label={categoryFilter === "ALL" ? "Total Spent" : "Filtered Total"}
          value={loading ? "…" : formatMoney(totals.allTotal, currency)}
          iconBg="bg-slate-100 dark:bg-slate-800"
          iconColor="text-slate-700 dark:text-slate-300"
        />
        <KpiCard
          icon={PieIcon}
          label="Top Category"
          value={totals.byCategory[0]?.name ?? "—"}
          iconBg="bg-violet-100 dark:bg-violet-950/50"
          iconColor="text-violet-600 dark:text-violet-400"
          valueColor="text-slate-900 dark:text-white"
        >
          {totals.byCategory[0] && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
              {formatMoney(totals.byCategory[0].amount, currency)}
            </p>
          )}
        </KpiCard>
        <KpiCard
          icon={Receipt}
          label="Entries"
          value={loading ? "…" : filtered.length.toLocaleString("en-IN")}
          iconBg="bg-blue-100 dark:bg-blue-950/50"
          iconColor="text-blue-600 dark:text-blue-400"
          valueColor="text-slate-900 dark:text-white"
        >
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {categoryFilter === "ALL" ? "All categories" : categoryFilter}
          </p>
        </KpiCard>
      </div>

      {/* Filters + list */}
      <Card className="surface overflow-hidden">
        <CardHeader className="border-b border-slate-100 dark:border-slate-800 flex flex-row items-center justify-between gap-2 flex-wrap pb-3">
          <CardTitle className="text-base flex items-center gap-2 text-slate-900 dark:text-white">
            <Filter className="h-4 w-4 text-slate-400" />
            All Expenses
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                placeholder="Search expenses..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 w-48 sm:w-56 text-sm pl-9"
              />
            </div>
            <Select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="h-9 w-44 text-sm bg-white dark:bg-slate-950"
            >
              <option value="ALL">All categories</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-16 text-center text-sm text-slate-500 flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading expenses...
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<Receipt className="h-7 w-7" strokeWidth={1.8} />}
                title={
                  expenses && expenses.length === 0
                    ? "No expenses yet"
                    : search.trim() || categoryFilter !== "ALL"
                      ? "No matching expenses"
                      : "No expenses yet"
                }
                description={
                  expenses && expenses.length === 0
                    ? "Log business costs like software, travel, and materials to see your true profit."
                    : search.trim()
                      ? `No expenses match "${search}". Try different keywords or clear filters.`
                      : "No expenses in this category."
                }
                action={
                  expenses && expenses.length === 0 ? (
                    <Button onClick={openNew} className="bg-gradient-to-r from-rose-500 to-orange-600 hover:from-rose-600 hover:to-orange-700 shadow-lg shadow-rose-500/25">
                      <Plus className="h-4 w-4 mr-2" />
                      Add first expense
                    </Button>
                  ) : (
                    <Button variant="outline" onClick={() => { setSearch(""); setCategoryFilter("ALL"); }}>
                      <X className="h-4 w-4 mr-2" />
                      Clear filters
                    </Button>
                  )
                }
              />
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((ex) => {
                const c = catStyle(ex.category);
                return (
                  <div key={ex.id} className="px-5 py-3.5 flex items-center gap-4 hover:bg-slate-50/70 dark:hover:bg-slate-800/40 group transition-colors">
                    <div className="w-24 shrink-0 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                      {formatDate(ex.date)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-white truncate">{ex.description}</p>
                      {ex.notes ? (
                        <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">{ex.notes}</p>
                      ) : (
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">No notes</p>
                      )}
                    </div>
                    <Badge className={`${c.pill} hidden sm:inline-flex`}>
                      <span className="h-1.5 w-1.5 rounded-full mr-1.5" style={{ background: c.dot }} />
                      {ex.category}
                    </Badge>
                    <p className="text-sm font-semibold text-rose-600 dark:text-rose-400 tabular-nums w-24 text-right shrink-0">
                      −{formatMoney(Number(ex.amount), currency)}
                    </p>
                    <div className="flex items-center gap-1 w-[72px] justify-end opacity-0 group-hover:opacity-100 transition-opacity no-print">
                      <button
                        type="button"
                        onClick={() => openEdit(ex)}
                        className="h-8 w-8 rounded-md text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 flex items-center justify-center"
                        aria-label="Edit expense"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(ex.id)}
                        className="h-8 w-8 rounded-md text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center justify-center"
                        aria-label="Delete expense"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Category breakdown (when data exists) */}
      {!loading && totals.byCategory.length > 0 && (
        <Card className="surface overflow-hidden">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <PieIcon className="h-4 w-4 text-violet-500" />
              Category Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2.5">
            {totals.byCategory.slice(0, 6).map((c) => {
              const pct = totals.maxCat > 0 ? (c.amount / totals.maxCat) * 100 : 0;
              return (
                <div key={c.name} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: c.dot }} />
                      <span className="font-medium text-slate-700 dark:text-slate-300 truncate">{c.name}</span>
                    </div>
                    <span className="font-semibold tabular-nums text-slate-900 dark:text-white">
                      {formatMoney(c.amount, currency)}
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${pct}%`, background: c.dot }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Expense" : "Add Expense"}</DialogTitle>
            <DialogDescription>
              {editingId ? "Update the expense entry." : "Log a new business expense."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit}>
            <div className="space-y-4 py-2">
              {formError && (
                <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 p-3 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
                  <X className="h-4 w-4 mt-0.5 shrink-0" /> {formError}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="x-date">Date</Label>
                  <Input id="x-date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="h-10" required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="x-amount">Amount ({currency})</Label>
                  <Input id="x-amount" type="number" min={0.01} step={0.01} value={form.amount} onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })} className="h-10" required />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="x-cat">Category</Label>
                <Select id="x-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="h-10 bg-white dark:bg-slate-950">
                  {DEFAULT_EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="x-desc">Description</Label>
                <Input id="x-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="h-10" maxLength={200} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="x-notes">Notes (optional)</Label>
                <Textarea id="x-notes" value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} maxLength={1000} />
              </div>
            </div>
            <DialogFooter className="pt-2">
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                {editingId ? "Save changes" : "Add expense"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
