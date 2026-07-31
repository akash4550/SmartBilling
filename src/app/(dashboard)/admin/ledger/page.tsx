import { redirect } from "next/navigation";
import { ShieldCheck, ChevronRight } from "lucide-react";
import { requireUser } from "@/lib/api-helpers";
import {
  getTenantAuditOverview,
  getLedgerChainEntries,
  listReconciliationAudits,
} from "./actions";
import LedgerAdmin from "./_components/ledger-admin";

export const dynamic = "force-dynamic";

/**
 * Admin Ledger Audit Console.
 *
 * Server Component: fetches the initial overview, tail of the hash chain,
 * and recent audit history, then renders the interactive client
 * <LedgerAdmin/> which owns mutation state and talks to Server Actions.
 */
export default async function AdminLedgerPage() {
  const user = await requireUser();
  if (!user) redirect("/login");

  const [overview, entries, audits] = await Promise.all([
    getTenantAuditOverview(user.id),
    getLedgerChainEntries(user.id, 50),
    listReconciliationAudits(user.id, 25),
  ]);

  return (
    <>
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <ShieldCheck className="h-4 w-4" />
            <span>Admin</span>
            <ChevronRight className="h-3.5 w-3.5" />
            <span>Ledger Audit Console</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            Ledger Integrity
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 max-w-2xl">
            Cryptographic hash-chain audit, read-model balance reconciliation,
            and quarantine control for this tenant&apos;s double-entry ledger.
          </p>
        </div>
      </div>
      <LedgerAdmin
        initialOverview={overview}
        initialEntries={entries}
        initialAudits={audits}
      />
      <p className="text-xs text-slate-400 dark:text-slate-500 pt-4 border-t border-slate-200/60 dark:border-slate-800/60">
        All reconciliation runs are append-only in{" "}
        <code className="font-mono text-[11px]">reconciliation_audits</code>.
        Writes to financial tables are blocked while the ledger is quarantined
        (SQLSTATE{" "}
        <code className="font-mono text-[11px] text-red-600 dark:text-red-400">
          L0001
        </code>
        ), but customer webhook payments are held with{" "}
        <code className="font-mono text-[11px]">
          lastError=&apos;tenant_quarantined&apos;
        </code>{" "}
        until operator release.
      </p>
    </>
  );
}
