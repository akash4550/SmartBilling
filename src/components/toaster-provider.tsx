"use client";

import { Toaster as SonnerToaster } from "sonner";

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
      toastOptions={{
        classNames: {
          toast:
            "!bg-white dark:!bg-slate-900 !border !border-slate-200 dark:!border-slate-800 !text-slate-900 dark:!text-slate-100 !shadow-xl !rounded-xl",
          description: "!text-slate-500 dark:!text-slate-400",
          actionButton:
            "!bg-blue-600 !text-white hover:!bg-blue-700 !h-8 !px-3 !rounded-lg !text-sm !font-medium",
          cancelButton:
            "!bg-slate-100 dark:!bg-slate-800 !text-slate-700 dark:!text-slate-300 hover:!bg-slate-200 dark:hover:!bg-slate-700 !h-8 !px-3 !rounded-lg !text-sm !font-medium",
        },
      }}
    />
  );
}
