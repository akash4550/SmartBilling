"use client";

import Link from "next/link";
import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Users, Mail, MapPin, Phone, Plus, FileText, ChevronRight, Loader2, Pencil, Link2, Check, Search, UserPlus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { NewClientDialog } from "@/components/clients/new-client-dialog";
import { EditClientDialog } from "@/components/clients/edit-client-dialog";
import { ImportClientsButton } from "@/components/clients/import-clients-button";
import { getPortalUrl } from "@/components/clients/portal-link-button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { PageTransition } from "@/components/page-transition";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import type { Client } from "@prisma/client";

type ClientWithCount = Client & { _count: { invoices: number } };

// Deterministic color pair for avatar backgrounds (based on client id).
const AVATAR_GRADIENTS = [
  "from-blue-500 to-indigo-600",
  "from-emerald-500 to-teal-600",
  "from-violet-500 to-purple-600",
  "from-amber-500 to-orange-600",
  "from-rose-500 to-pink-600",
  "from-sky-500 to-cyan-600",
  "from-fuchsia-500 to-pink-600",
  "from-lime-500 to-green-600",
];
function avatarGradientFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_GRADIENTS[Math.abs(h) % AVATAR_GRADIENTS.length];
}

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

  useEffect(() => { fetchClients(); }, [fetchClients]);

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        title="Clients"
        description={
          clients && clients.length > 0
            ? `${clients.length} customer${clients.length === 1 ? "" : "s"} in your directory`
            : "Manage your customer list"
        }
        icon={<Users className="h-5 w-5" strokeWidth={2.2} />}
        iconGradient="from-emerald-500 to-teal-600"
      >
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients..."
            className="pl-9 w-full sm:w-64 h-10"
          />
        </div>
        <ImportClientsButton onImported={fetchClients} />
        <NewClientDialog onSuccess={fetchClients} />
      </PageHeader>

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i} className="surface overflow-hidden">
              <CardContent className="p-5">
                <div className="flex items-center gap-3">
                  <div className="h-11 w-11 rounded-xl bg-slate-200 dark:bg-slate-800 animate-pulse" />
                  <div className="flex-1">
                    <div className="h-4 w-32 bg-slate-200 dark:bg-slate-800 rounded animate-pulse mb-2" />
                    <div className="h-3 w-48 bg-slate-100 dark:bg-slate-800/50 rounded animate-pulse" />
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  <div className="h-3 w-full bg-slate-100 dark:bg-slate-800/50 rounded animate-pulse" />
                  <div className="h-3 w-2/3 bg-slate-100 dark:bg-slate-800/50 rounded animate-pulse" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : error ? (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30">
          <CardContent className="py-10 text-center text-red-700 dark:text-red-300">
            <p className="font-medium">{error}</p>
            <Button onClick={fetchClients} variant="outline" className="mt-3">
              <Loader2 className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : clients && clients.length === 0 ? (
        <EmptyState
          icon={<UserPlus className="h-7 w-7" strokeWidth={1.8} />}
          title="No clients yet"
          description="Add your first client to start creating invoices, sending payment reminders, and tracking customer history."
          action={
            <NewClientDialog
              onSuccess={fetchClients}
              trigger={
                <Button className="bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 shadow-lg shadow-emerald-500/25">
                  <Plus className="h-4 w-4 mr-2" />
                  Add your first client
                </Button>
              }
            />
          }
        />
      ) : search.trim() && filteredClients.length === 0 ? (
        <EmptyState
          icon={<Search className="h-7 w-7" strokeWidth={1.8} />}
          title="No matching clients"
          description={`No clients match "${search}". Try a different search term or clear the filter.`}
          action={
            <Button variant="outline" onClick={() => setSearch("")}>
              Clear search
            </Button>
          }
        />
      ) : (
        <motion.div
          layout
          className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"
        >
          <AnimatePresence mode="popLayout">
            {filteredClients.map((client, i) => {
              const gradient = avatarGradientFor(client.id);
              return (
                <motion.div
                  key={client.id}
                  layout
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.3, delay: Math.min(i * 0.04, 0.3), ease: [0.22, 1, 0.36, 1] }}
                  className="group relative"
                >
                  <Link href={`/clients/${client.id}`} className="block h-full">
                    <Card className="h-full surface overflow-hidden transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-200/50 dark:hover:shadow-black/30 relative">
                      {/* Accent glow on hover */}
                      <div aria-hidden className="absolute -top-16 -right-16 h-40 w-40 rounded-full bg-blue-400/10 dark:bg-blue-500/10 blur-3xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                      <CardHeader className="pb-3 relative">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className={`h-11 w-11 shrink-0 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center text-white font-semibold shadow-md text-base group-hover:scale-110 transition-transform`}>
                              {client.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <CardTitle className="text-base truncate text-slate-900 dark:text-white">
                                {client.name}
                              </CardTitle>
                              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                                {client.email}
                              </p>
                            </div>
                          </div>
                          {client._count.invoices > 0 && (
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/50 px-2 py-1 rounded-full shrink-0">
                              <FileText className="h-3 w-3" />
                              {client._count.invoices}
                            </span>
                          )}
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-1.5 pt-0 relative">
                        <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400 text-sm">
                          <Mail className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                          <span className="truncate">{client.email}</span>
                        </div>
                        {client.phone && (
                          <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400 text-sm">
                            <Phone className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                            <span className="truncate">{client.phone}</span>
                          </div>
                        )}
                        {client.address && (
                          <div className="flex items-start gap-2 text-slate-600 dark:text-slate-400 text-sm">
                            <MapPin className="h-3.5 w-3.5 text-slate-400 shrink-0 mt-0.5" />
                            <span className="line-clamp-1">{client.address}</span>
                          </div>
                        )}
                        <div className="flex items-center justify-between pt-3 mt-3 border-t border-slate-100 dark:border-slate-800">
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {client._count.invoices === 0
                              ? "No invoices yet"
                              : `${client._count.invoices} invoice${client._count.invoices === 1 ? "" : "s"} sent`}
                          </span>
                          <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-blue-600 group-hover:translate-x-1 transition-all" />
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                  <div className="no-print absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); copyPortalLink(client); }}
                      className="h-8 w-8 rounded-lg bg-white/90 dark:bg-slate-800/90 backdrop-blur border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 dark:hover:border-indigo-700 shadow-sm"
                      aria-label={`Copy portal link for ${client.name}`}
                      title="Copy portal link"
                    >
                      {copiedId === client.id ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Link2 className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditingClient(client); }}
                      className="h-8 w-8 rounded-lg bg-white/90 dark:bg-slate-800/90 backdrop-blur border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-700 shadow-sm"
                      aria-label={`Edit ${client.name}`}
                      title="Edit client"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>

          {!search.trim() && (
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3, delay: 0.2 }}
            >
              <NewClientDialog
                trigger={
                  <Card className="h-full border-2 border-dashed border-slate-300 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-600 hover:bg-blue-50/40 dark:hover:bg-blue-950/10 transition-all cursor-pointer flex items-center justify-center min-h-[196px] group bg-transparent">
                    <CardContent className="flex flex-col items-center justify-center py-8 text-center text-slate-500 dark:text-slate-400 group-hover:text-blue-600 dark:group-hover:text-blue-400">
                      <div className="h-12 w-12 rounded-full border-2 border-dashed border-current flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                        <Plus className="h-5 w-5" />
                      </div>
                      <p className="text-sm font-semibold">Add Client</p>
                      <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">New customer</p>
                    </CardContent>
                  </Card>
                }
                onSuccess={fetchClients}
              />
            </motion.div>
          )}
        </motion.div>
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
    </PageTransition>
  );
}
