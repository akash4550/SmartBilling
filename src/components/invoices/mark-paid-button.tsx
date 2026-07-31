"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function MarkPaidButton({ id }: { id: string }) {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);
  // Hold the button element across the async boundary so the finally
  // path can re-enable it even if React hasn't yet committed the
  // loading=false state update (and so we can synchronously lock
  // before any await — defeating the 5–20ms double-click window).
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  // Defensive cleanup: if the component unmounts mid-flight, abort
  // so fetch promises resolve early and never try to setState on a
  // released fiber.
  React.useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  async function handleMarkPaid(e: React.MouseEvent<HTMLButtonElement>) {
    // ---- Synchronous DOM lock (closes the fast-double-click window) ----
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;

    // ---- Abort prior in-flight request (latest click wins) ----
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (!confirm("Mark this invoice as paid?")) {
      btn.disabled = false;
      abortRef.current = null;
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/invoices/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "PAID" }),
        signal: controller.signal,
      });
      if (res.ok) router.refresh();
    } catch (err) {
      // ---- AbortError filtering: user clicked again / unmounted ----
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Mark-paid is fire-and-forget refresh; surface nothing on network
      // failure so a flaky connection doesn't toast-storm. The button
      // simply re-enables for retry.
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      btn.disabled = false;
      setLoading(false);
    }
  }

  return (
    <Button
      ref={buttonRef}
      onClick={handleMarkPaid}
      disabled={loading}
      variant="default"
    >
      <CheckCircle className="h-4 w-4 mr-2" />
      {loading ? "Updating..." : "Mark as Paid"}
    </Button>
  );
}
