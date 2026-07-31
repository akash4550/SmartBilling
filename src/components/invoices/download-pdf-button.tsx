"use client";

import * as React from "react";
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
 *
 * Double-click / overlapping-request hardening:
 *   - Synchronous DOM lock before await/setState.
 *   - AbortController in a ref; a second click aborts the in-flight fetch
 *     (and revokes its blob URL if it already resolved — very unlikely in
 *     20ms, but covered defensively).
 *   - AbortError filtered in catch().
 */
export function DownloadPdfButton({
  invoiceId,
  publicDownload = false,
  variant = "outline",
  size = "default",
  label = "Download PDF",
  className,
}: DownloadPdfButtonProps) {
  const [loading, setLoading] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const lastBlobUrlRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current);
    };
  }, []);

  async function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    // ---- Synchronous DOM lock ----
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;

    // ---- Abort any prior in-flight download ----
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const url = publicDownload
        ? `/api/public/invoices/${invoiceId}/pdf`
        : `/api/invoices/${invoiceId}/pdf`;
      const res = await fetch(url, { cache: "no-store", signal: controller.signal });
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
      // If aborted after headers but during blob read, don't surface the file.
      if (controller.signal.aborted) return;
      const blobUrl = URL.createObjectURL(blob);
      // Revoke any stale blob URL from a prior aborted run.
      if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current);
      lastBlobUrlRef.current = blobUrl;
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => {
        if (lastBlobUrlRef.current === blobUrl) {
          URL.revokeObjectURL(blobUrl);
          lastBlobUrlRef.current = null;
        }
      }, 2000);
      toast.success("PDF downloaded", { description: filename });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast.error("Network error — please try again");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      btn.disabled = false;
      setLoading(false);
    }
  }

  return (
    <Button
      type="button"
      ref={buttonRef}
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
