"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { BellRing, Loader2 } from "lucide-react";

interface BulkRemindResult {
  success: boolean;
  sent: number;
  failed: number;
  total: number;
}

export function BulkRemindButton() {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    if (loading) return;
    if (!confirm("Send payment reminders to all overdue clients?")) return;
    setLoading(true);
    try {
      const res = await fetch("/api/dashboard/remind-overdue", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as Partial<BulkRemindResult> & {
        error?: string;
        message?: string;
      };

      if (!res.ok) {
        if (res.status === 429) {
          toast.error(data.error || "Please wait before sending another batch");
        } else if (res.status === 503) {
          toast.error("Email not configured", {
            description: "Set RESEND_API_KEY to enable reminders.",
          });
        } else {
          toast.error(data.error || "Failed to send reminders");
        }
        return;
      }

      const sent = data.sent ?? 0;
      const failed = data.failed ?? 0;
      if (sent === 0 && failed === 0) {
        toast.success(data.message || "No overdue invoices need reminders");
      } else if (failed === 0) {
        toast.success(`Sent ${sent} reminder${sent === 1 ? "" : "s"}`, {
          description: "All overdue clients have been notified.",
        });
      } else if (sent === 0) {
        toast.error(`Failed to send ${failed} reminder${failed === 1 ? "" : "s"}`);
      } else {
        toast.warning(`Sent ${sent}, ${failed} failed`, {
          description: "Some reminders didn't go through — check server logs.",
        });
      }

      // Trigger a page refresh so counts update (overdue panel will refetch
      // via its own effect; we just need a soft refresh for the KPIs).
      window.location.reload();
    } catch {
      toast.error("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={loading}
      className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/30"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <BellRing className="h-4 w-4 mr-2" />
      )}
      Send Reminders
    </Button>
  );
}
