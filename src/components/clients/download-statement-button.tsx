"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface DownloadStatementButtonProps {
  clientId: string;
  clientName?: string;
  size?: "sm" | "default";
  variant?: "default" | "outline" | "secondary";
  className?: string;
}

export function DownloadStatementButton({
  clientId,
  clientName,
  size = "default",
  variant = "outline",
  className,
}: DownloadStatementButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleDownload() {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/statement`, { cache: "no-store" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to download statement");
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="?([^";"]+)"?/.exec(cd);
      const filename = match?.[1] ?? `statement-${clientId}.pdf`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Statement downloaded", clientName ? { description: clientName } : undefined);
    } catch {
      toast.error("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button type="button" variant={variant} size={size} onClick={handleDownload} disabled={loading} className={className}>
      {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileText className="h-4 w-4 mr-2" />}
      Download Statement
    </Button>
  );
}
