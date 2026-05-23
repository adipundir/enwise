import { z } from "zod";
import {
  createBusiness,
  formatBusinessForMcp,
  getBusinessProfile,
  updateBusinessProfile,
  WalletAddressValidationError,
  type BusinessPatch,
} from "@/lib/businesses";
import { ctxFromAuthInfo, scopeFromCtx } from "@/lib/mcp/context";
import { toolError, toolOk, zodToToolError } from "@/lib/mcp/errors";
import { uploadLogo } from "@/lib/storage/blob";
import { SUPPORTED_CHAIN_IDS } from "@/lib/web3/chain";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const supportedChainIdSchema = z
  .number()
  .int()
  .refine(
    (n): n is (typeof SUPPORTED_CHAIN_IDS)[number] =>
      (SUPPORTED_CHAIN_IDS as readonly number[]).includes(n),
    {
      message: `must be one of: ${SUPPORTED_CHAIN_IDS.join(", ")}`,
    },
  );

const uuid = z.string().uuid();

const logoInput = z.union([
  z.object({
    image_url: z.string().url(),
  }),
  z.object({
    image_base64: z.string().min(1),
    mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  }),
  z.null(),
]);

const updateInput = {
  business_id: uuid.optional(),
  name: z.string().min(1).max(200).optional(),
  legal_name: z.string().max(200).nullish(),
  tax_id: z.string().max(64).nullish(),
  contact_name: z.string().max(200).nullish(),
  wallet_address: z.string().max(200).nullish(),
  address_line1: z.string().max(200).nullish(),
  address_line2: z.string().max(200).nullish(),
  city: z.string().max(100).nullish(),
  region: z.string().max(100).nullish(),
  postal_code: z.string().max(20).nullish(),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "2-letter ISO-3166 code like 'US' or 'GB'")
    .transform((s) => s.toUpperCase())
    .optional(),
  invoice_number_prefix: z.string().min(1).max(12).optional(),
  invoice_number_next: z.number().int().min(1).max(9_999_999).optional(),
  brand_color: z.string().max(32).nullish(),
  email_reply_to: z.string().email().nullish(),
  default_payment_terms_days: z.number().int().min(0).max(365).optional(),
  default_notes: z.string().max(2000).nullish(),
  // Bank payout details now live in business_bank_accounts. Use the dedicated
  // bank-account MCP tools (add_bank_account, update_bank_account,
  // remove_bank_account, set_default_bank_account, list_bank_accounts).
  // Preferred EVM chain id for receiving USDC wallet payments. Pass null to
  // reset to the platform default. Validated against the SUPPORTED_CHAIN_IDS
  // list from lib/web3/chain.ts so callers can discover allowed values
  // from the schema error message.
  payment_chain_id: supportedChainIdSchema.nullish(),
  logo: logoInput.optional(),
  client_request_id: z.string().max(64).optional(),
};

const createBusinessInput = {
  name: z.string().min(1).max(200),
  set_as_default: z.boolean().optional(),
};

const getProfileInput = {
  business_id: uuid.optional(),
};

export function registerBusinessTools(server: McpServer) {
  server.registerTool(
    "create_business",
    {
      title: "Create a business",
      description:
        "Create a new business profile under the authenticated user. Use when the user says they want to bill from a new entity (different company, side project, freelance pseudonym, etc.). Ask for the name first; everything else (address, tax ID, etc.) can be added later via update_business_profile. Currency is NOT a business-level concept — it lives on the client (or per invoice). Don't ask the user for currency here. Pass `set_as_default: true` if the user says this should be their primary.",
      inputSchema: createBusinessInput,
    },
    async (args, extra) => {
      const parsed = z.object(createBusinessInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const input = parsed.data;
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const business = await createBusiness({
        userId: ctx.userId,
        name: input.name,
        setAsDefault: input.set_as_default ?? false,
      });
      return toolOk(formatBusinessForMcp(business));
    },
  );

  server.registerTool(
    "get_business_profile",
    {
      title: "Get business profile",
      description:
        "Return the full profile for a business: name, legal_name, tax_id, contact_name, invoice_number_prefix, logo_url, brand_color, email_reply_to, default_payment_terms_days, default_notes, full address, wallet_address, payment_chain_id (preferred EVM chain for receiving USDC), and timestamps. Currency is not stored on the business — it lives on the client (default_currency) or per invoice. Bank payout details are managed separately via list_bank_accounts / add_bank_account / etc. If the user owns only one business, `business_id` can be omitted; if they own multiple, pass `business_id`. Call this before update_business_profile to show the user what's currently on file.",
      inputSchema: getProfileInput,
    },
    async (args, extra) => {
      const parsed = z.object(getProfileInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;
      const profile = await getBusinessProfile(scope.scoped);
      if (!profile) {
        return toolError(
          "not_found",
          "Business not found.",
        );
      }
      return toolOk(formatBusinessForMcp(profile));
    },
  );

  server.registerTool(
    "update_business_profile",
    {
      title: "Update business profile",
      description:
        "Update any subset of a business profile (name, tax ID, address, invoice number prefix, logo, contact person, wallet address, preferred crypto chain, etc.). Currency lives on the client (default_currency) or per invoice, not on the business. Omitted fields are left unchanged. Pass null to clear a nullable field. Logo can be passed as either `{ image_url: 'https://…' }` or `{ image_base64: '…', mime_type: 'image/png' }`. To manage BANK ACCOUNTS, use the dedicated tools — add_bank_account / update_bank_account / remove_bank_account / set_default_bank_account / list_bank_accounts (a business can have multiple bank accounts; one is marked default for new invoices). `contact_name` is the person at the business who handles invoicing — used in PDF letterhead / email footer. **`wallet_address` is the ONLY place a crypto wallet belongs.** It's the merchant's onchain payout identity (raw 0x… or ENS name like `acme.eth`). The Pay-with-USDC button on the share page reads THIS field — not bank account fields. Whenever the user says 'add my wallet' / 'set my USDC address' / 'I want to receive crypto' / pastes a 0x… address / pastes a .eth name, the tool you want is THIS one with `wallet_address`. DO NOT call add_bank_account with a wallet stuffed into account_number — that tool will reject EVM-shaped input and points you back here. `payment_chain_id` selects the EVM chain payers will send USDC on — 8453 for Base mainnet, 84532 for Base Sepolia; pass null to use the platform default. Pass `business_id` if the user owns multiple businesses.",
      inputSchema: updateInput,
    },
    async (args, extra) => {
      const parsed = z.object(updateInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const input = parsed.data;
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, input.business_id);
      if (!scope.ok) return scope.error;

      const patch: BusinessPatch = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.legal_name !== undefined) patch.legalName = input.legal_name ?? null;
      if (input.tax_id !== undefined) patch.taxId = input.tax_id ?? null;
      if (input.contact_name !== undefined) patch.contactName = input.contact_name ?? null;
      if (input.wallet_address !== undefined) patch.walletAddress = input.wallet_address ?? null;
      if (input.address_line1 !== undefined) patch.addressLine1 = input.address_line1 ?? null;
      if (input.address_line2 !== undefined) patch.addressLine2 = input.address_line2 ?? null;
      if (input.city !== undefined) patch.city = input.city ?? null;
      if (input.region !== undefined) patch.region = input.region ?? null;
      if (input.postal_code !== undefined) patch.postalCode = input.postal_code ?? null;
      if (input.country !== undefined) patch.country = input.country;
      if (input.invoice_number_prefix !== undefined) patch.invoiceNumberPrefix = input.invoice_number_prefix;
      if (input.invoice_number_next !== undefined) {
        // Refuse to lower the invoice number sequence below what's already
        // been allocated. The unique index (business_id, invoice_number)
        // would throw on the next create_invoice and surface as a generic
        // internal_error to the user.
        const current = await getBusinessProfile(scope.scoped);
        if (current && input.invoice_number_next < current.invoiceNumberNext) {
          return toolError(
            "invalid_input",
            `invoice_number_next (${input.invoice_number_next}) is below the current allocator value (${current.invoiceNumberNext}). Setting it lower would collide on the next create_invoice.`,
            {
              hint: `Pass a value >= ${current.invoiceNumberNext}, or leave it unset.`,
            },
          );
        }
        patch.invoiceNumberNext = input.invoice_number_next;
      }
      if (input.brand_color !== undefined) patch.brandColor = input.brand_color ?? null;
      if (input.email_reply_to !== undefined) patch.emailReplyTo = input.email_reply_to ?? null;
      if (input.default_payment_terms_days !== undefined)
        patch.defaultPaymentTermsDays = input.default_payment_terms_days;
      if (input.default_notes !== undefined) patch.defaultNotes = input.default_notes ?? null;
      if (input.payment_chain_id !== undefined) patch.paymentChainId = input.payment_chain_id ?? null;

      if (input.logo !== undefined) {
        if (input.logo === null) {
          patch.logoUrl = null;
        } else {
          const result = await uploadLogo({ businessId: scope.scoped.businessId, input: input.logo });
          if (!result.ok) {
            return toolError(result.code, result.message, {
              hint: result.hint,
            });
          }
          patch.logoUrl = result.url;
        }
      }

      let updated;
      try {
        updated = await updateBusinessProfile(scope.scoped, patch);
      } catch (e) {
        if (e instanceof WalletAddressValidationError) {
          return toolError("invalid_input", e.message, { hint: e.hint });
        }
        throw e;
      }
      if (!updated) {
        return toolError(
          "not_found",
          "Business disappeared during update. this shouldn't happen.",
        );
      }
      return toolOk(formatBusinessForMcp(updated));
    },
  );
}
