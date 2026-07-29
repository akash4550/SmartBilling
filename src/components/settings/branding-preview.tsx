"use client";

import { useMemo } from "react";

interface BrandingPreviewProps {
  companyName: string;
  logoUrl: string | null;
  brandColor: string;
}

/**
 * A small static mock of the top of an invoice, rendered in plain HTML/CSS so
 * the user can immediately see how their logo + accent color look together
 * while editing Settings. Updates live as they type.
 */
export function BrandingPreview({ companyName, logoUrl, brandColor }: BrandingPreviewProps) {
  const color = useMemo(() => {
    const s = brandColor.trim();
    return /^#([0-9a-fA-F]{3}){1,2}$/.test(s) ? s : "#2563eb";
  }, [brandColor]);

  const initial = (companyName || "Y").charAt(0).toUpperCase();

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 overflow-hidden shadow-sm">
      {/* Simulated accent bar */}
      <div className="h-1.5 w-full" style={{ backgroundColor: color }} />

      <div className="p-6">
        <div className="flex items-start justify-between gap-6">
          {/* Logo / initial */}
          <div className="flex items-center gap-3 min-w-0">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt={`${companyName} logo`}
                className="max-h-12 max-w-[170px] object-contain"
              />
            ) : (
              <div
                className="h-10 w-10 rounded-lg flex items-center justify-center text-white font-bold shadow-sm shrink-0"
                style={{ backgroundColor: color }}
              >
                {initial}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                {companyName || "Your Business Name"}
              </p>
              <p className="text-xs text-slate-500 font-mono">INV-YYYYMMDD-0001</p>
            </div>
          </div>

          {/* Amount due block */}
          <div className="text-right shrink-0">
            <span className="inline-block text-[9px] font-bold uppercase tracking-wider px-2 py-1 rounded-full bg-amber-100 text-amber-700">
              Pending
            </span>
            <p
              className="text-lg font-bold mt-2"
              style={{ color }}
            >
              AMOUNT DUE
            </p>
            <p className="text-xs text-slate-500 font-mono">INV-20260728-0001</p>
            <p className="text-[10px] uppercase tracking-wide text-slate-500 mt-2">Total</p>
            <p className="text-xl font-bold" style={{ color }}>
              ₹12,500.00
            </p>
          </div>
        </div>

        <p className="mt-4 text-[10px] text-slate-400">
          Live preview of how your invoice header will look.
        </p>
      </div>
    </div>
  );
}
