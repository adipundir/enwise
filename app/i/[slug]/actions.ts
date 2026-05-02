"use server";

import {
  prepareRailgunShield,
  type PrepareRailgunShieldResult,
} from "@/lib/railgun/prepare";
import {
  verifyAndRecordRailgunPayment,
  type VerifyRailgunPaymentResult,
} from "@/lib/railgun/verify";

/**
 * Build (but don't sign) RAILGUN Shield calldata for the invoice's
 * outstanding USDC balance. The browser then submits the resulting tx
 * via the user's wallet and POSTs the txHash + shieldRandom back to
 * `submitRailgunPayment` to flip the invoice to paid.
 */
export async function buildRailgunShield(input: {
  slug: string;
  signatureHex: string;
}): Promise<PrepareRailgunShieldResult> {
  return prepareRailgunShield(input);
}

/**
 * Verify a RAILGUN Shield transaction and record the payment. Same-origin
 * only via Next's default action handling; no extra auth needed because the
 * txHash + shieldRandom witness is what binds the call to a specific invoice.
 */
export async function submitRailgunPayment(input: {
  slug: string;
  txHash: string;
  shieldRandom: string;
}): Promise<VerifyRailgunPaymentResult> {
  return verifyAndRecordRailgunPayment(input);
}
