"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, Loader2, Trash2, Pencil, Save, X, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DEFAULT_EXPENSE_CATEGORIES, type ExpenseInput } from "@/lib/validations";
import { formatMoney } from "@/lib/format-money";

function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface Expense {
  id: string;
  date: string;
  category: string;
  description: string;
  amount: number | string;
  notes?: string | null;
}

interface ExpenseTrackerProps {
  currency: string;
}

export function ExpenseTracker({ currency }: ExpenseTrackerProps) {
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
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

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/expenses?limit=200", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load expenses");
      const data = (await res.json()) as Expense[];
      setExpenses(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load expenses");
    } finally {
      setLoading(false);
    }
  }

  async function openNew() {
    setEditingId(null);
    setForm({
      date: toLocalISODate(new Date()),
      category: "General",
      description: "",
      amount: 0,
      notes: "",
    });
    setFormError(null);
    setDialogOpen(true);
  }

  function openEdit(ex: Expense) {
    setEditingId(ex.id);
    setForm({
      date: toLocalISODate(new Date(ex.date)),
      category: ex.category,
      description: ex.description,
      amount: Number(ex.amount),
      notes: ex.notes ?? "",
    });
    setFormError(null);
    setDialogOpen(true);
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
        if (data.details && Array.isArray(data.details)) {
          setFormError(data.details[0]?.message || "Validation error");
        } else {
          setFormError(data.error || "Failed to save expense");
        }
        return;
      }
      toast.success(editingId ? "Expense updated" : "Expense added");
      setDialogOpen(false);
      load();
    } catch {
      setFormError("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this expense?")) return;
    try {
      const res = await fetch(`/api/expenses/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      toast.success("Expense deleted");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  // Auto-load on mount
  if (expenses === null && !loading) {
    load();
  }

  const totalMonth = (expenses ?? []).reduce((s, e) => {
    const d = new Date(e.date);
    const now = new Date();
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
      return s + Number(e.amount);
    }
    return s;
  }, 0);

  // Group recent expenses by category for the inline breakdown
  const byCategory = (expenses ?? []).reduce<Record<string, number>>((acc, e) => {
    const d = new Date(e.date);
    const now = new Date();
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
      acc[e.category] = (acc[e.category] ?? 0) + Number(e.amount);
    }
    return acc;
  }, {});

  return (
    <>
      <Card className="border-slate-200/60 dark:border-slate-800/60">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <span className="h-7 w-7 rounded-lg bg-rose-100 dark:bg-rose-950/50 flex items-center justify-center">
              <span className="text-rose-700 dark:text-rose-300 text-sm">💸</span>
            </span>
            Recent Expenses
          </CardTitle>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" onClick={openNew}>
                <Plus className="h-4 w-4 mr-1" /> Add Expense
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingId ? "Edit Expense" : "Add Expense"}</DialogTitle>
                <DialogDescription>Track business expenses for P&L reporting.</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                {formError && (
                  <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 p-3 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
                    <X className="h-4 w-4 mt-0.5 shrink-0" /> {formError}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="exp-date">Date</Label>
                    <Input
                      id="exp-date"
                      type="date"
                      value={form.date}
                      onChange={(e) => setForm({ ...form, date: e.target.value })}
                      className="h-10"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="exp-amount">Amount ({currency})</Label>
                    <Input
                      id="exp-amount"
                      type="number"
                      min={0.01}
                      step={0.01}
                      value={form.amount}
                      onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })}
                      className="h-10"
                      required
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="exp-cat">Category</Label>
                  <Select
                    id="exp-cat"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className="h-10 bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-700"
                  >
                    {DEFAULT_EXPENSE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="exp-desc">Description</Label>
                  <Input
                    id="exp-desc"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="e.g. Notion subscription, Client dinner"
                    className="h-10"
                    maxLength={200}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="exp-notes">Notes (optional)</Label>
                  <Textarea
                    id="exp-notes"
                    value={form.notes ?? ""}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    rows={2}
                    maxLength={1000}
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={submitting}>
                    {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                    {editingId ? "Save" : "Add expense"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-gradient-to-br from-rose-50 to-orange-50 dark:from-rose-950/40 dark:to-orange-950/30 border border-rose-100 dark:border-rose-900/40 p-3">
              <p className="text-xs text-rose-700 dark:text-rose-300 uppercase tracking-wider font-semibold">This month</p>
              <p className="text-xl font-bold text-rose-700 dark:text-rose-200 mt-1 tabular-nums">
                {loading ? "…" : formatMoney(totalMonth, currency)}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 dark:bg-slate-800/40 p-3 space-y-1">
              {Object.keys(byCategory).length === 0 ? (
                <p className="text-xs text-slate-500">No expenses this month yet.</p>
              ) : (
                Object.entries(byCategory)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3)
                  .map(([cat, amt]) => (
                    <div key={cat} className="flex items-center justify-between text-xs">
                      <span className="text-slate-600 dark:text-slate-400 truncate">{cat}</span>
                      <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-200">{formatMoney(amt, currency)}</span>
                    </div>
                  ))
              )}
            </div>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto">
            {loading ? (
              <div className="py-6 text-center text-sm text-slate-500">Loading expenses…</div>
            ) : !expenses || expenses.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-500">
                No expenses yet. Add your first expense to start tracking costs.
              </div>
            ) : (
              expenses.slice(0, 12).map((ex) => (
                <div key={ex.id} className="py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{ex.description}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {new Date(ex.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} · {ex.category}
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-rose-600 dark:text-rose-400 tabular-nums">−{formatMoney(Number(ex.amount), currency)}</p>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(ex)}
                      className="h-7 w-7 rounded-md text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center"
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(ex.id)}
                      className="h-7 w-7 rounded-md text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center justify-center"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          {expenses && expenses.length > 0 && (
            <Link href="/expenses">
              <Button type="button" variant="ghost" size="sm" className="w-full text-xs text-slate-500 group">
                View all expenses
                <ArrowRight className="h-3 w-3 ml-1 group-hover:translate-x-0.5 transition-transform" />
              </Button>
            </Link>
          )}
        </CardContent>
      </Card>
    </>
  );
}
