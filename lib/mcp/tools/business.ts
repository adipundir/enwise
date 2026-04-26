import { z } from "zod";
import {
  createBusiness,
  formatBusinessForMcp,
  getBusinessProfile,
  updateBusinessProfile,
  type BusinessPatch,
} from "@/lib/businesses";
import { ctxFromAuthInfo, scopeFromCtx } from "@/lib/mcp/context";
import { toolError, toolOk, zodToToolError } from "@/lib/mcp/errors";
import { uploadLogo } from "@/lib/storage/blob";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
  default_currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "3-letter ISO 4217 code like 'USD' or 'EUR'")
    .transform((s) => s.toUpperCase())
    .optional(),
  invoice_number_prefix: z.string().min(1).max(12).optional(),
  invoice_number_next: z.number().int().min(1).max(9_999_999).optional(),
  brand_color: z.string().max(32).nullish(),
  email_reply_to: z.string().email().nullish(),
  default_payment_terms_days: z.number().int().min(0).max(365).optional(),
  default_notes: z.string().max(2000).nullish(),
  logo: logoInput.optional(),
  client_request_id: z.string().max(64).optional(),
};

const createBusinessInput = {
  name: z.string().min(1).max(200),
  default_currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "3-letter ISO 4217 code like 'USD' or 'EUR'")
    .transform((s) => s.toUpperCase())
    .optional(),
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
        "Create a new business profile under the authenticated user. Use when the user says they want to bill from a new entity (different company, side project, freelance pseudonym, etc.). Ask for the name first; everything else (address, tax ID, etc.) can be added later via update_business_profile. Pass `set_as_default: true` if the user says this should be their primary.\n\nFREE PLAN LIMIT: free accounts get one business. Calling this on a free account that already has a business returns `business_limit_reached`. surface the message verbatim and link the user to https://enwise.app/dashboard to upgrade. Don't retry until they confirm they upgraded.",
      inputSchema: createBusinessInput,
    },
    async (args, extra) => {
      const parsed = z.object(createBusinessInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const input = parsed.data;
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const result = await createBusiness({
        userId: ctx.userId,
        name: input.name,
        defaultCurrency: input.default_currency,
        setAsDefault: input.set_as_default ?? false,
      });
      if (!result.ok) {
        return toolError(result.code, result.message, { hint: result.hint });
      }
      return toolOk(formatBusinessForMcp(result.business));
    },
  );

  server.registerTool(
    "get_business_profile",
    {
      title: "Get business profile",
      description:
        "Return the full profile for a business. If the user owns only one business, `business_id` can be omitted. If they own multiple, pass `business_id`.",
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
        "Update any subset of a business profile (name, tax ID, address, default currency, invoice number prefix, logo, etc.). Omitted fields are left unchanged. Pass null to clear a nullable field. Logo can be passed as either `{ image_url: 'https://…' }` or `{ image_base64: '…', mime_type: 'image/png' }`. Pass `business_id` if the user owns multiple businesses.",
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
      if (input.address_line1 !== undefined) patch.addressLine1 = input.address_line1 ?? null;
      if (input.address_line2 !== undefined) patch.addressLine2 = input.address_line2 ?? null;
      if (input.city !== undefined) patch.city = input.city ?? null;
      if (input.region !== undefined) patch.region = input.region ?? null;
      if (input.postal_code !== undefined) patch.postalCode = input.postal_code ?? null;
      if (input.country !== undefined) patch.country = input.country;
      if (input.default_currency !== undefined) patch.defaultCurrency = input.default_currency;
      if (input.invoice_number_prefix !== undefined) patch.invoiceNumberPrefix = input.invoice_number_prefix;
      if (input.invoice_number_next !== undefined) patch.invoiceNumberNext = input.invoice_number_next;
      if (input.brand_color !== undefined) patch.brandColor = input.brand_color ?? null;
      if (input.email_reply_to !== undefined) patch.emailReplyTo = input.email_reply_to ?? null;
      if (input.default_payment_terms_days !== undefined)
        patch.defaultPaymentTermsDays = input.default_payment_terms_days;
      if (input.default_notes !== undefined) patch.defaultNotes = input.default_notes ?? null;

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

      const updated = await updateBusinessProfile(scope.scoped, patch);
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
