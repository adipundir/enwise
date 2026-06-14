import { z } from "zod";
import {
  createBusiness,
  deleteBusiness,
  formatBusinessForMcp,
  getBusinessProfile,
  setDefaultBusiness,
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
  evm_wallet_address: z.string().max(200).nullish(),
  starknet_wallet_address: z.string().max(200).nullish(),
  aptos_wallet_address: z.string().max(200).nullish(),
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
  // The set of EVM chains this business accepts USDC on. The payer picks one
  // at pay time; all pay to the same evm_wallet_address. Pass null to reset to
  // [payment_chain_id ?? platform default]. Each id validated against
  // SUPPORTED_CHAIN_IDS so callers discover allowed values from the error.
  accepted_chain_ids: z.array(supportedChainIdSchema).nullish(),
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
        "Return the full profile for a business: name, legal_name, tax_id, contact_name, invoice_number_prefix, logo_url, brand_color, email_reply_to, default_payment_terms_days, default_notes, full address, evm_wallet_address, starknet_wallet_address, aptos_wallet_address, payment_chain_id (preferred EVM chain for receiving USDC), accepted_chain_ids (the set of EVM chains the payer can choose from), and timestamps. Currency is not stored on the business — it lives on the client (default_currency) or per invoice. Bank payout details are managed separately via list_bank_accounts / add_bank_account / etc. If the user owns only one business, `business_id` can be omitted; if they own multiple, pass `business_id`. Call this before update_business_profile to show the user what's currently on file.",
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
        "Update any subset of a business profile (name, tax ID, address, invoice number prefix, logo, contact person, per-chain wallets, preferred EVM crypto chain, etc.). Currency lives on the client (default_currency) or per invoice, not on the business. Omitted fields are left unchanged. Pass null to clear a nullable field. To manage BANK ACCOUNTS, use the dedicated tools — add_bank_account / update_bank_account / remove_bank_account / set_default_bank_account / list_bank_accounts (a business can have multiple bank accounts; one is marked default for new invoices). `contact_name` is the person at the business who handles invoicing — used in PDF letterhead / email footer.\n\n**LOGO UPLOAD — two paths:**\n1. Public URL (fastest): `logo: { image_url: 'https://…' }` — server fetches the image and stores it. Use this when the logo is already online.\n2. Local file (correct path for files on disk): call `request_attachment_upload({filename: 'logo.png', mime_type: 'image/png'})` first to get a presigned PUT URL, curl the file bytes to that URL, then pass the returned public blob URL here as `logo: { image_url: '<blob-url>' }`. DO NOT base64-encode a local file — it bloats the MCP payload and is slow for anything over 100 KB. The `image_base64` path is only for small in-memory images (e.g. programmatically generated PNGs under 100 KB).\n\n**WALLETS — three chain-specific fields. ALL crypto goes here, never in bank accounts.**\n  - `evm_wallet_address`: raw 0x + 40 hex (e.g. 0xabc…) or an ENS name like `name.eth`. Used by EVM USDC payers (Base, Ethereum, Arbitrum, Optimism, Polygon, etc.). The Pay-with-USDC button on the share page reads THIS field specifically and only fires on raw 0x.\n  - `starknet_wallet_address`: raw 0x + up to 64 hex, or a Starknet Domains name like `name.stark`. Used by Starknet USDC payers. Rendered on the invoice; no client-side pay button yet.\n  - `aptos_wallet_address`: raw 0x + up to 64 hex, or an Aptos Names handle like `name.apt`. Used by Aptos USDC payers. Rendered on the invoice; no client-side pay button yet.\n\nWhen the user says 'add my wallet' / 'set my USDC address' / 'I want to receive crypto' / pastes a 0x address: ASK which chain (EVM / Starknet / Aptos) unless the format makes it obvious. A 40-hex 0x address is unambiguously EVM. A longer 0x string could be either Starknet or Aptos — ASK. The user can set as many as they want; the invoice surfaces every configured chain. DO NOT call add_bank_account with a wallet — that tool rejects EVM-shaped input and points back here. **EVM CHAINS — the same evm_wallet_address receives USDC on every chain (Base and Arbitrum are both EVM), so one wallet covers all of them.** `accepted_chain_ids` is the SET of EVM chains the payer may choose from on the share page — e.g. `[8453, 42161]` to accept on both Base and Arbitrum, `[42161]` for Arbitrum only. `payment_chain_id` is the single PREFERRED chain, pre-selected for the payer and used as the fallback when accepted_chain_ids is unset. Supported ids: 8453 Base mainnet, 42161 Arbitrum One, 84532 Base Sepolia. Pass null on either to reset to the platform default. When the user says 'accept payments on Base and Arbitrum' set `accepted_chain_ids: [8453, 42161]`. Pass `business_id` if the user owns multiple businesses.",
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
      if (input.evm_wallet_address !== undefined) patch.evmWalletAddress = input.evm_wallet_address ?? null;
      if (input.starknet_wallet_address !== undefined) patch.starknetWalletAddress = input.starknet_wallet_address ?? null;
      if (input.aptos_wallet_address !== undefined) patch.aptosWalletAddress = input.aptos_wallet_address ?? null;
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
      if (input.accepted_chain_ids !== undefined) patch.acceptedChainIds = input.accepted_chain_ids ?? null;

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

  const setDefaultInput = {
    business_id: uuid,
  };

  server.registerTool(
    "set_default_business",
    {
      title: "Set default business",
      description:
        "Make a business the user's default. The default is what tools fall back to when `business_id` is omitted on a multi-business account, and what new invoices render under unless the user says otherwise. Use when the user says 'make X my main/primary/default business'. `business_id` is required — resolve it via whoami first. (To set a default at creation time, create_business already accepts `set_as_default`.)",
      inputSchema: setDefaultInput,
    },
    async (args, extra) => {
      const parsed = z.object(setDefaultInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;
      await setDefaultBusiness(scope.scoped);
      const profile = await getBusinessProfile(scope.scoped);
      return toolOk({
        default_business_id: scope.scoped.businessId,
        name: profile?.name ?? null,
      });
    },
  );

  const deleteInput = {
    business_id: uuid.optional(),
    confirm_business_name: z.string().min(1).max(200),
  };

  server.registerTool(
    "delete_business",
    {
      title: "Delete business (permanent)",
      description:
        "**HARD-DELETE** a business and everything under it: ALL its invoices (with line items, payment records, event history), recurring invoice templates, bank accounts, and the business profile itself. THIS IS PERMANENT and unrecoverable — share links for every invoice under this business will 404 for recipients. Clients and products are account-level and are NOT touched.\n\nMandatory pre-call confirmation. Tell the user exactly what goes: 'Deleting <name> permanently removes the business AND its N invoices, recurring templates, and bank accounts. Recipients lose access to every share link. This cannot be undone. To confirm, please say the business name.' Get an explicit yes AND the name before calling. `confirm_business_name` must match the business's current name (case-insensitive) — the call is refused with `confirmation_mismatch` otherwise.\n\nIf the user only wants to stop using a business while keeping its invoice history, suggest leaving it in place (businesses cost nothing) or moving invoices first. If they're deleting their ONLY business, warn that the account needs a new create_business before invoicing again.\n\nReturns counts of what was deleted plus `new_default_business_id` (the default is repointed to the oldest remaining business when the deleted one was the default).",
      inputSchema: deleteInput,
    },
    async (args, extra) => {
      const parsed = z.object(deleteInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;
      const r = await deleteBusiness(scope.scoped, {
        confirmName: parsed.data.confirm_business_name,
      });
      if (!r.ok) return toolError(r.code, r.message, { hint: r.hint });
      return toolOk(r.value);
    },
  );
}
