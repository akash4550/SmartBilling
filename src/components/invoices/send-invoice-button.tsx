"use client";

import * as React from "react";
import { Mail, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SendInvoiceButtonProps {
  invoiceId: string;
  clientEmail: string;
  variant?: "default" | "outline" | "secondary";
}

export function SendInvoiceButton({
  invoiceId,
  clientEmail,
  variant = "outline",
}: SendInvoiceButtonProps) {
  const [loading, setLoading] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const reloadTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
    };
  }, []);

  async function handleSend(e: React.MouseEvent<HTMLButtonElement>) {
    // ---- Synchronous DOM lock ----
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;

    // ---- Abort prior in-flight send ----
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.details || "Failed to send email");
      }
      setSent(true);
      reloadTimerRef.current = window.setTimeout(() => {
        reloadTimerRef.current = null;
        window.location.reload();
      }, 1200);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      // On success we leave the button disabled (we're about to reload).
      // On failure, re-enable for retry.
      if (!sent) {
        btn.disabled = false;
        setLoading(false);
      }
    }
  }

  if (sent) {
    return (
      <Button variant="outline" disabled className="border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-4 w-4 mr-2" />
        Sent!
      </Button>
    );
  }

  return (
    <div className="flex flex-col items-start">
      <Button ref={buttonRef} variant={variant} onClick={handleSend} disabled={loading}>
        {loading ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Mail className="h-4 w-4 mr-2" />
        )}
        {loading ? "Sending..." : `Send to ${clientEmail.split("@")[0]}`}
      </Button>
      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-1">{error}</p>}
    </div>
  );
}
