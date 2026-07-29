import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-slate-950 focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-slate-900 text-slate-50 dark:bg-slate-50 dark:text-slate-900",
        secondary: "border-transparent bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100",
        destructive: "border-transparent bg-red-500 text-slate-50 dark:bg-red-600",
        outline: "text-slate-950 dark:text-slate-100 border-slate-200 dark:border-slate-700",
        // Status colors for invoices
        success: "border-transparent bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-900/50 ring-1 ring-inset ring-emerald-600/20 dark:ring-emerald-400/20",
        warning: "border-transparent bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-900/50 ring-1 ring-inset ring-amber-600/20 dark:ring-amber-400/20",
        draft: "border-transparent bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 ring-1 ring-inset ring-slate-500/20",
        info: "border-transparent bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400 ring-1 ring-inset ring-blue-600/20",
        danger: "border-transparent bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400 ring-1 ring-inset ring-red-600/20 animate-pulse",
        neutral: "border-transparent bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400 ring-1 ring-inset ring-slate-400/20 line-through decoration-slate-400/60",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
