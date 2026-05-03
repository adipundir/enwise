import "server-only";
import { eq } from "drizzle-orm";
import { Interface, JsonRpcProvider, type Log } from "ethers";
import { RailgunEngine, ShieldNote } from "@railgun-community/engine";
import { db } from "@/lib/db";
import { businesses, invoices } from "@/lib/db/schema";
import {
  recordOnchainPayment,
  type RecordOnchainPaymentResult,
} from "@/lib/invoices";
import { activeRailgunNetwork, rpcUrlsFor } from "./config";

/**
 * Minimal fallback wrapper for the two read-only RPC calls verify needs.
 * Tries each provider in order; on error or null receipt, advances. We don't
 * use ethers' FallbackProvider here because its consensus quorum semantics
 * are designed for parallel reads, and we want strict primary-then-secondary
 * for cost (Alchemy first; only hit the public RPC if Alchemy actually fails).
 */
class FallbackRpc {
  private providers: JsonRpcProvider[];
  constructor(urls: string[]) {
    this.providers = urls.map((u) => new JsonRpcProvider(u));
  }
  async getTransactionReceipt(txHash: string) {
    return this.tryEach((p) => p.getTransactionReceipt(txHash));
  }
  async getBlock(blockNumber: number) {
    return this.tryEach((p) => p.getBlock(blockNumber));
  }
  private async tryEach<T>(
    fn: (p: JsonRpcProvider) => Promise<T>,
  ): Promise<T> {
    let lastErr: unknown;
    for (const p of this.providers) {
      try {
        return await fn(p);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
}

/**
 * Stateless verification of a RAILGUN Shield transaction.
 *
 * The PayButton constructed the Shield client-side with the recipient's 0zk
 * address and a fresh `random` nonce. It hands us back the txHash + that
 * random. We verify by recomputing the note public key and matching against
 * the on-chain Shield event's commitment — no engine, no merkletree, no
 * decryption keys required server-side.
 *
 * Out-of-band shields (someone bypassing our UI) won't have a `random` to
 * submit and so can't be recorded through this path. That's deferred to a
 * future async scanner using ECDH + decryptRandom.
 */

const USDC_DECIMALS = 6;

// V2.1 Shield event. RAILGUN's contract emits this with the commitment
// preimage (npk, tokenData, value) un-hashed, plus the per-commitment
// shield fee separately so callers can reconstruct the gross amount.
const SHIELD_EVENT_FRAGMENT =
  "event Shield(uint256 treeNumber,uint256 startPosition," +
  "(bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value)[] commitments," +
  "(bytes32[3] encryptedBundle,bytes32 shieldKey)[] shieldCiphertext," +
  "uint256[] fees)";

const shieldIface = new Interface([SHIELD_EVENT_FRAGMENT]);
const SHIELD_TOPIC =
  shieldIface.getEvent("Shield")!.topicHash.toLowerCase();

export type VerifyRailgunPaymentInput = {
  slug: string;
  txHash: string;
  /**
   * The 16-byte random nonce the PayButton used when constructing the Shield
   * note. Hex string, with or without 0x prefix. This is the witness that
   * lets us match an on-chain commitment to this specific invoice without
   * needing a viewing key on the server.
   */
  shieldRandom: string;
};

export type VerifyRailgunPaymentResult =
  | {
      ok: true;
      alreadyRecorded: boolean;
      paymentId: string;
      invoiceStatus: "sent" | "paid";
      txHash: string;
    }
  | {
      ok: false;
      code:
        | "invoice_not_found"
        | "invoice_not_payable"
        | "currency_unsupported"
        | "business_no_railgun"
        | "tx_not_mined"
        | "tx_failed"
        | "tx_no_event"
        | "tx_mismatch"
        | "tx_amount_mismatch";
      message: string;
    };

export async function verifyAndRecordRailgunPayment(
  input: VerifyRailgunPaymentInput,
): Promise<VerifyRailgunPaymentResult> {
  const t0 = Date.now();
  const txHash = normalizeHex(input.txHash);
  console.log(`[railgun] verify_start slug=${input.slug} tx=${txHash}`);

  const [inv] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.shareSlug, input.slug));
  if (!inv) {
    console.warn(`[railgun] verify_invoice_not_found slug=${input.slug}`);
    return {
      ok: false,
      code: "invoice_not_found",
      message: `No invoice for slug ${input.slug}.`,
    };
  }
  if (inv.status === "draft" || inv.status === "void" || inv.status === "paid") {
    console.warn(
      `[railgun] verify_not_payable inv=${inv.invoiceNumber} status=${inv.status}`,
    );
    return {
      ok: false,
      code: "invoice_not_payable",
      message: `Invoice ${inv.invoiceNumber} is ${inv.status}; not accepting payments.`,
    };
  }
  if ((inv.currency ?? "").toUpperCase() !== "USD") {
    return {
      ok: false,
      code: "currency_unsupported",
      message: `Invoice currency ${inv.currency} is not supported. Only USD invoices accept USDC payments today.`,
    };
  }

  const [biz] = await db
    .select({ railgunZkAddress: businesses.railgunZkAddress })
    .from(businesses)
    .where(eq(businesses.id, inv.businessId));
  if (!biz?.railgunZkAddress) {
    return {
      ok: false,
      code: "business_no_railgun",
      message: "This business hasn't enabled private payments.",
    };
  }

  // Decode 0zk → masterPublicKey, then recompute the expected note public key
  // for the random the browser submitted.
  const { masterPublicKey } = RailgunEngine.decodeAddress(biz.railgunZkAddress);
  const random = stripHex(input.shieldRandom);
  const expectedNpk = ShieldNote.getNotePublicKey(masterPublicKey, random);

  const cfg = activeRailgunNetwork();
  const provider = new FallbackRpc(rpcUrlsFor(cfg));
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    console.log(`[railgun] verify_tx_not_mined tx=${txHash}`);
    return {
      ok: false,
      code: "tx_not_mined",
      message: "Transaction not yet mined; try again in a few seconds.",
    };
  }
  if (receipt.status !== 1) {
    console.warn(`[railgun] verify_tx_reverted tx=${txHash}`);
    return {
      ok: false,
      code: "tx_failed",
      message: "Transaction reverted on-chain.",
    };
  }

  const proxyLower = cfg.railgunProxy.toLowerCase();
  const shieldLogs = receipt.logs.filter(
    (l: Log) =>
      l.address.toLowerCase() === proxyLower &&
      l.topics[0]?.toLowerCase() === SHIELD_TOPIC,
  );
  if (shieldLogs.length === 0) {
    return {
      ok: false,
      code: "tx_no_event",
      message: "No RAILGUN Shield event in this transaction.",
    };
  }

  let matched: { value: bigint; fee: bigint; tokenAddress: string } | null = null;
  for (const log of shieldLogs) {
    const decoded = shieldIface.decodeEventLog("Shield", log.data, log.topics);
    const commitments = decoded.commitments as ReadonlyArray<{
      npk: string;
      token: { tokenAddress: string };
      value: bigint;
    }>;
    const fees = decoded.fees as ReadonlyArray<bigint>;
    for (let i = 0; i < commitments.length; i++) {
      const c = commitments[i]!;
      if (BigInt(c.npk) === expectedNpk) {
        matched = {
          value: BigInt(c.value),
          fee: BigInt(fees[i] ?? 0n),
          tokenAddress: c.token.tokenAddress.toLowerCase(),
        };
        break;
      }
    }
    if (matched) break;
  }
  if (!matched) {
    return {
      ok: false,
      code: "tx_mismatch",
      message: "Shield found, but no commitment in it is addressed to this invoice's recipient.",
    };
  }

  if (matched.tokenAddress !== cfg.usdcAddress.toLowerCase()) {
    return {
      ok: false,
      code: "tx_mismatch",
      message: `Shielded token (${matched.tokenAddress}) is not USDC on ${cfg.displayName}.`,
    };
  }

  // gross = value (post-fee) + fee. Compare against the invoice's outstanding
  // balance in USDC's 6-decimal native units.
  const gross = matched.value + matched.fee;
  const expected = decimalToUsdcUnits(inv.total) - decimalToUsdcUnits(inv.amountPaid);
  if (gross !== expected) {
    return {
      ok: false,
      code: "tx_amount_mismatch",
      message: `On-chain amount (${formatUsdc(gross)} USDC) does not match outstanding balance (${formatUsdc(expected)} USDC).`,
    };
  }

  const block = await provider.getBlock(receipt.blockNumber);
  const paidAt = new Date(
    (block?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
  );

  const recorded: RecordOnchainPaymentResult = await recordOnchainPayment({
    invoiceId: inv.id,
    chainId: cfg.chainId,
    txHash,
    paymentMethod: "railgun_shield",
    payerAddress: receipt.from?.toLowerCase() ?? null,
    amount: usdcUnitsToDecimal2(gross),
    currency: "USD",
    paidAt,
  });

  console.log(
    `[railgun] verify_ok inv=${inv.invoiceNumber} tx=${txHash} amount=${formatUsdc(gross)} status=${recorded.invoiceStatus} already_recorded=${recorded.alreadyRecorded} ms=${Date.now() - t0}`,
  );

  return {
    ok: true,
    alreadyRecorded: recorded.alreadyRecorded,
    paymentId: recorded.payment.id,
    invoiceStatus: recorded.invoiceStatus,
    txHash,
  };
}

function normalizeHex(hash: string): string {
  const trimmed = hash.trim().toLowerCase();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function stripHex(hex: string): string {
  const trimmed = hex.trim().toLowerCase();
  return trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
}

function decimalToUsdcUnits(decimal: string): bigint {
  const [intPart, decPart = ""] = decimal.split(".");
  const padded = decPart.padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS);
  return BigInt(intPart || "0") * 1_000_000n + BigInt(padded || "0");
}

// numeric(14,2) on the column. USDC's native 6dp can carry sub-cent precision;
// we banker-round to two decimals for storage. Round-trip mismatch (eg shielding
// 500.000001 USDC for a $500.00 invoice) is caught by the amount equality
// check above, so we only land here for clean cents.
function usdcUnitsToDecimal2(units: bigint): string {
  const intPart = units / 1_000_000n;
  const fracPart = units % 1_000_000n;
  const cents = (fracPart + 5_000n) / 10_000n;
  if (cents >= 100n) {
    return `${(intPart + 1n).toString()}.00`;
  }
  return `${intPart.toString()}.${cents.toString().padStart(2, "0")}`;
}

function formatUsdc(units: bigint): string {
  const intPart = units / 1_000_000n;
  const fracPart = units % 1_000_000n;
  return `${intPart.toString()}.${fracPart.toString().padStart(6, "0")}`;
}
