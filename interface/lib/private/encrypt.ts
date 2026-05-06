/**
 * Encrypt a recipient address into an encrypted eaddress ciphertext bound to the
 * relayer EOA. The resulting bytes get embedded in the invoice (DB) and the
 * relayer is the only address that can submit them on-chain via
 * EnwisePay.payInvoice — that's what makes the ct safe to expose publicly via
 * the invoice link.
 *
 * No wallet client involved here: zap.encrypt is pure crypto, the
 * accountAddress field is metadata stamped into the ct envelope.
 */

import { handleTypes, type HexString } from "@inco/js";
import { getZap, getEnwisePayAddress, getRelayerAddress } from "./client";

export async function encryptRecipient(recipient: `0x${string}`): Promise<HexString> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
    throw new Error(`encryptRecipient: invalid address ${recipient}`);
  }
  const zap = await getZap();
  return zap.encrypt(BigInt(recipient), {
    accountAddress: getRelayerAddress(),
    dappAddress: getEnwisePayAddress(),
    handleType: handleTypes.euint160,
  });
}
