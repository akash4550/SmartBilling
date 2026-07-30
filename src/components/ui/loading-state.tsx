"use client";

import { Loader2, Receipt } from "lucide-react";

/**
 * Centered full-height loading spinner used by Suspense fallbacks and
 * initial page loads. Shows a subtle brand mark + spinner for better
 * perceived performance than a bare spinner.
 */
export function LoadingState({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4">
      <div className="relative">
        <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
          <Receipt className="h-7 w-7 text-white" />
        </div>
        <Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400 absolute -bottom-1 -right-1 bg-white dark:bg-slate-950 rounded-full p-0.5" />
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400">{label}</p>
    </div>
  );
}
