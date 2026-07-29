"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Mail, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface SendPortalButtonProps {
  clientId: string;
  clientName: string;
  clientEmail?: string | null;
  variant?: "outline" | "default" | "ghost" | "secondary";
  size?: "sm" | "default" | "icon";
}

/**
 * Button + dialog: emails the client their portal link with an optional
 * personal message. Calls POST /api/clients/:id/send-portal-link.
 */
export function SendPortalButton({
  clientId,
  clientName,
  clientEmail,
  variant = "default",
  size = "sm",
}: SendPortalButtonProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSend() {
    if (!clientEmail) {
      toast.error("This client has no email address on file");
      return;
    }
    setSending(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/send-portal-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to send portal invite");
        return;
      }
      toast.success("Portal invite sent", { description: clientEmail });
      setOpen(false);
      setMessage("");
    } catch {
      toast.error("Network error — please try again");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant={variant} size={size}>
          <Mail className="h-4 w-4 mr-2" />
          Email portal link
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Email portal link</DialogTitle>
          <DialogDescription>
            Send a secure portal invite to <strong>{clientName}</strong>
            {clientEmail ? ` at ${clientEmail}` : ""}. They will receive a unique link to view all their invoices and pay online.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="portal-msg">Personal message (optional)</Label>
          <Textarea
            id="portal-msg"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            maxLength={500}
            placeholder="Hi — here's your dedicated client portal where you can view all invoices and pay online anytime."
          />
          <p className="text-xs text-slate-500">{message.length}/500</p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={sending}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSend} disabled={sending || !clientEmail}>
            {sending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
            {sending ? "Sending…" : "Send invite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
