/**
 * GET /i/:slug/receipt.pdf
 *
 * Streams the on-chain payment receipt as a PDF. Public by share-slug
 * (same gating model as /pdf), but additionally requires the invoice to
 * be in `paid` state with at least one recorded invoice_payments row —
 * receipts don't exist before payment.
 */

import { getInvoiceBySlug } from "@/lib/invoices";
import { renderReceiptStream } from "@/lib/pdf/renderReceipt";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;
  const invoice = await getInvoiceBySlug(slug);
  if (!invoice) {
    return new Response("Not found", { status: 404 });
  }
  if (invoice.status !== "paid") {
    return new Response("Receipt not available — invoice has not been paid yet", { status: 409 });
  }

  let nodeStream: NodeJS.ReadableStream;
  try {
    nodeStream = await renderReceiptStream(invoice);
  } catch (e) {
    console.error("[receipt.pdf] render failed:", e);
    return new Response("Receipt unavailable", { status: 500 });
  }

  return new Response(nodeStreamToWeb(nodeStream), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${invoice.invoiceNumber}-receipt.pdf"`,
      "cache-control": "private, max-age=0, must-revalidate",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function nodeStreamToWeb(node: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      node.on("data", (chunk: Buffer | Uint8Array | string) => {
        if (typeof chunk === "string") {
          controller.enqueue(new TextEncoder().encode(chunk));
        } else {
          controller.enqueue(chunk);
        }
      });
      node.on("end", () => controller.close());
      node.on("error", (err) => controller.error(err));
    },
  });
}
