import Link from "next/link";
import { Navbar } from "@/components/layout/navbar";
import { KeyboardShortcuts } from "@/components/layout/keyboard-shortcuts";
import { Receipt, Heart, ExternalLink } from "lucide-react";

/**
 * Dashboard layout — wraps all authenticated (admin) pages with the
 * sticky Navbar and site footer. Pages outside this route group
 * (e.g. /login and the public /view/:id portal) render WITHOUT this
 * chrome, which is the desired behaviour for emailed invoice links
 * and the login screen.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Navbar />
      <main className="container mx-auto px-4 py-8 max-w-7xl flex-1">
        {children}
      </main>
      <footer className="no-print py-5 border-t border-slate-200/70 dark:border-slate-800/70 bg-white/60 dark:bg-slate-950/60 backdrop-blur-sm">
        <div className="container mx-auto max-w-7xl px-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center">
              <Receipt className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="font-medium text-slate-700 dark:text-slate-300">SmartBill</span>
            <span className="text-slate-400 dark:text-slate-600">—</span>
            <span>© {new Date().getFullYear()} · Built with <Heart className="inline h-3 w-3 align-text-bottom text-rose-500 fill-rose-500" /> using Next.js</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden sm:inline-flex items-center gap-1.5">
              Press <kbd className="px-1.5 py-0.5 text-[10px] rounded border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 font-mono">?</kbd> for shortcuts
            </span>
            <Link
              href="https://github.com/akash4550/SmartBilling"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Source
            </Link>
          </div>
        </div>
      </footer>
      <KeyboardShortcuts />
    </>
  );
}
