"use client";

import { useEffect, useState, Suspense, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, FileText, Loader2 } from "lucide-react";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import type { Client } from "@prisma/client";
import type { InvoiceWithRelations } from "@/types";

function EditInvoicePageInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [clients, setClients] = useState<Client[] | null>(null);
  const [invoice, setInvoice] = useState<InvoiceWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [clientsRes, invoiceRes] = await Promise.all([
        fetch("/api/clients", { cache: "no-store" }),
        fetch(`/api/invoices/${id}`, { cache: "no-store" }),
      ]);
      if (invoiceRes.status === 404) {
        setError("Invoice not found");
        return;
      }
      if (!clientsRes.ok) throw new Error("Failed to load clients");
      if (!invoiceRes.ok) throw new Error("Failed to load invoice");
      const c: Client[] = await clientsRes.json();
      const i: InvoiceWithRelations = await invoiceRes.json();
      // Ownership sanity check: the PATCH endpoint will re-verify, but if
      // the invoice client isn't in the user's client list (impossible for
      // a valid tenant but safe to guard), surface a friendly error.
      const ownsClient = c.some((cl) => cl.id === i.clientId);
      if (!ownsClient) {
        setError("This invoice belongs to a different account");
        return;
      }
      if (i.status === "VOID" || i.status === "PAID") {
        setError(i.status === "VOID" ? "Voided invoices cannot be edited." : "Paid invoices cannot be edited — void & recreate or use 'Duplicate'.");
        return;
      }
      setClients(c);
      setInvoice(i);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6 no-print">
      {loading ? (
        <Card className="border-slate-200/60 dark:border-slate-800/60">
          <CardContent className="py-16 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600 mx-auto" />
            <p className="text-sm text-slate-500 mt-3">Loading invoice...</p>
          </CardContent>
        </Card>
      ) : error ? (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30">
          <CardContent className="py-8 text-center text-red-700 dark:text-red-300">
            <FileText className="h-10 w-10 mx-auto mb-2 text-red-400" />
            <p className="font-medium">{error}</p>
            <div className="flex items-center justify-center gap-2 mt-4">
              <Link href="/invoices">
                <Button variant="outline">
                  <ArrowLeft className="h-4 w-4 mr-2" /> Back to Invoices
                </Button>
              </Link>
              <Button variant="outline" onClick={() => router.refresh()}>Retry</Button>
            </div>
          </CardContent>
        </Card>
      ) : clients && invoice ? (
        <InvoiceForm mode="edit" clients={clients} invoice={invoice} />
      ) : null}
    </div>
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
