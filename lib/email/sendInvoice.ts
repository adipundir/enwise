import { render } from "@react-email/components";
import { createElement } from "react";
import { Resend } from "resend";
import { InvoiceEmail } from "@/emails/InvoiceEmail";
import {
  finalizeInvoice,
  getInvoice,
  invoiceShareUrl,
  revertFinalizeInvoice,
  type InvoiceWithLineItems,
} from "@/lib/invoices";
import type { ScopedCtx } from "@/lib/mcp/context";
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
  ctx: ScopedCtx,
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
  // Remember whether this call is the one that flipped draft→sent. If Resend
  // later rejects the message, we revert the finalize so the invoice doesn't
  // sit in a "sent but not actually sent" state.
  const didFinalizeInThisCall =
    invoice.status === "draft" && invoice.clientNameSnapshot === null;

  // 3. Finalize invoice (snapshot + status=sent).
  const finalized = await finalizeInvoice(ctx, invoice.id);
  if (!finalized.ok) {
    // Finalize never moves businesses, so business_not_found is unreachable
    // here; fold into not_found for the SendInvoiceOutcome shape.
    const code =
      finalized.code === "business_not_found" ? "not_found" : finalized.code;
    return { ok: false, code, message: finalized.message };
  }
  const sent = finalized.value;

  // 4. Build PDF-render data (used by the email template for business/client
  //    info) but don't render the PDF into the email itself. we no longer
  //    attach it. Email clients auto-preview PDF attachments inline, which
  //    makes the email feel like a dumped invoice rather than a clean
  //    transactional notice. Instead we link to /i/[slug] which has a
  //    prominent Download PDF button.
  const pdfData = await buildInvoicePdfData(sent);

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

  const emailProps = {
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
  };

  const html = await render(createElement(InvoiceEmail, emailProps));
  const plainText = await render(createElement(InvoiceEmail, emailProps), {
    plainText: true,
  });

  // 6. Send via Resend.
  const resend = new Resend(apiKey);
  // Fallback to Resend's sandbox sender so local dev / unconfigured servers
  // don't hard-fail. Only delivers to the Resend account owner in that mode.
  // Prod sets RESEND_FROM_ADDRESS=invoices@enwise.app.
  const fromAddress =
    process.env.RESEND_FROM_ADDRESS || "onboarding@resend.dev";
  // Display name is just the business name. the @enwise.app in the address
  // already tells the recipient which platform sent it, so we don't need
  // "via enwise" duplicating that signal in the display name.
  const fromDisplay = `${sanitizeHeaderValue(pdfData.business.name)} <${fromAddress}>`;

  try {
    const result = await resend.emails.send({
      from: fromDisplay,
      to: toArray,
      cc: input.cc,
      bcc: input.bcc,
      replyTo: undefined, // Populated from business.email_reply_to if set; see below.
      subject: `${sanitizeHeaderValue(pdfData.business.name)}. Invoice ${sent.invoiceNumber}`,
      html,
      text: plainText,
      headers: {
        // Gmail/Outlook expect a mailto or https unsubscribe target. The
        // invoice share URL is a poor target; use the business reply-to
        // (which we set when configured) so replying is the canonical "please
        // stop sending" action. Falls back to the from-address.
        "List-Unsubscribe": `<mailto:${process.env.RESEND_REPLY_TO || fromAddress}?subject=Unsubscribe ${sent.invoiceNumber}>`,
      },
    });
    if (result.error) {
      if (didFinalizeInThisCall) {
        await revertFinalizeInvoice(ctx, invoice.id);
      }
      return {
        ok: false,
        code: "resend_failure",
        message: `Resend rejected the message: ${result.error.message}. Invoice kept as draft.`,
        hint:
          "Check RESEND_API_KEY, verify the sending domain, and confirm the from-address is on a verified domain. Retry send_invoice once fixed.",
      };
    }
    return {
      ok: true,
      invoice: sent,
      to: toArray,
      resendId: result.data?.id ?? null,
    };
  } catch (err) {
    if (didFinalizeInThisCall) {
      await revertFinalizeInvoice(ctx, invoice.id);
    }
    return {
      ok: false,
      code: "resend_failure",
      message: `Resend request failed: ${(err as Error).message}. Invoice kept as draft.`,
      hint:
        "Check RESEND_API_KEY and network connectivity to Resend. Retry send_invoice once fixed.",
    };
  }
}

async function getClientEmail(ctx: ScopedCtx, clientId: string): Promise<string | null> {
  const { db } = await import("@/lib/db");
  const { clients } = await import("@/lib/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const [row] = await db
    .select({ email: clients.email })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.ownerUserId, ctx.userId)));
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

/**
 * Strip anything that could break out of an email header (CR, LF, NUL) or
 * confuse a display-name parser (unmatched angle brackets, leading/trailing
 * whitespace). Resend's HTTP API probably sanitizes too, but we should
 * never rely on the downstream library to enforce our own header integrity.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0<>]/g, "").trim();
}
