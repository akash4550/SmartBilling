"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: React.ReactNode;
  icon?: ReactNode;
  iconGradient?: string;
  children?: ReactNode;
  /** Optional badge content (rendered next to the title) */
  badge?: ReactNode;
}

/**
 * Shared page header used across list/detail pages.
 *
 * Provides consistent title + description + action slot styling, a
 * soft icon chip, and a subtle entrance animation.
 */
export function PageHeader({
  title,
  description,
  icon,
  iconGradient = "from-blue-600 to-indigo-600",
  children,
  badge,
}: PageHeaderProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-6 no-print"
    >
      <div className="flex items-start gap-3 min-w-0">
        {icon && (
          <div
            className={`hidden sm:flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${iconGradient} text-white shadow-md shadow-blue-500/20`}
          >
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">
              {title}
            </h1>
            {badge}
          </div>
          {description && (
            <p className="text-slate-500 dark:text-slate-400 mt-1 text-sm sm:text-base">
              {description}
            </p>
          )}
        </div>
      </div>
      {children && (
        <div className="flex flex-wrap gap-2 shrink-0 items-center sm:pt-1">{children}</div>
      )}
    </motion.div>
  );
}
