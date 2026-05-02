import "server-only";
import { eq } from "drizzle-orm";
import { Interface, getBytes, keccak256, randomBytes } from "ethers";
import {
  ByteUtils,
  RailgunEngine,
  ShieldNoteERC20,
} from "@railgun-community/engine";
import { db } from "@/lib/db";
import { businesses, invoices } from "@/lib/db/schema";
import { activeRailgunNetwork } from "./config";

/**
 * Build (but don't sign) a RAILGUN Shield transaction for an invoice's
 * outstanding USDC balance. The browser:
 *   1. asks the user to sign the constant message "RAILGUN_SHIELD" via
 *      personal_sign,
 *   2. sends that signature here,
 *   3. receives back ABI-encoded calldata + the random nonce,
 *   4. submits the tx via the user's wallet,
 *   5. POSTs the txHash + random to verifyAndRecordRailgunPayment.
 *
 * No engine state required. Everything below is pure crypto + ABI encoding.
 */

const USDC_DECIMALS = 6;

const SHIELD_FN_FRAGMENT =
  "function shield(((bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value) preimage,(bytes32[3] encryptedBundle,bytes32 shieldKey) ciphertext)[] _shieldRequests) payable";

const shieldIface = new Interface([SHIELD_FN_FRAGMENT]);

export type PrepareRailgunShieldInput = {
  slug: string;
  /** Hex (0x-prefixed) signature of the constant `RAILGUN_SHIELD` message,
   *  signed via personal_sign by the payer's wallet. */
  signatureHex: string;
};

export type PrepareRailgunShieldResult =
  | {
      ok: true;
      to: string;
      data: string;
      value: string;
      shieldRandom: string;
      grossAmountUsdc: string;
      grossAmountUnits: string;
      chainId: number;
      usdcAddress: string;
      railgunProxyAddress: string;
      shieldMessage: string;
    }
  | {
      ok: false;
      code:
        | "invoice_not_found"
        | "invoice_not_payable"
        | "currency_unsupported"
        | "business_no_railgun"
        | "invalid_signature";
      message: string;
    };

export const SHIELD_SIGNATURE_MESSAGE = "RAILGUN_SHIELD";

export async function prepareRailgunShield(
  input: PrepareRailgunShieldInput,
): Promise<PrepareRailgunShieldResult> {
  const [inv] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.shareSlug, input.slug));
  if (!inv) {
    return {
      ok: false,
      code: "invoice_not_found",
      message: `No invoice for slug ${input.slug}.`,
    };
  }
  if (
    inv.status === "draft" ||
    inv.status === "void" ||
    inv.status === "paid"
  ) {
    return {
      ok: false,
      code: "invoice_not_payable",
      message: `Invoice ${inv.invoiceNumber} is ${inv.status}.`,
    };
  }
  if ((inv.currency ?? "").toUpperCase() !== "USD") {
    return {
      ok: false,
      code: "currency_unsupported",
      message: `Invoice currency ${inv.currency} is not supported.`,
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

  let shieldPrivateKey: string;
  try {
    const sigBytes = getBytes(input.signatureHex);
    if (sigBytes.length !== 65) {
      throw new Error("expected 65-byte signature");
    }
    // Standard derivation per RAILGUN docs: keccak256 of the user's
    // personal_sign("RAILGUN_SHIELD") signature → shieldPrivateKey.
    shieldPrivateKey = keccak256(sigBytes);
  } catch (err) {
    return {
      ok: false,
      code: "invalid_signature",
      message: `Invalid signature: ${(err as Error).message}`,
    };
  }

  const { masterPublicKey, viewingPublicKey } = RailgunEngine.decodeAddress(
    biz.railgunZkAddress,
  );

  const grossUnits =
    decimalToUsdcUnits(inv.total) - decimalToUsdcUnits(inv.amountPaid);
  const random = `0x${Buffer.from(randomBytes(16)).toString("hex")}`;

  const cfg = activeRailgunNetwork();
  const note = new ShieldNoteERC20(
    masterPublicKey,
    random,
    grossUnits,
    cfg.usdcAddress,
  );
  const shieldRequest = await note.serialize(
    ByteUtils.hexToBytes(shieldPrivateKey),
    viewingPublicKey,
  );

  // ABI-encode shield([request]). The Interface generated above matches the
  // V2 RailgunSmartWallet ABI; the calldata is the same regardless of which
  // versioned wrapper we use to construct it.
  const data = shieldIface.encodeFunctionData("shield", [
    [
      {
        preimage: {
          npk: shieldRequest.preimage.npk,
          token: {
            tokenType: shieldRequest.preimage.token.tokenType,
            tokenAddress: shieldRequest.preimage.token.tokenAddress,
            tokenSubID: shieldRequest.preimage.token.tokenSubID,
          },
          value: shieldRequest.preimage.value,
        },
        ciphertext: {
          encryptedBundle: shieldRequest.ciphertext.encryptedBundle,
          shieldKey: shieldRequest.ciphertext.shieldKey,
        },
      },
    ],
  ]);

  return {
    ok: true,
    to: cfg.railgunProxy,
    data,
    value: "0x0",
    shieldRandom: random,
    grossAmountUsdc: formatUsdc(grossUnits),
    grossAmountUnits: grossUnits.toString(),
    chainId: cfg.chainId,
    usdcAddress: cfg.usdcAddress,
    railgunProxyAddress: cfg.railgunProxy,
    shieldMessage: SHIELD_SIGNATURE_MESSAGE,
  };
}

function decimalToUsdcUnits(decimal: string): bigint {
  const [intPart, decPart = ""] = decimal.split(".");
  const padded = decPart.padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS);
  return BigInt(intPart || "0") * 1_000_000n + BigInt(padded || "0");
}

function formatUsdc(units: bigint): string {
  const intPart = units / 1_000_000n;
  const fracPart = units % 1_000_000n;
  const cents = (fracPart + 5_000n) / 10_000n;
  if (cents >= 100n) return `${(intPart + 1n).toString()}.00`;
  return `${intPart.toString()}.${cents.toString().padStart(2, "0")}`;
}
