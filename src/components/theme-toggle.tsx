"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Theme toggle button that cycles: Light → Dark → System → Light.
 *
 * Shows a sun (light), moon (dark), or monitor (system) icon depending on
 * the current mode. Uses a mounted guard to avoid hydration mismatches
 * (the theme isn't known on the server).
 */
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(timer);
  }, []);

  // Avoid rendering theme-specific icon until mounted (prevents hydration mismatch)
  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" aria-label="Toggle theme" disabled>
        <Sun className="h-[1.2rem] w-[1.2rem] opacity-0" />
      </Button>
    );
  }

  function cycle() {
    if (theme === "light") setTheme("dark");
    else if (theme === "dark") setTheme("system");
    else setTheme("light");
  }

  const currentLabel =
    theme === "system" ? `System (${resolvedTheme})` : theme;
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={`Toggle theme (current: ${currentLabel})`}
      title={`Theme: ${currentLabel} — click to change`}
      className="text-slate-600 dark:text-slate-300"
    >
      <Icon className="h-[1.2rem] w-[1.2rem] transition-all" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
