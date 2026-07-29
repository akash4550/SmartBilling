"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function MarkPaidButton({ id }: { id: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleMarkPaid() {
    if (!confirm("Mark this invoice as paid?")) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/invoices/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "PAID" }),
      });
      if (res.ok) router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleMarkPaid} disabled={loading} variant="default">
      <CheckCircle className="h-4 w-4 mr-2" />
      {loading ? "Updating..." : "Mark as Paid"}
    </Button>
  );
}
