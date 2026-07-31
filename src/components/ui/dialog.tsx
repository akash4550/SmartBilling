"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

// ============================================================
// DIALOG CONTEXT
// ============================================================

interface DialogContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Trigger element that opened the dialog — captured by
   *  <DialogTrigger> so that return-focus after close can be
   *  guaranteed to a node we know still exists. */
  triggerRef: React.RefObject<HTMLElement | null>;
  /** Auto-generated ids wired to <DialogTitle> / <DialogDescription>
   *  so <DialogContent> can announce aria-labelledby/aria-describedby
   *  without callers having to wire them by hand. */
  titleId: string;
  descriptionId: string;
  /** Title/description register flags — if the consumer renders
   *  neither, we don't add empty aria attributes. */
  titleMounted: boolean;
  descriptionMounted: boolean;
  registerTitle: () => () => void;
  registerDescription: () => () => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialog() {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error("Dialog components must be used within <Dialog>");
  return ctx;
}

// ============================================================
// FOCUS TRAP (WCAG 2.1 AA, zero-dependency)
// ============================================================
//
// Implements the ARIA Authoring Practices Guide (APG) modal-dialog
// pattern:
//   1. Capture the previously-focused element when the dialog opens.
//      (Here we use the <DialogTrigger>-captured ref when available,
//      falling back to document.activeElement for programmatic opens.)
//   2. Move focus into the dialog on open (to the first focusable
//      descendant, or to the panel itself if there are none, so screen
//      readers start reading from the title/description).
//   3. Intercept Tab / Shift+Tab and wrap focus within the set of
//      visible focusable descendants.
//   4. Intercept Escape, stop propagation (so nested/layered dialogs
//      don't double-close), and call onClose.
//   5. Restore focus to the triggering element when the dialog closes,
//      guarded by document.contains + queueMicrotask to avoid React
//      "setState on unmounted component" warnings and to run after
//      React has committed the closed state.
//
// Selector intentionally excludes [tabindex="-1"], [disabled],
// [aria-hidden="true"], and [inert] elements.

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  'button:not([disabled]):not([aria-hidden="true"])',
  'input:not([disabled]):not([type="hidden"]):not([aria-hidden="true"])',
  'select:not([disabled]):not([aria-hidden="true"])',
  'textarea:not([disabled]):not([aria-hidden="true"])',
  "iframe",
  "object",
  "embed",
  '[tabindex]:not([tabindex="-1"]):not([disabled]):not([aria-hidden="true"])',
  '[contenteditable="true"]',
].join(",");

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  );
  return nodes.filter((n) => {
    if (n.hasAttribute("inert")) return false;
    // offsetParent is null for display:none / hidden elements (except
    // inside <tr> in some browsers; acceptable for our UI).
    if (
      n.tabIndex === -1 &&
      n.tagName !== "AUDIO" &&
      n.tagName !== "VIDEO"
    ) {
      return false;
    }
    return true;
  });
}

interface UseFocusTrapOptions {
  /** When true, the trap is active (dialog open). */
  active: boolean;
  /** Callback to invoke on Escape dismissal. */
  onClose: () => void;
  /** Optional ref whose current element should receive initial focus. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Optional explicit element to return focus to on close. When
   *  omitted, the hook falls back to document.activeElement captured
   *  at the moment the trap activates. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /** When true, focus will not scroll into view (default false). */
  preventScroll?: boolean;
}

/**
 * Zero-dependency accessible focus-trap hook used by <DialogContent>
 * (and available for bespoke modal panels, e.g. the admin ledger
 * inspectors, which import it indirectly via the dialog primitive).
 */
function useFocusTrap({
  active,
  onClose,
  initialFocusRef,
  returnFocusRef,
  preventScroll,
}: UseFocusTrapOptions): React.RefObject<HTMLDivElement | null> {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = React.useRef<HTMLElement | null>(null);

  // Stable callback identity so we don't re-subscribe keydown on
  // every render.
  const stableOnClose = React.useRef(onClose);
  React.useEffect(() => {
    stableOnClose.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    if (!active) {
      // ---- Restore focus on close ----
      // Prefer the explicit return-focus target (captured trigger)
      // over whatever document.activeElement happened to be at open
      // time. Use queueMicrotask so React has finished committing the
      // closed DOM before we call .focus() — calling focus on a node
      // that React is in the middle of unmounting triggers warnings
      // and can move focus to <body>.
      const target =
        (returnFocusRef?.current ?? previouslyFocusedRef.current) || null;
      previouslyFocusedRef.current = null;

      queueMicrotask(() => {
        if (
          target &&
          typeof (target as HTMLElement).focus === "function" &&
          document.contains(target)
        ) {
          try {
            (target as HTMLElement).focus({ preventScroll: false });
          } catch {
            /* noop — some browsers refuse focus on detached nodes */
          }
        }
      });
      return;
    }

    // ---- Capture pre-open focus BEFORE mutating anything ----
    // If a trigger ref is available and still mounted, prefer it;
    // otherwise fall back to document.activeElement (covers
    // programmatic opens and hotkey-triggered dialogs).
    const trigger = returnFocusRef?.current;
    previouslyFocusedRef.current =
      trigger && document.contains(trigger)
        ? trigger
        : (document.activeElement as HTMLElement | null) ?? null;

    const container = containerRef.current;
    if (!container) return;

    // Delay initial focus until after the portal/panel has fully
    // mounted and React has committed; otherwise .focus() on a
    // not-yet-visible element is a no-op in some browsers.
    const focusTimer = window.setTimeout(() => {
      const initial = initialFocusRef?.current;
      const target =
        initial && container.contains(initial)
          ? initial
          : getFocusableElements(container)[0] ?? container;
      try {
        (target as HTMLElement).focus({
          preventScroll: !!preventScroll,
        });
      } catch {
        container.focus({ preventScroll: !!preventScroll });
      }
    }, 0);

    function handleKeyDown(event: KeyboardEvent) {
      if (!containerRef.current) return;
      const node = containerRef.current;

      if (event.key === "Escape") {
        // Stop propagation so an outer/parent dialog (or our own
        // document-level ESC handler, if one is ever added) does not
        // also fire and double-close. Each dialog layer is responsible
        // for closing itself in response to its own ESC.
        event.preventDefault();
        event.stopPropagation();
        stableOnClose.current();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(node);
      if (focusable.length === 0) {
        // No interactive descendants — trap focus on the container
        // itself so keyboard users don't escape to the background.
        event.preventDefault();
        node.focus({ preventScroll: !!preventScroll });
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeEl = document.activeElement as HTMLElement | null;

      // If focus has escaped (e.g. browser UI shifted it, or a link
      // opened a new tab and focus returned elsewhere), pull it back
      // to the first element.
      if (!activeEl || !node.contains(activeEl)) {
        event.preventDefault();
        first.focus({ preventScroll: !!preventScroll });
        return;
      }

      if (event.shiftKey && activeEl === first) {
        event.preventDefault();
        last.focus({ preventScroll: !!preventScroll });
      } else if (!event.shiftKey && activeEl === last) {
        event.preventDefault();
        first.focus({ preventScroll: !!preventScroll });
      }
    }

    // Listen in the capture phase so we beat other document-level
    // handlers that might also try to respond to Escape. Also using
    // { capture: true } means nested dialogs (portals) attached to
    // document.body still receive the event first on the inner
    // container's bubble path.
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [active, initialFocusRef, returnFocusRef, preventScroll]);

  return containerRef;
}

// ============================================================
// DIALOG PROVIDER
// ============================================================

interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

export function Dialog({
  open: controlledOpen,
  onOpenChange,
  children,
}: DialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  // Stable ref to the trigger element for return-focus on close.
  // <DialogTrigger> writes its DOM node here on click.
  const triggerRef = React.useRef<HTMLElement | null>(null);

  // Stable IDs for aria-labelledby / aria-describedby. useId is
  // deterministic across server+client in React 18+/19.
  const titleId = React.useId();
  const descriptionId = React.useId();
  const [titleMounted, setTitleMounted] = React.useState(false);
  const [descriptionMounted, setDescriptionMounted] = React.useState(false);

  const registerTitle = React.useCallback(() => {
    setTitleMounted(true);
    return () => setTitleMounted(false);
  }, []);
  const registerDescription = React.useCallback(() => {
    setDescriptionMounted(true);
    return () => setDescriptionMounted(false);
  }, []);

  const setOpen = React.useCallback(
    (value: boolean) => {
      if (!isControlled) setInternalOpen(value);
      onOpenChange?.(value);
    },
    [isControlled, onOpenChange]
  );

  // ---- Body scroll lock (handled at the provider level) ----
  // We do NOT listen for Escape here — Escape is handled inside
  // useFocusTrap which is attached to DialogContent. That way:
  //   - If there is no DialogContent rendered (edge case), ESC is
  //     inert rather than closing an invisible dialog.
  //   - When nested dialogs are open, only the innermost
  //     DialogContent's keydown handler runs (it stopPropagates),
  //     eliminating duplicate-close bugs.
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const ctxValue = React.useMemo<DialogContextValue>(
    () => ({
      open,
      setOpen,
      triggerRef,
      titleId,
      descriptionId,
      titleMounted,
      descriptionMounted,
      registerTitle,
      registerDescription,
    }),
    [
      open,
      setOpen,
      titleId,
      descriptionId,
      titleMounted,
      descriptionMounted,
      registerTitle,
      registerDescription,
    ]
  );

  return (
    <DialogContext.Provider value={ctxValue}>{children}</DialogContext.Provider>
  );
}

// ============================================================
// DIALOG TRIGGER
// ============================================================
// Semantics:
//  - By default (asChild=false) we render a <button>{children}</button>.
//  - When asChild=true, we merge our onClick onto the single child
//    element WITHOUT wrapping it in a <button>. This is REQUIRED when
//    the child is itself a <Button>, <a>, or any interactive element —
//    otherwise we'd produce invalid HTML like <button><button>…</button>
//    </button> which causes React hydration errors and broken bubbling.
//
// The trigger captures a ref to itself when clicked, so the focus trap
// can reliably return focus to it after close — even if the trigger
// was unmounted/re-mounted between open and close (e.g. inside a
// list row). If the original node is gone, document.contains guards
// against focusing a detached node.

type DialogTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
};

export function DialogTrigger({
  asChild = false,
  children,
  ...props
}: DialogTriggerProps) {
  const { open, setOpen, triggerRef } = useDialog();

  const activate = React.useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (e.defaultPrevented) return;
      // Capture the actual DOM node that was clicked so return-focus
      // on close lands on the right trigger even when multiple
      // triggers share a dialog.
      triggerRef.current = e.currentTarget;
      setOpen(true);
    },
    [setOpen, triggerRef]
  );

  // If already open, clicking the trigger again is a no-op (defensive).
  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (open) {
        e.preventDefault();
        return;
      }
      activate(e);
    },
    [activate, open]
  );

  if (asChild) {
    const child = React.Children.only(children) as React.ReactElement<{
      onClick?: (e: React.MouseEvent<HTMLElement>) => void;
    }>;
    return React.cloneElement(child, {
      onClick: (e: React.MouseEvent<HTMLElement>) => {
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

// ============================================================
// DIALOG CONTENT (the portal panel itself)
// ============================================================
//
// When open, renders an overlay + panel with:
//   - role="dialog" aria-modal="true"
//   - aria-labelledby / aria-describedby auto-wired to whichever of
//     <DialogTitle> / <DialogDescription> is present inside.
//   - Backdrop click-to-close.
//   - Full WCAG focus trap (Tab wrap, Escape with stopPropagation,
//     initial focus, return focus to trigger via queueMicrotask).
//
// Accepts an optional `initialFocusRef` for callers that want a
// specific element (e.g. a textarea) to be focused on open.

interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
  /** Optional ref whose element should receive initial focus
   *  (otherwise the first focusable descendant gets it). */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** When true, clicking the backdrop does NOT close the dialog
   *  (useful for destructive flows where we want an explicit
   *  Cancel/Confirm). Defaults to false (backdrop closes). */
  disableBackdropClose?: boolean;
}

export function DialogContent({
  children,
  className,
  initialFocusRef,
  disableBackdropClose = false,
  ...rest
}: DialogContentProps) {
  const {
    open,
    setOpen,
    triggerRef,
    titleId,
    descriptionId,
    titleMounted,
    descriptionMounted,
  } = useDialog();

  // Stable close handler so we can pass it to the focus trap without
  // causing re-subscriptions on every render.
  const handleClose = React.useCallback(() => setOpen(false), [setOpen]);

  const trapRef = useFocusTrap({
    active: open,
    onClose: handleClose,
    initialFocusRef,
    returnFocusRef: triggerRef,
  });

  // Don't render the portal unless the dialog is open. Important: the
  // focus trap's active=false path handles return-focus, so we keep
  // the hook called unconditionally but return null here so React
  // doesn't keep an inert backdrop mounted.
  if (!open) return null;

  const labelledBy = titleMounted ? titleId : undefined;
  const describedBy = descriptionMounted ? descriptionId : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      // Container element: do NOT put role/aria here — the panel div
      // below is the actual dialog; this wrapper is positioning only.
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in"
        onClick={() => {
          if (!disableBackdropClose) setOpen(false);
        }}
        aria-hidden="true"
      />
      {/* Panel */}
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={cn(
          "relative z-10 w-full max-w-lg rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xl border border-slate-200 dark:border-slate-700",
          "max-h-[90vh] overflow-y-auto",
          className
        )}
        onClick={(e) => {
          // Clicks inside the panel must not reach the backdrop.
          e.stopPropagation();
        }}
        {...rest}
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

// ============================================================
// HEADER / FOOTER / TITLE / DESCRIPTION
// ============================================================

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
  id: idProp,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  const { titleId, registerTitle } = useDialog();
  // Register/unregister on mount/unmount so DialogContent knows
  // whether to attach aria-labelledby. Respect a caller-supplied id
  // for bespoke panels that manage their own aria-labelledby (e.g.
  // the admin ledger Release/Quarantine/Inspector modals that pre-
  // date the shared primitive).
  React.useEffect(() => registerTitle(), [registerTitle]);
  return (
    <h2
      id={idProp ?? titleId}
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
  id: idProp,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  const { descriptionId, registerDescription } = useDialog();
  React.useEffect(() => registerDescription(), [registerDescription]);
  return (
    <p
      id={idProp ?? descriptionId}
      className={cn("text-sm text-slate-500 dark:text-slate-400", className)}
      {...props}
    />
  );
}

// Expose the focus trap for bespoke panels (e.g. admin ledger
// hand-rolled modals that don't go through DialogContent).
export { useFocusTrap };
