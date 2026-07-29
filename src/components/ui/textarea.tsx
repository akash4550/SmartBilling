"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          "flex min-h-[80px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-slate-400",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:border-blue-500",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "dark:border-slate-800 dark:bg-slate-950 dark:placeholder:text-slate-500 dark:focus-visible:ring-blue-400",
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";
