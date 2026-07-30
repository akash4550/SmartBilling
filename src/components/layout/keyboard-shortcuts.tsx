"use client";

/**
 * Global keyboard shortcuts for logged-in dashboard pages.
 *
 * Shortcuts:
 *   - "c" (when not typing): clients page
 *   - "i" or "n": new invoice
 *   - "e": expenses
 *   - "r": recurring
 *   - "s": settings
 *   - "d": dashboard
 *   - "/": focus search input
 *   - "?": show help
 */
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Keyboard, Command, X } from "lucide-react";

function isEditable(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

const SHORTCUTS: Array<{ label: string; keys: string[] }> = [
  { label: "Go to Dashboard", keys: ["D"] },
  { label: "New Invoice", keys: ["N"] },
  { label: "Clients", keys: ["C"] },
  { label: "Expenses", keys: ["E"] },
  { label: "Recurring", keys: ["R"] },
  { label: "Settings", keys: ["S"] },
  { label: "Focus search", keys: ["/"] },
  { label: "Toggle this help", keys: ["?"] },
  { label: "Close dialog", keys: ["Esc"] },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 rounded-md bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 shadow-[0_1px_0_rgba(0,0,0,0.08)] dark:shadow-[0_1px_0_rgba(0,0,0,0.4)] text-[11px] font-semibold font-mono text-slate-700 dark:text-slate-200">
      {children}
    </kbd>
  );
}

export function KeyboardShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;

      const k = e.key.toLowerCase();

      if (k === "?") {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        setShowHelp(false);
        return;
      }

      if (
        pathname.startsWith("/login") ||
        pathname.startsWith("/register") ||
        pathname.startsWith("/forgot") ||
        pathname.startsWith("/reset") ||
        pathname.startsWith("/view") ||
        pathname.startsWith("/portal")
      ) {
        return;
      }

      switch (k) {
        case "i":
        case "n":
          e.preventDefault();
          router.push("/invoices/new");
          break;
        case "c":
          e.preventDefault();
          router.push("/clients");
          break;
        case "e":
          e.preventDefault();
          router.push("/expenses");
          break;
        case "r":
          e.preventDefault();
          router.push("/recurring");
          break;
        case "s":
          e.preventDefault();
          router.push("/settings");
          break;
        case "d":
          e.preventDefault();
          router.push("/dashboard");
          break;
        case "/":
          e.preventDefault();
          const firstSearch = document.querySelector<HTMLInputElement>(
            'input[type="search"], input[placeholder*="earch"], input[placeholder*="Search"]',
          );
          firstSearch?.focus();
          firstSearch?.select();
          break;
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [router, pathname]);

  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/register") ||
    pathname.startsWith("/view") ||
    pathname.startsWith("/portal");

  if (isPublic) return null;

  return (
    <>
      {/* Floating hint button */}
      <button
        type="button"
        onClick={() => setShowHelp(true)}
        className="fixed bottom-4 right-4 z-40 hidden md:flex items-center gap-2 rounded-full bg-white/90 dark:bg-slate-900/90 backdrop-blur border border-slate-200 dark:border-slate-800 shadow-lg px-3 py-1.5 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white transition-all hover:shadow-xl no-print group"
        aria-label="Show keyboard shortcuts"
      >
        <Keyboard className="h-3.5 w-3.5" />
        <span className="hidden lg:inline">Shortcuts</span>
        <Kbd>?</Kbd>
      </button>

      {/* Help modal */}
      {showHelp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm no-print animate-in"
          onClick={() => setShowHelp(false)}
        >
          <Card
            className="w-full max-w-md mx-4 shadow-2xl border-slate-200/70 dark:border-slate-800/70 bg-white/95 dark:bg-slate-900/95 backdrop-blur"
            onClick={(e) => e.stopPropagation()}
          >
            <CardContent className="p-0">
              <div className="flex items-center justify-between p-5 pb-3 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2.5">
                  <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-md">
                    <Keyboard className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">Keyboard Shortcuts</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Navigate SmartBill faster</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowHelp(false)}
                  className="h-8 w-8 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center transition-colors"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-5 pt-3 space-y-0.5 max-h-[60vh] overflow-y-auto">
                {SHORTCUTS.map((s) => (
                  <div
                    key={s.label}
                    className="flex items-center justify-between py-2 text-sm"
                  >
                    <span className="text-slate-700 dark:text-slate-300">{s.label}</span>
                    <div className="flex items-center gap-1">
                      {s.keys.map((k, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && <span className="text-slate-400 text-xs">/</span>}
                          <Kbd>{k}</Kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="px-5 pb-4 pt-1">
                <p className="text-[11px] text-slate-400 dark:text-slate-500">
                  Tip: shortcuts are disabled while typing in inputs.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
