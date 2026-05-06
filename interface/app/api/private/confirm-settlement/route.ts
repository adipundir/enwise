/**
 * POST /api/private/confirm-settlement
 *
 * Endpoint hit by `app/sign-settlement/page.tsx` (the web-bounce signing UI).
 * Verifies a signed canonical message, then writes
 * `businesses.private_settlement_wallet`.
 *
 * NOT authenticated by API token — the cryptographic proof IS the auth.
 * The signed message contains `business_id`; the user must sign with the
 * candidate wallet, and the server verifies recovery + that the message
 * isn't a replay of an older binding.
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses } from "@/lib/db/schema";
import { verifySettlement } from "@/lib/private/wallet-proof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  message?: unknown;
  signature?: unknown;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body.message !== "string" || typeof body.signature !== "string") {
    return NextResponse.json({ error: "missing message or signature" }, { status: 400 });
  }
  if (!/^0x[a-fA-F0-9]+$/.test(body.signature)) {
    return NextResponse.json({ error: "invalid signature hex" }, { status: 400 });
  }

  const result = await verifySettlement(body.message, body.signature as `0x${string}`);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: 400 });
  }
  const { challenge } = result;

  const [biz] = await db
    .select({ id: businesses.id, enabledAt: businesses.privateEnabledAt })
    .from(businesses)
    .where(eq(businesses.id, challenge.businessId));
  if (!biz) {
    return NextResponse.json({ error: "business not found" }, { status: 404 });
  }
  if (biz.enabledAt && challenge.issuedAt < biz.enabledAt) {
    return NextResponse.json(
      { error: "proof issued before current setting; request a fresh proof", code: "stale_proof" },
      { status: 409 },
    );
  }

  const now = new Date();
  await db
    .update(businesses)
    .set({
      privateSettlementWallet: challenge.candidate,
      privateEnabledAt: now,
    })
    .where(eq(businesses.id, challenge.businessId));

  return NextResponse.json({
    settlement_wallet: challenge.candidate,
    business_id: challenge.businessId,
    enabled_at: now.toISOString(),
    verified: true,
  });
}
