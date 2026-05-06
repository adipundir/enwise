import { getInvoiceBySlug } from "@/lib/invoices";
import { renderInvoicePdf } from "@/lib/pdf/renderInvoice";
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

  const nodeStream = await renderInvoicePdf(invoice);
  // Convert Node Readable to Web ReadableStream so Next can stream the response.
  const webStream = nodeStreamToWeb(nodeStream);

  return new Response(webStream, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${invoice.invoiceNumber}.pdf"`,
      "cache-control": "private, max-age=0, must-revalidate",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function nodeStreamToWeb(
  node: NodeJS.ReadableStream,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      node.on("data", (chunk: Buffer | Uint8Array | string) => {
        if (typeof chunk === "string") {
          controller.enqueue(new TextEncoder().encode(chunk));
        } else if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk);
        } else {
          controller.enqueue(Uint8Array.from(chunk as Buffer));
        }
      });
      node.on("end", () => controller.close());
      node.on("error", (err) => controller.error(err));
    },
  });
}
