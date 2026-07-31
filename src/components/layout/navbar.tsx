"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import { signOut, useSession } from "next-auth/react";
import {
  FileText,
  Users,
  LayoutDashboard,
  Receipt,
  LogOut,
  UserCircle,
  ChevronDown,
  Settings,
  UserCog,
  RefreshCw,
  TrendingDown,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/invoices", label: "Invoices", icon: FileText },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/expenses", label: "Expenses", icon: TrendingDown },
  { href: "/recurring", label: "Recurring", icon: RefreshCw },
];

function UserMenu({ email, name }: { email: string; name?: string | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const initials = (name ?? email)
    .split(/[ @]/)[0]
    .slice(0, 2)
    .toUpperCase();

  async function handleSignOut() {
    await signOut({ callbackUrl: "/login" });
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full md:rounded-lg py-1.5 pl-1 pr-2 md:px-2 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        aria-label="Account menu"
      >
        <span className="h-8 w-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center text-xs font-semibold shadow-sm">
          {initials}
        </span>
        <span className="hidden md:flex items-center gap-1 text-sm">
          <span className="max-w-[140px] truncate text-slate-700 dark:text-slate-300">
            {email}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
        </span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-60 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg z-50 overflow-hidden animate-in fade-in">
            <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 bg-gradient-to-r from-blue-50/50 to-indigo-50/50 dark:from-blue-950/30 dark:to-indigo-950/30">
              <p className="text-sm font-medium truncate text-slate-900 dark:text-slate-100">
                {name ?? email}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{email}</p>
            </div>
            <Link
              href="/settings"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              <Settings className="h-4 w-4 text-slate-500" />
              Company Settings
            </Link>
            <Link
              href="/settings/account"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              <UserCog className="h-4 w-4 text-slate-500" />
              Account
            </Link>
            <Link
              href="/admin/ledger"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              <ShieldCheck className="h-4 w-4 text-slate-500" />
              Ledger Audit Console
            </Link>
            <button
              onClick={handleSignOut}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors border-t border-slate-100 dark:border-slate-800"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Navbar() {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const isPublicPage = pathname === "/login" || pathname.startsWith("/view");

  if (isPublicPage) return null;

  return (
    <header className="no-print sticky top-0 z-40 w-full border-b border-slate-200/60 dark:border-slate-800/60 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl supports-[backdrop-filter]:bg-white/60 dark:supports-[backdrop-filter]:bg-slate-900/60">
      <div className="container mx-auto max-w-7xl px-4">
        <div className="flex h-16 items-center justify-between gap-4">
          <Link href="/dashboard" className="flex items-center gap-2.5 font-bold text-xl shrink-0 group">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-md shadow-blue-500/20 group-hover:shadow-lg group-hover:shadow-blue-500/30 transition-shadow">
              <Receipt className="h-5 w-5 text-white" />
            </div>
            <span className="bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400 bg-clip-text text-transparent">
              SmartBill
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-1 p-1 rounded-lg bg-slate-100/80 dark:bg-slate-800/50">
            {navItems.map((item) => {
              const isActive = pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all",
                    isActive
                      ? "bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-300 shadow-sm"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-1 sm:gap-2">
            <Link href="/invoices/new" className="hidden sm:inline-flex">
              <Button
                size="sm"
                className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-md shadow-blue-500/20 hover:shadow-lg hover:shadow-blue-500/30"
              >
                <FileText className="h-4 w-4 mr-2" />
                New Invoice
              </Button>
            </Link>
            <ThemeToggle />
            {status === "authenticated" && session?.user ? (
              <UserMenu email={session.user.email ?? ""} name={session.user.name} />
            ) : status === "loading" ? (
              <div className="h-8 w-8 rounded-full bg-slate-200 dark:bg-slate-700 animate-pulse" />
            ) : (
              <Link href="/login">
                <Button variant="outline" size="sm">
                  <UserCircle className="h-4 w-4 mr-2" />
                  Sign in
                </Button>
              </Link>
            )}
          </div>
        </div>

        {/* Mobile nav */}
        <nav className="md:hidden flex items-center gap-1 pb-3 overflow-x-auto -mx-1 px-1">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors",
                  isActive
                    ? "bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
