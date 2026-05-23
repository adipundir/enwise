import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses, users, type Business } from "@/lib/db/schema";
import type { ScopedCtx } from "@/lib/mcp/context";
import { uniqueSlug } from "@/lib/slug";

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
  contactName: string | null;
  walletAddress: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  invoiceNumberPrefix: string;
  invoiceNumberNext: number;
  logoUrl: string | null;
  brandColor: string | null;
  emailReplyTo: string | null;
  defaultPaymentTermsDays: number;
  defaultNotes: string | null;
  paymentChainId: number | null;
}>;

export async function getBusinessProfile(
  ctx: ScopedCtx,
): Promise<Business | null> {
  const [row] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId));
  return row ?? null;
}

/**
 * wallet_address must be a recognizable onchain identifier: either a raw
 * EVM address (0x + 40 hex) or a plausible ENS name (foo.eth / foo.bar.eth).
 * Rejects anything else — including bank account numbers, IBANs, emails,
 * free-form text — at the library layer so any caller (MCP, future REST,
 * scripts) gets the same guarantee. The DB CHECK constraint is the third
 * layer of defense.
 *
 * The Pay-with-USDC button on the share page ALSO requires raw 0x; ENS is
 * accepted for display only. That's a separate gate in the share page.
 */
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ENS_NAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;

export class WalletAddressValidationError extends Error {
  code = "invalid_wallet_address";
  hint =
    "wallet_address must be a raw 0x… EVM address (40 hex chars) or an ENS name ending in .eth. Bank account numbers, IBANs, and free-form text are rejected. If the user meant to add a bank account, call addBankAccount instead.";
}

function assertValidWalletAddress(value: string | null | undefined) {
  if (value === undefined || value === null) return;
  const v = value.trim();
  if (v === "") return; // empty string treated as null
  if (EVM_ADDRESS_RE.test(v) || ENS_NAME_RE.test(v)) return;
  throw new WalletAddressValidationError(
    `wallet_address "${v}" is not a recognizable onchain identifier (expected raw 0x + 40 hex, or an ENS name like name.eth).`,
  );
}

export async function updateBusinessProfile(
  ctx: ScopedCtx,
  patch: BusinessPatch,
): Promise<Business | null> {
  if (patch.walletAddress !== undefined) {
    assertValidWalletAddress(patch.walletAddress);
  }
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
    contact_name: row.contactName,
    wallet_address: row.walletAddress,
    address_line1: row.addressLine1,
    address_line2: row.addressLine2,
    city: row.city,
    region: row.region,
    postal_code: row.postalCode,
    country: row.country,
    invoice_number_prefix: row.invoiceNumberPrefix,
    invoice_number_next: row.invoiceNumberNext,
    logo_url: row.logoUrl,
    brand_color: row.brandColor,
    email_reply_to: row.emailReplyTo,
    default_payment_terms_days: row.defaultPaymentTermsDays,
    default_notes: row.defaultNotes,
    payment_chain_id: row.paymentChainId,
  };
}

/**
 * Create a new business under `userId`. A user can own as many
 * businesses as they want — no plan gating, all accounts are equal.
 */
export async function createBusiness(params: {
  userId: string;
  name: string;
  setAsDefault?: boolean;
}): Promise<Business> {
  const [created] = await db
    .insert(businesses)
    .values({
      ownerUserId: params.userId,
      name: params.name,
      slug: uniqueSlug(params.name),
    })
    .returning();
  if (!created) {
    throw new Error("Failed to create business");
  }
  if (params.setAsDefault) {
    await db
      .update(users)
      .set({ defaultBusinessId: created.id })
      .where(eq(users.id, params.userId));
  }
  return created;
}
