"use client";

import { useEffect, useState, Suspense, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, FileText, Loader2, Pencil, Ban, CheckCircle2, Copy } from "lucide-react";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { PageTransition } from "@/components/page-transition";
import type { Client } from "@prisma/client";
import type { InvoiceWithRelations } from "@/types";

function EditInvoicePageInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [clients, setClients] = useState<Client[] | null>(null);
  const [invoice, setInvoice] = useState<InvoiceWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; blocked?: "paid" | "void" | "notfound" | "forbidden" } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [clientsRes, invoiceRes] = await Promise.all([
        fetch("/api/clients", { cache: "no-store" }),
        fetch(`/api/invoices/${id}`, { cache: "no-store" }),
      ]);
      if (invoiceRes.status === 404) {
        setError({ message: "We couldn't find that invoice.", blocked: "notfound" });
        return;
      }
      if (!clientsRes.ok) throw new Error("Failed to load clients");
      if (!invoiceRes.ok) throw new Error("Failed to load invoice");
      const c: Client[] = await clientsRes.json();
      const i: InvoiceWithRelations = await invoiceRes.json();
      const ownsClient = c.some((cl) => cl.id === i.clientId);
      if (!ownsClient) {
        setError({ message: "This invoice belongs to a different account.", blocked: "forbidden" });
        return;
      }
      if (i.status === "VOID") {
        setError({ message: "Voided invoices cannot be edited.", blocked: "void" });
        return;
      }
      if (i.status === "PAID") {
        setError({ message: "Paid invoices cannot be edited — duplicate to create a new one, or void it.", blocked: "paid" });
        return;
      }
      setClients(c);
      setInvoice(i);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  return (
    <PageTransition className="space-y-6 no-print">
      <PageHeader
        title={invoice ? `Edit ${invoice.invoiceNumber}` : "Edit Invoice"}
        description="Update line items, taxes, due dates, or notes. Changes are saved when you click Save."
        icon={<Pencil className="h-5 w-5" strokeWidth={2.2} />}
        iconGradient="from-blue-600 to-indigo-600"
      >
        <Link href={invoice ? `/invoices/${invoice.id}` : "/invoices"}>
          <Button variant="outline" className="bg-white/70 dark:bg-slate-900/60">
            <ArrowLeft className="h-4 w-4 mr-2" />
            {invoice ? "Back to invoice" : "Back to invoices"}
          </Button>
        </Link>
      </PageHeader>

      {loading ? (
        <Card className="surface overflow-hidden">
          <CardContent className="py-16 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600 mx-auto" />
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-3">Loading invoice...</p>
          </CardContent>
        </Card>
      ) : error ? (
        error.blocked === "paid" || error.blocked === "void" ? (
          <EmptyState
            icon={error.blocked === "paid" ? <CheckCircle2 className="h-7 w-7" strokeWidth={1.8} /> : <Ban className="h-7 w-7" strokeWidth={1.8} />}
            title={error.blocked === "paid" ? "Invoice is already paid" : "Invoice is voided"}
            description={error.message}
            action={
              <div className="flex items-center justify-center gap-2 flex-wrap">
                <Link href={`/invoices/${id}`}>
                  <Button variant="outline">
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    View invoice
                  </Button>
                </Link>
                {error.blocked === "paid" && (
                  <Button
                    className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25"
                    onClick={() => router.push(`/invoices/${id}?duplicate=1`)}
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    Duplicate as new
                  </Button>
                )}
              </div>
            }
          />
        ) : (
          <Card className="surface border-red-200 dark:border-red-900 bg-red-50/60 dark:bg-red-950/20">
            <CardContent className="py-10 text-center text-red-700 dark:text-red-300">
              <FileText className="h-10 w-10 mx-auto mb-2 text-red-400" />
              <p className="font-medium">{error.message}</p>
              <div className="flex items-center justify-center gap-2 mt-4">
                <Link href="/invoices">
                  <Button variant="outline">
                    <ArrowLeft className="h-4 w-4 mr-2" /> Back to Invoices
                  </Button>
                </Link>
                <Button variant="outline" onClick={() => router.refresh()}>
                  <Loader2 className="h-4 w-4 mr-2" /> Retry
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      ) : clients && invoice ? (
        <InvoiceForm mode="edit" clients={clients} invoice={invoice} />
      ) : null}
    </PageTransition>
  );
}

export default function EditInvoicePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      }
    >
      <EditInvoicePageInner />
    </Suspense>
  );
}
