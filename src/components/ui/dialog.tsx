"use client";

import * as React from "react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

interface DialogContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialog() {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error("Dialog components must be used within <Dialog>");
  return ctx;
}

interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

export function Dialog({ open: controlledOpen, onOpenChange, children }: DialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const setOpen = React.useCallback(
    (value: boolean) => {
      if (!isControlled) setInternalOpen(value);
      onOpenChange?.(value);
    },
    [isControlled, onOpenChange]
  );

  // Close on ESC key + lock body scroll
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, setOpen]);

  return (
    <DialogContext.Provider value={{ open, setOpen }}>{children}</DialogContext.Provider>
  );
}

// ============================================================
// DIALOG TRIGGER
// ============================================================
// Semantics:
//  - By default (asChild=false) we render a <button>{children}</button>.
//    Use this for plain text/children (e.g. <DialogTrigger>Open</DialogTrigger>).
//  - When asChild=true, we merge our onClick onto the single child element
//    WITHOUT wrapping it in a <button>. This is REQUIRED when the child is
//    itself a <Button>, <a>, or any interactive element — otherwise we'd
//    produce invalid HTML like <button><button>…</button></button> which
//    causes React hydration errors and broken click bubbling.
//
type DialogTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
};

export function DialogTrigger({
  asChild = false,
  children,
  ...props
}: DialogTriggerProps) {
  const { setOpen } = useDialog();

  const handleClick = React.useCallback(
    (e: React.MouseEvent) => {
      if (e.defaultPrevented) return;
      setOpen(true);
    },
    [setOpen]
  );

  if (asChild) {
    const child = React.Children.only(children) as React.ReactElement<{
      onClick?: (e: React.MouseEvent) => void;
    }>;
    return React.cloneElement(child, {
      onClick: (e: React.MouseEvent) => {
        child.props.onClick?.(e);
        handleClick(e);
      },
    });
  }

  return (
    <button type="button" onClick={handleClick} {...props}>
      {children}
    </button>
  );
}

export function DialogContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { open, setOpen } = useDialog();
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in"
        onClick={() => setOpen(false)}
      />
      {/* Panel — dark-mode aware (white in light, slate-900 in dark) */}
      <div
        className={cn(
          "relative z-10 w-full max-w-lg rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xl border border-slate-200 dark:border-slate-700",
          "max-h-[90vh] overflow-y-auto",
          className
        )}
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="absolute right-4 top-4 rounded-sm opacity-70 text-slate-500 dark:text-slate-400 ring-offset-white dark:ring-offset-slate-900 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-slate-950 dark:focus:ring-slate-300 focus:ring-offset-2"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col space-y-1.5 p-6 pb-4 text-left", className)}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 p-6 pt-0",
        className
      )}
      {...props}
    />
  );
}

export function DialogTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn(
        "text-lg font-semibold leading-none tracking-tight text-slate-900 dark:text-slate-100",
        className
      )}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("text-sm text-slate-500 dark:text-slate-400", className)}
      {...props}
    />
  );
}
