"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DeleteInvoiceButton({ id }: { id: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDelete() {
    if (!confirm("Are you sure you want to delete this invoice? This cannot be undone.")) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/invoices/${id}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/invoices");
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleDelete} disabled={loading} variant="destructive">
      <Trash2 className="h-4 w-4 mr-2" />
      {loading ? "Deleting..." : "Delete"}
    </Button>
  );
}
