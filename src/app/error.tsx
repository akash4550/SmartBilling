"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, RotateCcw, Home } from "lucide-react";
import Link from "next/link";

/**
 * Per-route error boundary. Renders INSIDE the root layout (Navbar + main
 * visible) when an error occurs in a page or its children. For a full-app
 * fatal error see global-error.tsx.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[RouteError]", error);
  }, [error]);

  return (
    <div className="relative flex items-center justify-center py-16 px-4 no-print min-h-[calc(100vh-8rem)]">
      <div className="absolute top-10 -left-40 w-96 h-96 bg-red-400/10 dark:bg-red-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-10 -right-40 w-96 h-96 bg-orange-400/10 dark:bg-orange-500/10 rounded-full blur-3xl pointer-events-none" />

      <Card className="relative z-10 w-full max-w-md text-center border-slate-200/60 dark:border-slate-800/60 shadow-xl shadow-slate-200/50 dark:shadow-black/20 backdrop-blur-sm">
        <CardContent className="pt-12 pb-10 px-8">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-red-100 to-orange-100 dark:from-red-900/40 dark:to-orange-900/40 shadow-inner">
            <AlertTriangle className="h-10 w-10 text-red-600 dark:text-red-400" />
          </div>

          <p className="text-sm font-bold text-red-600 dark:text-red-400 uppercase tracking-widest">
            Error
          </p>
          <h2 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">
            Something went wrong
          </h2>
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
            An unexpected error occurred while loading this page.
          </p>
          {error.digest && (
            <p className="mt-3 text-xs text-slate-400 font-mono bg-slate-50 dark:bg-slate-800/50 rounded-md py-1 px-2 inline-block">
              ID: {error.digest}
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
                Dashboard
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
