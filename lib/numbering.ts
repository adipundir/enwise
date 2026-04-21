import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { EnwiseCtx } from "@/lib/mcp/context";

export interface AllocatedNumber {
  invoiceNumber: string;
  businessSnapshot: {
    name: string;
    slug: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
    logoUrl: string | null;
    defaultCurrency: string;
    taxId: string | null;
    legalName: string | null;
  };
}

/**
 * Atomically bump businesses.invoice_number_next and format the next
 * invoice number. Safe under concurrency. the row lock on the business
 * serializes concurrent allocations so each gets a distinct integer.
 *
 * Also returns the business snapshot fields needed to freeze on the invoice
 * row at creation time, so the caller doesn't have to re-fetch.
 */
export async function allocateInvoiceNumber(
  ctx: EnwiseCtx,
): Promise<AllocatedNumber | null> {
  const result = await db.execute(sql`
    update businesses
    set invoice_number_next = invoice_number_next + 1,
        updated_at = now()
    where id = ${ctx.businessId}
    returning
      invoice_number_prefix           as prefix,
      invoice_number_next - 1         as allocated,
      name                            as name,
      slug                            as slug,
      address_line1                   as address_line1,
      address_line2                   as address_line2,
      city                            as city,
      region                          as region,
      postal_code                     as postal_code,
      country                         as country,
      logo_url                        as logo_url,
      default_currency                as default_currency,
      tax_id                          as tax_id,
      legal_name                      as legal_name
  `);
  const row = result.rows[0] as
    | {
        prefix: string;
        allocated: number;
        name: string;
        slug: string;
        address_line1: string | null;
        address_line2: string | null;
        city: string | null;
        region: string | null;
        postal_code: string | null;
        country: string | null;
        logo_url: string | null;
        default_currency: string;
        tax_id: string | null;
        legal_name: string | null;
      }
    | undefined;
  if (!row) return null;

  const invoiceNumber = `${row.prefix}${String(row.allocated).padStart(4, "0")}`;
  return {
    invoiceNumber,
    businessSnapshot: {
      name: row.name,
      slug: row.slug,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      city: row.city,
      region: row.region,
      postalCode: row.postal_code,
      country: row.country,
      logoUrl: row.logo_url,
      defaultCurrency: row.default_currency,
      taxId: row.tax_id,
      legalName: row.legal_name,
    },
  };
}
