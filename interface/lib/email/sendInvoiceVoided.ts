/**
 * Send a void-notification email to the address an invoice was previously
 * delivered to. Triggered from voidInvoice; only fires when:
 *   - invoice.sentToEmail is set (the invoice was actually delivered)
 *   - RESEND_API_KEY is configured
 *
 * Failures don't roll back the void — voiding an invoice in the merchant's
 * own books should never be blocked on email infrastructure. We log and
 * continue.
 */
import { render } from "@react-email/components";
import { Resend } from "resend";
import { createElement } from "react";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses, invoices } from "@/lib/db/schema";
import { invoiceShareUrl } from "@/lib/invoices";
import { InvoiceVoidedEmail } from "@/emails/InvoiceVoidedEmail";

export type VoidEmailOutcome =
  | { ok: true; to: string; resendId: string | null }
  | { ok: false; reason: string };

export async function sendInvoiceVoidedEmail(params: {
  invoiceId: string;
  reason: string | null;
}): Promise<VoidEmailOutcome> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, reason: "RESEND_API_KEY not configured" };

  const [inv] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, params.invoiceId)));
  if (!inv) return { ok: false, reason: "invoice not found" };
  if (!inv.sentToEmail) {
    return { ok: false, reason: "invoice was never sent; no recipient to notify" };
  }

  const [biz] = await db
    .select({
      name: businesses.name,
      emailReplyTo: businesses.emailReplyTo,
    })
    .from(businesses)
    .where(eq(businesses.id, inv.businessId));
  const businessName =
    inv.businessNameSnapshot ?? biz?.name ?? "Your supplier";

  const clientName = inv.clientNameSnapshot ?? "there";
  const contactName = inv.clientContactNameSnapshot ?? null;

  const shareUrl = invoiceShareUrl(inv.shareSlug);

  const emailProps = {
    invoiceNumber: inv.invoiceNumber,
    clientName,
    contactName,
    businessName,
    shareUrl,
    reason: params.reason,
  };

  const html = await render(createElement(InvoiceVoidedEmail, emailProps));
  const plainText = await render(createElement(InvoiceVoidedEmail, emailProps), {
    plainText: true,
  });

  const fromAddress =
    process.env.RESEND_FROM_ADDRESS || "onboarding@resend.dev";
  const fromDisplay = `${sanitizeHeader(businessName)} <${fromAddress}>`;
  const replyTo = biz?.emailReplyTo ?? undefined;

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from: fromDisplay,
      to: [inv.sentToEmail],
      replyTo,
      subject: `Invoice ${inv.invoiceNumber} has been voided`,
      html,
      text: plainText,
    });
    if (result.error) {
      return { ok: false, reason: `resend rejected: ${result.error.message}` };
    }
    return { ok: true, to: inv.sentToEmail, resendId: result.data?.id ?? null };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n<>]/g, "").trim();
}
