import { Navbar } from "@/components/layout/navbar";
import { KeyboardShortcuts } from "@/components/layout/keyboard-shortcuts";

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
      <footer className="no-print py-6 text-center text-xs text-slate-400 dark:text-slate-500 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        © {new Date().getFullYear()} SmartBill — Built with Next.js &amp; Prisma
      </footer>
      <KeyboardShortcuts />
    </>
  );
}
