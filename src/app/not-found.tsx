import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FileX, Home, Receipt, ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="relative min-h-[calc(100vh-4rem)] flex items-center justify-center px-4 no-print overflow-hidden">
      {/* Decorative orbs */}
      <div className="absolute top-20 -left-40 w-96 h-96 bg-blue-400/15 dark:bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-10 -right-40 w-96 h-96 bg-indigo-400/15 dark:bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />

      <Card className="relative z-10 w-full max-w-md text-center border-slate-200/60 dark:border-slate-800/60 shadow-xl shadow-slate-200/50 dark:shadow-black/20 backdrop-blur-sm">
        <CardContent className="pt-12 pb-10 px-8">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-100 to-indigo-100 dark:from-blue-900/40 dark:to-indigo-900/40 shadow-inner">
            <FileX className="h-10 w-10 text-blue-600 dark:text-blue-400" />
          </div>

          <p className="text-sm font-bold bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400 bg-clip-text text-transparent uppercase tracking-widest">
            404
          </p>
          <h1 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">
            Page not found
          </h1>
          <p className="mt-3 text-slate-500 dark:text-slate-400 text-sm leading-relaxed">
            Sorry, we couldn&apos;t find what you&apos;re looking for. The page,
            invoice, or record you&apos;re trying to view may have been deleted
            or the link might be incorrect.
          </p>

          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link href="/dashboard" className="w-full sm:w-auto">
              <Button className="w-full sm:w-auto shadow-lg shadow-blue-500/25">
                <Home className="h-4 w-4 mr-2" />
                Back to Dashboard
              </Button>
            </Link>
            <Link href="/invoices" className="w-full sm:w-auto">
              <Button variant="outline" className="w-full sm:w-auto">
                <Receipt className="h-4 w-4 mr-2" />
                View Invoices
              </Button>
            </Link>
          </div>

          <div className="mt-6 pt-6 border-t border-slate-100 dark:border-slate-800">
            <Link href="/" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
              <ArrowLeft className="h-3 w-3" />
              Go to home
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
