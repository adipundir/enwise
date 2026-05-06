/**
 * Settlement wallet ownership proof.
 *
 * Before persisting `businesses.private_settlement_wallet`, we want cryptographic
 * evidence that the user actually controls that address. The flow:
 *
 *   1. `buildSettlementMessage(...)` — server constructs a canonical message
 *      that bakes in (candidate address, business_id, issued_at, nonce).
 *   2. User signs the message verbatim with their wallet (EIP-191
 *      `personal_sign`). No tx, no gas.
 *   3. `verifySettlement(message, signature)` — server parses the message,
 *      checks freshness, recovers the signer, and confirms it matches the
 *      claimed candidate address.
 *
 * Replay protection: messages are valid only within `PROOF_TTL_MIN`. The
 * caller layer additionally enforces `issuedAt >= business.private_enabled_at`
 * to prevent rolling back a newer setting via a stale signature.
 *
 * Limitations:
 * - EOAs only. Smart-wallet (Safe / ERC-1271) signing requires an on-chain
 *   `isValidSignature(bytes32,bytes)` call — not implemented here.
 */

import { recoverMessageAddress } from "viem";

const MESSAGE_HEADER = "enwise.app: settlement wallet binding";
export const PROOF_TTL_MIN = 15;

export type SettlementChallenge = {
  candidate: `0x${string}`;
  businessId: string;
  issuedAt: Date;
  nonce: string;
};

export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function buildSettlementMessage(c: SettlementChallenge): string {
  return [
    MESSAGE_HEADER,
    "",
    `Wallet:    ${c.candidate}`,
    `Business:  ${c.businessId}`,
    `Issued at: ${c.issuedAt.toISOString()}`,
    `Nonce:     ${c.nonce}`,
    "",
    "I confirm I control this wallet and authorize enwise to use it as the",
    "settlement destination for unshielded USDC paid to invoices issued",
    "under this business. Signing this message has no on-chain effect and",
    "costs no gas.",
  ].join("\n");
}

const PARSE_RE = new RegExp(
  "^enwise\\.app: settlement wallet binding\\n\\n" +
    "Wallet:\\s+(0x[a-fA-F0-9]{40})\\n" +
    "Business:\\s+([0-9a-fA-F-]{36})\\n" +
    "Issued at:\\s+(\\S+)\\n" +
    "Nonce:\\s+(\\S+)\\n",
);

export function parseSettlementMessage(msg: string): SettlementChallenge | null {
  const m = msg.match(PARSE_RE);
  if (!m) return null;
  const [, candidate, businessId, issued, nonce] = m;
  const issuedAt = new Date(issued!);
  if (Number.isNaN(issuedAt.getTime())) return null;
  return {
    candidate: candidate as `0x${string}`,
    businessId: businessId!,
    issuedAt,
    nonce: nonce!,
  };
}

export type VerifyErrorCode = "bad_message" | "expired" | "future" | "bad_signature" | "mismatch";

export type VerifyResult =
  | { ok: true; challenge: SettlementChallenge; recovered: `0x${string}` }
  | { ok: false; code: VerifyErrorCode; error: string };

export async function verifySettlement(
  message: string,
  signature: `0x${string}`,
): Promise<VerifyResult> {
  const c = parseSettlementMessage(message);
  if (!c) return { ok: false, code: "bad_message", error: "Message format unrecognized" };

  const ageMs = Date.now() - c.issuedAt.getTime();
  if (ageMs > PROOF_TTL_MIN * 60_000) {
    return { ok: false, code: "expired", error: `Proof older than ${PROOF_TTL_MIN} minutes; request a new message.` };
  }
  if (ageMs < -2 * 60_000) {
    return { ok: false, code: "future", error: "Proof issued_at is in the future; clock skew?" };
  }

  let recovered: `0x${string}`;
  try {
    recovered = await recoverMessageAddress({
      message,
      signature,
    });
  } catch (e) {
    return {
      ok: false,
      code: "bad_signature",
      error: `Signature recovery failed: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }

  if (recovered.toLowerCase() !== c.candidate.toLowerCase()) {
    return {
      ok: false,
      code: "mismatch",
      error: `Signature recovers to ${recovered}, but the message claims ${c.candidate}`,
    };
  }
  return { ok: true, challenge: c, recovered };
}
