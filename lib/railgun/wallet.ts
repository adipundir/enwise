import { randomBytes } from "node:crypto";
import { Mnemonic, randomBytes as ethersRandomBytes } from "ethers";
import {
  createRailgunWallet,
  getRailgunAddress,
  getRailgunWalletPrivateViewingKey,
  unloadWalletByID,
} from "@railgun-community/wallet";
import { ensureEngineStarted, ensureNetworkLoaded, PRIMARY_NETWORK } from "./setup";

/**
 * RAILGUN wallet generation via the high-level SDK.
 *
 * Used at signup-time only (one call per business). Subsequent verification
 * does NOT use this path — verification uses lower-level note primitives
 * directly without engine state.
 *
 * Cold-start cost: ~1s (engine init + Ethereum network probe). Fine for an
 * onboarding flow that runs once per business.
 *
 * Returns:
 *   - mnemonic: 12-word BIP-39, returned to user once for backup; we never
 *     persist this. Loss of mnemonic = loss of spending power; viewing-only
 *     access via the stored viewing key is unaffected.
 *   - zkAddress: 0zk1q… string, stored on the business row, displayed on invoices.
 *   - viewingPrivateKeyHex: raw bytes hex-encoded; used for stateless tx
 *     verification via ShieldNote primitives. STORE ENCRYPTED AT REST.
 */

const ENCRYPTION_KEY = (() => {
  const env = process.env.RAILGUN_ENCRYPTION_KEY;
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) {
      throw new Error(
        "RAILGUN_ENCRYPTION_KEY must be 32-byte hex (64 hex chars). " +
          "Generate one with: openssl rand -hex 32",
      );
    }
    return env;
  }
  // Per-process random key. Wallets in memdown don't outlive the process,
  // so a fresh per-process key works (we never need to re-load the wallet
  // we just generated; the mnemonic + viewing key are returned to the caller).
  return randomBytes(32).toString("hex");
})();

export type GeneratedWallet = {
  mnemonic: string;
  zkAddress: string;
  viewingPrivateKeyHex: string;
};

export async function generateRailgunWallet(): Promise<GeneratedWallet> {
  await ensureEngineStarted();
  await ensureNetworkLoaded(PRIMARY_NETWORK);

  // Fresh 12-word BIP-39 mnemonic.
  const mnemonic = Mnemonic.fromEntropy(ethersRandomBytes(16)).phrase;

  const info = await createRailgunWallet(ENCRYPTION_KEY, mnemonic, undefined);
  const zkAddress = getRailgunAddress(info.id);
  if (!zkAddress) {
    throw new Error("Wallet created but address resolution failed.");
  }
  // Extract raw viewing private key for stateless verification later.
  const viewingPrivKeyBytes = getRailgunWalletPrivateViewingKey(info.id);
  const viewingPrivateKeyHex = Buffer.from(viewingPrivKeyBytes).toString("hex");

  // We have everything we need; the in-memory wallet is no longer useful.
  unloadWalletByID(info.id);

  return {
    mnemonic,
    zkAddress,
    viewingPrivateKeyHex,
  };
}
