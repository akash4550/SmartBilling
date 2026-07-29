"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Upload, FileSpreadsheet, X, Loader2, Download, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseCsv } from "@/lib/csv-parse";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

interface ImportClientsButtonProps {
  onImported?: () => void;
  variant?: "outline" | "default" | "ghost" | "secondary";
  size?: "sm" | "default" | "icon";
}

interface RowError {
  row: number;
  name?: string;
  email?: string;
  message: string;
}

const TEMPLATE_CSV = "name,email,phone,address\nAcme Corp,billing@acme.com,+91 98765 43210,\"123 Main St, Pune, MH 411001\"\nJane Doe,jane@example.com,,\n";

export function ImportClientsButton({ onImported, variant = "outline", size = "sm" }: ImportClientsButtonProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<number>(0);
  const [errors, setErrors] = useState<RowError[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function reset() {
    setFile(null);
    setParsedRows(0);
    setErrors([]);
    setParseErrors([]);
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function downloadTemplate() {
    const blob = new Blob([TEMPLATE_CSV], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "clients-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleFile(f: File) {
    setResult(null);
    setErrors([]);
    setParseErrors([]);
    if (f.size > 1024 * 1024) {
      toast.error("File too large", { description: "Please upload a CSV smaller than 1 MB." });
      return;
    }
    try {
      const text = await f.text();
      const { rows, errors: parseErrs } = parseCsv(text);
      setFile(f);
      setParsedRows(rows.length);
      if (parseErrs.length > 0) {
        setParseErrors(parseErrs);
      }
    } catch (err) {
      toast.error("Could not read file", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  async function handleImport() {
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const { rows } = parseCsv(text);
      const res = await fetch("/api/clients/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Import failed");
        return;
      }
      const errs = (data.errors ?? []) as RowError[];
      setErrors(errs);
      setResult({ created: data.created ?? 0, skipped: data.skipped ?? 0 });
      if (data.created > 0) {
        toast.success(`Imported ${data.created} client${data.created === 1 ? "" : "s"}`, {
          description: errs.length > 0 ? `${errs.length} row${errs.length === 1 ? "" : "s"} skipped` : undefined,
        });
        onImported?.();
      } else if (errs.length > 0) {
        toast.error(`No clients imported`, { description: `${errs.length} row${errs.length === 1 ? "" : "s"} failed validation` });
      }
    } catch {
      toast.error("Network error — please try again");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setTimeout(reset, 200); }}>
      <DialogTrigger asChild>
        <Button type="button" variant={variant} size={size}>
          <Upload className="h-4 w-4 mr-2" /> Import CSV
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import clients from CSV</DialogTitle>
          <DialogDescription>
            Upload a CSV with columns <strong>name</strong>, <strong>email</strong>, and optionally <strong>phone</strong>, <strong>address</strong>. Up to 500 rows per import.
          </DialogDescription>
        </DialogHeader>

        {!result ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={downloadTemplate} className="text-xs">
                <Download className="h-3.5 w-3.5 mr-1.5" /> Download template
              </Button>
              <p className="text-xs text-slate-500">Accepted aliases: Client Name, Email Address, Phone, Billing Address</p>
            </div>

            <label
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) handleFile(f);
              }}
              className={[
                "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 cursor-pointer transition-colors text-center",
                dragOver
                  ? "border-blue-400 bg-blue-50 dark:bg-blue-950/30"
                  : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-slate-50/60 dark:bg-slate-900/30",
              ].join(" ")}
            >
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
              {file ? (
                <>
                  <FileSpreadsheet className="h-8 w-8 text-emerald-600" />
                  <p className="text-sm font-medium text-slate-900 dark:text-white">{file.name}</p>
                  <p className="text-xs text-slate-500">{parsedRows} data row{parsedRows === 1 ? "" : "s"} detected</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); reset(); }}
                  >
                    <X className="h-3.5 w-3.5 mr-1" /> Remove
                  </Button>
                </>
              ) : (
                <>
                  <Upload className="h-8 w-8 text-slate-400" />
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Click to upload or drag & drop</p>
                  <p className="text-xs text-slate-500">CSV files only (max 1 MB)</p>
                </>
              )}
            </label>

            {parseErrors.length > 0 && (
              <div className="rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300">
                {parseErrors.map((e, i) => <p key={i}>• {e}</p>)}
              </div>
            )}

            <div>
              <Label className="text-xs text-slate-500">
                Emails that already exist in your client list will be skipped and reported below.
              </Label>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50">
              <CheckCircle2 className="h-6 w-6 text-emerald-600 shrink-0" />
              <div>
                <p className="font-semibold text-emerald-700 dark:text-emerald-300">Import complete</p>
                <p className="text-sm text-emerald-600 dark:text-emerald-400">
                  {result.created} created · {result.skipped} skipped
                </p>
              </div>
            </div>
            {errors.length > 0 && (
              <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/50">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold text-slate-600 dark:text-slate-300">Row</th>
                      <th className="text-left px-3 py-2 font-semibold text-slate-600 dark:text-slate-300">Name / Email</th>
                      <th className="text-left px-3 py-2 font-semibold text-slate-600 dark:text-slate-300">Issue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errors.slice(0, 50).map((e, i) => (
                      <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-3 py-1.5 font-mono text-slate-500">{e.row}</td>
                        <td className="px-3 py-1.5">
                          <div className="font-medium text-slate-800 dark:text-slate-200">{e.name || "—"}</div>
                          <div className="text-slate-500">{e.email || ""}</div>
                        </td>
                        <td className="px-3 py-1.5 text-red-600 dark:text-red-400">{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {errors.length > 50 && (
                  <p className="text-xs text-slate-500 text-center py-2">… and {errors.length - 50} more</p>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              type="button"
              onClick={handleImport}
              disabled={!file || parsedRows === 0 || parseErrors.length > 0 || importing}
              className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
            >
              {importing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
              {importing ? "Importing…" : `Import ${parsedRows || ""} row${parsedRows === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
