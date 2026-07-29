"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ThemeProviderProps as NextThemesProviderProps } from "next-themes";

/**
 * Thin wrapper around next-themes' ThemeProvider so we can use it
 * as a client component within the App Router.
 *
 * Defaults:
 *  - attribute="class"  (Tailwind uses the `.dark` class)
 *  - defaultTheme="system"
 *  - enableSystem=true  (respects OS preference on first visit)
 *  - disableTransitionOnChange (avoids flicker when switching)
 */
export function ThemeProvider({
  children,
  attribute = "class",
  defaultTheme = "system",
  enableSystem = true,
  disableTransitionOnChange = true,
  ...props
}: React.PropsWithChildren<NextThemesProviderProps>) {
  return (
    <NextThemesProvider
      attribute={attribute}
      defaultTheme={defaultTheme}
      enableSystem={enableSystem}
      disableTransitionOnChange={disableTransitionOnChange}
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
