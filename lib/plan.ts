import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export type Plan = "free" | "pro";

// ---------- Free-tier limits ----------

/** One business per Free account. */
export const FREE_BUSINESS_LIMIT = 1;

/** Free is capped at this many *created* invoices per rolling 30-day window. */
export const FREE_MONTHLY_INVOICE_LIMIT = 10;

/** Per line item attachment caps. */
export const FREE_ATTACHMENTS_PER_LINE_ITEM = 2;
export const PRO_ATTACHMENTS_PER_LINE_ITEM = 10;

/** Per attachment byte caps. */
export const FREE_ATTACHMENT_BYTES = 2 * 1024 * 1024; // 2 MB
export const PRO_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MB

// ---------- Lookups ----------

export async function getUserPlan(userId: string): Promise<Plan> {
  const [row] = await db
    .select({ plan: users.plan })
    .from(users)
    .where(eq(users.id, userId));
  return (row?.plan as Plan | undefined) ?? "free";
}

export function attachmentByteCap(plan: Plan): number {
  return plan === "pro" ? PRO_ATTACHMENT_BYTES : FREE_ATTACHMENT_BYTES;
}

export function attachmentCountCap(plan: Plan): number {
  return plan === "pro"
    ? PRO_ATTACHMENTS_PER_LINE_ITEM
    : FREE_ATTACHMENTS_PER_LINE_ITEM;
}
