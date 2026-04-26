import { count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses, users, type Business } from "@/lib/db/schema";
import type { ScopedCtx } from "@/lib/mcp/context";
import { uniqueSlug } from "@/lib/slug";

const FREE_BUSINESS_LIMIT = 1;

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
  ctx: ScopedCtx,
): Promise<Business | null> {
  const [row] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId));
  return row ?? null;
}

export async function updateBusinessProfile(
  ctx: ScopedCtx,
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

export type CreateBusinessResult =
  | { ok: true; business: Business }
  | {
      ok: false;
      code: "business_limit_reached";
      message: string;
      hint: string;
    };

/**
 * Create a new business under `userId`. A user can own many businesses;
 * the plan (Free / Pro) is account-level, not per-business. Free is
 * capped at one business — every additional business requires Pro.
 *
 * The very first business at signup is created via this function before
 * the user has any plan friction, but the auth.ts createUser hook calls
 * `db.insert(businesses)` directly (not this function), so the cap only
 * fires when a *signed-in* user tries to add a second business.
 */
export async function createBusiness(params: {
  userId: string;
  name: string;
  defaultCurrency?: string;
  setAsDefault?: boolean;
}): Promise<CreateBusinessResult> {
  // Plan + count gate — Free users can have one business max.
  const [user] = await db
    .select({ plan: users.plan })
    .from(users)
    .where(eq(users.id, params.userId));
  if (user?.plan === "free") {
    const [{ value: existingCount }] = await db
      .select({ value: count() })
      .from(businesses)
      .where(eq(businesses.ownerUserId, params.userId));
    if (Number(existingCount) >= FREE_BUSINESS_LIMIT) {
      return {
        ok: false,
        code: "business_limit_reached",
        message: `Free accounts are limited to ${FREE_BUSINESS_LIMIT} business. Upgrade to Pro to add more.`,
        hint: "Tell the user this is a Pro-only feature and link them to https://enwise.app/dashboard to upgrade. Don't try again until they confirm they've upgraded.",
      };
    }
  }

  const [created] = await db
    .insert(businesses)
    .values({
      ownerUserId: params.userId,
      name: params.name,
      slug: uniqueSlug(params.name),
      defaultCurrency: params.defaultCurrency ?? "USD",
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
  return { ok: true, business: created };
}
