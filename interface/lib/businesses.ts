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
  evmWalletAddress: string | null;
  starknetWalletAddress: string | null;
  aptosWalletAddress: string | null;
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
 * Per-chain wallet validation. Three chain families supported (all with
 * native Circle-issued USDC): EVM, Starknet, Aptos. Library-layer guard;
 * the MCP tool surfaces this as a structured invalid_input, and the DB
 * has matching CHECK constraints in migration 0028 as third-layer defense.
 *
 * The Pay-with-USDC button on the share page reads ONLY evm_wallet_address
 * and additionally requires raw 0x (ENS accepted for display only). Other
 * chains render on the invoice as additional payment-info rows.
 */
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ENS_NAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;
const STARKNET_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;
const STARKNET_NAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.stark$/i;
const APTOS_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;
const APTOS_NAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.apt$/i;

const CHAIN_RULES = {
  evm: {
    field: "evm_wallet_address",
    label: "EVM address",
    matchers: [EVM_ADDRESS_RE, ENS_NAME_RE] as const,
    expected: "raw 0x + 40 hex (e.g. 0xabc…), or an ENS name like name.eth",
  },
  starknet: {
    field: "starknet_wallet_address",
    label: "Starknet address",
    matchers: [STARKNET_ADDRESS_RE, STARKNET_NAME_RE] as const,
    expected: "raw 0x + up to 64 hex, or a Starknet Domains name like name.stark",
  },
  aptos: {
    field: "aptos_wallet_address",
    label: "Aptos address",
    matchers: [APTOS_ADDRESS_RE, APTOS_NAME_RE] as const,
    expected: "raw 0x + up to 64 hex, or an Aptos Names handle like name.apt",
  },
} as const;

export class WalletAddressValidationError extends Error {
  code = "invalid_wallet_address";
  hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.hint = hint;
  }
}

function assertValidChainAddress(
  chain: keyof typeof CHAIN_RULES,
  value: string | null | undefined,
) {
  if (value === undefined || value === null) return;
  const v = value.trim();
  if (v === "") return;
  const rule = CHAIN_RULES[chain];
  if (rule.matchers.some((r) => r.test(v))) return;
  throw new WalletAddressValidationError(
    `${rule.field} "${v}" is not a recognizable ${rule.label} (expected ${rule.expected}).`,
    `Each wallet field is chain-specific. EVM addresses go in evm_wallet_address, Starknet in starknet_wallet_address, Aptos in aptos_wallet_address. Bank account numbers / IBANs / free-form text are always rejected — for fiat use addBankAccount.`,
  );
}

export async function updateBusinessProfile(
  ctx: ScopedCtx,
  patch: BusinessPatch,
): Promise<Business | null> {
  if (patch.evmWalletAddress !== undefined) assertValidChainAddress("evm", patch.evmWalletAddress);
  if (patch.starknetWalletAddress !== undefined) assertValidChainAddress("starknet", patch.starknetWalletAddress);
  if (patch.aptosWalletAddress !== undefined) assertValidChainAddress("aptos", patch.aptosWalletAddress);
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
    evm_wallet_address: row.evmWalletAddress,
    starknet_wallet_address: row.starknetWalletAddress,
    aptos_wallet_address: row.aptosWalletAddress,
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
