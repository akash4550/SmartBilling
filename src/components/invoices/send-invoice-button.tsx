"use client";

import { useState } from "react";
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
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.details || "Failed to send email");
      }
      setSent(true);
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setLoading(false);
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
      <Button variant={variant} onClick={handleSend} disabled={loading}>
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
