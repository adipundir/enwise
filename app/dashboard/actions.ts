"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { apiTokens, businesses, users } from "@/lib/db/schema";
import { createToken } from "@/lib/tokens";
import { createBusiness } from "@/lib/businesses";

type SessionUser = { id: string; defaultBusinessId?: string | null };

async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  const user = session?.user as SessionUser | undefined;
  if (!user?.id) {
    throw new Error("Not signed in");
  }
  return user;
}

export type RotateResult = {
  ok: true;
  rawToken: string;
};

/**
 * Rotate: revoke every active token for the authenticated user and mint one
 * new one. The token is user-scoped (grants access to every business the
 * user owns), so we revoke by user, not by business. Returns the raw token
 * once; it is never persisted in plaintext.
 */
export async function rotateKeyAction(): Promise<RotateResult> {
  const user = await requireUser();

  await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiTokens.createdByUserId, user.id),
        isNull(apiTokens.revokedAt),
      ),
    );

  // Use the user's default business if they have one — the legacy
  // api_tokens.businessId column stays populated for back-compat but has
  // no semantic weight anymore.
  const { raw } = await createToken({
    businessId: user.defaultBusinessId ?? "",
    createdByUserId: user.id,
    name: "Default",
  });

  revalidatePath("/dashboard");
  return { ok: true, rawToken: raw };
}

export type CreateBusinessResult =
  | { ok: true; businessId: string }
  | { ok: false; error: string };

/**
 * Create a new business under the authenticated user. If the user has no
 * default business yet (edge case — signup flow already mints one), the
 * new one is set as default.
 */
export async function createBusinessAction(formData: FormData): Promise<CreateBusinessResult> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { ok: false, error: "Name is required." };
  }
  if (name.length > 200) {
    return { ok: false, error: "Name is too long (max 200 chars)." };
  }

  const shouldBeDefault = !user.defaultBusinessId;
  const created = await createBusiness({
    userId: user.id,
    name,
    setAsDefault: shouldBeDefault,
  });

  revalidatePath("/dashboard");
  return { ok: true, businessId: created.id };
}

export type SetDefaultBusinessResult =
  | { ok: true }
  | { ok: false; error: string };

export async function setDefaultBusinessAction(
  businessId: string,
): Promise<SetDefaultBusinessResult> {
  const user = await requireUser();
  // Verify ownership before flipping the pointer.
  const [owned] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(
      and(
        eq(businesses.id, businessId),
        eq(businesses.ownerUserId, user.id),
      ),
    );
  if (!owned) {
    return { ok: false, error: "Business not found." };
  }

  await db
    .update(users)
    .set({ defaultBusinessId: businessId })
    .where(eq(users.id, user.id));

  revalidatePath("/dashboard");
  return { ok: true };
}
