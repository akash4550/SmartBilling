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
import { ArrowLeft, Plus, Save, Trash2, Pencil, X, Loader2, TrendingDown, Receipt, Filter } from "lucide-react";
import { DEFAULT_EXPENSE_CATEGORIES, type ExpenseInput } from "@/lib/validations";
import { formatMoney } from "@/lib/format-money";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { ImportExpensesButton } from "@/components/expenses/import-expenses-button";

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

const CATEGORY_COLORS: Record<string, string> = {
  "Software & SaaS": "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  Marketing: "bg-pink-100 text-pink-700 dark:bg-pink-950/50 dark:text-pink-300",
  Travel: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  Materials: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  Contractors: "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300",
  Office: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  "Legal & Accounting": "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
  Taxes: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  "Bank Fees": "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
  General: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

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

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

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
    return {
      monthTotal,
      allTotal,
      byCategory: Array.from(byCategory.entries())
        .map(([name, amount]) => ({ name, amount }))
        .sort((a, b) => b.amount - a.amount),
    };
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
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href="/dashboard">
            <Button variant="ghost" size="icon" className="rounded-full">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Expenses</h1>
            <p className="text-slate-500 dark:text-slate-400 text-sm mt-0.5">
              Track business costs and see your profit picture.
            </p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <ImportExpensesButton onImported={load} />
          <Button
            variant="outline"
            onClick={() => exportExpensesCsv(filtered, currency)}
            disabled={!filtered.length}
          >
            Export CSV
          </Button>
          <Button onClick={openNew} className="bg-gradient-to-r from-rose-600 to-orange-600 hover:from-rose-700 hover:to-orange-700 shadow-lg shadow-rose-500/20">
            <Plus className="h-4 w-4 mr-2" /> Add Expense
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-6 flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-rose-100 dark:bg-rose-950/50 flex items-center justify-center">
              <TrendingDown className="h-5 w-5 text-rose-600 dark:text-rose-400" />
            </div>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold">This month</p>
              <p className="text-xl font-bold text-rose-700 dark:text-rose-300 tabular-nums">
                {loading ? "…" : formatMoney(totals.monthTotal, currency)}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
              <Receipt className="h-5 w-5 text-slate-600 dark:text-slate-300" />
            </div>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold">Total (filtered)</p>
              <p className="text-xl font-bold text-slate-900 dark:text-white tabular-nums">
                {loading ? "…" : formatMoney(totals.allTotal, currency)}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-2">Top categories</p>
            <div className="space-y-1 max-h-16 overflow-hidden">
              {totals.byCategory.slice(0, 3).map((c) => (
                <div key={c.name} className="flex items-center justify-between text-xs">
                  <span className="text-slate-600 dark:text-slate-400 truncate">{c.name}</span>
                  <span className="font-semibold tabular-nums">{formatMoney(c.amount, currency)}</span>
                </div>
              ))}
              {totals.byCategory.length === 0 && <p className="text-xs text-slate-400">No expenses yet</p>}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="border-b border-slate-100 dark:border-slate-800 flex flex-row items-center justify-between gap-2 flex-wrap pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="h-4 w-4" /> All Expenses
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              placeholder="Search expenses…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-48 text-sm"
            />
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
            <div className="py-16 text-center text-sm text-slate-500">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center">
              <Receipt className="h-10 w-10 mx-auto text-slate-300 mb-2" />
              <p className="text-slate-500 text-sm">No expenses found. Add your first one to get started.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((ex) => (
                <div key={ex.id} className="px-5 py-3 flex items-center gap-4 hover:bg-slate-50 dark:hover:bg-slate-900/40">
                  <div className="w-24 text-xs text-slate-500 font-mono">{formatDate(ex.date)}</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 dark:text-white truncate">{ex.description}</p>
                    {ex.notes && <p className="text-xs text-slate-500 truncate">{ex.notes}</p>}
                  </div>
                  <Badge className={CATEGORY_COLORS[ex.category] || CATEGORY_COLORS.General}>{ex.category}</Badge>
                  <p className="text-sm font-semibold text-rose-600 dark:text-rose-400 tabular-nums w-24 text-right">
                    −{formatMoney(Number(ex.amount), currency)}
                  </p>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(ex)}
                      className="h-8 w-8 rounded-md text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(ex.id)}
                      className="h-8 w-8 rounded-md text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center justify-center"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <CardHeader>
              <CardTitle>{editingId ? "Edit Expense" : "Add Expense"}</CardTitle>
            </CardHeader>
            <form onSubmit={handleSubmit}>
              <CardContent className="space-y-4">
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
              </CardContent>
              <div className="flex justify-end gap-2 px-6 pb-6">
                <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                  {editingId ? "Save" : "Add"}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
