"use client";

import type { ReactNode } from "react";
import { motion } from "framer-motion";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/**
 * Reusable, polished empty-state panel.
 *
 * Use for "no invoices / no clients / no expenses" scenarios so the app
 * doesn't show an awkward blank table area.
 */
export function EmptyState({ icon, title, description, action, className = "" }: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className={`relative overflow-hidden rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/40 p-10 sm:p-14 text-center ${className}`}
    >
      {/* Soft dot grid */}
      <div aria-hidden className="absolute inset-0 bg-dot-grid opacity-30 dark:opacity-20 pointer-events-none" />
      <div aria-hidden className="absolute -top-20 left-1/2 -translate-x-1/2 h-40 w-40 rounded-full bg-blue-400/10 dark:bg-blue-500/10 blur-3xl pointer-events-none" />

      <div className="relative">
        <div className="mx-auto h-14 w-14 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm flex items-center justify-center text-slate-500 dark:text-slate-400 mb-4">
          {icon}
        </div>
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">{title}</h3>
        {description && (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            {description}
          </p>
        )}
        {action && <div className="mt-5 flex justify-center">{action}</div>}
      </div>
    </motion.div>
  );
}
