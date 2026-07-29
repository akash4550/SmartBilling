"use client";

import { useState } from "react";
import { Copy, Check, RefreshCw, ExternalLink, Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

/**
 * Build an absolute URL to the client portal. Works both server- and
 * client-side by reading NEXT_PUBLIC_SITE_URL or VERCEL_URL. Pure function
 * so it can be used in both contexts.
 */
export function getPortalUrl(token: string): string {
  let base =
    (typeof process !== "undefined" &&
      ((process.env as Record<string, string | undefined>).NEXT_PUBLIC_SITE_URL ||
        (process.env as Record<string, string | undefined>).VERCEL_URL)) ||
    "";
  if (base && !/^https?:\/\//i.test(base)) base = `https://${base}`;
  if (!base) {
    if (typeof window !== "undefined") {
      base = window.location.origin;
    } else {
      base = "http://localhost:3000";
    }
  }
  return `${base.replace(/\/$/, "")}/portal/${token}`;
}

interface PortalLinkProps {
  clientId: string;
  token: string;
  onTokenRotated?: (newToken: string) => void;
  size?: "sm" | "default";
  variant?: "outline" | "default" | "ghost" | "secondary";
  className?: string;
  iconOnly?: boolean;
}

export function PortalLinkButton({
  clientId,
  token,
  onTokenRotated,
  size = "sm",
  variant = "outline",
  className,
  iconOnly = false,
}: PortalLinkProps) {
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);

  const portalUrl = getPortalUrl(token);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(portalUrl);
      setCopied(true);
      toast.success("Portal link copied", { description: "Share it with your client for 24/7 invoice access." });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  }

  async function handleRotate() {
    if (!confirm("Rotate portal link? The old link will stop working immediately.")) return;
    setRotating(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/portal-token`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to rotate link");
      }
      const data = (await res.json()) as { portalToken: string };
      onTokenRotated?.(data.portalToken);
      const newUrl = getPortalUrl(data.portalToken);
      try {
        await navigator.clipboard.writeText(newUrl);
      } catch {
        /* ignore clipboard failures after rotate */
      }
      toast.success("Portal link rotated", { description: "New link copied to clipboard. Old link is now invalid." });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rotate");
    } finally {
      setRotating(false);
    }
  }

  async function handleOpen() {
    window.open(portalUrl, "_blank", "noopener,noreferrer");
  }

  if (iconOnly) {
    return (
      <Button
        type="button"
        variant={variant}
        size="icon"
        onClick={handleCopy}
        className={className}
        title="Copy client portal link"
      >
        {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Link2 className="h-4 w-4" />}
      </Button>
    );
  }

  return (
    <div className={["flex items-center gap-2 flex-wrap", className].filter(Boolean).join(" ")}>
      <Button type="button" variant={variant} size={size} onClick={handleCopy}>
        {copied ? <Check className="h-4 w-4 mr-2 text-emerald-600" /> : <Copy className="h-4 w-4 mr-2" />}
        {copied ? "Copied" : "Copy portal link"}
      </Button>
      <Button type="button" variant="ghost" size={size} onClick={handleOpen} title="Preview portal">
        <ExternalLink className="h-4 w-4 mr-2" /> Preview
      </Button>
      <Button
        type="button"
        variant="ghost"
        size={size}
        onClick={handleRotate}
        disabled={rotating}
        title="Invalidate the current link and generate a new one"
      >
        {rotating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
        Rotate
      </Button>
    </div>
  );
}

