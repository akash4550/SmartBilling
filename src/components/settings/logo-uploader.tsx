"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, Trash2, Image as ImageIcon, Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

const MAX_DISPLAY_HEIGHT = 120;
const MAX_DISPLAY_WIDTH = 280;
// Resize uploaded images to at most 600px wide @ ~0.88 quality before
// POSTing to the server — keeps DB payloads small and ensures the PDF/email
// renderers never get absurdly large raster data.
const UPLOAD_MAX_SIDE = 600;
const UPLOAD_QUALITY = 0.88;
const ACCEPTED = ["image/png", "image/jpeg", "image/jpg", "image/webp"];

interface LogoUploaderProps {
  /** Current logo URL (from /api/public/logo) if one exists. */
  logoUrl: string | null;
  /** Callback after a successful upload — receives new logoUrl. */
  onUploaded: (url: string) => void;
  /** Callback after logo is removed. */
  onRemoved: () => void;
}

type Status = "idle" | "resizing" | "uploading" | "done";

export function LogoUploader({ logoUrl, onUploaded, onRemoved }: LogoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      if (!ACCEPTED.includes(file.type.toLowerCase())) {
        toast.error("Unsupported file type", {
          description: "Please upload a PNG, JPEG, or WebP image.",
        });
        return;
      }
      if (file.size === 0) {
        toast.error("File is empty");
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        toast.error("File too large", {
          description: "Maximum 5 MB. Images will be auto-resized for best performance.",
        });
        return;
      }

      setStatus("resizing");
      try {
        const { blob, dataUrl } = await resizeImage(file, UPLOAD_MAX_SIDE, UPLOAD_QUALITY);
        setLocalPreview(dataUrl);
        setStatus("uploading");

        const formData = new FormData();
        const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
        // File name is not used server-side (we only read the bytes), but
        // FormData requires one for multipart file fields.
        formData.set("logo", new File([blob], `logo.${ext}`, { type: blob.type || file.type }));

        const res = await fetch("/api/settings/logo", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Upload failed (${res.status})`);
        }

        const payload = (await res.json()) as { logoUrl?: string };
        const url = payload.logoUrl || "/api/public/logo";
        // Append cache-buster so the <img> picks up the new bytes immediately.
        const busted = `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
        setLocalPreview(null);
        setStatus("done");
        onUploaded(busted);
        toast.success("Logo uploaded", {
          description: "Your logo will appear on invoices and emails.",
        });
        setTimeout(() => setStatus("idle"), 1800);
      } catch (err) {
        setStatus("idle");
        setLocalPreview(null);
        toast.error("Upload failed", {
          description: err instanceof Error ? err.message : "Please try again.",
        });
      }
    },
    [onUploaded],
  );

  const handleRemove = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/logo", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove logo");
      setLocalPreview(null);
      onRemoved();
      toast.success("Logo removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove logo");
    }
  }, [onRemoved]);

  const busy = status === "resizing" || status === "uploading";
  const previewSrc = localPreview ?? logoUrl;
  const hasLogo = !!previewSrc;

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
        className={[
          "relative rounded-xl border-2 border-dashed transition-all p-6 text-center",
          dragOver
            ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
            : hasLogo
              ? "border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/40"
              : "border-slate-300 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-600 bg-white dark:bg-slate-950",
        ].join(" ")}
      >
        {hasLogo ? (
          <div className="flex flex-col items-center gap-4">
            {/* Logo preview against a white card so transparent PNGs look right */}
            <div
              className="flex items-center justify-center bg-white dark:bg-white rounded-lg border border-slate-200 shadow-sm p-4"
              style={{
                minHeight: MAX_DISPLAY_HEIGHT + 32,
                width: "100%",
                maxWidth: 420,
                margin: "0 auto",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewSrc ?? undefined}
                alt="Company logo preview"
                style={{
                  maxHeight: MAX_DISPLAY_HEIGHT,
                  maxWidth: MAX_DISPLAY_WIDTH,
                  objectFit: "contain",
                  display: "block",
                }}
              />
            </div>
            <div className="flex items-center justify-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                Replace
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRemove}
                disabled={busy}
                className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 border-red-200 dark:border-red-900/50"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Remove
              </Button>
              {status === "done" && (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Saved
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="h-12 w-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
              {busy ? (
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
              ) : (
                <ImageIcon className="h-6 w-6 text-slate-500" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                {status === "resizing"
                  ? "Preparing image…"
                  : status === "uploading"
                    ? "Uploading…"
                    : "Upload your company logo"}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                PNG, JPEG, or WebP. Max 5 MB. Drag & drop or click below.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="h-4 w-4 mr-2" />
              Choose file
            </Button>
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED.join(",")}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            // Reset so re-selecting the same file triggers change again.
            e.target.value = "";
          }}
        />
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Your logo appears on invoice PDFs, email headers, and the client payment page. A transparent PNG works best.
      </p>
    </div>
  );
}

/**
 * Downscale an image to at most `maxSide` pixels on its longer edge,
 * re-encoding as JPEG or PNG depending on whether the source has alpha.
 * Returns both a Blob (for upload) and a data URL (for instant preview).
 */
async function resizeImage(
  file: File,
  maxSide: number,
  quality: number,
): Promise<{ blob: Blob; dataUrl: string }> {
  // Browser-only; safe because this is a client component.
  const createBitmap =
    typeof window !== "undefined" && "createImageBitmap" in window
      ? (window as Window & { createImageBitmap: typeof createImageBitmap }).createImageBitmap.bind(window)
      : null;

  const bitmap = createBitmap
    ? await createBitmap(file)
    : await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Could not read image"));
        img.src = URL.createObjectURL(file);
      });

  const srcW = "width" in bitmap ? (bitmap as { width: number }).width : (bitmap as HTMLImageElement).naturalWidth;
  const srcH = "height" in bitmap ? (bitmap as { height: number }).height : (bitmap as HTMLImageElement).naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  // White background for JPEGs (no alpha); PNGs keep transparency.
  const outType =
    file.type === "image/png" || file.type === "image/webp" ? "image/png" : "image/jpeg";
  if (outType === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, w, h);

  const dataUrl = canvas.toDataURL(outType, quality);
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Image encoding failed"))),
      outType,
      quality,
    );
  });
  return { blob, dataUrl };
}
