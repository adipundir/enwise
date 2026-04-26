"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { apiTokens } from "@/lib/db/schema";
import { createToken } from "@/lib/tokens";

type BusinessUser = { id: string; defaultBusinessId?: string | null };

async function requireContext() {
  const session = await auth();
  const user = session?.user as BusinessUser | undefined;
  if (!user?.id || !user.defaultBusinessId) {
    throw new Error("Not signed in");
  }
  return { userId: user.id, businessId: user.defaultBusinessId };
}

export type RotateResult = {
  ok: true;
  rawToken: string;
};

/**
 * Rotate: revoke every active token on the user's business and mint exactly
 * one new one. Returns the raw token once; it is never persisted in
 * plaintext.
 */
export async function rotateKeyAction(): Promise<RotateResult> {
  const { userId, businessId } = await requireContext();

  // Revoke all active tokens on this business.
  await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.businessId, businessId), isNull(apiTokens.revokedAt)));

  const { raw } = await createToken({
    businessId,
    createdByUserId: userId,
    name: "Default",
  });

  revalidatePath("/dashboard");
  return { ok: true, rawToken: raw };
}
