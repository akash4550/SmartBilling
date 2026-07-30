"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, FileText, UserPlus, ArrowLeft } from "lucide-react";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { PageTransition } from "@/components/page-transition";
import { NewClientDialog } from "@/components/clients/new-client-dialog";
import type { Client } from "@prisma/client";

interface UserSettings {
  defaultTaxRate: number | string;
  defaultTaxLabel?: string;
  defaultDueDays?: number;
  defaultNotes?: string | null;
}

function NewInvoicePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const clientIdParam = searchParams.get("clientId");

  const [clients, setClients] = useState<Client[] | null>(null);
  const [defaultTaxRate, setDefaultTaxRate] = useState(0);
  const [defaultTaxLabel, setDefaultTaxLabel] = useState("GST");
  const [defaultDueDays, setDefaultDueDays] = useState(30);
  const [defaultNotes, setDefaultNotes] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [clientsRes, settingsRes] = await Promise.all([
          fetch("/api/clients", { cache: "no-store" }),
          fetch("/api/settings", { cache: "no-store" }),
        ]);
        if (!clientsRes.ok) throw new Error("Failed to load clients");
        const data: Client[] = await clientsRes.json();
        if (!mounted) return;
        setClients(data);
        if (settingsRes.ok) {
          const s: UserSettings = await settingsRes.json();
          setDefaultTaxRate(Number(s.defaultTaxRate) || 0);
          setDefaultTaxLabel(typeof s.defaultTaxLabel === "string" && s.defaultTaxLabel ? s.defaultTaxLabel : "GST");
          setDefaultDueDays(Number(s.defaultDueDays) >= 0 ? Number(s.defaultDueDays) : 30);
          setDefaultNotes(typeof s.defaultNotes === "string" ? s.defaultNotes : "");
        }
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, []);

  return (
    <PageTransition className="space-y-6 no-print">
      <PageHeader
        title="New Invoice"
        description="Create a professional invoice and send it to your client in seconds."
        icon={<FileText className="h-5 w-5" strokeWidth={2.2} />}
        iconGradient="from-blue-600 to-indigo-600"
      >
        <Link href="/invoices">
          <Button variant="outline" className="bg-white/70 dark:bg-slate-900/60">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to invoices
          </Button>
        </Link>
      </PageHeader>

      {loading ? (
        <Card className="surface overflow-hidden">
          <CardContent className="py-16 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600 mx-auto" />
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-3">Loading clients and settings...</p>
          </CardContent>
        </Card>
      ) : error ? (
        <Card className="surface border-red-200 dark:border-red-900 bg-red-50/60 dark:bg-red-950/20">
          <CardContent className="py-10 text-center text-red-700 dark:text-red-300">
            <p className="font-medium">{error}</p>
            <Button variant="outline" className="mt-3" onClick={() => router.refresh()}>
              <Loader2 className="h-4 w-4 mr-2" /> Retry
            </Button>
          </CardContent>
        </Card>
      ) : clients && clients.length === 0 ? (
        <EmptyState
          icon={<UserPlus className="h-7 w-7" strokeWidth={1.8} />}
          title="Add a client first"
          description="You need at least one client before creating an invoice. Add a client in seconds — you'll be right back here to continue."
          action={
            <div className="flex items-center gap-2 justify-center flex-wrap">
              <Link href="/clients">
                <Button variant="outline">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Browse clients
                </Button>
              </Link>
              <NewClientDialog
                onSuccess={() => router.refresh()}
                trigger={
                  <Button className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25">
                    <UserPlus className="h-4 w-4 mr-2" />
                    Add a client
                  </Button>
                }
              />
            </div>
          }
        />
      ) : (
        <InvoiceForm
          mode="create"
          clients={clients ?? []}
          initialClientId={clientIdParam ?? undefined}
          defaultTaxRate={defaultTaxRate}
          defaultTaxLabel={defaultTaxLabel}
          defaultDueDays={defaultDueDays}
          defaultNotes={defaultNotes}
        />
      )}
    </PageTransition>
  );
}

export default function NewInvoicePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      }
    >
      <NewInvoicePageInner />
    </Suspense>
  );
}
