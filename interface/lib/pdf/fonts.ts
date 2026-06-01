import path from "node:path";
import { Font } from "@react-pdf/renderer";

/**
 * Register Inter for PDF rendering.
 *
 * react-pdf's built-in Helvetica is a single-byte WinAnsi font: it cannot
 * encode currency symbols outside Latin-1, so the rupee sign (U+20B9) was
 * truncated to its low byte 0xB9 and rendered as the superscript "1" glyph.
 * Inter is a full Unicode TTF and also matches the hosted invoice page's
 * typeface, so the PDF and the web invoice look identical.
 *
 * The .ttf files live in `assets/fonts` and are read from disk at render time
 * (PDF routes run on the Node.js runtime). They are bundled into the
 * serverless functions via `outputFileTracingIncludes` in next.config.ts.
 */
let registered = false;

export function registerPdfFonts(): void {
  if (registered) return;
  const dir = path.join(process.cwd(), "assets", "fonts");
  Font.register({
    family: "Inter",
    fonts: [
      { src: path.join(dir, "Inter-Regular.ttf"), fontWeight: 400 },
      { src: path.join(dir, "Inter-Bold.ttf"), fontWeight: 700 },
    ],
  });
  registered = true;
}
