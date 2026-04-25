import { renderToStream, type DocumentProps } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses, clients, type Business, type Client } from "@/lib/db/schema";
import type { InvoiceWithLineItems } from "@/lib/invoices";
import { InvoiceDocument, type InvoicePdfData } from "@/components/pdf/InvoiceDocument";

/**
 * Render an invoice to a PDF Node stream.
 *
 * Preference order for client/business fields:
 *   1. Snapshot fields on the invoice (captured on finalize/send)
 *   2. Live rows from the DB (for drafts — there's no snapshot yet)
 */
export async function renderInvoicePdf(
  invoice: InvoiceWithLineItems,
): Promise<NodeJS.ReadableStream> {
  const data = await buildInvoicePdfData(invoice);
  const element = createElement(InvoiceDocument, data) as unknown as ReactElement<DocumentProps>;
  return renderToStream(element);
}

export async function buildInvoicePdfData(
  invoice: InvoiceWithLineItems,
): Promise<InvoicePdfData> {
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

  const clientSnapshot = (invoice.clientAddressSnapshot as ClientAddressSnapshot | null) ?? null;
  const businessSnapshot = (invoice.businessAddressSnapshot as ClientAddressSnapshot | null) ?? null;

  return {
    invoice,
    client: {
      name: invoice.clientNameSnapshot ?? client?.name ?? "(unknown client)",
      email: invoice.clientEmailSnapshot ?? client?.email ?? null,
      addressLine1: clientSnapshot?.line1 ?? client?.addressLine1 ?? null,
      addressLine2: clientSnapshot?.line2 ?? client?.addressLine2 ?? null,
      city: clientSnapshot?.city ?? client?.city ?? null,
      region: clientSnapshot?.region ?? client?.region ?? null,
      postalCode: clientSnapshot?.postal_code ?? client?.postalCode ?? null,
      country: clientSnapshot?.country ?? client?.country ?? null,
    },
    business: {
      name: invoice.businessNameSnapshot ?? business?.name ?? "(unknown business)",
      logoUrl: invoice.businessLogoUrlSnapshot ?? business?.logoUrl ?? null,
      addressLine1: businessSnapshot?.line1 ?? business?.addressLine1 ?? null,
      addressLine2: businessSnapshot?.line2 ?? business?.addressLine2 ?? null,
      city: businessSnapshot?.city ?? business?.city ?? null,
      region: businessSnapshot?.region ?? business?.region ?? null,
      postalCode: businessSnapshot?.postal_code ?? business?.postalCode ?? null,
      country: businessSnapshot?.country ?? business?.country ?? null,
      taxId: business?.taxId ?? null,
    },
  };
}

interface ClientAddressSnapshot {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
}
