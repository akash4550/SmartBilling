"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { InvoiceForm } from "@/components/invoices/invoice-form";
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
    <div className="space-y-6 no-print">
      {loading ? (
        <Card className="border-slate-200/60 dark:border-slate-800/60">
          <CardContent className="py-16 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600 mx-auto" />
            <p className="text-sm text-slate-500 mt-3">Loading...</p>
          </CardContent>
        </Card>
      ) : error ? (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30">
          <CardContent className="py-8 text-center text-red-700 dark:text-red-300">
            <p>{error}</p>
            <Button variant="outline" className="mt-3" onClick={() => router.refresh()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : clients && clients.length === 0 ? (
        <Card className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30">
          <CardContent className="py-8 text-center">
            <p className="font-medium text-amber-900 dark:text-amber-200">No clients found</p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              You need to add at least one client before creating an invoice.
            </p>
            <Link href="/clients" className="inline-block mt-4">
              <Button>Go to Clients</Button>
            </Link>
          </CardContent>
        </Card>
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
    </div>
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
