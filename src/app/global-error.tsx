"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, RotateCcw, Home } from "lucide-react";
import Link from "next/link";

/**
 * Global error boundary for the App Router.
 *
 * This is rendered by Next.js when an unhandled exception bubbles up in any
 * route (page, layout, or server component). It MUST render its own <html>
 * and <body> tags because it replaces the root layout entirely during a
 * fatal error.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error#global-errorjs
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-gradient-to-br from-slate-50 via-red-50/20 to-orange-50/30 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 flex items-center justify-center p-4 relative overflow-hidden">
        <div className="absolute top-0 -left-40 w-96 h-96 bg-red-400/15 dark:bg-red-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 -right-40 w-96 h-96 bg-orange-400/15 dark:bg-orange-500/10 rounded-full blur-3xl pointer-events-none" />

        <Card className="relative z-10 w-full max-w-lg text-center border-slate-200/60 dark:border-slate-800/60 shadow-xl backdrop-blur-sm">
          <CardContent className="pt-12 pb-10 px-8">
            <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-red-100 to-orange-100 dark:from-red-900/40 dark:to-orange-900/40 shadow-inner">
              <AlertTriangle className="h-10 w-10 text-red-600 dark:text-red-400" />
            </div>

            <p className="text-sm font-bold text-red-600 dark:text-red-400 uppercase tracking-widest">
              Fatal Error
            </p>
            <h1 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">
              Something went wrong
            </h1>
            <p className="mt-3 text-slate-500 dark:text-slate-400 text-sm leading-relaxed">
              An unexpected error occurred while loading this page. You can try
              again, and if the problem persists please contact support.
            </p>

            {error.digest && (
              <p className="mt-4 text-xs text-slate-400 font-mono bg-slate-50 dark:bg-slate-800/50 rounded-md py-1 px-2 inline-block">
                Error ID: {error.digest}
              </p>
            )}

            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
              <Button onClick={() => reset()} className="w-full sm:w-auto shadow-lg shadow-blue-500/25">
                <RotateCcw className="h-4 w-4 mr-2" />
                Try Again
              </Button>
              <Link href="/dashboard" className="w-full sm:w-auto">
                <Button variant="outline" className="w-full sm:w-auto">
                  <Home className="h-4 w-4 mr-2" />
                  Back to Dashboard
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </body>
    </html>
  );
}
