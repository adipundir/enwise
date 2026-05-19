import { renderToBuffer, renderToStream, type DocumentProps } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  businesses,
  clients,
  invoicePayments,
  type Business,
  type Client,
} from "@/lib/db/schema";
import type { InvoiceWithLineItems } from "@/lib/invoices";
import { resolveChain } from "@/lib/web3/chain";
import {
  PaymentReceiptDocument,
  type PaymentReceiptData,
} from "@/components/pdf/PaymentReceiptDocument";

type AddressSnap = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
};

export async function renderReceiptStream(
  invoice: InvoiceWithLineItems,
): Promise<NodeJS.ReadableStream> {
  const data = await buildReceiptData(invoice);
  if (!data) throw new Error("Cannot render receipt: invoice has no recorded payment");
  return renderToStream(
    createElement(PaymentReceiptDocument, data) as unknown as ReactElement<DocumentProps>,
  );
}

export async function renderReceiptBuffer(
  invoice: InvoiceWithLineItems,
): Promise<Buffer> {
  const data = await buildReceiptData(invoice);
  if (!data) throw new Error("Cannot render receipt: invoice has no recorded payment");
  return renderToBuffer(
    createElement(PaymentReceiptDocument, data) as unknown as ReactElement<DocumentProps>,
  );
}

/**
 * Builds the data bag the receipt PDF needs. Returns null when there's no
 * recorded payment yet (caller decides whether that's a 404 or a 409).
 */
export async function buildReceiptData(
  invoice: InvoiceWithLineItems,
): Promise<PaymentReceiptData | null> {
  // Most recent recorded payment for this invoice. If there are multiple
  // (partials), the receipt is for the latest one — most use-cases pay in full
  // anyway, so this is the typical case.
  const [payment] = await db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, invoice.id))
    .orderBy(desc(invoicePayments.paidAt))
    .limit(1);
  if (!payment) return null;

  // Live rows when snapshots are missing (drafts shouldn't get here but be defensive).
  let client: Client | null = null;
  let business: Business | null = null;
  if (!invoice.clientNameSnapshot) {
    const [row] = await db.select().from(clients).where(eq(clients.id, invoice.clientId));
    client = row ?? null;
  }
  if (!invoice.businessNameSnapshot) {
    const [row] = await db.select().from(businesses).where(eq(businesses.id, invoice.businessId));
    business = row ?? null;
  }

  const businessName = invoice.businessNameSnapshot ?? business?.name ?? "—";
  const businessLegalName = invoice.businessLegalNameSnapshot ?? business?.legalName ?? null;
  const businessLogoUrl = invoice.businessLogoUrlSnapshot ?? business?.logoUrl ?? null;
  const businessTaxId = invoice.businessTaxIdSnapshot ?? business?.taxId ?? null;
  const businessAddressLines = addressLines(
    (invoice.businessAddressSnapshot as AddressSnap | null) ?? null,
    business,
  );

  const paidByName = invoice.clientNameSnapshot ?? client?.name ?? "—";
  const paidByAddressLines = addressLines(
    (invoice.clientAddressSnapshot as AddressSnap | null) ?? null,
    client,
  );

  const chainInfo = resolveChain(payment.chainId);
  const methodLabel = payment.paymentMethod === "direct_transfer"
    ? `${payment.currency.toUpperCase()} on ${chainInfo.chain.name}`
    : payment.paymentMethod === "manual"
      ? "Recorded manually"
      : payment.paymentMethod;

  return {
    receipt: {
      invoiceNumber: invoice.invoiceNumber,
      paidAt: payment.paidAt,
      amount: payment.amount,
      currency: payment.currency,
    },
    invoice: {
      issueDate: invoice.issueDate,
      total: invoice.total,
      currency: invoice.currency,
    },
    business: {
      name: businessName,
      legalName: businessLegalName,
      logoUrl: businessLogoUrl,
      addressLines: businessAddressLines,
      taxId: businessTaxId,
    },
    paidBy: {
      name: paidByName,
      addressLines: paidByAddressLines,
    },
    payment: {
      methodLabel,
      chainName: chainInfo.chain.name,
      txHash: payment.txHash,
      txExplorerUrl: chainInfo.txExplorerUrl(payment.txHash),
      payerAddress: payment.payerAddress,
    },
  };
}

function addressLines(
  snap: AddressSnap | null,
  live: { addressLine1?: string | null; addressLine2?: string | null; city?: string | null; region?: string | null; postalCode?: string | null; country?: string | null } | null,
): string[] {
  const a1 = snap?.line1 ?? live?.addressLine1 ?? null;
  const a2 = snap?.line2 ?? live?.addressLine2 ?? null;
  const city = snap?.city ?? live?.city ?? null;
  const region = snap?.region ?? live?.region ?? null;
  const pc = snap?.postal_code ?? live?.postalCode ?? null;
  const country = snap?.country ?? live?.country ?? null;
  const out: string[] = [];
  if (a1) out.push(a1);
  if (a2) out.push(a2);
  const cityLine = [city, region, pc].filter(Boolean).join(", ");
  if (cityLine) out.push(cityLine);
  if (country) out.push(country);
  return out;
}

