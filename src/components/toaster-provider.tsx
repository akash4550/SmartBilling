"use client";

import { Toaster as SonnerToaster } from "sonner";
import { CheckCircle2, AlertTriangle, Info, XCircle, Loader2 } from "lucide-react";

/**
 * Application-wide Sonner toaster. Renders nothing visible until a toast
 * is fired; mounted inside the root layout so toasts work from any page.
 */
export function ToasterProvider() {
  return (
    <SonnerToaster
      position="top-right"
      richColors
      closeButton
      duration={3800}
      icons={{
        success: <CheckCircle2 className="h-4 w-4" />,
        error: <XCircle className="h-4 w-4" />,
        warning: <AlertTriangle className="h-4 w-4" />,
        info: <Info className="h-4 w-4" />,
        loading: <Loader2 className="h-4 w-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "!bg-white/95 dark:!bg-slate-900/95 !backdrop-blur !border !border-slate-200 dark:!border-slate-800 !text-slate-900 dark:!text-slate-100 !shadow-xl !shadow-slate-200/50 dark:!shadow-black/30 !rounded-xl !p-4 !gap-3",
          title: "!text-sm !font-semibold",
          description: "!text-slate-500 dark:!text-slate-400 !text-xs !mt-0.5",
          icon: "!mt-0",
          actionButton:
            "!bg-gradient-to-r !from-blue-600 !to-indigo-600 hover:!from-blue-700 hover:!to-indigo-700 !text-white !h-8 !px-3 !rounded-lg !text-xs !font-semibold !shadow-md !shadow-blue-500/25",
          cancelButton:
            "!bg-slate-100 dark:!bg-slate-800 !text-slate-700 dark:!text-slate-300 hover:!bg-slate-200 dark:hover:!bg-slate-700 !h-8 !px-3 !rounded-lg !text-xs !font-medium",
          closeButton:
            "!text-slate-400 hover:!text-slate-700 dark:hover:!text-slate-200 !bg-transparent !border-0 hover:!bg-slate-100 dark:hover:!bg-slate-800 !right-2 !top-2 !left-auto !transform-none",
        },
      }}
    />
  );
}
