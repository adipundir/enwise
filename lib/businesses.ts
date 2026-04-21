import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses, type Business } from "@/lib/db/schema";
import type { EnvoiceCtx } from "@/lib/mcp/context";

/**
 * Fields a client can update on the business profile. `logoUrl` is expected
 * to be an already-resolved URL. the logo upload pipeline runs *before*
 * this service is called.
 *
 * Pass `logoUrl: null` to clear the logo.
 */
export type BusinessPatch = Partial<{
  name: string;
  legalName: string | null;
  taxId: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  defaultCurrency: string;
  invoiceNumberPrefix: string;
  invoiceNumberNext: number;
  logoUrl: string | null;
  brandColor: string | null;
  emailReplyTo: string | null;
  defaultPaymentTermsDays: number;
  defaultNotes: string | null;
}>;

export async function getBusinessProfile(
  ctx: EnvoiceCtx,
): Promise<Business | null> {
  const [row] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId));
  return row ?? null;
}

export async function updateBusinessProfile(
  ctx: EnvoiceCtx,
  patch: BusinessPatch,
): Promise<Business | null> {
  if (Object.keys(patch).length === 0) {
    return getBusinessProfile(ctx);
  }
  const [updated] = await db
    .update(businesses)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(businesses.id, ctx.businessId))
    .returning();
  return updated ?? null;
}

/**
 * Trim the business row down to the shape the MCP surface exposes (snake_case keys,
 * no internal timestamps). Kept out of service layer itself so the row type stays
 * clean for internal callers.
 */
export function formatBusinessForMcp(row: Business) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    legal_name: row.legalName,
    tax_id: row.taxId,
    address_line1: row.addressLine1,
    address_line2: row.addressLine2,
    city: row.city,
    region: row.region,
    postal_code: row.postalCode,
    country: row.country,
    default_currency: row.defaultCurrency,
    invoice_number_prefix: row.invoiceNumberPrefix,
    invoice_number_next: row.invoiceNumberNext,
    logo_url: row.logoUrl,
    brand_color: row.brandColor,
    email_reply_to: row.emailReplyTo,
    default_payment_terms_days: row.defaultPaymentTermsDays,
    default_notes: row.defaultNotes,
  };
}
