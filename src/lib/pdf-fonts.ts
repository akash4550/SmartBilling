/**
 * Shared font registration for @react-pdf/renderer.
 *
 * Noto Sans Regular + Bold are shipped under src/assets/fonts/ to provide
 * broader Unicode coverage (Latin Extended, Devanagari, etc.) than PDFKit's
 * built-in Helvetica. Registration is best-effort: if loading fails we
 * silently fall back to Helvetica/Courier so invoice PDFs always render.
 *
 * Register is guarded by an in-process flag so repeat calls across requests
 * don't re-register (react-pdf throws on duplicate family names).
 */
import path from "node:path";

type FontLike = {
  register: (opts: unknown) => void;
};

let registered = false;

export async function registerPdfFonts(Font: FontLike): Promise<void> {
  if (registered) return;
  try {
    // Font registration is currently disabled because @react-pdf/renderer v4
    // has issues loading TTF files that don't match its fontkit expectations
    // ("f is not a function" deep in layout). The TTF files are kept in
    // src/assets/fonts/ for future enablement when the library issue is
    // resolved or we switch to a pre-subsetted font.
    // Mark as "registered" so we don't retry on every PDF render.
    registered = true;
    return;
  } catch (e) {
    console.warn("[pdf-fonts] Failed to register NotoSans:", (e as Error).message);
  }
}

// Keep path helper exported for future use
export function getFontPath(name: string): string {
  return path.join(process.cwd(), "src", "assets", "fonts", name);
}
