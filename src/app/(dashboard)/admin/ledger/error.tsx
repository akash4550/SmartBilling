"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, ShieldAlert, RotateCcw } from "lucide-react";

/**
 * Segment error boundary for /admin/ledger.
 *
 * Rendered IN PLACE of the LedgerAdmin client tree when a Server Action
 * invocation or child render throws. We deliberately do NOT fall back to
 * the generic route error so operators see a message specific to the
 * audit console (which is a privileged, security-sensitive surface).
 */
export default function LedgerAdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side console.error is already in the action handlers;
    // client-side we log to stderr as [admin/ledger] for easy grep.
    console.error("[admin/ledger] UI error:", error);
  }, [error]);

  return (
    <div className="space-y-6">
      <Card className="border-red-200 dark:border-red-900/50">
        <div className="h-1.5 bg-gradient-to-r from-red-500/90 to-rose-600/90" />
        <CardContent className="pt-8 pb-8 px-6 sm:px-8">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-50 dark:bg-red-950/40 ring-4 ring-red-500/20">
              <ShieldAlert className="h-6 w-6 text-red-600 dark:text-red-400" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-red-700 dark:text-red-400 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Ledger Console Error
              </h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                The audit console failed to render or a server action threw
                an unhandled exception. The ledger itself is unaffected —
                this is a UI/render failure only. Click &quot;Try Again&quot;
                to re-mount the component tree, or refresh the page.
              </p>
              {error.digest && (
                <p className="mt-3 text-xs font-mono text-slate-500 bg-slate-50 dark:bg-slate-900/40 rounded px-2 py-1 inline-block">
                  digest: {error.digest}
                </p>
              )}
              {process.env.NODE_ENV !== "production" && error.message && (
                <pre className="mt-3 max-h-40 overflow-auto rounded bg-slate-900/90 text-slate-100 p-3 text-[11px] font-mono">
                  {error.message}
                </pre>
              )}
              <div className="mt-5 flex gap-2">
                <Button onClick={() => reset()} size="sm" className="gap-1.5">
                  <RotateCcw className="h-4 w-4" /> Try Again
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.location.reload()}
                >
                  Reload Page
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
