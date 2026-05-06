/**
 * POST /api/invoices/:slug/pay
 *
 * The payer's frontend submits their Permit2-with-witness signature here.
 * We sign the on-chain `payInvoice` tx as the relayer EOA and broadcast.
 *
 * The encrypted recipient ct was bound to the relayer at invoice creation,
 * so only this code path can successfully materialise the on-chain handle.
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { keccak256, encodePacked } from "viem";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { getZap, getEnwisePayAddress } from "@/lib/private/client";
import { getRelayerWallet, getPublicClient } from "@/lib/private/relayer";
import enwisePayArtifact from "@/lib/abi/EnwisePay.json";

const enwisePayAbi = enwisePayArtifact.abi;

type PayBody = {
  payer: `0x${string}`;
  signature: `0x${string}`;
  permit: {
    permitted: { token: `0x${string}`; amount: string };
    nonce: string;
    deadline: string;
  };
};

function isHexAddress(s: unknown): s is `0x${string}` {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

function isHexBytes(s: unknown): s is `0x${string}` {
  return typeof s === "string" && /^0x[a-fA-F0-9]+$/.test(s);
}

function isBigintStr(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try {
    BigInt(s);
    return true;
  } catch {
    return false;
  }
}

function validate(body: unknown): { ok: true; body: PayBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = body as Partial<PayBody>;
  if (!isHexAddress(b.payer)) return { ok: false, error: "invalid payer" };
  if (!isHexBytes(b.signature)) return { ok: false, error: "invalid signature" };
  if (!b.permit || typeof b.permit !== "object") return { ok: false, error: "missing permit" };
  const p = b.permit;
  if (!p.permitted || typeof p.permitted !== "object") return { ok: false, error: "missing permit.permitted" };
  if (!isHexAddress(p.permitted.token)) return { ok: false, error: "invalid permit.permitted.token" };
  if (!isBigintStr(p.permitted.amount)) return { ok: false, error: "invalid permit.permitted.amount" };
  if (!isBigintStr(p.nonce)) return { ok: false, error: "invalid permit.nonce" };
  if (!isBigintStr(p.deadline)) return { ok: false, error: "invalid permit.deadline" };
  return { ok: true, body: b as PayBody };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const validated = validate(await req.json().catch(() => null));
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const { body } = validated;

  // Look up the invoice. Must be private-payments-enabled, unpaid, and have a recipient ct.
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.shareSlug, slug))
    .limit(1);

  if (!invoice) {
    return NextResponse.json({ error: "invoice not found" }, { status: 404 });
  }
  if (!invoice.privateEnabled || !invoice.privateRecipientCt) {
    return NextResponse.json({ error: "private payments not enabled on this invoice" }, { status: 409 });
  }
  if (invoice.status === "paid") {
    return NextResponse.json({ error: "already paid" }, { status: 409 });
  }
  if (invoice.status === "void") {
    return NextResponse.json({ error: "invoice is void" }, { status: 409 });
  }

  const slugBytes32 = keccak256(encodePacked(["string"], [slug]));
  const enwisePay = getEnwisePayAddress();
  const relayer = getRelayerWallet();
  if (!relayer.account) {
    return NextResponse.json({ error: "relayer wallet not configured" }, { status: 500 });
  }
  const publicClient = getPublicClient();

  // Pay the private payments fee (newEaddress forwards inco.getFee() out of msg.value).
  const zap = await getZap();
  let fee: bigint;
  try {
    fee = await publicClient.readContract({
      address: zap.executorAddress as `0x${string}`,
      abi: [{
        inputs: [],
        name: "getFee",
        outputs: [{ type: "uint256" }],
        stateMutability: "view",
        type: "function",
      }] as const,
      functionName: "getFee",
    });
  } catch (e) {
    console.error("[private-payments] failed to read fee from executor:", e);
    return NextResponse.json({ error: "failed to read private payments fee" }, { status: 502 });
  }

  let txHash: `0x${string}`;
  try {
    txHash = await relayer.writeContract({
      account: relayer.account,
      chain: relayer.chain,
      address: enwisePay,
      abi: enwisePayAbi,
      functionName: "payInvoice",
      args: [
        slugBytes32,
        invoice.privateRecipientCt as `0x${string}`,
        body.payer,
        {
          permitted: {
            token: body.permit.permitted.token,
            amount: BigInt(body.permit.permitted.amount),
          },
          nonce: BigInt(body.permit.nonce),
          deadline: BigInt(body.permit.deadline),
        },
        body.signature,
      ],
      value: fee,
    });
  } catch (e) {
    console.error("[private-payments] payInvoice tx failed:", e);
    return NextResponse.json({ error: "tx broadcast failed" }, { status: 502 });
  }

  // Record the shield tx hash; the indexer will fill in noteId from the event.
  await db
    .update(invoices)
    .set({ privateShieldTxHash: txHash, updatedAt: new Date() })
    .where(eq(invoices.id, invoice.id));

  return NextResponse.json({ txHash });
}
