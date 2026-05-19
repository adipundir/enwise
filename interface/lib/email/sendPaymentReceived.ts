import { render } from "@react-email/components";
import { createElement } from "react";
import { Resend } from "resend";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses, clients, invoices, users } from "@/lib/db/schema";
import { getInvoiceBySlug, invoiceShareUrl } from "@/lib/invoices";
import { resolveChain } from "@/lib/web3/chain";
import { renderReceiptBuffer } from "@/lib/pdf/renderReceipt";
import { PaymentReceivedEmail } from "@/emails/PaymentReceivedEmail";

type SendPaymentReceivedInput = {
  invoiceId: string;
  amount: string; // decimal string, invoice currency
  currency: string;
  txHash: string;
  chainId: number;
};

/**
 * Best-effort: never throws. Logs failures and returns a per-recipient
 * outcome. Designed to run inside next/server `after()` so a Resend
 * outage or a malformed email can't roll back a paid invoice.
 */
export async function sendPaymentReceivedEmails(
  input: SendPaymentReceivedInput,
): Promise<{ merchant: "sent" | "skipped" | "failed"; client: "sent" | "skipped" | "failed" }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[payment-received] RESEND_API_KEY missing — skipping confirmations");
    return { merchant: "skipped", client: "skipped" };
  }

  const [inv] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId));
  if (!inv) {
    console.warn(`[payment-received] invoice ${input.invoiceId} not found`);
    return { merchant: "skipped", client: "skipped" };
  }

  // Merchant info: business row + owner's auth email.
  const [biz] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, inv.businessId));
  if (!biz) return { merchant: "skipped", client: "skipped" };

  const [owner] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, biz.ownerUserId));

  // Client info: prefer snapshot (frozen at finalize), else live row.
  let clientName = inv.clientNameSnapshot ?? null;
  let clientContactName = inv.clientContactNameSnapshot ?? null;
  let clientEmail = inv.clientEmailSnapshot ?? null;
  if (!clientEmail || !clientName) {
    const [liveClient] = await db
      .select({ name: clients.name, email: clients.email, contactName: clients.contactName })
      .from(clients)
      .where(eq(clients.id, inv.clientId));
    if (liveClient) {
      clientName ??= liveClient.name;
      clientContactName ??= liveClient.contactName;
      clientEmail ??= liveClient.email;
    }
  }

  const resend = new Resend(apiKey);
  const fromAddress = process.env.RESEND_FROM_ADDRESS || "onboarding@resend.dev";
  const replyTo = biz.emailReplyTo ?? undefined;
  const shareUrl = invoiceShareUrl(inv.shareSlug);
  const explorerUrl = resolveChain(input.chainId).txExplorerUrl(input.txHash);

  // Render the receipt PDF once and reuse for both recipients. If it fails
  // (missing payment row, render error), email still sends without the
  // attachment — receipt is still downloadable from the share page.
  let receiptAttachment: { filename: string; content: Buffer } | null = null;
  try {
    const fullInvoice = await getInvoiceBySlug(inv.shareSlug);
    if (fullInvoice) {
      const buf = await renderReceiptBuffer(fullInvoice);
      receiptAttachment = {
        filename: `${inv.invoiceNumber}-receipt.pdf`,
        content: buf,
      };
    }
  } catch (err) {
    console.warn("[payment-received] receipt render failed, sending email without attachment:", err);
  }

  const businessAddressLines = buildAddressLines(biz);
  const sharedProps = {
    invoiceNumber: inv.invoiceNumber,
    businessName: biz.name,
    businessLegalName: biz.legalName,
    logoUrl: biz.logoUrl,
    amount: input.amount,
    currency: input.currency,
    txHash: input.txHash,
    txExplorerUrl: explorerUrl,
    shareUrl,
    businessAddressLines,
  } as const;
  const fromDisplay = `${sanitizeHeader(biz.name)} <${fromAddress}>`;

  // --- Merchant email ---
  let merchantOutcome: "sent" | "skipped" | "failed" = "skipped";
  if (owner?.email) {
    try {
      const html = await render(
        createElement(PaymentReceivedEmail, {
          ...sharedProps,
          recipientRole: "merchant",
          greetingName: biz.contactName ?? owner.name ?? biz.name,
          counterpartyName: clientName ?? "Your client",
        }),
      );
      const text = await render(
        createElement(PaymentReceivedEmail, {
          ...sharedProps,
          recipientRole: "merchant",
          greetingName: biz.contactName ?? owner.name ?? biz.name,
          counterpartyName: clientName ?? "Your client",
        }),
        { plainText: true },
      );
      const result = await resend.emails.send({
        from: fromDisplay,
        to: [owner.email],
        replyTo,
        subject: `Payment received: ${inv.invoiceNumber}`,
        html,
        text,
        attachments: receiptAttachment ? [receiptAttachment] : undefined,
      });
      merchantOutcome = result.error ? "failed" : "sent";
      if (result.error) {
        console.error(
          `[payment-received] merchant ${owner.email}: ${result.error.message}`,
        );
      }
    } catch (err) {
      console.error("[payment-received] merchant send threw:", err);
      merchantOutcome = "failed";
    }
  }

  // --- Client email ---
  let clientOutcome: "sent" | "skipped" | "failed" = "skipped";
  if (clientEmail) {
    try {
      const html = await render(
        createElement(PaymentReceivedEmail, {
          ...sharedProps,
          recipientRole: "client",
          greetingName: clientContactName ?? clientName ?? "there",
          counterpartyName: biz.name,
        }),
      );
      const text = await render(
        createElement(PaymentReceivedEmail, {
          ...sharedProps,
          recipientRole: "client",
          greetingName: clientContactName ?? clientName ?? "there",
          counterpartyName: biz.name,
        }),
        { plainText: true },
      );
      const result = await resend.emails.send({
        from: fromDisplay,
        to: [clientEmail],
        replyTo,
        subject: `Payment confirmed: ${inv.invoiceNumber}`,
        html,
        text,
        attachments: receiptAttachment ? [receiptAttachment] : undefined,
      });
      clientOutcome = result.error ? "failed" : "sent";
      if (result.error) {
        console.error(
          `[payment-received] client ${clientEmail}: ${result.error.message}`,
        );
      }
    } catch (err) {
      console.error("[payment-received] client send threw:", err);
      clientOutcome = "failed";
    }
  }

  return { merchant: merchantOutcome, client: clientOutcome };
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

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n\0<>]/g, "").trim();
}
