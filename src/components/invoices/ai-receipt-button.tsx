"use client";

import { useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ScanLine, Loader2, Camera, CheckCircle2, Sparkles } from "lucide-react";
import type { ParsedReceipt } from "@/app/api/parse-receipt/route";

interface AiReceiptButtonProps {
  onParsed: (data: ParsedReceipt) => void;
  onError?: (message: string) => void;
  className?: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

const ACCEPTED_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_FILE_SIZE_MB = 10;

export function AiReceiptButton({ onParsed, onError, className }: AiReceiptButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (!file) return;

      if (!ACCEPTED_MIME.includes(file.type)) {
        const msg = "Please upload a JPG, PNG, WebP, or GIF image.";
        setStatusMessage(msg);
        onError?.(msg);
        return;
      }
      if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        const msg = `Image must be under ${MAX_FILE_SIZE_MB}MB.`;
        setStatusMessage(msg);
        onError?.(msg);
        return;
      }

      setLoading(true);
      setSuccess(false);
      setStatusMessage("Reading image...");

      try {
        const base64 = await fileToBase64(file);
        setStatusMessage("Analyzing with AI...");

        const res = await fetch("/api/parse-receipt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: base64 }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data.error || "Failed to parse receipt. Please try again.";
          setStatusMessage(msg);
          onError?.(msg);
          return;
        }

        setSuccess(true);
        setStatusMessage(`Extracted ${data.items?.length ?? 0} item(s)`);
        onParsed(data as ParsedReceipt);
        setTimeout(() => {
          setStatusMessage(null);
          setSuccess(false);
        }, 3000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error. Please try again.";
        setStatusMessage(msg);
        onError?.(msg);
      } finally {
        setLoading(false);
      }
    },
    [onParsed, onError]
  );

  return (
    <div className={className}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={handleClick}
        disabled={loading}
        className="bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-700 hover:to-indigo-700 border-0 shadow-md shadow-violet-500/20 hover:shadow-lg hover:shadow-violet-500/30"
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            {statusMessage ?? "Processing..."}
          </>
        ) : success ? (
          <>
            <CheckCircle2 className="h-4 w-4 mr-2" />
            Scanned!
          </>
        ) : (
          <>
            <Sparkles className="h-4 w-4 mr-2" />
            Scan Receipt (AI)
          </>
        )}
      </Button>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileChange}
        disabled={loading}
      />

      {statusMessage && !loading && (
        <p className={`text-xs mt-1.5 flex items-center gap-1 ${
          success ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500"
        }`}>
          {success ? <CheckCircle2 className="h-3 w-3" /> : <Camera className="h-3 w-3" />}
          {statusMessage}
        </p>
      )}
    </div>
  );
}
