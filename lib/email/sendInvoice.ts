import { render } from "@react-email/components";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";
import { Resend } from "resend";
import { InvoiceDocument } from "@/components/pdf/InvoiceDocument";
import { InvoiceEmail } from "@/emails/InvoiceEmail";
import {
  finalizeInvoice,
  getInvoice,
  invoiceShareUrl,
  type InvoiceWithLineItems,
} from "@/lib/invoices";
import type { EnwiseCtx } from "@/lib/mcp/context";
import { buildInvoicePdfData } from "@/lib/pdf/renderInvoice";

export type SendInvoiceOutcome =
  | { ok: true; invoice: InvoiceWithLineItems; to: string[]; resendId: string | null }
  | {
      ok: false;
      code:
        | "not_found"
        | "invoice_not_draft"
        | "client_not_found"
        | "email_not_configured"
        | "no_recipient"
        | "resend_failure";
      message: string;
      hint?: string;
    };

interface SendInvoiceInput {
  invoiceId: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  message?: string | null;
}

export async function sendInvoiceByEmail(
  ctx: EnwiseCtx,
  input: SendInvoiceInput,
): Promise<SendInvoiceOutcome> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      code: "email_not_configured",
      message: "Email sending isn't configured on this server.",
      hint:
        "Set RESEND_API_KEY in your environment and verify a sending domain at https://resend.com/domains.",
    };
  }

  // 1. Load invoice (respects soft-delete and business scoping).
  const invoice = await getInvoice(ctx, input.invoiceId);
  if (!invoice) {
    return { ok: false, code: "not_found", message: `No invoice with id ${input.invoiceId}.` };
  }
  if (invoice.status === "void") {
    return {
      ok: false,
      code: "invoice_not_draft",
      message: `Invoice ${invoice.invoiceNumber} is void and cannot be sent.`,
    };
  }

  // 2. Figure out recipient(s): explicit `to` wins; otherwise client email snapshot / live.
  const recipientEmail =
    (input.to && input.to[0]) ||
    invoice.clientEmailSnapshot ||
    (await getClientEmail(ctx, invoice.clientId));
  if (!recipientEmail) {
    return {
      ok: false,
      code: "no_recipient",
      message: "Client has no email and no `to` address was provided.",
      hint: "Pass `to` explicitly, or add an email to the client first via update_client.",
    };
  }
  const toArray = input.to?.length ? input.to : [recipientEmail];

  // 3. Finalize invoice (snapshot + status=sent).
  const finalized = await finalizeInvoice(ctx, invoice.id);
  if (!finalized.ok) {
    return { ok: false, code: finalized.code, message: finalized.message };
  }
  const sent = finalized.value;

  // 4. Render PDF to Buffer (uses the same data function as the public /i/[slug]/pdf route).
  const pdfData = await buildInvoicePdfData(sent);
  const pdfElement = createElement(InvoiceDocument, pdfData) as unknown as ReactElement<DocumentProps>;
  const pdfBuffer = await renderToBuffer(pdfElement);

  // 5. Render HTML email.
  const shareUrl = invoiceShareUrl(sent.shareSlug);
  const addressLines = buildAddressLines({
    addressLine1: pdfData.business.addressLine1,
    addressLine2: pdfData.business.addressLine2,
    city: pdfData.business.city,
    region: pdfData.business.region,
    postalCode: pdfData.business.postalCode,
    country: pdfData.business.country,
  });

  const html = await render(
    createElement(InvoiceEmail, {
      invoiceNumber: sent.invoiceNumber,
      clientName: pdfData.client.name,
      businessName: pdfData.business.name,
      logoUrl: pdfData.business.logoUrl,
      total: sent.total,
      currency: sent.currency,
      dueDate: sent.dueDate,
      shareUrl,
      customMessage: input.message ?? null,
      businessAddressLines: addressLines,
    }),
  );
  const plainText = await render(
    createElement(InvoiceEmail, {
      invoiceNumber: sent.invoiceNumber,
      clientName: pdfData.client.name,
      businessName: pdfData.business.name,
      logoUrl: pdfData.business.logoUrl,
      total: sent.total,
      currency: sent.currency,
      dueDate: sent.dueDate,
      shareUrl,
      customMessage: input.message ?? null,
      businessAddressLines: addressLines,
    }),
    { plainText: true },
  );

  // 6. Send via Resend.
  const resend = new Resend(apiKey);
  const fromAddress =
    process.env.RESEND_FROM_ADDRESS || "invoices@enwise.app";
  const fromDisplay = `${pdfData.business.name} via enwise <${fromAddress}>`;

  try {
    const result = await resend.emails.send({
      from: fromDisplay,
      to: toArray,
      cc: input.cc,
      bcc: input.bcc,
      replyTo: undefined, // Populated from business.email_reply_to if set; see below.
      subject: `${pdfData.business.name}. Invoice ${sent.invoiceNumber}`,
      html,
      text: plainText,
      attachments: [
        {
          filename: `${sent.invoiceNumber}.pdf`,
          content: pdfBuffer,
        },
      ],
      headers: {
        // Gmail/Outlook expect a mailto or https unsubscribe target. The
        // invoice share URL is a poor target; use the business reply-to
        // (which we set when configured) so replying is the canonical "please
        // stop sending" action. Falls back to the from-address.
        "List-Unsubscribe": `<mailto:${process.env.RESEND_REPLY_TO || fromAddress}?subject=Unsubscribe ${sent.invoiceNumber}>`,
      },
    });
    if (result.error) {
      return {
        ok: false,
        code: "resend_failure",
        message: `Resend rejected the message: ${result.error.message}`,
        hint:
          "Check RESEND_API_KEY, verify the sending domain, and confirm the from-address is on a verified domain.",
      };
    }
    return {
      ok: true,
      invoice: sent,
      to: toArray,
      resendId: result.data?.id ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      code: "resend_failure",
      message: `Resend request failed: ${(err as Error).message}`,
    };
  }
}

async function getClientEmail(ctx: EnwiseCtx, clientId: string): Promise<string | null> {
  const { db } = await import("@/lib/db");
  const { clients } = await import("@/lib/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const [row] = await db
    .select({ email: clients.email })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.businessId, ctx.businessId)));
  return row?.email ?? null;
}

function buildAddressLines(a: {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}): string[] {
  const out: string[] = [];
  if (a.addressLine1) out.push(a.addressLine1);
  if (a.addressLine2) out.push(a.addressLine2);
  const cityLine = [a.city, a.region, a.postalCode].filter(Boolean).join(", ");
  if (cityLine) out.push(cityLine);
  if (a.country) out.push(a.country);
  return out;
}
