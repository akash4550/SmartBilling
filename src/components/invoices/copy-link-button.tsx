"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Link2, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface CopyLinkButtonProps {
  invoiceId: string;
  variant?: "default" | "outline" | "secondary" | "ghost";
  size?: "sm" | "default" | "icon";
  className?: string;
  children?: React.ReactNode;
}

export function CopyLinkButton({
  invoiceId,
  variant = "outline",
  size = "default",
  className,
  children,
}: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleCopy() {
    if (copied || loading) return;
    setLoading(true);
    try {
      const url = `${window.location.origin}/view/${invoiceId}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Public invoice link copied", {
        description: "Anyone with this link can view and pay the invoice.",
      });
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error("Could not copy to clipboard — copy the URL from the address bar.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button type="button" variant={variant} size={size} onClick={handleCopy} disabled={loading} className={className}>
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : copied ? (
        <Check className="h-4 w-4 text-emerald-600" />
      ) : (
        <Link2 className="h-4 w-4" />
      )}
      {children ?? (copied ? "Copied!" : "Copy Link")}
    </Button>
  );
}
