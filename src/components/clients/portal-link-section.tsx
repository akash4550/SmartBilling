"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { PortalLinkButton, getPortalUrl } from "@/components/clients/portal-link-button";
import { SendPortalButton } from "@/components/clients/send-portal-button";
import { ExternalLink, Link2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface PortalLinkSectionProps {
  clientId: string;
  clientName: string;
  clientEmail?: string | null;
  initialToken: string;
}

/**
 * Client-side wrapper that exposes the portal link URL in an Input (easy
 * copy-paste) plus Copy/Rotate/Preview controls. Lives in its own component
 * so we can use navigator.clipboard + toast without making the entire client
 * page a client component.
 */
export function PortalLinkSection({ clientId, clientName, clientEmail, initialToken }: PortalLinkSectionProps) {
  const [token, setToken] = useState(initialToken);
  const url = getPortalUrl(token);

  return (
    <Card className="border-slate-200/60 dark:border-slate-800/60">
      <CardContent className="pt-6">
        <div className="flex items-center gap-2 mb-2">
          <Link2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          <p className="text-sm font-semibold text-slate-900 dark:text-white">Client Portal</p>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          Share this magic link with {clientName} to give them 24/7 access to all their invoices, outstanding balance, and online payment.
        </p>
        <div className="flex gap-2">
          <Input readOnly value={url} className="font-mono text-xs h-10 bg-slate-50 dark:bg-slate-900" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="outline" size="icon" className="h-10 w-10 shrink-0" asChild>
            <a href={url} target="_blank" rel="noopener noreferrer" title="Preview portal">
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <PortalLinkButton
            clientId={clientId}
            token={token}
            onTokenRotated={(t) => setToken(t)}
            variant="outline"
            size="sm"
          />
          <SendPortalButton
            clientId={clientId}
            clientName={clientName}
            clientEmail={clientEmail}
            variant="default"
            size="sm"
          />
        </div>
      </CardContent>
    </Card>
  );
}
