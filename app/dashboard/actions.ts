"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { apiTokens } from "@/lib/db/schema";
import { createToken } from "@/lib/tokens";

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
