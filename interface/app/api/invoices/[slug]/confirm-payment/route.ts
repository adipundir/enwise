/**
 * POST /api/invoices/:slug/confirm-payment
 *
 * Called by the share page after the payer signs a USDC.transfer to the
 * merchant's wallet via their connected wallet. We verify on-chain that the
 * transaction happened on the merchant's preferred chain (or the platform
 * default), targets USDC, hits the merchant's wallet, and clears the
 * outstanding balance. Only then do we mark the invoice paid.
 *
 * The chain is the source of truth — we never trust the client's claim that
 * "this tx is mine," we verify directly via the chain's RPC. Idempotent on
 * (chainId, txHash) so the page can safely retry / users can refresh.
 */

import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
} from "viem";
import { db } from "@/lib/db";
import { businesses, invoices } from "@/lib/db/schema";
import { recordOnchainPayment } from "@/lib/invoices";
import { addAmounts } from "@/lib/money";
import { sendPaymentReceivedEmails } from "@/lib/email/sendPaymentReceived";
import { resolveChain, transportFor } from "@/lib/web3/chain";

const REQUIRED_CONFIRMATIONS = 1n;

export const runtime = "nodejs";

type Body = { txHash?: unknown };

function isHexAddress(s: unknown): s is `0x${string}` {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

function isTxHash(s: unknown): s is `0x${string}` {
  return typeof s === "string" && /^0x[a-fA-F0-9]{64}$/.test(s);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    return await handle(req, await params);
  } catch (e) {
    console.error("[confirm-payment] unhandled:", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

async function handle(
  req: NextRequest,
  { slug }: { slug: string },
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || !isTxHash(body.txHash)) {
    return NextResponse.json({ error: "invalid txHash" }, { status: 400 });
  }
  const txHash = body.txHash;

  const [invoice] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.shareSlug, slug));
  if (!invoice) {
    return NextResponse.json({ error: "invoice not found" }, { status: 404 });
  }
  if (invoice.status === "paid") {
    return NextResponse.json({ ok: true, alreadyPaid: true });
  }
  if (invoice.status === "void") {
    return NextResponse.json({ error: "invoice is void" }, { status: 409 });
  }
  if (invoice.currency.toUpperCase() !== "USD") {
    return NextResponse.json({ error: "invoice currency is not USD" }, { status: 409 });
  }

  // Merchant wallet + preferred chain. Wallet falls back to live business
  // if no snapshot. Chain is always live — merchants who switch chains
  // expect outstanding invoices to be payable on the new chain immediately.
  let merchantWallet: `0x${string}` | null = null;
  if (isHexAddress(invoice.businessWalletAddressSnapshot)) {
    merchantWallet = invoice.businessWalletAddressSnapshot.toLowerCase() as `0x${string}`;
  }
  const [biz] = await db
    .select({
      wallet: businesses.walletAddress,
      paymentChainId: businesses.paymentChainId,
    })
    .from(businesses)
    .where(eq(businesses.id, invoice.businessId));
  if (!merchantWallet && isHexAddress(biz?.wallet)) {
    merchantWallet = biz!.wallet!.toLowerCase() as `0x${string}`;
  }
  if (!merchantWallet) {
    return NextResponse.json(
      { error: "merchant wallet not configured on this invoice" },
      { status: 409 },
    );
  }

  const resolved = resolveChain(biz?.paymentChainId ?? null);
  const publicClient = createPublicClient({
    chain: resolved.chain,
    transport: transportFor(resolved),
  });

  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: Number(REQUIRED_CONFIRMATIONS),
      timeout: 60_000,
    });
  } catch (e) {
    console.error("[confirm-payment] waitForTransactionReceipt failed:", e);
    return NextResponse.json(
      { error: "transaction not found or timed out" },
      { status: 502 },
    );
  }

  if (receipt.status !== "success") {
    return NextResponse.json({ error: "transaction reverted on-chain" }, { status: 409 });
  }

  // Parse the receipt for a USDC Transfer to the merchant on the expected
  // chain. We accept the tx if any log is (a) emitted by the chain's USDC
  // contract and (b) a Transfer with to=merchantWallet.
  let transferredAmount = 0n;
  let fromAddress: `0x${string}` | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== resolved.usdcAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "Transfer") continue;
      const { to, from, value } = decoded.args as {
        from: `0x${string}`;
        to: `0x${string}`;
        value: bigint;
      };
      if (to.toLowerCase() === merchantWallet.toLowerCase()) {
        transferredAmount += value;
        if (!fromAddress) fromAddress = from;
      }
    } catch {
      // Non-Transfer log on the USDC contract — ignore.
    }
  }

  if (transferredAmount === 0n) {
    return NextResponse.json(
      { error: "transaction does not transfer USDC to the merchant wallet" },
      { status: 409 },
    );
  }

  const outstandingDecimal = addAmounts(invoice.total, `-${invoice.amountPaid}`);
  const outstandingUnits = decimalToUsdcUnits(outstandingDecimal, resolved.usdcDecimals);
  if (transferredAmount < outstandingUnits) {
    return NextResponse.json(
      {
        error: "transferred amount is less than outstanding",
        outstanding_units: outstandingUnits.toString(),
        transferred_units: transferredAmount.toString(),
      },
      { status: 409 },
    );
  }

  // Cap at outstanding so a tx with multiple Transfer logs (e.g. a DEX
  // route that happens to land in the merchant wallet) or an honest
  // over-payment can't inflate amount_paid past invoice.total. The merchant
  // still receives any excess on-chain; the books just reflect the invoice.
  const creditedUnits =
    transferredAmount > outstandingUnits ? outstandingUnits : transferredAmount;
  const amountDecimal = usdcUnitsToDecimal(creditedUnits, resolved.usdcDecimals);

  const result = await recordOnchainPayment({
    invoiceId: invoice.id,
    chainId: resolved.chainId,
    txHash,
    paymentMethod: "direct_transfer",
    // On-chain Transfer.from is the canonical payer. Don't accept a payer
    // field from the request body — that was advisory and would let a
    // client put a fake address into emails / receipts.
    payerAddress: fromAddress,
    amount: amountDecimal,
    currency: "USD",
    paidAt: new Date(),
  });

  if (!result.alreadyRecorded) {
    after(async () => {
      try {
        await sendPaymentReceivedEmails({
          invoiceId: invoice.id,
          amount: amountDecimal,
          currency: "USD",
          txHash,
          chainId: resolved.chainId,
        });
      } catch (err) {
        console.error("[confirm-payment] email send threw:", err);
      }
    });
  }

  return NextResponse.json({
    ok: true,
    alreadyRecorded: result.alreadyRecorded,
    invoiceStatus: result.invoiceStatus,
  });
}

function decimalToUsdcUnits(decimal: string, decimals: number): bigint {
  const negative = decimal.startsWith("-");
  const body = negative ? decimal.slice(1) : decimal;
  const [intPart, decPart = ""] = body.split(".");
  const padded = decPart.padEnd(decimals, "0").slice(0, decimals);
  const units = BigInt(intPart || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
  return negative ? -units : units;
}

function usdcUnitsToDecimal(units: bigint, decimals: number): string {
  // raw → 2-decimal string (truncate, don't round — we err in the merchant's
  // favor by only crediting full cents).
  const divisor = 10n ** BigInt(decimals);
  const whole = units / divisor;
  const fractional = units % divisor;
  const centsDivisor = divisor / 100n;
  const cents = fractional / centsDivisor;
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}
