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
import { formatMoney } from "@/lib/money";
import { buildInvoicePdfData, renderInvoiceBuffer } from "@/lib/pdf/renderInvoice";

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
  const toArray = dedupEmails(input.to?.length ? input.to : [recipientEmail]);
  // Dedup cc/bcc against to so a caller passing the same address into
  // multiple buckets doesn't double-deliver. Case-insensitive.
  const toSet = new Set(toArray.map((a) => a.toLowerCase()));
  const ccArray = input.cc ? dedupEmails(input.cc).filter((a) => !toSet.has(a.toLowerCase())) : undefined;
  const ccSet = new Set([...toSet, ...(ccArray ?? []).map((a) => a.toLowerCase())]);
  const bccArray = input.bcc
    ? dedupEmails(input.bcc).filter((a) => !ccSet.has(a.toLowerCase()))
    : undefined;
  // Remember whether this call is the one that flipped draft→sent. If Resend
  // later rejects the message, we revert the finalize so the invoice doesn't
  // sit in a "sent but not actually sent" state.
  const didFinalizeInThisCall =
    invoice.status === "draft" && invoice.clientNameSnapshot === null;

  // 3. Finalize invoice (snapshot + status=sent).
  const finalized = await finalizeInvoice(ctx, invoice.id);
  if (!finalized.ok) {
    // Finalize never moves businesses, renumbers, or reverts payments, so
    // business_not_found / duplicate_invoice_number / invalid_invoice_number /
    // invalid_transition are unreachable here; fold them into not_found for
    // the SendInvoiceOutcome shape.
    const code =
      finalized.code === "business_not_found" ||
      finalized.code === "duplicate_invoice_number" ||
      finalized.code === "invalid_invoice_number" ||
      finalized.code === "invalid_transition"
        ? "not_found"
        : finalized.code;
    return { ok: false, code, message: finalized.message };
  }
  const sent = finalized.value;

  // 4. Build PDF-render data (used by the email template for business/client
  //    info) AND render the PDF as a Buffer for attachment. Attaching the
  //    PDF gives the recipient a portable, offline-readable copy that doesn't
  //    depend on enwise being online, and matches what most recipients
  //    expect when they hear "invoice email".
  const pdfData = await buildInvoicePdfData(sent);
  let invoiceAttachment: { filename: string; content: Buffer } | null = null;
  try {
    const buf = await renderInvoiceBuffer(sent);
    invoiceAttachment = {
      filename: `${sent.invoiceNumber}.pdf`,
      content: buf,
    };
  } catch (err) {
    // Don't fail the send if the PDF render fails — the share link still
    // gives the recipient a way to view + download the invoice.
    console.warn("[send-invoice] PDF render failed, sending without attachment:", err);
  }

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
    contactName: pdfData.client.contactName,
    businessName: pdfData.business.name,
    businessLegalName: pdfData.business.legalName,
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

  // Look up the business's configured reply-to (where the recipient's
  // replies should land) for this specific invoice's rendering business.
  const replyToAddress = await getBusinessReplyTo(sent.businessId);
  const unsubscribeAddress =
    replyToAddress || process.env.RESEND_REPLY_TO || fromAddress;

  try {
    const result = await resend.emails.send({
      from: fromDisplay,
      to: toArray,
      cc: ccArray && ccArray.length > 0 ? ccArray : undefined,
      bcc: bccArray && bccArray.length > 0 ? bccArray : undefined,
      replyTo: replyToAddress ?? undefined,
      subject: `Invoice ${sent.invoiceNumber} — ${formatMoney(sent.total, sent.currency)} due ${sent.dueDate}`,
      html,
      text: plainText,
      attachments: invoiceAttachment ? [invoiceAttachment] : undefined,
      headers: {
        // Gmail/Outlook expect a mailto or https unsubscribe target. The
        // invoice share URL is a poor target; use the business reply-to
        // (or the configured server-wide one) so replying is the canonical
        // "please stop sending" action.
        "List-Unsubscribe": `<mailto:${unsubscribeAddress}?subject=Unsubscribe ${sent.invoiceNumber}>`,
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
    // Persist the primary recipient on the invoice row so void_invoice can
    // notify the same address later. Tracks send-time overrides (the merchant
    // may have passed `to` explicitly, different from client.email). Only
    // [0] — cc/bcc don't get void notifications.
    {
      const { db } = await import("@/lib/db");
      const { invoices } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      await db
        .update(invoices)
        .set({ sentToEmail: toArray[0]!, updatedAt: new Date() })
        .where(eq(invoices.id, sent.id));
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

/**
 * Look up the business's configured reply-to address for this invoice.
 * Used as the `replyTo` header on the outbound email so recipients reply
 * to the user's actual inbox instead of our `RESEND_FROM_ADDRESS`.
 */
async function getBusinessReplyTo(businessId: string): Promise<string | null> {
  const { db } = await import("@/lib/db");
  const { businesses } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await db
    .select({ emailReplyTo: businesses.emailReplyTo })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  return row?.emailReplyTo ?? null;
}

function dedupEmails(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of arr) {
    const k = a.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a.trim());
  }
  return out;
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
