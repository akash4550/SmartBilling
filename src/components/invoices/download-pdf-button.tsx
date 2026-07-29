"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";

interface DownloadPdfButtonProps {
  /** Invoice CUID. */
  invoiceId: string;
  /** Use the public unauthenticated endpoint (for the /view/:id page). */
  publicDownload?: boolean;
  /** Button variant override (defaults to "outline"). */
  variant?: "outline" | "default" | "ghost" | "secondary";
  /** Size override. */
  size?: "sm" | "default" | "icon" | "lg";
  /** Override button label. */
  label?: string;
  /** Extra class names. */
  className?: string;
}

/**
 * Renders a download-as-PDF button. We do NOT use <a download>/target trickery
 * because the request may need auth cookies (admin endpoint); a programmatic
 * fetch + blob-url click preserves the session and surfaces HTTP errors
 * (e.g. 401/404/429) as Sonner toasts instead of silent browser errors.
 */
export function DownloadPdfButton({
  invoiceId,
  publicDownload = false,
  variant = "outline",
  size = "default",
  label = "Download PDF",
  className,
}: DownloadPdfButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const url = publicDownload
        ? `/api/public/invoices/${invoiceId}/pdf`
        : `/api/invoices/${invoiceId}/pdf`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        let msg = "Failed to download PDF";
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {
          /* ignore */
        }
        if (res.status === 429) {
          toast.error("Too many downloads", { description: "Please try again in a minute." });
        } else if (res.status === 404) {
          toast.error("Invoice not found");
        } else {
          toast.error(msg);
        }
        return;
      }
      // Derive filename from Content-Disposition if possible.
      const disposition = res.headers.get("Content-Disposition") ?? "";
      let filename = `Invoice_${invoiceId.slice(0, 8)}.pdf`;
      const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      if (match && match[1]) {
        try { filename = decodeURIComponent(match[1]); } catch { /* keep fallback */ }
      } else {
        const simpleMatch = /filename="([^"]+)"/i.exec(disposition);
        if (simpleMatch && simpleMatch[1]) filename = simpleMatch[1];
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
      toast.success("PDF downloaded", { description: filename });
    } catch {
      toast.error("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={handleClick}
      disabled={loading}
      className={className}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <Download className="h-4 w-4 mr-2" />
      )}
      {label}
    </Button>
  );
}
