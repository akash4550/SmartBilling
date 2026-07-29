"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Pencil } from "lucide-react";
import { EditClientDialog } from "./edit-client-dialog";
import type { Client } from "@prisma/client";

interface EditClientButtonProps {
  client: Client;
}

export function EditClientButton({ client }: EditClientButtonProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4 mr-2" />
        Edit Client
      </Button>
      <EditClientDialog
        client={client}
        open={open}
        onOpenChange={setOpen}
        onSuccess={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}
