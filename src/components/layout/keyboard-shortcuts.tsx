"use client";

/**
 * Global keyboard shortcuts for logged-in dashboard pages.
 *
 * Shortcuts:
 *   - "c" (when not typing in input/textarea/contenteditable): go to new client
 *   - "i" or "n": go to new invoice
 *   - "e": go to expenses
 *   - "r": go to recurring invoices
 *   - "s": go to settings
 *   - "d" or "g then d": go to dashboard
 *   - "/": focus first search input on page
 *   - "?": show shortcuts help
 */
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Keyboard } from "lucide-react";

function isEditable(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

export function KeyboardShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Don't trigger when typing in inputs or when modifier keys are held
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

      // Don't trigger shortcuts on auth / public pages
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
          // New client opens dialog via the Clients page; shortcut takes them there
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

  if (!showHelp) {
    // Small indicator in bottom-right corner that ? shows help
    if (
      pathname.startsWith("/login") ||
      pathname.startsWith("/register") ||
      pathname.startsWith("/view") ||
      pathname.startsWith("/portal")
    ) {
      return null;
    }
    return (
      <button
        type="button"
        onClick={() => setShowHelp(true)}
        className="fixed bottom-4 right-4 z-40 hidden md:flex items-center gap-1.5 rounded-full bg-white/90 dark:bg-slate-900/90 backdrop-blur border border-slate-200 dark:border-slate-800 shadow-lg px-3 py-1.5 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors no-print"
        aria-label="Show keyboard shortcuts"
      >
        <Keyboard className="h-3.5 w-3.5" />
        <span>Press <kbd className="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-[10px] font-mono">?</kbd> for shortcuts</span>
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm no-print" onClick={() => setShowHelp(false)}>
      <Card className="w-full max-w-md mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-6">
          <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
            <Keyboard className="h-5 w-5 text-blue-600" /> Keyboard Shortcuts
          </h3>
          <div className="space-y-2 text-sm">
            {[
              ["Go to Dashboard", "D"],
              ["New Invoice", "N or I"],
              ["Clients", "C"],
              ["Expenses", "E"],
              ["Recurring", "R"],
              ["Settings", "S"],
              ["Focus search", "/"],
              ["Toggle this help", "?"],
            ].map(([label, key]) => (
              <div key={key} className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
                <span className="text-slate-700 dark:text-slate-300">{label}</span>
                <kbd className="px-2 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-xs font-mono">{key}</kbd>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-400 mt-4">Press <kbd className="px-1 bg-slate-100 dark:bg-slate-800 rounded text-[10px] font-mono">Esc</kbd> or click outside to close.</p>
        </CardContent>
      </Card>
    </div>
  );
}
