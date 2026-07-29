"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Show the checkbox in an "indeterminate" state (some selected). */
  indeterminate?: boolean;
}

/**
 * Lightweight accessible checkbox that wraps a native <input type="checkbox">
 * with a Tailwind-styled visual box (no Radix dependency). Supports the
 * `indeterminate` prop (visual-only — does not change the checked value).
 */
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked, indeterminate, disabled, onChange, ...props }, forwardedRef) => {
    const innerRef = React.useRef<HTMLInputElement>(null);
    const ref = React.useMemo(() => {
      // Merge refs (forwardedRef + innerRef for indeterminate)
      return (el: HTMLInputElement | null) => {
        (innerRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
      };
    }, [forwardedRef]);

    React.useEffect(() => {
      if (innerRef.current) innerRef.current.indeterminate = !!indeterminate && checked !== true;
    }, [indeterminate, checked]);

    const isChecked = checked === true;
    const isIndeterminate = !!indeterminate && !isChecked;

    return (
      <label
        className={cn(
          "inline-flex items-center justify-center shrink-0 rounded border transition-colors cursor-pointer",
          "h-4 w-4",
          isChecked
            ? "bg-blue-600 border-blue-600 text-white"
            : isIndeterminate
            ? "bg-blue-600 border-blue-600 text-white"
            : "bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700 hover:border-blue-500",
          disabled && "opacity-50 cursor-not-allowed",
          className,
        )}
      >
        <input
          ref={ref}
          type="checkbox"
          className="sr-only"
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          {...props}
        />
        {isChecked ? <Check className="h-3 w-3" strokeWidth={3} /> : isIndeterminate ? (
          <span className="h-0.5 w-2 bg-white rounded-full" />
        ) : null}
      </label>
    );
  },
);
Checkbox.displayName = "Checkbox";
