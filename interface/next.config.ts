import type { NextConfig } from "next";

// The PDF routes read the Inter .ttf files from `assets/fonts` at render time
// (see lib/pdf/fonts.ts). Those files are not statically imported, so Next's
// tracer can't discover them. List every route that renders a PDF here so the
// fonts get bundled into its serverless function. `*` matches the dynamic
// `[slug]` segment.
const PDF_FONT_INCLUDES = ["./assets/fonts/**"];

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/i/*/pdf": PDF_FONT_INCLUDES,
    "/i/*/receipt.pdf": PDF_FONT_INCLUDES,
    "/api/mcp": PDF_FONT_INCLUDES,
    "/api/cron/recurring": PDF_FONT_INCLUDES,
    "/api/invoices/*/confirm-payment": PDF_FONT_INCLUDES,
  },
};

export default nextConfig;
