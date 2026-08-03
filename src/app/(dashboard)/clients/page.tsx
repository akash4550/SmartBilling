"use client";

import Link from "next/link";
import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Users, Mail, MapPin, Phone, Plus, FileText, ChevronRight, Pencil, Link2, Check, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { NewClientDialog } from "@/components/clients/new-client-dialog";
import { EditClientDialog } from "@/components/clients/edit-client-dialog";
import { ImportClientsButton } from "@/components/clients/import-clients-button";
import { getPortalUrl } from "@/components/clients/portal-link-button";
import { toast } from "sonner";
import type { Client } from "@prisma/client";

type ClientWithCount = Client & { _count: { invoices: number } };

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientWithCount[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingClient, setEditingClient] = useState<ClientWithCount | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const filteredClients = clients?.filter((c) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      (c.phone ?? "").toLowerCase().includes(q) ||
      (c.address ?? "").toLowerCase().includes(q)
    );
  }) ?? [];

  async function copyPortalLink(client: ClientWithCount) {
    try {
      await navigator.clipboard.writeText(getPortalUrl(client.portalToken));
      setCopiedId(client.id);
      toast.success("Portal link copied", { description: `${client.name} can now access all their invoices.` });
      setTimeout(() => setCopiedId((cur) => (cur === client.id ? null : cur)), 2000);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  }

  const fetchClients = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/clients", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load clients");
      const data: ClientWithCount[] = await res.json();
      setClients(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load clients");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void fetchClients(); }, 0);
    return () => clearTimeout(timer);
  }, [fetchClients]);

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">Clients</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1">Manage your customer list</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search clients..."
              className="pl-9 w-full sm:w-64"
            />
          </div>
          <ImportClientsButton onImported={fetchClients} />
          <NewClientDialog onSuccess={fetchClients} />
        </div>
      </div>

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader><div className="h-5 w-32 bg-slate-200 dark:bg-slate-800 rounded" /></CardHeader>
              <CardContent><div className="h-4 w-full bg-slate-100 dark:bg-slate-800/50 rounded mb-2" /><div className="h-4 w-2/3 bg-slate-100 dark:bg-slate-800/50 rounded" /></CardContent>
            </Card>
          ))}
        </div>
      ) : error ? (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30">
          <CardContent className="py-8 text-center text-red-700 dark:text-red-300">
            <p>{error}</p>
            <Button onClick={fetchClients} variant="outline" className="mt-3">Retry</Button>
          </CardContent>
        </Card>
      ) : clients && clients.length === 0 ? (
        <Card className="border-dashed border-slate-300 dark:border-slate-700 text-center py-20">
          <CardContent>
            <div className="mx-auto h-16 w-16 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4">
              <Users className="h-8 w-8 text-slate-400" />
            </div>
            <p className="font-semibold text-slate-700 dark:text-slate-300 text-lg">No clients yet</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
              Add your first client to start creating invoices and tracking payments.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
        {clients && search.trim() && filteredClients.length === 0 ? (
          <Card className="border-dashed border-slate-300 dark:border-slate-700 text-center py-12">
            <CardContent>
              <Search className="h-8 w-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
              <p className="text-sm text-slate-500">No clients match &quot;{search}&quot;</p>
            </CardContent>
          </Card>
        ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredClients.map((client) => (
            <div key={client.id} className="group relative">
              <Link href={`/clients/${client.id}`} className="block">
                <Card className="h-full hover:border-blue-200 dark:hover:border-blue-800 hover:shadow-xl transition-all duration-300 cursor-pointer relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-blue-100/50 to-transparent dark:from-blue-900/20 rounded-bl-full opacity-0 group-hover:opacity-100 transition-opacity" />
                  <CardHeader className="pb-3 relative">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-semibold shadow-md shadow-blue-500/20 text-base group-hover:scale-110 transition-transform">
                          {client.name.charAt(0).toUpperCase()}
                        </div>
                        <CardTitle className="text-lg truncate text-slate-900 dark:text-white pr-2">
                          {client.name}
                        </CardTitle>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2 pt-0 relative">
                    <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400 text-sm">
                      <Mail className="h-4 w-4 text-slate-400 shrink-0" />
                      <span className="truncate">{client.email}</span>
                    </div>
                    {client.phone && (
                      <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400 text-sm">
                        <Phone className="h-4 w-4 text-slate-400 shrink-0" />
                        <span className="truncate">{client.phone}</span>
                      </div>
                    )}
                    {client.address && (
                      <div className="flex items-start gap-2 text-slate-600 dark:text-slate-400 text-sm">
                        <MapPin className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
                        <span className="line-clamp-2">{client.address}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between pt-3 mt-3 border-t border-slate-100 dark:border-slate-800">
                      <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400 text-sm">
                        <FileText className="h-4 w-4 text-blue-500" />
                        <span>
                          <span className="font-semibold text-slate-900 dark:text-white">{client._count.invoices}</span>{" "}
                          invoice{client._count.invoices !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-blue-600 group-hover:translate-x-1 transition-all" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
              <div className="no-print absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); copyPortalLink(client); }}
                  className="h-8 w-8 rounded-lg bg-white/80 dark:bg-slate-800/80 backdrop-blur border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 dark:hover:border-indigo-700"
                  aria-label={`Copy portal link for ${client.name}`}
                  title="Copy portal link"
                >
                  {copiedId === client.id ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Link2 className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditingClient(client); }}
                  className="h-8 w-8 rounded-lg bg-white/80 dark:bg-slate-800/80 backdrop-blur border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-700"
                  aria-label={`Edit ${client.name}`}
                  title="Edit client"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}

          {!search.trim() && (
            <NewClientDialog
              trigger={
                <Card className="h-full border-dashed border-slate-300 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-600 hover:bg-blue-50/50 dark:hover:bg-blue-950/10 transition-all cursor-pointer flex items-center justify-center min-h-[180px] group">
                  <CardContent className="flex flex-col items-center justify-center py-8 text-center text-slate-500 dark:text-slate-400 group-hover:text-blue-600 dark:group-hover:text-blue-400">
                    <div className="h-11 w-11 rounded-full border-2 border-dashed border-current flex items-center justify-center mb-2 group-hover:scale-110 transition-transform">
                      <Plus className="h-5 w-5" />
                    </div>
                    <p className="text-sm font-medium">Add Client</p>
                  </CardContent>
                </Card>
              }
              onSuccess={fetchClients}
            />
          )}
        </div>
        )}
        </>
      )}

      <EditClientDialog
        client={editingClient}
        open={!!editingClient}
        onOpenChange={(o) => { if (!o) setEditingClient(null); }}
        onSuccess={() => {
          toast.success("Client updated");
          fetchClients();
        }}
      />
    </div>
  );
}
