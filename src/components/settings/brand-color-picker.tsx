"use client";

import { useId, useState } from "react";
import { Palette } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

const PRESETS = [
  "#2563eb", // default blue
  "#7c3aed", // violet
  "#db2777", // pink
  "#dc2626", // red
  "#f59e0b", // amber
  "#10b981", // emerald
  "#0891b2", // cyan
  "#0f172a", // slate
];

interface BrandColorPickerProps {
  value: string;
  onChange: (hex: string) => void;
  label?: string;
  id?: string;
}

export function BrandColorPicker({ value, onChange, label = "Brand color", id }: BrandColorPickerProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [text, setText] = useState(value);

  const normalized = normalizeHex(value);

  function commit(next: string) {
    const n = normalizeHex(next);
    setText(n ?? value);
    if (n) onChange(n);
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId} className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
        <Palette className="h-3.5 w-3.5" /> {label}
      </Label>

      <div className="flex items-center gap-3">
        {/* Native color input (looks different per browser but offers picker) */}
        <label
          className="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer shadow-sm"
          style={{ backgroundColor: normalized || "#2563eb" }}
          title="Pick a color"
        >
          <input
            type="color"
            value={normalized || "#2563eb"}
            onChange={(e) => commit(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label="Pick brand color"
          />
        </label>

        <Input
          id={inputId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            }
          }}
          placeholder="#2563eb"
          className="h-11 font-mono uppercase"
          maxLength={7}
        />
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        {PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => commit(c)}
            aria-label={`Use color ${c}`}
            className={[
              "h-7 w-7 rounded-full border transition-all",
              normalized?.toLowerCase() === c.toLowerCase()
                ? "border-slate-900 dark:border-white ring-2 ring-offset-2 ring-slate-400 dark:ring-offset-slate-950 scale-110"
                : "border-slate-200 dark:border-slate-700 hover:scale-110",
            ].join(" ")}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Used for the invoice PDF accent bar, email header, and totals highlight.
      </p>
    </div>
  );
}

function normalizeHex(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s.startsWith("#")) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  return null;
}
