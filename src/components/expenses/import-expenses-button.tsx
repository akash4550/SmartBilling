"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Upload, Loader2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseCsv } from "@/lib/csv-parse";

interface ImportExpensesButtonProps {
  onImported?: () => void;
}

const TEMPLATE = "date,category,description,amount,notes\n2026-07-01,Software & SaaS,Notion subscription,800,Annual plan\n2026-07-15,Travel,Client meeting - Pune,1250,Cab + lunch\n";

export function ImportExpensesButton({ onImported }: ImportExpensesButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);

  function downloadTemplate() {
    const blob = new Blob([TEMPLATE], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "expenses-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleFile(f: File) {
    if (f.size > 1024 * 1024) {
      toast.error("File too large", { description: "CSV must be under 1 MB." });
      return;
    }
    setLoading(true);
    try {
      const text = await f.text();
      const { rows, errors } = parseCsv(text);
      if (errors.length) {
        toast.error(errors[0]);
        return;
      }
      if (rows.length === 0) {
        toast.error("No data rows found");
        return;
      }
      // Normalize expected columns
      const payload = {
        rows: rows.map((r) => ({
          date: r.date ?? "",
          category: r.category ?? "General",
          description: r.description ?? r.vendor ?? r.payee ?? "",
          amount: r.amount ?? r.cost ?? "",
          notes: r.notes ?? "",
        })),
      };
      const res = await fetch("/api/expenses/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Import failed");
        return;
      }
      toast.success(`Imported ${data.created} expense${data.created === 1 ? "" : "s"}`, {
        description: data.errors?.length ? `${data.errors.length} row${data.errors.length === 1 ? "" : "s"} skipped` : undefined,
      });
      onImported?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setLoading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
      <Button
        type="button"
        variant="outline"
        onClick={() => inputRef.current?.click()}
        disabled={loading}
      >
        {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
        Import CSV
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={downloadTemplate}>
        <Download className="h-3.5 w-3.5 mr-1.5" /> Template
      </Button>
    </>
  );
}
