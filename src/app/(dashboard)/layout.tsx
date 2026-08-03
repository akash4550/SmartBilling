import { Navbar } from "@/components/layout/navbar";
import { KeyboardShortcuts } from "@/components/layout/keyboard-shortcuts";

/**
 * Shared layout for authenticated application pages.
 *
 * The wider container gives dashboard grids enough room to stay balanced
 * without affecting the login page or public invoice portal.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Navbar />

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {children}
      </main>

      <footer className="no-print border-t border-slate-200 bg-white py-5 text-center text-xs text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-500">
        © {new Date().getFullYear()} SmartBill — Built with Next.js &amp; Prisma
      </footer>

      <KeyboardShortcuts />
    </>
  );
}