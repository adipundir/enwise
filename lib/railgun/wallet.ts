import { randomBytes } from "node:crypto";
import { Mnemonic, randomBytes as ethersRandomBytes } from "ethers";
import {
  createRailgunWallet,
  getRailgunAddress,
  getRailgunWalletPrivateViewingKey,
  unloadWalletByID,
} from "@railgun-community/wallet";
import { ensureEngineStarted } from "./setup";

/**
 * RAILGUN wallet generation via the high-level SDK.
 *
 * Used at signup-time only (one call per business). Verification
 * (`lib/railgun/verify.ts`) uses lower-level note primitives directly with
 * no engine state at all.
 *
 * Cold-start cost: ~75ms total (engine init <2ms, createRailgunWallet ~70ms,
 * unload + extract <1ms). Confirmed by isolated smoke test. Wallet creation
 * does NOT require a chain RPC connection — `loadProvider` was previously
 * called here but is unnecessary for the create path.
 *
 * Returns:
 *   - mnemonic: 12-word BIP-39, returned to user once for backup; we never
 *     persist this. Loss of mnemonic = loss of spending power; viewing-only
 *     access via the stored viewing key is unaffected.
 *   - zkAddress: 0zk1q… string, stored on the business row, displayed on invoices.
 *   - viewingPrivateKeyHex: raw bytes hex-encoded; used for stateless tx
 *     verification via ShieldNote primitives. STORE ENCRYPTED AT REST.
 */

// Per-process random key. The SDK requires an encryption key to create a
// wallet (it AES-encrypts the wallet record before writing to the LevelDOWN
// backend), but we use memdown — the encrypted blob lives in RAM for ~70ms
// and is unloaded right after we extract the address + viewing key. Nothing
// is ever decrypted from this key after creation; persistence of the actual
// viewing key happens at the app layer via TOKEN_ENC_KEY (lib/tokens.ts).
// `RAILGUN_ENCRYPTION_KEY` env var is intentionally not honored — it would
// imply consistency that doesn't exist in our usage.
const ENCRYPTION_KEY = randomBytes(32).toString("hex");

export type GeneratedWallet = {
  mnemonic: string;
  zkAddress: string;
  viewingPrivateKeyHex: string;
};

export async function generateRailgunWallet(): Promise<GeneratedWallet> {
  await ensureEngineStarted();

  // Fresh 12-word BIP-39 mnemonic. 16 bytes of entropy → 128 bits.
  const mnemonic = Mnemonic.fromEntropy(ethersRandomBytes(16)).phrase;

  const info = await createRailgunWallet(ENCRYPTION_KEY, mnemonic, undefined);
  const zkAddress = getRailgunAddress(info.id);
  if (!zkAddress) {
    throw new Error("Wallet created but address resolution failed.");
  }
  // Extract raw viewing private key for stateless verification later.
  const viewingPrivKeyBytes = getRailgunWalletPrivateViewingKey(info.id);
  const viewingPrivateKeyHex = Buffer.from(viewingPrivKeyBytes).toString("hex");

  // We have everything we need; drop the in-memory wallet.
  unloadWalletByID(info.id);

  return {
    mnemonic,
    zkAddress,
    viewingPrivateKeyHex,
  };
}
