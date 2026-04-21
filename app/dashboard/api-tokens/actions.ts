"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { createToken, listTokens, revokeToken } from "@/lib/tokens";

type BusinessUser = { id: string; defaultBusinessId?: string | null };

async function requireContext() {
  const session = await auth();
  const user = session?.user as BusinessUser | undefined;
  if (!user?.id || !user.defaultBusinessId) {
    throw new Error("Not signed in");
  }
  return { userId: user.id, businessId: user.defaultBusinessId };
}

export type CreateTokenState = {
  ok: boolean;
  rawToken?: string;
  tokenName?: string;
  error?: string;
};

/** One-click: no name required. Assigns a sensible default. */
export async function createTokenAction(): Promise<CreateTokenState> {
  const { userId, businessId } = await requireContext();
  const existing = await listTokens(businessId);
  const activeCount = existing.filter((t) => !t.revokedAt).length;
  const name =
    activeCount === 0 ? "Default" : `Token ${existing.length + 1}`;

  const { raw } = await createToken({
    businessId,
    createdByUserId: userId,
    name,
  });

  revalidatePath("/dashboard/api-tokens");
  revalidatePath("/dashboard");
  return { ok: true, rawToken: raw, tokenName: name };
}

export async function revokeTokenAction(formData: FormData): Promise<void> {
  const tokenId = String(formData.get("tokenId") ?? "");
  if (!tokenId) return;
  const { businessId } = await requireContext();
  await revokeToken({ businessId, tokenId });
  revalidatePath("/dashboard/api-tokens");
  revalidatePath("/dashboard");
}
